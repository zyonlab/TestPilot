/**
 * 拿环境里存着的登录态，用 harness 自己的浏览器打开被测地址，报它落在哪里。
 *
 * 存在的理由：一次「探索跑偏了」有两种完全不同的原因——会话没带上，
 * 或者带上了但对面不认（指纹、WAF、token 绑定）。两者的修法相反，
 * 而从探索结果上看它们长得一模一样：都是"落到了登录页"。
 *
 * **不打印任何 cookie 值。** 只报名字、条数、落点。
 */
import puppeteer from "puppeteer";

const envId = process.argv[2];
const base = process.env.TP_API ?? "http://127.0.0.1:5301";
if (!envId) {
  console.error("用法：node server/scripts/probe-session.mjs <envId>");
  process.exit(1);
}

// 网关不回传明文会话（sanitizeEnv 会抹掉），所以直接读库那一侧的解密结果。
const { getEnvironment } = await import("../src/db.js");
const env = getEnvironment(envId);
if (!env) { console.error("没有这个环境:", envId); process.exit(1); }
const st = env.login?.session;
if (!st?.cookies?.length) { console.error("这个环境没有存登录态"); process.exit(1); }

const url = env.baseUrl;
console.log(`环境  ${env.name}`);
console.log(`地址  ${url}`);
console.log(`会话  ${st.cookies.length} 个 cookie · ${st.origins?.[0]?.localStorage?.length ?? 0} 个 localStorage 键`);
console.log(`      httpOnly 标记为 true 的：${st.cookies.filter((c) => c.httpOnly).length} 个`);
console.log("");

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setUserAgent(
  process.env.TP_UA ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
);
await page.setViewport({ width: 1440, height: 900 });

const clean = st.cookies.map((c) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
  secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
  ...(c.expires ? { expires: c.expires } : {}),
}));
await page.setCookie(...clean);

const waf = [];
page.on("response", (r) => {
  const a = r.headers()["x-amzn-waf-action"];
  if (a) waf.push(`${a} @ ${r.url().slice(0, 70)}`);
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
// localStorage 要在同源之后才能写，写完重导航一次（和 applyPostNav 同一套做法）
const ls = st.origins?.[0]?.localStorage ?? [];
if (ls.length) {
  await page.evaluate((items) => { for (const it of items) { try { localStorage.setItem(it.name, it.value); } catch {} } }, ls);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
}
// 等它自己安定（和 settleOn 同一套判据：连续两次不再长）
{
  const began = Date.now();
  const cap = Number(process.env.TP_SETTLE_MS ?? 30000);
  let last = { n: -1, len: -1 }, steady = 0;
  while (Date.now() - began < cap) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await page.evaluate(() => ({
      n: [...document.querySelectorAll("button,a,input,select,textarea,[role=button]")].filter((el) => el.offsetParent !== null).length,
      len: (document.body?.innerText ?? "").length,
    }));
    if (now.n <= last.n && now.len <= last.len) steady++; else steady = 0;
    last = now;
    if (steady >= 2 && (last.n > 0 || last.len > 0)) break;
  }
  console.log(`安定  用了 ${Math.round((Date.now() - began) / 1000)} 秒 · ${last.n} 个控件 · ${last.len} 字`);
}

const seen = await page.evaluate(() => ({
  url: location.href,
  title: document.title.slice(0, 70),
  textLen: (document.body?.innerText ?? "").length,
  controls: [...document.querySelectorAll("button,a,input,select,textarea,[role=button]")]
    .filter((el) => el.offsetParent !== null).length,
  tradingUI: /Buy\/Long|Sell\/Short|Avbl/.test(document.body?.innerText ?? ""),
  loginUI: /Log ?in|Email\/Phone/i.test(document.body?.innerText ?? ""),
  head: (document.body?.innerText ?? "").slice(0, 700),
  // offsetParent 对 position:fixed 的元素返回 null——用它判"看得见"会把整块固定面板漏掉。
  buttonsOffsetParent: [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null).length,
  buttonsRect: [...document.querySelectorAll("button")].filter((b) => {
    const r = b.getBoundingClientRect();
    const s = getComputedStyle(b);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  }).map((b) => b.innerText.trim()).filter(Boolean).slice(0, 20),
}));

console.log(`落点  ${seen.url}`);
console.log(`标题  ${seen.title}`);
console.log(`页面  ${seen.controls} 个可见控件 · ${seen.textLen} 字`);
console.log("");
console.log(seen.tradingUI ? "✓ 会话生效——看到了交易界面（Buy/Long · Avbl）" : "✗ 没看到交易界面");
if (seen.loginUI) console.log("✗ 落在登录界面上");
console.log("\n--- 页面文本 ---\n" + seen.head);
console.log(`\n--- 可见按钮 ---\noffsetParent 判据：${seen.buttonsOffsetParent} 个\ngetBoundingClientRect 判据：${seen.buttonsRect.length} 个\n` + JSON.stringify(seen.buttonsRect, null, 1));
if (waf.length) console.log("WAF  " + waf.slice(0, 3).join("\n     "));
else console.log("WAF  这一趟没有 x-amzn-waf-action 响应头");

const shot = process.env.TP_SHOT;
if (shot) { await page.screenshot({ path: shot, fullPage: false }); console.log(`\n截图  ${shot}`); }
await browser.close();
