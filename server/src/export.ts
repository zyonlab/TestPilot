import type { Project, TestCase, Environment } from "./db.js";

/**
 * 文件名。
 *
 * CJK 必须留着：这个平台产出的用例标题就是中文的，而剥掉 CJK 之后每一条标题都塌成空串、
 * 退回 `"case"`——于是**同一个优先级下所有用例写的是同一个文件，互相覆盖**，
 * 一批用例导出之后只剩一条，而且一声不响。
 */
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "case";

// Turn a ${env.KEY}/${secret.KEY} template into a JS template-literal body that
// reads process.env at run time: "hi ${env.USER}" → `hi ${process.env.USER ?? ""}`.
function toEnvTemplate(text: string): string {
  const body = text.replace(
    /\$\{(?:env|secret)\.([A-Za-z0-9_]+)\}/g,
    (_m, key) => "${process.env." + key + ' ?? ""}',
  );
  return "`" + body.replace(/`/g, "\\`") + "`";
}
// Does the text reference any injected variable? (→ use a template literal vs plain string)
const usesVars = (text: string) => /\$\{(?:env|secret)\.[A-Za-z0-9_]+\}/.test(text);
const lit = (text: string) => (usesVars(text) ? toEnvTemplate(text) : JSON.stringify(text));

const TAG: Record<TestCase["type"], string> = {
  functional: "@functional",
  negative: "@negative",
  boundary: "@boundary",
  e2e: "@e2e",
};

function specForCase(tc: TestCase, targetUrl: string): string {
  const tags = `@${tc.priority} ${TAG[tc.type] ?? "@functional"}`;
  const steps = tc.steps.map((s) => `  await aiAction(${lit(s.text)});`).join("\n");
  const post = tc.postSteps.length
    ? "\n  // teardown\n" +
      tc.postSteps
        .map((s) => `  await aiAction(${lit(s.text)}).catch(() => {});`)
        .join("\n")
    : "";
  /**
   * 判据：能由程序判定的就由程序判定。
   *
   * 此前这里无条件写 `aiAssert`，于是平台内刚兑现的 tier1/tier2 机器判据一导出就全变回
   * 「模型看一眼截图然后表态」——导出的套件整套退回 tier3，而 tier 这个标签好不容易才
   * 摆脱这个状态。有 oracle 就用 oracle，没有才退回 judge，和平台内是同一条规则。
   */
  const assert = tc.oracle
    ? `  await checkOracle(page, ${JSON.stringify(tc.oracle)}${tc.oracle.kind === "delta" ? ", before" : ""});` +
      (tc.expected ? `\n  // 断言原文：${tc.expected.replace(/\r?\n/g, " ")}` : "")
    : tc.expected
      ? `  await aiAssert(${lit(tc.expected)});`
      : `  await aiAssert("the page reached the expected state");`;
  const trace = tc.requirementId ? ` — req ${tc.requirementId}` : "";
  const usesOracle = !!tc.oracle;
  const needsBefore = tc.oracle?.kind === "delta";
  // 只解构真的用到的 fixture。一条由程序判定的用例不该顺手把判定模型的 fixture 也拉起来——
  // 那既是多余的开销，也让「这条用例到底要不要模型」在源码上看不出来。
  const fixtures = ["page", ...(steps || post ? ["aiAction"] : []), ...(usesOracle ? [] : ["aiAssert"])];
  return `import { test } from "./ai";
${usesOracle ? `import { checkOracle${needsBefore ? ", bodyText" : ""} } from "./oracle";\n` : ""}
// ${tc.priority} · ${tc.type}${trace} — ${tc.priorityReason || ""}
test(${JSON.stringify(`[${tags}] ${tc.title}`)}, async ({ ${fixtures.join(", ")} }) => {
  await page.goto(process.env.BASE_URL || ${JSON.stringify(targetUrl)});
${needsBefore ? "  // 关系需要两次观察：先读一次，动作之后再读一次。\n  const before = await bodyText(page);\n" : ""}${steps}
${assert}${post}
});
`;
}

// Build a standalone, runnable Playwright + Midscene project from a project's cases.
// Includes env/secrets config, a shared login setup (storageState reuse), tags,
// retries, and a CI workflow — a maintainable suite, not just a flat list of specs.
export function buildExportFiles(
  project: Project,
  cases: TestCase[],
  opts: { environments?: Environment[]; secretKeys?: string[] } = {},
): Record<string, string> {
  const files: Record<string, string> = {};
  const name = slug(project.name) + "-e2e";
  const environments = opts.environments ?? [];
  const defaultEnv = environments.find((e) => e.isDefault) ?? environments[0];
  const login = defaultEnv?.login;
  const hasAuth = !!(login?.authRequired && login.steps?.length);

  // Collect the env-var + secret names referenced anywhere, for .env.example.
  const envVarNames = new Set<string>();
  const secretNames = new Set<string>(opts.secretKeys ?? []);
  const scanText = (t: string) => {
    for (const m of t.matchAll(/\$\{(env|secret)\.([A-Za-z0-9_]+)\}/g)) {
      (m[1] === "secret" ? secretNames : envVarNames).add(m[2]);
    }
  };
  for (const e of environments) {
    Object.keys(e.vars).forEach((k) => envVarNames.add(k));
    Object.values(e.headers ?? {}).forEach(scanText);
    Object.values(e.query ?? {}).forEach(scanText);
  }
  for (const c of cases) [...c.steps, ...c.postSteps].forEach((s) => scanText(s.text));
  for (const s of login?.steps ?? []) scanText(s);

  files["package.json"] = JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        test: "playwright test",
        "test:headed": "playwright test --headed",
        "test:p0": "playwright test --grep @P0",
      },
      devDependencies: {
        // Pinned to the versions TestPilot validates against. Do NOT loosen to a
        // caret range: @playwright/test >= 1.61 has a test-loader regression that
        // crashes collecting the Midscene fixture on a transitive @azure module.
        "@midscene/web": "0.30.10",
        "@playwright/test": "1.48.2",
        dotenv: "16.4.7",
      },
    },
    null,
    2,
  );

  // Fixed request headers (pass the site's own checks) → context-level extraHTTPHeaders.
  // Secret/env refs become process.env reads at run time (see lit()). Query params are
  // carried on baseURL / navigations; the captured session maps to the auth.setup below.
  const headers = defaultEnv?.headers ?? {};
  const headerEntries = Object.entries(headers).filter(([k]) => k.trim());
  const headersBlock = headerEntries.length
    ? `    extraHTTPHeaders: {\n` +
      headerEntries.map(([k, v]) => `      ${JSON.stringify(k)}: ${lit(v)},`).join("\n") +
      `\n    },\n`
    : "";

  // storageState reuse: an auth "setup" project logs in once and saves the session;
  // all test projects start already-authenticated. This is the exported 登录态.
  const projects = hasAuth
    ? `  projects: [
    { name: "setup", testMatch: /auth\\.setup\\.ts/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { storageState: ".auth/state.json" },
    },
  ],`
    : `  projects: [{ name: "chromium" }],`;

  files["playwright.config.ts"] =
    `import { defineConfig } from "@playwright/test";
import "dotenv/config";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    baseURL: process.env.BASE_URL || ${JSON.stringify(defaultEnv?.baseUrl || project.targetUrl)},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
${headersBlock}  },
${projects}
});
`;

  files["tests/ai.ts"] =
    `import { test as base } from "@playwright/test";
import { PlaywrightAiFixture } from "@midscene/web/playwright";

// Adds ai / aiAction / aiQuery / aiAssert to the test context, driven by the
// OpenAI-compatible vision model configured in .env (see .env.example).
export const test = base.extend(PlaywrightAiFixture());
export { expect } from "@playwright/test";
`;

  /**
   * 判据的机器判定，原样搬进导出的工程。
   *
   * 在这个文件出现之前，导出只会写 `aiAssert(expected)`——**平台内刚兑现的 tier1/tier2
   * 一导出就全变回让模型看截图**，而那正是 tier 这个标签好不容易才摆脱的状态。
   * 语义与 `harness-testing/exec/oracle.ts` 保持一致：文本按可见正文的包含判定，
   * 次数按字面量出现次数，delta 需要动作前后各读一次。
   */
  files["tests/oracle.ts"] =
    `import type { Page } from "@playwright/test";

export type Oracle =
  | { kind: "text" | "noText"; value: string }
  | { kind: "url"; value: string }
  | { kind: "count"; value: string; op: "eq" | "gte" | "lte"; n: number }
  | { kind: "delta"; value: string; direction: "increased" | "decreased" | "unchanged"; by?: number };

export const bodyText = (page: Page): Promise<string> =>
  page.evaluate(() => document.body?.innerText ?? "");

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let from = 0, n = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
}

/**
 * 标签旁边的那个数。
 *
 * 刻意简单，也刻意在读不到时明说：同一个标签出现两次且数值不同，或者旁边根本不是数字，
 * 就返回 undefined 让检查如实报「读不到」——猜一个，是「确定性判据」变成抛硬币的方式。
 */
export function readNumberNear(text: string, label: string): number | undefined {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(label, from);
    if (at === -1) break;
    from = at + label.length;
    const m = text.slice(from, from + 40).match(/-?\\d+(?:[.,]\\d+)?/);
    if (m) found.push(Number(m[0].replace(",", "")));
  }
  if (!found.length) return undefined;
  return found.every((v) => v === found[0]) ? found[0] : undefined;
}

/** 判定，并在失败时说清楚页面上实际是什么。程序判定：不调模型，不看截图。 */
export async function checkOracle(page: Page, oracle: Oracle, before?: string): Promise<void> {
  const after = await bodyText(page);
  const fail = (detail: string): never => {
    throw new Error(\`oracle \${oracle.kind} failed — \${detail}\`);
  };
  switch (oracle.kind) {
    case "text":
      if (!after.includes(oracle.value)) fail(\`页面上没有「\${oracle.value}」\`);
      return;
    case "noText":
      if (after.includes(oracle.value)) fail(\`页面上仍有「\${oracle.value}」\`);
      return;
    case "url":
      if (!page.url().includes(oracle.value)) fail(\`地址是 \${page.url()}，不含 \${oracle.value}\`);
      return;
    case "count": {
      const n = occurrences(after, oracle.value);
      const ok = oracle.op === "eq" ? n === oracle.n : oracle.op === "gte" ? n >= oracle.n : n <= oracle.n;
      if (!ok) fail(\`「\${oracle.value}」出现 \${n} 次（要求 \${oracle.op} \${oracle.n}）\`);
      return;
    }
    case "delta": {
      // 关系需要两次观察。没有前置快照时如实报「测不到」，而不是把它算成产品的错。
      if (before === undefined) fail(\`没有取到步骤执行前的快照，\${oracle.value} 的变化无法判定\`);
      const a = readNumberNear(before!, oracle.value);
      const b = readNumberNear(after, oracle.value);
      if (a === undefined || b === undefined)
        fail(\`读不到 \${oracle.value} 旁边的数值（前 \${a ?? "—"} / 后 \${b ?? "—"}）\`);
      const diff = b! - a!;
      const ok =
        oracle.direction === "increased" ? (oracle.by !== undefined ? diff === oracle.by : diff > 0)
        : oracle.direction === "decreased" ? (oracle.by !== undefined ? diff === -oracle.by : diff < 0)
        : diff === 0;
      if (!ok) fail(\`\${oracle.value}: \${a} → \${b}（Δ \${diff}）\`);
      return;
    }
  }
}
`;

  if (hasAuth) {
    const loginSteps = (login!.steps ?? [])
      .map((s) => `  await aiAction(${lit(s)});`)
      .join("\n");
    files["tests/auth.setup.ts"] =
      `import { test as setup } from "./ai";

// Runs ONCE before the suite: performs the login flow using credentials injected
// from .env (never hard-coded), then persists the session to .auth/state.json so
// every test starts authenticated. Central login state — change it in one place.
setup("authenticate", async ({ page, aiAction }) => {
  await page.goto(process.env.BASE_URL || ${JSON.stringify(defaultEnv?.baseUrl || project.targetUrl)});
${loginSteps}
  await page.context().storageState({ path: ".auth/state.json" });
});
`;
  }

  // 两条标题仍然可能塌成同一个名字（截断、或只差标点）。撞名就带上用例 id：
  // 一个静默覆盖掉另一条用例的导出，比导出失败更糟——它看起来是成功的。
  const taken = new Set<string>();
  for (const tc of cases) {
    let name = `tests/${tc.priority.toLowerCase()}-${slug(tc.title)}.spec.ts`;
    if (taken.has(name)) name = `tests/${tc.priority.toLowerCase()}-${slug(tc.title)}-${tc.id}.spec.ts`;
    taken.add(name);
    files[name] = specForCase(tc, defaultEnv?.baseUrl || project.targetUrl);
  }

  const envLines = [...envVarNames].sort().map((k) => {
    const v = defaultEnv?.vars?.[k];
    return `${k}=${v ?? ""}`;
  });
  const secretLines = [...secretNames].sort().map((k) => `${k}=            # set me (never commit real values)`);
  files[".env.example"] =
    `# ---- Vision-language model Midscene uses to drive the tests ----
OPENAI_BASE_URL=http://127.0.0.1:8010/v1
OPENAI_API_KEY=1234
MIDSCENE_MODEL_NAME=Qwen3.6-35B-A3B-4bit
MIDSCENE_USE_QWEN3_VL=1

# ---- Target ----
BASE_URL=${defaultEnv?.baseUrl || project.targetUrl}

# ---- Environment variables (non-secret) ----
${envLines.length ? envLines.join("\n") : "# (none)"}

# ---- Secrets (injected at run time; keep out of version control) ----
${secretLines.length ? secretLines.join("\n") : "# (none)"}
`;

  files[".gitignore"] = `node_modules/\n.env\n.auth/\nplaywright-report/\ntest-results/\n`;

  files[".github/workflows/e2e.yml"] =
    `name: E2E
on: [push, pull_request, workflow_dispatch]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npx playwright install --with-deps chromium
      - run: npm test
        env:
          OPENAI_BASE_URL: \${{ secrets.OPENAI_BASE_URL }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          MIDSCENE_MODEL_NAME: \${{ vars.MIDSCENE_MODEL_NAME }}
          BASE_URL: \${{ vars.BASE_URL }}
${[...secretNames].sort().map((k) => `          ${k}: \${{ secrets.${k} }}`).join("\n")}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: playwright-report, path: playwright-report/ }
`;

  const p0 = cases.filter((c) => c.priority === "P0").length;
  const neg = cases.filter((c) => c.type === "negative" || c.type === "boundary").length;
  files["README.md"] =
    `# ${project.name} — E2E tests

Generated by TestPilot from ${cases.length} test cases (${p0} P0, ${neg} negative/boundary).
Runnable Playwright + [Midscene](https://midscenejs.com) suite — the vision model
drives each step by natural language.

## Run

\`\`\`bash
npm install
npx playwright install chromium
cp .env.example .env    # point at your vision model + set secrets
npm test                # all tests
npm run test:p0         # only P0 (tagged @P0)
npm run test:headed     # watch it drive the browser
\`\`\`

${hasAuth ? "## Login state\n\nLogin runs once in `tests/auth.setup.ts` using credentials from `.env`, and the\nauthenticated session is saved to `.auth/state.json` and reused by every test —\nno per-test re-login, and no credentials in the specs.\n\n" : ""}## Secrets & environments

Credentials are injected from environment variables at run time (see \`.env.example\`) —
the specs reference \`process.env.*\`, never literal passwords. In CI, set them as
GitHub Actions **secrets**; non-secret config as **vars**.

## Cases
${cases.map((c) => `- **${c.priority}** \`${c.type}\` ${c.title}`).join("\n")}
`;

  return files;
}
