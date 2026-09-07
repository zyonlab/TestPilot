/**
 * 色板全部走 CSS 变量，值在 `src/index.css`，来源是原型 v3。
 *
 * 每个颜色都写成 `hsl(var(--x) / <alpha-value>)` 而不是 `hsl(var(--x))`——
 * 少了后半截，`bg-primary/12` 这种透明度修饰符会被 Tailwind 静默丢掉。
 * 之前 `bg-accent` 更彻底：它压根没定义过，于是**左导航选中项一直没有底色**，
 * 只剩那道 2px 的竖条。
 */
/** @type {import('tailwindcss').Config} */
const v = (name) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: v("border"),
        input: v("input"),
        ring: v("ring"),
        background: v("background"),
        foreground: v("foreground"),
        /** 次级正文。比 foreground 淡一档，但仍然是拿来读的。 */
        ink2: v("ink2"),
        /** 只在需要时才读的东西：id 前缀、时间戳、行号。 */
        faint: v("faint"),
        primary: {
          DEFAULT: v("primary"),
          foreground: v("primary-foreground"),
          /** 主色的垫底。用法固定：`bg-primary-soft text-primary`。 */
          soft: v("primary-soft"),
        },
        muted: { DEFAULT: v("muted"), foreground: v("muted-foreground") },
        accent: { DEFAULT: v("accent"), foreground: v("accent-foreground") },
        card: { DEFAULT: v("card"), foreground: v("card-foreground") },
        /* 语义四对。它们自己会在暗色下翻面，调用处不需要再写 `dark:` 孪生类。 */
        ok: { DEFAULT: v("ok"), soft: v("ok-soft") },
        warn: { DEFAULT: v("warn"), soft: v("warn-soft") },
        bad: { DEFAULT: v("bad"), soft: v("bad-soft") },
        chat: { DEFAULT: v("chat"), soft: v("chat-soft") },
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "system-ui", "sans-serif"],
        /* 原型只有一个字族，标题靠字重拉开而不是换字。`font-display` 保留是为了
           不用改上百个调用处，但它现在指向同一套字。 */
        display: ["IBM Plex Sans", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "SFMono-Regular", "Menlo", "monospace"],
      },
      /* 原型的圆角比 Tailwind 默认小一圈（5–7px）。整体调一次，
         比把上百处 `rounded-xl` 逐个改掉便宜，效果一样。 */
      borderRadius: { sm: "3px", DEFAULT: "5px", md: "5px", lg: "6px", xl: "7px", "2xl": "9px" },
      boxShadow: { panel: "var(--shadow-panel)" },
    },
  },
  plugins: [],
};
