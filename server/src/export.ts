import type { Project, TestCase, Environment } from "./db.js";
import { buildLayers, type Layers } from "./exportLayers.js";
import { getDataset, type Dataset } from "./datasets.js";

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

/** 循环体里的代码多缩一级。缩进不影响执行，但一份缩进是错的导出没人愿意读第二眼。 */
const indent = (s: string): string => s.replace(/^(?=.)/gm, "  ");

/**
 * @param up 从这个 spec 文件回到 `tests/` 要走几级。按模块建目录之后是 `../`，
 *           平铺时是 `./`——写死任何一个，另一种布局的导入路径就是坏的。
 */
/**
 * 把一段可能引用了数据行的文本，变成一个 JS 表达式。
 *
 * 用**字符串拼接**而不是模板字符串：模板字符串要转义反引号和 `${`，而步骤原文里这两样
 * 都可能有。少一层转义，就少一类只在某几条用例上才犯的错。
 *
 * 第一版是拿正则去改写**已经生成好的代码**（把 `${row.x}` 换成 `${r.x}`），那条路本身
 * 就错：`lit()` 已经把步骤包进了 JSON 双引号，改完得到的是
 * `aiAction("在 firstName 填入 ${r.firstName}")`——双引号不插值，那串字会被原样输进表单，
 * 而且没有任何一层会报错。生成代码这件事上，字符串替换分不清代码、注释和字面量。
 */
function rowExpr(text: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(/\$\{row(?:\.([A-Za-z0-9_]+))?\}/g)) {
    if (m.index! > last) parts.push(lit(text.slice(last, m.index!)));
    parts.push(m[1] ? `r[${JSON.stringify(m[1])}]` : "JSON.stringify(r)");
    last = m.index! + m[0].length;
  }
  if (!parts.length) return lit(text);
  if (last < text.length) parts.push(lit(text.slice(last)));
  return parts.join(" + ");
}

