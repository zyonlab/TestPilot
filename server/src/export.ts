import { LedgerError } from './runLedger.js';
import type { TextCase } from "@testpilot/harness-testing/casegen";
import { sealExport, exportHash } from './exportIntegrity.js';
import { exportOracleFiles } from './exportOracle.js';
import type { Project, TestCase, Environment } from "./db.js";
import { buildLayers, flowKey, type LayerMemory, type Layers } from "./exportLayers.js";
import { getDataset, type Dataset } from "./datasets.js";

type ExportCase = TestCase & { assertions?: TextCase["assertions"]; lifecycle?: TextCase["lifecycle"] };

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
  const parts: string[] = []; let last = 0;
  for (const match of text.matchAll(/\$\{(?:env|secret)\.([A-Za-z0-9_]+)\}/g)) {
    if (match.index! > last) parts.push(JSON.stringify(text.slice(last, match.index!)));
    parts.push(`(process.env[${JSON.stringify(match[1])}] ?? "")`);
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push(JSON.stringify(text.slice(last)));
  return parts.join(" + ") || JSON.stringify(text);
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

/**
 * **导航不该交给视觉模型跑一遍。**
 *
 * 2026-09-14 看导出产物时发现的：spec 体里已经有
 * `await page.goto(BASE_URL)`，而用例的第 1 步几乎都是「打开 https://…/trade/ETH」，
 * 于是它又被编译成一次 `aiAction("打开 https://…")`——**每条用例导航两次**，
 * 第二次由视觉模型去看屏幕、找地址栏、敲回车，十几秒一次，242 条就是一小时。
 * 更糟的是抽取层把它认成了「19 条用例共用的动作」，起了个
 * `打开_https_app_hyperliquid_testnet_xyz_tra_19` 的名字放进 `tests/actions`——
 * 一个纯噪音的抽象，还骗过了「至少两条用例用它才抽」那道门槛。
 *
 * 平台内早就有这条口径（`caseEntry.ts` 的 `explicit-page-precondition-v1`）：
 * 入口地址由前置条件决定，不进步骤。导出这一侧照做——首步是**裸导航**就把它提成
 * `page.goto` 的目标并从步骤里去掉。只认首步、只认整句就是一个地址的那种：
 * 「打开设置面板」不是导航，「在新标签页打开」也不是。
 */
/**
 * 首步的形状实测是 `打开 <url> 并等待<条件>`（242 条里 175 条），不是裸导航。
 * 所以分三件事处理，而不是一刀切：
 *   ① 地址 → `page.goto` 的目标；
 *   ② `并等待页面加载完成` 这种泛化等待 → 丢掉，`page.goto` 本来就等 load；
 *   ③ `并等待订单簿视图加载` 这种**真条件** → 留成一步 `等待…`，语义一个字不变。
 * 三件事分开，才不会为了省一次模型调用把一条真的等待也一起吞掉。
 */
const ENTRY_NAV =
  /^\s*(?:打开|访问|导航到?|前往|进入|open|go to|navigate to|visit)\s+[`'"]?(https?:\/\/[^\s`'"，,]+|\/[^\s`'"，,]*)[`'"]?\s*(?:[,，]?\s*(?:并|然后|and)?\s*(?:等待|wait\s+for)\s*(.+?))?\s*[.。]?\s*$/i;
/** 泛化的「等页面好」——`page.goto` 已经做了，留着只是多一次模型调用。 */
const GENERIC_WAIT = /^(页面)?(完全)?(加载|渲染|载入)(完成|完毕|好)?$|^page\s+(to\s+)?load(ed)?$|^加载完成$/i;
export function liftEntryNavigation(
  steps: readonly { text: string }[],
  fallback: string,
): { url: string; rest: readonly { text: string }[] } {
  const first = steps[0];
  const match = first ? ENTRY_NAV.exec(first.text) : null;
  if (!match) return { url: fallback, rest: steps };
  let url: string;
  try { url = new URL(match[1]!, fallback).href; } catch { return { url: fallback, rest: steps }; }
  const wait = match[2]?.trim();
  const kept = wait && !GENERIC_WAIT.test(wait)
    ? [{ ...first!, text: `等待${wait}` }, ...steps.slice(1)]
    : steps.slice(1);
  return { url, rest: kept };
}

function specForCase(
  tc: ExportCase,
  targetUrl: string,
  up = "./",
  layers?: Layers,
  dataset?: Dataset,
): string {
  /**
   * 标签里要带**追溯线**，不只是优先级和类别。
   *
   * 2026-09-14：导出的 242 条 spec 里，一条失败只说得出「这条用例挂了」，说不出
   * 它兑现的是哪条用户故事的哪条验收准则——而平台内这条线现在是齐的
   * （`acRefs` 已经是 `S-05/AC-2` 这样的稳定编号）。一份接不上需求的套件，
   * 失败时只能靠人回去猜它本来想证明什么。
   *
   * 用 tag 而不是注释：`playwright test --grep @story:S-MB-01` 能直接跑一条故事的全部用例，
   * 而注释谁都 grep 不到。
   */
  const tags = [
    `@${tc.priority}`,
    TAG[tc.type] ?? "@functional",
    tc.storyId ? `@story:${tc.storyId}` : "",
    /**
     * **这条测试兑现的是哪条验收准则。**
     *
     * `@story:` 只到故事一层，而一条故事有两三条准则——红了还是得回去猜是哪一条。
     * 2026-09-14 起 `acRefs` 是稳定编号（`S-05/AC-2`），把它带到这里，
     * `--grep @ac:S-05/AC-2` 就能跑「兑现这条准则的全部测试」。
     * 一条用例可能了结好几条，全带上。
     */
    ...(tc.acRefs ?? []).map((r) => `@ac:${r}`),
    tc.tier ? `@tier${tc.tier}` : "",
    tc.requirementId ? `@req:${tc.requirementId}` : "",
  ].filter(Boolean).join(" ");
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
  const topNone = tc.oracle?.kind === "none";
  if (topNone) tc = {...tc, oracle: undefined};
  const checks = (tc.assertions ?? []).map(a => a.oracle?.kind === "none" ? {...a, oracle: undefined} : a);
  const bound = (a: NonNullable<TextCase["assertions"]>[number]) => a.afterStep !== undefined && a.afterStep >= 1 && a.afterStep <= tc.steps.length && a.oracle?.kind !== "api";
  const finalMachine = !!tc.oracle || checks.some(a => a.oracle && !bound(a));
  const checkSource = (a: NonNullable<TextCase["assertions"]>[number], i: number) => a.oracle?.kind === "judge"
    ? `  await checkJudge(page, judgeAgent, ${JSON.stringify(a.oracle)});`
    : a.oracle ? `  await checkOracle(page, ${JSON.stringify(a.oracle)}, assertionBefore${i});`
    : `  await aiAssert(${T(a.statement)});`;
  // Preserve step positions: a shared flow must not swallow an intermediate assertion.
  const plan = checks.length ? undefined : layers?.plan.get(tc.id);
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
    : tc.steps.map((s, step) => [
        `  await aiAction(${T(s.text)});`,
        ...checks.flatMap((a, i) => bound(a) && a.afterStep === step + 1 ? [checkSource(a, i)] : [])
      ].join("\n")).join("\n");
  const post = tc.postSteps.length
    ? "\n  // teardown\n" +
      tc.postSteps
        .map((s, i) => `  try { await aiAction(${T(s.text)}); cleanupReceipts.push({step:${i+1},status:"unknown",detail:"Action completed; no reviewed cleanup oracle"}); } catch (error) { cleanupErrors.push(error); cleanupReceipts.push({step:${i+1},status:page.isClosed()?"unknown":"fail",detail:String(error)}); }`)
        .join("\n")
    : "";
  /**
   * 判据：能由程序判定的就由程序判定。
   *
   * 此前这里无条件写 `aiAssert`，于是平台内刚兑现的 tier1/tier2 机器判据一导出就全变回
   * 「模型看一眼截图然后表态」——导出的套件整套退回 tier3，而 tier 这个标签好不容易才
   * 摆脱这个状态。有 oracle 就用 oracle，没有才退回 judge，和平台内是同一条规则。
   */
  const relationalApi =
    tc.oracle?.kind === "api" &&
    (tc.oracle.op === "increased" || tc.oracle.op === "decreased" || tc.oracle.op === "unchanged");
  // judge 判据要模型采样：走 checkJudge，而不是只看页面文字的 checkOracle。
  const judged = tc.oracle?.kind === "judge";
  const assertionJudged = checks.some(a => a.oracle?.kind === "judge");
  const assert = judged
    ? `  await checkJudge(page, judgeAgent, ${JSON.stringify(tc.oracle)});` + (tc.expected ? `\n  // 断言原文：${tc.expected.replace(/\r?\n/g, " ")}` : "")
    : tc.oracle
    ? `  await checkOracle(page, ${JSON.stringify(tc.oracle)}${tc.oracle.kind === "delta" || relationalApi ? ", before" : ""});` +
      (tc.expected ? `\n  // 断言原文：${tc.expected.replace(/\r?\n/g, " ")}` : "")
    : finalMachine && !topNone ? "" : tc.expected
      ? `  await aiAssert(${T(tc.expected)});`
      : `  await aiAssert("the page reached the expected state");`;
  const trace = tc.requirementId ? ` — req ${tc.requirementId}` : "";
  const usesOracle = !!tc.oracle;
  const needsBefore = tc.oracle?.kind === "delta" || relationalApi;
  // 只解构真的用到的 fixture。一条由程序判定的用例不该顺手把判定模型的 fixture 也拉起来——
  // 那既是多余的开销，也让「这条用例到底要不要模型」在源码上看不出来。
  const fixtures = ["page", ...(steps || post ? ["aiAction"] : []), ...(!finalMachine || topNone || checks.some(a => !a.oracle) ? ["aiAssert"] : []), ...(judged || assertionJudged ? ["judgeAgent"] : [])];
  // 只导入真的用到的：一个把整层都 import 进来的 spec，读的人分不清它到底依赖了什么。
  const layerImports = [
    usedFlows.size ? `import { ${[...usedFlows].sort().join(", ")} } from "${up}flows";` : "",
    usedActions.size ? `import { ${[...usedActions].sort().join(", ")} } from "${up}actions";` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const oracleImports = new Set<string>([
    ...(usesOracle ? [judged ? "checkJudge" : "checkOracle"] : []),
    ...(needsBefore ? ["readBefore"] : []),
    ...checks.flatMap(a => a.oracle ? [a.oracle.kind === "judge" ? "checkJudge" : "checkOracle", "readBefore"] : [])
  ]);
  const head = `import { test } from "${up}ai";
${post ? 'test.describe.configure({ retries: 0 });\n' : ''}${oracleImports.size ? `import { ${[...oracleImports].join(", ")} } from "${up}oracle";\n` : ""}${layerImports ? layerImports + "\n" : ""}`;
  // targetUrl 已经是**这条用例自己的入口**（首步的裸导航被提到了这里，见 liftEntryNavigation）。
  const body = `  await page.goto(process.env.BASE_URL || ${JSON.stringify(targetUrl)});
${needsBefore ? `  // 关系需要两次观察：先读一次，动作之后再读一次。\n  const before = await readBefore(page, ${JSON.stringify(tc.oracle)});\n` : ""}${checks.map((a, i) => a.oracle ? `  const assertionBefore${i} = await readBefore(page, ${JSON.stringify(a.oracle)});\n` : "").join("")}${post ? "  let businessError: unknown; let businessFailed = false; const cleanupErrors: unknown[] = []; const cleanupReceipts: unknown[] = [];\n  try {\n" : ""}${steps}
${assert}
${checks.flatMap((a,i) => bound(a) ? [] : [checkSource(a,i)]).join("\n")}${post ? '\n  } catch (error) { businessFailed = true; businessError = error; } finally {' + post + '\n    try { await test.info().attach("cleanup-receipts", {body:JSON.stringify(cleanupReceipts),contentType:"application/json"}); } catch (error) { cleanupErrors.push(error); }\n  }\n  if (businessFailed) throw businessError;\n  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "ENV_TEARDOWN_FAILED");' : ""}`;
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
/**
 * **一份生成出来的测试工程里，有两种文件，混在一起它就没法用。**
 *
 * 2026-09-14 用户的要求：「要兼顾测试工程里的可变不可变……每个用例生成项目中可变的部分」。
 * 这里的分界线是**谁拥有这个文件**：
 *
 * - `generated`：工具拥有。每条用例的 spec、抽出来的 actions/flows、数据、清单。
 *   它们是用例的**投影**，下一次导出会原样覆盖。手改这里等于把改动扔进下一次导出。
 * - `scaffold`：人拥有。配置、夹具、登录 setup、CI、README、`.env.example`。
 *   工具**只在它缺失时**给一份能跑的默认值；此后加个 reporter、调个 timeout、
 *   换个 CI runner，都是这份工程自己的事。
 *
 * 不划这条线的后果很实：现在每次导出是全量覆盖，用户在 `playwright.config.ts` 里加的
 * 任何东西，下一次导出都会消失——而他不会收到任何提示。一个会悄悄吃掉人的改动的
 * 生成器，用第二次就没人敢用了。
 *
 * 这个函数是**唯一的判据**：文件头的标注、清单里的 `ownership`、README 里的那一节，
 * 三处都从它来，不各写一份。
 */
export type FileOwner = "generated" | "scaffold";
export function fileOwner(path: string): FileOwner {
  return /^tests\/.+\.spec\.ts$/.test(path)
    || path === "tests/actions/index.ts"
    || path === "tests/flows/index.ts"
    || path.startsWith("tests/data/")
    || path === "testpilot-manifest.json"
    ? "generated"
    : "scaffold";
}

/** 文件头的一行标注。放在最前面，读的人第一眼就知道这份改了算不算数。 */
function ownerBanner(path: string): string {
  const comment = path.endsWith(".json") ? null : path.endsWith(".yml") || path.endsWith(".yaml") || path.endsWith(".gitignore") || path.endsWith(".example") ? "#" : "//";
  if (!comment) return "";
  return fileOwner(path) === "generated"
    ? `${comment} 由 TestPilot 生成（用例的投影）。下一次导出会覆盖它——要改就去改用例。\n`
    : `${comment} TestPilot 脚手架：只在缺失时创建。这份归你，随便改，导出不会覆盖。\n`;
}

export function buildExportFiles(
  project: Project,
  cases: ExportCase[],
  opts: { environments?: Environment[]; secretKeys?: string[];
    /** 这个项目曾经命名过的步骤与前置。给了它，抽取层就只增不减——见 exportLayers 的 LayerMemory。 */
    sticky?: LayerMemory;
    /** 这次新抽出来的名字回调出去，由调用方落盘。导出本身保持无状态。 */
    onLayers?: (seen: { actions: string[]; flows: string[] }) => void } = {},
): Record<string, string> {
  const unsupported=cases.filter(c=>c.lifecycle);
  if(unsupported.length)throw new LedgerError(409,'export_lifecycle_unsupported:'+unsupported.map(c=>c.id).join(','));
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
        test: "node scripts/verify-export.mjs && playwright test",
        "test:headed": "playwright test --headed",
        "test:p0": "node scripts/verify-export.mjs && playwright test --grep @P0",
      },
      devDependencies: {
        // Pinned to the versions TestPilot validates against. Do NOT loosen to a
        // caret range: @playwright/test >= 1.61 has a test-loader regression that
        // crashes collecting the Midscene fixture on a transitive @azure module.
        "@midscene/web": "0.30.10",
        "@playwright/test": "1.48.2",
        dotenv: "16.4.7",
        zod: "3.25.76",
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
  retries: 0, // Report initial failures; retries must be a separately recorded run.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    headless: true,
    launchOptions: { executablePath: process.env.TP_CHROMIUM_EXECUTABLE_PATH || undefined },
    viewport: ${JSON.stringify({width:defaultEnv?.viewport?.width ?? 1280,height:defaultEnv?.viewport?.height ?? 800})},
    baseURL: process.env.BASE_URL || ${JSON.stringify(defaultEnv?.baseUrl || project.targetUrl)},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
${headersBlock}  },
${projects}
});
`;

  files["tests/ai.ts"] = `import { test as base } from '@playwright/test';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { executorConnectionFromEnv } from './model/connections-env.js';
import { openRoleProxy } from './model/role-proxy.js';
import { midsceneModelConfig } from './model/midscene.js';
import { writeFile } from 'node:fs/promises';
type Fixtures={midsceneAgent:PlaywrightAgent;aiAction:(text:string)=>Promise<unknown>;aiAssert:(text:string)=>Promise<unknown>;judgeAgent:{aiQuery:(demand:Record<string,string>,opt?:Record<string,unknown>)=>Promise<unknown>}};
export const test=base.extend<Fixtures>({
 midsceneAgent:async({page},use,testInfo)=>{
  const connection=executorConnectionFromEnv();
  const proxy=await openRoleProxy(connection,undefined,{maxCalls:Number(process.env.TP_EXECUTOR_MAX_CALLS??100),deadlineAt:Date.now()+Number(process.env.TP_EXECUTOR_WALL_MS??120000)});
  const agent=new PlaywrightAgent(page,{modelConfig:midsceneModelConfig(proxy.connection),cache:{id:testInfo.testId,strategy:'write-only'}});
  try{await use(agent);}finally{try{await agent.destroy();}finally{await proxy.close();const path=testInfo.outputPath('executor-requests.json');await writeFile(path,JSON.stringify(proxy.records,null,2));await testInfo.attach('executor-requests',{path,contentType:'application/json'});}}
 },
 aiAction:async({midsceneAgent},use)=>use(text=>text.startsWith('waitFor:')?midsceneAgent.aiWaitFor(text.slice(8).trim()):midsceneAgent.aiAction(text)),
 aiAssert:async({midsceneAgent},use)=>use(text=>midsceneAgent.aiAssert(text)),
 judgeAgent:async({midsceneAgent},use)=>use({aiQuery:(demand,opt)=>midsceneAgent.aiQuery(demand,opt as never)}),
});
export {expect} from '@playwright/test';
`;

  /**
   * 判据的机器判定，原样搬进导出的工程。
   *
   * 在这个文件出现之前，导出只会写 `aiAssert(expected)`——**平台内刚兑现的 tier1/tier2
   * 一导出就全变回让模型看截图**，而那正是 tier 这个标签好不容易才摆脱的状态。
   * 语义与 `harness-testing/exec/oracle.ts` 保持一致：文本按可见正文的包含判定，
   * 次数按字面量出现次数，delta 需要动作前后各读一次。
   */
  Object.assign(files, exportOracleFiles());

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
  /**
   * 先把每条用例的**入口导航**从步骤里提出来，再做三层抽取。
   *
   * 顺序不能反：抽取层认的是步骤原文，导航留在里面就会被当成「19 条用例共用的动作」
   * 抽进 `tests/actions`（实测确实发生了）。而且 spec 体里本来就有 `page.goto`——
   * 留着它等于每条用例导航两次，第二次还交给视觉模型。见 `liftEntryNavigation` 的注释。
   */
  const entryOf = new Map<string, string>();
  const normalized = cases.map((tc) => {
    const { url, rest } = tc.assertions?.length ? {url:defaultEnv?.baseUrl || project.targetUrl,rest:tc.steps} : liftEntryNavigation(tc.steps, defaultEnv?.baseUrl || project.targetUrl);
    entryOf.set(tc.id, url);
    // 按**引用**比，不按长度比：`打开 X 并等待 Y` 会留下一步 `等待 Y`，长度一样但内容变了。
    // `liftEntryNavigation` 在不匹配时原样返回同一个数组，所以引用相等就是「没动过」。
    return rest === tc.steps ? tc : { ...tc, steps: rest as TestCase["steps"] };
  });
  const layers = buildLayers(normalized, opts.sticky);
  opts.onLayers?.({ actions: layers.actions.map((a) => a.text), flows: layers.flows.map((f) => flowKey(f.steps)) });
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
  for (const tc of normalized) {
    /**
     * **路径由不会变的东西决定，会变的东西放进文件里。**
     *
     * 两处 2026-09-14 实测出来的毛病：
     *
     * ① 分目录塌了：242 条用例**全部**落在 `tests/_`。分组看的是 `activity`，
     *    而工作流产出的用例 242 条里 0 条有 `activity`、242 条有 `storyId`。
     *    改成先 activity 后 storyId：一条用户故事一个目录，
     *    「用例与用户故事对齐」这件事在文件树上就看得见。
     *
     * ② 文件名里有优先级（`p0-…`）。优先级是**会变的属性**，把它写进路径意味着
     *    改一次优先级就是 git 里一删一增，而 diff 里看不出改的是什么。
     *    标题同理——但标题变了确实是这条用例变了，重命名是诚实的；优先级不是。
     *    优先级进 tag（`--grep @P0` 照样能挑出来），不进路径。
     */
    const group = tc.activity?.trim() ? slug(tc.activity) : tc.storyId?.trim() ? slug(tc.storyId) : "_";
    const dir = `tests/${group}`;
    let name = `${dir}/${slug(tc.title)}.spec.ts`;
    if (taken.has(name)) name = `${dir}/${slug(tc.title)}-${tc.id}.spec.ts`;
    taken.add(name);
    const ds = tc.dataKey ? getDataset(project.id, tc.dataKey) : undefined;
    if (ds?.rows.length) files[`tests/data/${ds.name}.json`] = JSON.stringify(ds.rows, null, 2) + "\n";
    files[name] = specForCase(tc, entryOf.get(tc.id) ?? defaultEnv?.baseUrl ?? project.targetUrl, "../", layers, ds);
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
        with: { node-version: 22 }
      - run: npm install
      - run: npx playwright install --with-deps chromium
      - run: npm test
        env:
          TP_APPROVED_EXPORT_SHA256: \${{ vars.TP_APPROVED_EXPORT_SHA256 }}
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

## 这份工程里有两种文件

一份会被反复重新导出的测试工程，必须先说清楚**每个文件归谁**。否则第二次导出就会
悄悄吃掉你在配置里加的东西，而你不会收到任何提示。

| | 是什么 | 下次导出 | 你该怎么办 |
|---|---|---|---|
| **生成物**（文件头写着「由 TestPilot 生成」） | 每条用例的 \`tests/**/*.spec.ts\`、抽出来的 \`tests/actions\`、\`tests/flows\`、\`tests/data\`、\`testpilot-manifest.json\` | **原样覆盖** | 别在这里改。它们是用例的投影——**改用例**，再导一次 |
| **脚手架**（文件头写着「只在缺失时创建」） | \`playwright.config.ts\`、\`tests/ai.ts\`、\`tests/oracle.ts\`、\`tests/auth.setup.ts\`、\`package.json\`、CI、\`.env.example\`、这份 README | **不覆盖**（缺了才补一份能跑的默认值） | 随便改。加 reporter、调 timeout、换 CI runner，都是这份工程自己的事 |

机器可读的那份划分在 \`testpilot-manifest.json\` 的 \`ownership\` 里。

一句话：**可变的是用例，不可变的是跑用例的那套东西**；反过来做，两边都会痛。

## 目录怎么分

\`tests/<用户故事>/<用例标题>.spec.ts\`——**一条用户故事一个目录**。
路径只由不会变的东西组成：优先级、层级、类别都在 tag 里（\`--grep @P0\`、
\`--grep @story:S-MB-01\`、\`--grep @tier1\`），不进文件名——它们会变，
而一个会变的属性写进路径，意味着改一次就是版本库里一删一增。

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

## Approval and integrity
The manifest freezes every generated source file and the original case/oracle. Local verification checks consistency. CI additionally requires TP_APPROVED_EXPORT_SHA256 from a reviewer-controlled variable. Keep that variable and the required CI workflow outside candidate write authority; a repository writer who can replace both the verifier and approval value can bypass a local file check.
API observation failures are ORACLE_UNOBSERVABLE, never product failures. Required cleanup failures are ENV_TEARDOWN_FAILED. Exported runs start without reading an old Midscene cache.

## Cases
${cases.map((c) => `- **${c.priority}** \`${c.type}\` ${c.title}`).join("\n")}
`;

  /*
   * manifest 里要带**回得去的线索**。
   *
   * 原来只有 id / 标题 / 步骤 / 判据：交出去的工程里一条测试红了，拿着它回不到产生它的
   * 那次运行、那份材料、那次批准——而这正是「失败证据可追溯」要的东西。板上的 id 只在
   * 我们自己的库里有意义，客户手里那份 zip 里它是个孤立字符串。
   *
   * 只加**指针**，不加内容：run 与 story 的 id，不把材料或审批记录塞进导出。
   */
  sealExport(files, cases.map(c => ({id:c.id,priority:c.priority,title:c.title,steps:c.steps,postSteps:c.postSteps,expected:c.expected,oracle:c.oracle??null,assertions:c.assertions??[],
    ...(c.sourceRunId?{sourceRunId:c.sourceRunId}:{}),...(c.storyId?{storyId:c.storyId}:{})})));
  /**
   * 最后一步：给每个文件盖上归属标注，并把这份划分写进清单。
   *
   * 在 `sealExport` 之后盖，再按最终字节重算哈希，确保标注本身也进校验，
   * 而标注恰恰是这份工程最容易被人删掉的一行。
   * 清单里同时留一份机器可读的 `ownership`——将来做「导出到已有目录」时，
   * 要覆盖哪些、要跳过哪些，不该再靠路径猜一遍。
   */
  const ownership: Record<FileOwner, string[]> = { generated: [], scaffold: [] };
  for (const path of Object.keys(files)) ownership[fileOwner(path)].push(path);
  for (const k of Object.keys(ownership) as FileOwner[]) ownership[k].sort();
  if (files["testpilot-manifest.json"]) {
    const m = JSON.parse(files["testpilot-manifest.json"]) as Record<string, unknown>;
    files["testpilot-manifest.json"] = JSON.stringify({ ...m, ownership }, null, 2) + "\n";
  }
  for (const path of Object.keys(files)) {
    const banner = ownerBanner(path);
    if (banner && !files[path]!.startsWith(banner)) files[path] = banner + files[path]!;
  }
  const manifest = JSON.parse(files["testpilot-manifest.json"]!);
  manifest.files = Object.fromEntries(Object.entries(files).filter(([p]) => p !== "testpilot-manifest.json").sort(([a],[b]) => a.localeCompare(b)).map(([p, text]) => [p, exportHash(text)]));
  files["testpilot-manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
  return files;
}
