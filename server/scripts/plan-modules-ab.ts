/**
 * 产品模块规划 + 用户故事的机器臂。
 *
 * 当前这条链路上**没有模块规划节点**：`buildProductModel` 里 `modules: pack.modules`，
 * 模块树是人手写在规则包里的，模型一个字都没参与（docs/v3/23 §20）。所以这一臂不是
 * 「跑现有节点」，而是**跑这个节点如果存在会长什么样**：同一份领域知识 + 同一份界面观察，
 * 让规划模型给出模块树与用户故事。我这一臂吃同样两份材料，唯一的差别是谁来规划。
 */
import { config } from "dotenv";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!;
const out = resolve(arg("out") ?? join(root, "docs/v3/evidence/module-plan-2026-09-11"));
mkdirSync(out, { recursive: true });
const maxTokens = Number(arg("maxTokens") ?? 32000);

const { projectModelConnection } = await import("../src/modelProfiles.js");
const conn = projectModelConnection(projectId, "planner");
const domain = readFileSync(join(root, "fixtures/hyperliquid-mainnet/materials/domain-perp-zh.md"), "utf8");
const observed = readFileSync(join(root, "fixtures/hyperliquid-mainnet/materials/observed-zh.md"), "utf8");

async function post(url: string, body: string, headers: Record<string, string>): Promise<string> {
  const { request } = await import("node:https");
  const u = new URL(url);
  return new Promise((ok, fail) => {
    const req = request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    });
    req.setTimeout(30 * 60_000, () => req.destroy(new Error("REQUEST_TIMEOUT")));
    req.on("error", fail);
    req.end(body);
  });
}

const V1 = [
  "你是资深的产品分析师，同时懂加密货币永续合约这门生意。",
  "给你两份材料：一份是永续合约的领域知识，一份是这个交易页的界面观察。",
  "请产出这个页面的**产品模块树**与**用户故事**。",
  "",
  "只回 JSON：{\"modules\":[...],\"stories\":[...]}，不要散文、不要 markdown 围栏。",
  "",
  "modules 每一项：{id, name, parentId|null, purpose, evidence:[材料段 id]}",
  "  • id 用点分小写英文，例如 market.orderbook；层级最多两层。",
  "  • purpose 说这个模块对**用户**意味着什么，不是它在界面的哪个位置。",
  "  • evidence 引用 observed-zh.md#N 或 domain-perp-zh.md#N，每个模块至少一条。",
  "",
  "stories 每一项：{id, title, role, benefit, moduleIds:[...], acceptance:[...], evidence:[...], risk}",
  "  • acceptance 每一条要写清**前置、触发、业务结果**三段，可以被独立核对。",
  "  • risk ∈ funds-and-exposure | authorization | data-integrity | availability | information | cosmetic。",
  "  • 只写这份界面观察支持得住的；领域知识说得通但界面上看不到的，写成 acceptance 里的开放问题并标「【待确认】」。",
  "  • 会变的读数（标记价、资金费率、倒计时、24 小时量）只能断言字段存在或两次读数的关系，不得钉具体数值。",
].join("\n");

/**
 * v2：把上一轮机检抓到的每一处缺陷写进契约（docs/v3/24 §2 与 §7）。
 * 每一条后面括号里是它对应的那个真实缺陷，不是想出来的规矩。
 */