function specForCase(
  tc: TestCase,
  targetUrl: string,
  up = "./",
  layers?: Layers,
  dataset?: Dataset,
): string {
  const tags = `@${tc.priority} ${TAG[tc.type] ?? "@functional"}`;
  /**
   * 步骤分三层写：共享前置调 flow，重复的单步调 action，其余内联。
   *
   * 抽取只改组织不改语义——展开之后的序列和原来逐字相同（`expandPlan` 就是为了让这条
   * 能被测试验证）。没有 `layers` 时退回全部内联：一个只有一条用例的项目抽什么都是负担。
   */
  // 绑了数据集才把 `${row.x}` 当引用解析。没绑数据集的用例里出现 `${row.x}` 是个 bug，
  // 不该在这里被偷偷「修好」——`checkBinding` 会把它作为 missing 报出来。
  const dd = !!dataset?.rows.length;
  const T = (s: string): string => (dd ? rowExpr(s) : lit(s));
  const plan = layers?.plan.get(tc.id);
  const usedFlows = new Set<string>();
  const usedActions = new Set<string>();
  const steps = plan
    ? plan
        .map((s) => {
          if (s.kind === "flow") {
            usedFlows.add(s.name);
            return `  await ${s.name}(aiAction);`;
          }
          if (s.kind === "action") {
            usedActions.add(s.name);
            return `  await ${s.name}(aiAction);`;
          }
          return `  await aiAction(${T(s.text)});`;
        })
        .join("\n")
    : tc.steps.map((s) => `  await aiAction(${T(s.text)});`).join("\n");
  const post = tc.postSteps.length
    ? "\n  // teardown\n" +
      tc.postSteps
        .map((s) => `  await aiAction(${T(s.text)}).catch(() => {});`)
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
      ? `  await aiAssert(${T(tc.expected)});`
      : `  await aiAssert("the page reached the expected state");`;
  const trace = tc.requirementId ? ` — req ${tc.requirementId}` : "";
  const usesOracle = !!tc.oracle;
  const needsBefore = tc.oracle?.kind === "delta";
  // 只解构真的用到的 fixture。一条由程序判定的用例不该顺手把判定模型的 fixture 也拉起来——
  // 那既是多余的开销，也让「这条用例到底要不要模型」在源码上看不出来。
  const fixtures = ["page", ...(steps || post ? ["aiAction"] : []), ...(usesOracle ? [] : ["aiAssert"])];
  // 只导入真的用到的：一个把整层都 import 进来的 spec，读的人分不清它到底依赖了什么。
  const layerImports = [
    usedFlows.size ? `import { ${[...usedFlows].sort().join(", ")} } from "${up}flows";` : "",
    usedActions.size ? `import { ${[...usedActions].sort().join(", ")} } from "${up}actions";` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const head = `import { test } from "${up}ai";
${usesOracle ? `import { checkOracle${needsBefore ? ", bodyText" : ""} } from "${up}oracle";\n` : ""}${layerImports ? layerImports + "\n" : ""}`;
  const body = `  await page.goto(process.env.BASE_URL || ${JSON.stringify(targetUrl)});
${needsBefore ? "  // 关系需要两次观察：先读一次，动作之后再读一次。\n  const before = await bodyText(page);\n" : ""}${steps}
${assert}${post}`;
  const title = `[${tags}] ${tc.title}`;

  /**
   * 绑了数据集的用例：**一行一个 test**，不是一个 test 里跑一个循环。
   *
   * 差别在失败的时候：一个 test 里循环，报告只说「这条用例挂了」，是哪一行要去翻日志；
   * 一行一个 test，报告直接说「第 2 行 Jane/Roe 挂了」。E2E 的失败定位成本几乎全在这里。
   *
   * 数据随工程走（`tests/data/<name>.json`），不是运行时去平台上取——导出的工程要能
   * 离开平台自己跑，而一份留在服务器上的数据集会让它在别人的 CI 上第一天就挂。
   */
  if (!dataset?.rows.length) {
    return `${head}
// ${tc.priority} · ${tc.type}${trace} — ${tc.priorityReason || ""}
test(${JSON.stringify(title)}, async ({ ${fixtures.join(", ")} }) => {
${body}
});
`;
  }
  const cols = dataset.columns;
  return `${head}import rows from "${up}data/${dataset.name}.json";

// ${tc.priority} · ${tc.type}${trace} — ${tc.priorityReason || ""}
// 数据驱动：${dataset.rows.length} 行各跑一次${dataset.uniqueCols.length ? `；${dataset.uniqueCols.join("/")} 每次运行加唯一后缀` : ""}
${dataset.uniqueCols.length ? `const suffix = process.env.RUN_SUFFIX || \`r\${Date.now().toString(36).slice(-4)}\`;\nconst uniq = (v: string) => { const at = v.indexOf("@"); return at > 0 ? \`\${v.slice(0, at)}-\${suffix}\${v.slice(at)}\` : \`\${v}-\${suffix}\`; };\n` : ""}
for (const [i, row] of (rows as Array<Record<string, string>>).entries()) {
${dataset.uniqueCols.length ? `  const r = { ...row${cols.map((c) => (dataset.uniqueCols.includes(c) ? `, ${JSON.stringify(c)}: uniq(row[${JSON.stringify(c)}] ?? "")` : "")).join("")} };\n` : "  const r = row;\n"}\
  // 一行一个 test：失败时报告直接说是第几行，不用去翻日志。
  test(${JSON.stringify(title)} + \` — 第 \${i + 1} 行\`, async ({ ${fixtures.join(", ")} }) => {
${indent(body)}
  });
}
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

  /**
   * 按模块建目录，模块内按优先级命名。
   *
   * 此前是全部平铺在 `tests/` 下，前缀是优先级——而优先级此前恒为 P1（设计节点从不产出，
   * 批准时默认），于是两千条用例就是两千个 `p1-*.spec.ts` 挤在一个目录里。
   * 模块是规格里**算出来**的路由聚类，用例批准时跟着落了盘，拿它建目录不用再发明什么。
   *
   * 没有模块的用例放 `tests/_`：一个说不出自己属于哪儿的用例，不该被塞进某个模块里
   * 假装它有归属——那会让「这个模块测到什么程度」这个数悄悄变得不可信。
   *
   * 两条标题仍然可能塌成同一个名字（截断、或只差标点）。撞名就带上用例 id：
   * 一个静默覆盖掉另一条用例的导出，比导出失败更糟——它看起来是成功的。
   */
  /**
   * 三层：actions（具名单步）/ flows（具名前置）/ cases（每条用例一个 spec）。
   *
   * 此前导出是「平铺语句」——同一段前置在几十条用例里各写一遍，改一次要改几十处。
   * 抽取门槛是**至少两条用例用它**：一个只有一个调用方的公共函数比内联更糟，
   * 读的人多跳一次却什么也没省。名字由步骤原文 slug 化而来，不问模型——
   * 导出必须可重复，同一批用例导两次要得到逐字节相同的工程，否则它进不了版本库。
   */
  const layers = buildLayers(cases);
  const ACT_TYPE = "type Act = (text: string) => Promise<unknown>;";
  if (layers.actions.length)
    files["tests/actions/index.ts"] =
      "// 具名的单步交互：同一句话在至少两条用例里出现过，才在这里有名字。\n" +
      "// 名字来自步骤原文，所以同一批用例每次导出得到同一份文件。\n" +
      `${ACT_TYPE}\n\n` +
      layers.actions
        .map(
          (a) =>
            `/** 用于 ${a.usedBy.length} 条用例。 */\n` +
            `export const ${a.name} = (aiAction: Act) => aiAction(${lit(a.text)});\n`,
        )
        .join("\n");
  if (layers.flows.length)
    files["tests/flows/index.ts"] =
      "// 具名的共享前置：到达某一屏要走的那几步，被至少两条用例共用。\n" +
      "// 只认前缀，不认任意子序列——两条不相干的用例中间偶然相同的两步不是流程。\n" +
      `${ACT_TYPE}\n\n` +
      layers.flows
        .map(
          (f) =>
            `/** 用于 ${f.usedBy.length} 条用例，共 ${f.steps.length} 步。 */\n` +
            `export const ${f.name} = async (aiAction: Act) => {\n` +
            f.steps.map((s) => `  await aiAction(${lit(s)});`).join("\n") +
            "\n};\n",
        )
        .join("\n");

  const taken = new Set<string>();
  for (const tc of cases) {
    const dir = `tests/${tc.activity?.trim() ? slug(tc.activity) : "_"}`;
    let name = `${dir}/${tc.priority.toLowerCase()}-${slug(tc.title)}.spec.ts`;
    if (taken.has(name)) name = `${dir}/${tc.priority.toLowerCase()}-${slug(tc.title)}-${tc.id}.spec.ts`;
    taken.add(name);
    const ds = tc.dataKey ? getDataset(project.id, tc.dataKey) : undefined;
    if (ds?.rows.length) files[`tests/data/${ds.name}.json`] = JSON.stringify(ds.rows, null, 2) + "\n";
    files[name] = specForCase(tc, defaultEnv?.baseUrl || project.targetUrl, "../", layers, ds);
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
