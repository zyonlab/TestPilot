#!/usr/bin/env node
/**
 * 一个 OpenAI 兼容端点到底能不能用，以及**能不能看图**。
 *
 * 为什么值得一个脚本：这个项目被端点坑过两次，两次都不是「连不上」这种一眼能看出来的
 * 故障。一次是 `qwen3.8-27b:free` 在一次 216 条执行的运行中途从目录里消失，9/18 轮变异
 * 拿到 404，而代码把它们记成了「用例没抓到」；一次是 `deepseek-v4-flash` 文本请求好好的，
 * 一发图片就 400——而 Midscene 只在缓存未命中时才发图，于是「跑了两小时才发现它不能看图」。
 *
 * 所以这里问三个问题，且**分开问**：
 *   ① 端点活着吗（GET /models）
 *   ② 文本能不能跑（一次最小的 chat.completions）
 *   ③ **图片能不能跑**，而且模型是不是真的看了——不是「没报错」就算通过
 *
 * ③ 的判据是：给一张只有一种颜色的图，问它是什么颜色。一个不看图、靠先验瞎猜的模型
 * 答不对随机指定的颜色。用现成的截图问「你看到什么字」也行，但那考的是 OCR，
 * 而且答案对不对要人来判——这里要的是一个能自动判、判错不了的信号。
 *
 * 用法：
 *   node scripts/probe-endpoint.mjs                       # 默认试题目里那个免费端点
 *   node scripts/probe-endpoint.mjs --base <url> --model <name> --key <key>
 *   node scripts/probe-endpoint.mjs --image path/to.png   # 换成一张真截图（改判 OCR，人工看结果）
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = arg("base", "https://free.empero.org/v1").replace(/\/$/, "");
const MODEL = arg("model", "Qwen/Qwen3.8-27B-FP8");
const KEY = arg("key", "free");
const IMAGE = arg("image", "");
const TIMEOUT_MS = Number(arg("timeout", "60000"));

/** 随机挑一种颜色，模型猜不中。红/绿/蓝三选一，判词各自互斥。 */
const COLORS = [
  { name: "red", rgb: [220, 30, 30], words: ["red", "红"] },
  { name: "green", rgb: [30, 180, 60], words: ["green", "绿"] },
  { name: "blue", rgb: [30, 60, 220], words: ["blue", "蓝"] },
];
const pick = COLORS[Math.floor(Math.random() * COLORS.length)];

function solidPng([r, g, b], size = 96) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function call(path, init = {}) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* 端点可能返回 HTML 错误页——那本身就是有用的信息，原样留在 text 里 */
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - started, text, json };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, text: String(e), error: e };
  } finally {
    clearTimeout(timer);
  }
}

const line = (label, verdict, detail) =>
  console.log(`${verdict.padEnd(4)} ${label.padEnd(22)} ${detail}`);

const contentOf = (j) => j?.choices?.[0]?.message?.content ?? "";

console.log(`base   ${BASE}\nmodel  ${MODEL}\n`);

/* ---- ① 活着吗 ---- */
const models = await call("/models", { method: "GET" });
if (!models.ok) {
  const msg = models.json?.error?.message ?? models.text.slice(0, 160);
  line("① 端点", "✗", `HTTP ${models.status} · ${msg}`);
  // 服务端明说在维护时不必往下试：后面两项必然同样失败，跑完只是把同一句话说三遍。
  if (models.status === 503 || /maintenance/i.test(models.text)) {
    console.log("\n端点自己说它在维护。稍后重跑这个脚本即可，判据没有变。");
    process.exit(2);
  }
} else {
  const ids = (models.json?.data ?? []).map((m) => m.id);
  const has = ids.includes(MODEL);
  line("① 端点", "✓", `${ids.length} 个模型 · ${models.ms}ms`);
  line("  目录里有这个模型", has ? "✓" : "✗", has ? MODEL : `目录里没有 ${MODEL}；有的是 ${ids.slice(0, 6).join(", ")}`);
  // 目录里没有不等于不能用，但**中途消失**是这个项目被坑过的那种故障，
  // 所以把目录也记一笔：跑长任务之前值得对一眼。
}

/* ---- ② 文本 ---- */
const text = await call("/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: ok" }],
    max_tokens: 16,
    stream: false,
    // 本地/自建的 Qwen 常常默认开思考模式，一开就是几秒起步且可能被 max_tokens 截断。
    // 这个字段不认识的端点会忽略它，认识的会关掉——两边都不会因此报错。
    enable_thinking: false,
  }),
});
if (!text.ok) {
  line("② 文本", "✗", `HTTP ${text.status} · ${(text.json?.error?.message ?? text.text).slice(0, 200)}`);
} else {
  const c = contentOf(text.json).trim();
  line("② 文本", "✓", `${text.ms}ms · 回复 ${JSON.stringify(c.slice(0, 60))}`);
}

/* ---- ③ 图片 ---- */
const buf = IMAGE ? readFileSync(IMAGE) : solidPng(pick.rgb);
const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
const question = IMAGE
  ? "What text do you see in this screenshot? Answer with the words only."
  : "What is the single colour of this image? Answer with one word.";

const vision = await call("/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
    enable_thinking: false,
  }),
});

if (!vision.ok) {
  const msg = (vision.json?.error?.message ?? vision.text).slice(0, 240);
  /**
   * **把「不能看图」和「今天不让我跑」分开。**
   *
   * 一次 429（额度用完）或 401（key 不对）说明不了模型能不能看图，而这两种失败长得
   * 和真的不收图片一模一样：都是「图片那一发挂了」。混为一谈的代价很实在——
   * 会有人因为一次配额错误就把一个能看图的模型划掉。
   *
   * 只有当文本那一发过了、图片这一发没过，或者错误本身点名了 image/vision/multimodal，
   * 才敢说是「不收图片」。
   */
  const aboutImage =
    /image|vision|multimodal|modality|不支持图片/i.test(msg) ||
    (text.ok && [400, 415, 422, 500].includes(vision.status));
  line("③ 图片", "✗", `HTTP ${vision.status} · ${msg}${aboutImage ? "" : "（这不是图片的问题）"}`);
  if (aboutImage)
    console.log(
      "\n不收图片的端点在这条流水线上只能干半件事：Midscene 只在**缓存未命中**时才发图，\n" +
        "所以一个不能看图的模型可以顺利跑完整批缓存命中的重放，然后在第一次真的要看屏幕时挂掉。",
    );
  else if (!text.ok)
    console.log("\n文本那一发也没过，所以这一条什么都证明不了——先把上面那个错误解决掉再看图片。");
} else {
  const answer = contentOf(vision.json).trim();
  if (IMAGE) {
    line("③ 图片", "?", `${vision.ms}ms · 回复 ${JSON.stringify(answer.slice(0, 80))}（用了真截图，对不对要人看）`);
  } else {
    const right = pick.words.some((w) => answer.toLowerCase().includes(w));
    const wrongOne = COLORS.find((c) => c !== pick && c.words.some((w) => answer.toLowerCase().includes(w)));
    line(
      "③ 图片",
      right ? "✓" : "✗",
      right
        ? `${vision.ms}ms · 认出了 ${pick.name}（随机指定，猜不中）`
        : `${vision.ms}ms · 图是 ${pick.name}，它说 ${JSON.stringify(answer.slice(0, 40))}` +
            (wrongOne ? " —— 收下了图片但没真看" : " —— 收下了图片，答非所问"),
    );
  }
}