const V2 = [
  ...V1.split("\n"),
  "",
  "════ 以下每一条都对应上一版产出里真实出现过的错，逐条照做 ════",
  "",
  "【层级】父子关系写在 parentId 里，不是写在名字里。id 带点号（market.depth）就**必须**声明 parentId=\"market\"，",
  "  而且 market 本身必须也是一个模块。上一版 7 个模块 7 个都是「id 带点号、parentId 为 null」——交出来的是一张伪装成树的清单。",
  "",
  "【覆盖】材料的**每一段**都要有落点：要么被某个模块或故事的 evidence 引用，要么写进顶层的",
  '  outOfScope:[{sectionId,reason}] 并说清为什么不在范围内。上一版整段漏掉了 observed-zh.md#1（全站导航）',
  "  和 domain-perp-zh.md#13（预测市场是另一套风控模型），于是预测市场整个不见了。说不出交代才叫漏。",
  "",
  "【粗细】树要比故事**粗**：叶子模块平均至少 1.5 条故事。上一版 7 个叶子里 3 个一条故事都没有，",
  "  平均 0.86——叶子和故事 1:1 的树没有在提供结构，只是把故事换了个名字排了一遍。",
  "  没有故事的叶子模块，要么补故事，要么它就不该是一个模块。",
  "",
  "【不许推测】acceptance 里不许出现「可能 / 或许 / 应该会 / 大概 / 视情况」。上一版写过",
  "  「『可用』余额显示逻辑**可能**因模式不同而有所区别（全仓显示总权益）」——而它自己引用的 domain#4 写的是",
  "  未实现盈亏计入权益、通常不计入可用。**引了出处却写出相反的话，比漏写更危险**：复核时最容易被放过。",
  "  不确定就写成【待确认】并说清要确认什么，不要用推测词糊过去。",
  "",
  "【不许断言两个易变读数不相等】上一版写过「标记价与预言机价**两者数值不同**」。它们可以相等",
  "  （偏离为零时资金费率就是零）。易变读数之间只能断言**存在**或**方向关系**，不能断言不等。",
  "",
  "【每条验收各自带出处】acceptance 写成 [{text, evidence:[材料段 id]}]，而不是纯字符串数组。",
  "  故事级的 evidence 说不清是哪一条验收从哪一段推来的，冲突就定位不到。",
  "",
  "【验收条数不是定额】一条验收对应一个可独立核对的结果；一个故事有几个就写几条。",
  "  上一版 6 个故事全部恰好 2 条——那是凑数，不是推导。",
  "",
  "【待确认分两类】标注时写清是哪一种：",
  "  「界面观察不到」= 覆盖缺口，需要实测补上；",
  "  「与领域知识冲突」= **产品缺陷线索**，要单独指出冲突的是哪一段。上一版三条待确认全是前者，它没发现任何冲突。",
  "",
  "【不要照抄界面分区】模块要按**用户要完成的事**切，不是按屏幕区域切。上一版的一层是",
  "  market.header / market.chart / trade.panel——那是屏幕分区。风险口径（保证金模式、杠杆、强平）",
  "  在界面上散落三处，但它是永续区别于现货的全部所在，埋进「下单面板」就消失了。",
  "",
  '顶层结构：{"modules":[...],"stories":[...],"outOfScope":[{"sectionId":"...","reason":"..."}]}',
].join("\n");

/**
 * `--think`：不发 `reasoning_effort: "none"`，让模型自己想。
 *
 * 这个端点上关思考的唯一办法就是显式发 `none`（`packages/harness-core/src/model/openai.ts`
 * 里的注释记着这件事）；不发就是开着。开着之后要看 `usage.completion_tokens_details.reasoning_tokens`
 * 是不是真的大于 0——不看这个数就没法说「思考开了」，只能说「我没关它」。
 */
const think = process.argv.includes("--think");
const version = (arg("contract") ?? "v2") + (think ? "-think" : "");
const CONTRACT = version.startsWith("v1") ? V1 : V2;

const user = [CONTRACT, "", "<domain_knowledge>", domain, "</domain_knowledge>", "", "<observed_ui>", observed, "</observed_ui>"].join("\n");
const t0 = Date.now();
const text = await post(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`,
  JSON.stringify({ model: conn.model, temperature: 0, max_tokens: maxTokens, ...(think ? {} : { reasoning_effort: "none" }),
    messages: [{ role: "system", content: "只回 JSON。" }, { role: "user", content: user }] }),
  { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}` });
const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, number> };
const raw = json.choices?.[0]?.message?.content ?? "";
const m = raw.match(/\{[\s\S]*\}/);
let parsed: { modules?: unknown[]; stories?: unknown[] } = {};
try { parsed = m ? JSON.parse(m[0]) : {}; } catch (e) { parsed = { } ; console.log("parse error", String(e).slice(0, 120)); }
writeFileSync(join(out, `machine-arm-${version}.json`), JSON.stringify({ contract: CONTRACT, model: conn.model, finish: json.choices?.[0]?.finish_reason, usage: json.usage, ms: Date.now() - t0, raw, parsed }, null, 2));
console.log(JSON.stringify({ contract: version, model: conn.model, think, finish: json.choices?.[0]?.finish_reason, ms: Date.now() - t0,
  modules: (parsed.modules ?? []).length, stories: (parsed.stories ?? []).length, usage: json.usage }));
