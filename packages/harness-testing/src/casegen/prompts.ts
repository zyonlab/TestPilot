/**
 * Prompts, split the way the model client demands: `stable` never changes within a node
 * type and goes first (that is the half the endpoint's prefix cache can reuse), the
 * material goes last.
 *
 * They are plain strings rather than templates with holes in the middle for the same
 * reason: interpolating into the middle of the stable half would break the prefix for
 * every later call.
 */

export const STORIES_STABLE = [
  "You extract user stories from a product specification.",
  "",
  "Rules:",
  "- One story per distinct user-visible capability. Do not invent capabilities the spec does not describe.",
  "- Keep the spec's own ids when it has them (US-01 and so on); otherwise number them S-01, S-02, ...",
  "- `acceptance` must quote the spec's acceptance criteria, one entry per criterion, in the spec's own words.",
  "- If the spec lists things that are explicitly out of scope, produce no story for them.",
  "- The material may be SEVERAL documents, each starting with a `===== path =====` line.",
  "  Cover every one of them. Documents describe the same product at different levels (what",
  "  it does, how it behaves on screen); stopping after the first leaves half the product",
  "  untested. Set `source` to the path the story came from.",
  "- When the budget of stories is smaller than the material, spread it across the documents",
  "  rather than exhausting it on the first.",
  "",
  'Return JSON only: {"stories":[{"id":"US-01","title":"...","acceptance":["..."],"requirementId":"US-01","source":"docs/a.md"}]}',
].join("\n");

export const CASES_STABLE = [
  "You are a senior test designer. Given ONE user story and the specification it came from,",
  "design the text-level test cases for that story.",
  "",
  "Apply test design methods explicitly, and say which one each case uses:",
  '- "equivalence": one representative per valid/invalid input class',
  '- "boundary": empty, minimum, maximum, just-over-the-limit',
  '- "state-transition": a state change and what must hold after it',
  '- "decision-table": a combination of conditions',
  '- "negative": an error path — the product must refuse, and say so',
  "",
  "Rules that decide whether a case is worth anything:",
  "- `expected` is ONE concrete, checkable outcome. Name the observable thing: a literal",
  "  message, a number, a state. Never 'works correctly', 'behaves normally', 'is fine'.",
  "- Quote interface text EXACTLY as the specification writes it. Do not translate it and",
  "  do not invent wording the spec never promised.",
  "- `tier` says how hard the verdict is: 1 = a program can settle it (literal text, a",
  "  number), 2 = a relation between two observations, 3 = a model has to judge a screen.",
  "  Prefer 1. Use 3 only when nothing else can decide it.",
  "- For tier 1 and tier 2 you MUST also give `oracle`, the same outcome in a form a program",
  "  can check without looking at a picture. One of:",
  '    {"kind":"text","value":"<a literal the page shows>"}',
  '    {"kind":"noText","value":"<a literal the page must NOT show>"}',
  '    {"kind":"url","value":"<part of the address>"}',
  '    {"kind":"count","value":"<a literal>","op":"eq|gte|lte","n":<number>}',
  '    {"kind":"delta","value":"<the label a number sits beside>","direction":"increased|decreased|unchanged","by":<number, optional>}   ← this one is tier 2',
  "  Quote the literal EXACTLY as the specification writes it. If the outcome cannot be put",
  "  in any of these forms, then it is tier 3 — say so and leave `oracle` out. Claiming",
  "  tier 1 without an oracle is the one thing that makes the label worthless.",
  "- Steps are short, concrete, end-agnostic actions. No selectors, no page objects, no code.",
  "- Never put credentials in a step. Use ${env.NAME} and ${secret.NAME} placeholders.",
  "- `key` is a dedupe triple 'transition|parameters|assertion', lowercase, no spaces.",
  "- A suite that is all happy path is a bad suite. Cover the refusals the story implies.",
  "- Design at most the number of cases stated as CASE BUDGET in the material. Beyond that",
  "  you are splitting hairs, and the reply gets truncated — a truncated reply loses the",
  "  whole story's work.",
  "",
  'Return JSON only: {"cases":[{"title":"...","designMethod":"equivalence","precondition":["..."],',
  '"steps":["..."],"expected":"...","tier":1,"key":"login|valid-credentials|dashboard-shown"}]}',
].join("\n");

/**
 * The same job with the design-method instructions removed — the baseline arm of the
 * ablation. It still asks for good assertions, because otherwise the comparison would be
 * measuring two changes at once.
 */
export const CASES_STABLE_PLAIN = [
  "You are a senior test designer. Given ONE user story and the specification it came from,",
  "design the text-level test cases for that story.",
  "",
  "Rules that decide whether a case is worth anything:",
  "- `expected` is ONE concrete, checkable outcome. Name the observable thing: a literal",
  "  message, a number, a state. Never 'works correctly', 'behaves normally', 'is fine'.",
  "- Quote interface text EXACTLY as the specification writes it.",
  "- `tier` says how hard the verdict is: 1 = a program can settle it, 2 = a relation,",
  "  3 = a model has to judge a screen.",
  "- Steps are short, concrete, end-agnostic actions. No selectors, no code.",
  "- Never put credentials in a step. Use ${env.NAME} and ${secret.NAME} placeholders.",
  "- `key` is a dedupe triple 'transition|parameters|assertion', lowercase, no spaces.",
  "- `designMethod` must still be one of: equivalence, boundary, state-transition,",
  "  decision-table, negative — say which one each case happens to be.",
  "- Design at most the number of cases stated as CASE BUDGET in the material.",
  "",
  'Return JSON only: {"cases":[{"title":"...","designMethod":"equivalence","precondition":["..."],',
  '"steps":["..."],"expected":"...","tier":1,"key":"login|valid-credentials|dashboard-shown"}]}',
].join("\n");

/**
 * A stricter definition of what an assertion has to name.
 *
 * Selectable rather than edited in place, because it exists to be compared: the critic
 * reads 77 `oracle-vague` findings and proposes tightening this, and a proposal that can
 * only be adopted by editing source is a proposal nobody can weigh. As a parameter it is
 * one arm of a paired evaluation.
 *
 * It goes in the STABLE half — it is the same for every case in a run, so the prefix cache
 * still hits; what differs is which of two stable prefixes a run uses.
 */
export const ORACLE_STRICT = [
  "",
  "WHAT COUNTS AS AN OBSERVABLE PHENOMENON (this decides whether `expected` is usable):",
  "- A literal string the interface shows, quoted exactly: 页面显示「用户名不能为空」",
  "- A count or a number: 列表少一行；余额为 0；耗时字段显示 0ms",
  "- A named element's presence or absence: 「删除」按钮消失；进程行出现 anvil-local",
  "- A location: 仍停留在登录页；跳转到 /review",
  "These do NOT count, however specific they sound:",
  '- "弹出确认对话框，提示用户确认删除" — names no text, no element, no number',
  '- "配置保存成功并正确回显" — "正确" is the reader\'s judgement, not the product\'s output',
  '- "页面正常展示各项指标" — a description of a screen, not a claim that can fail',
  "Rewrite any assertion of the second kind into one of the first before returning it.",
].join("\n");

/**
 * Language: the artifact is read and maintained by the same people who wrote the spec, so
 * it must come back in the spec's language. Left to itself the model answered a Chinese
 * specification in English, which also made every downstream keyword measurement wrong.
 */
export function languageDirective(lang?: string): string {
  const name = lang === "en" ? "English" : lang === "ja" ? "Japanese" : lang === "zh" ? "Simplified Chinese" : undefined;
  if (!name)
    return [
      "",
      "LANGUAGE: write titles, steps and expected outcomes in the SAME language as the",
      "specification above. Quote interface text exactly as the specification writes it,",
      "in its original language, even when that differs from the language you are writing in.",
    ].join("\n");
  return [
    "",
    `LANGUAGE: write titles, steps and expected outcomes in ${name}.`,
    "Quote interface text exactly as the specification writes it, in its original language.",
  ].join("\n");
}

export function storiesVariable(specText: string, lang?: string): string {
  return ["SPECIFICATION:", "", specText, languageDirective(lang)].join("\n");
}

export function casesVariable(
  specText: string,
  story: { id: string; title: string; acceptance: string[] },
  lang?: string,
  /**
   * How many cases this story may have.
   *
   * In the variable half, not the stable one: it is a knob the harness turns between runs,
   * and a number baked into the stable prefix would cost the prefix cache on every call.
   * It used to live nowhere at all — the parameter called `maxCasesPerStory` only trimmed
   * the reply after the fact, so raising it produced exactly as many cases as before and a
   * comparison of the two settings measured nothing.
   */
  maxCases?: number,
): string {
  return [
    "SPECIFICATION (for context — design cases for the STORY below only):",
    "",
    specText,
    "",
    `STORY ${story.id}: ${story.title}`,
    "ACCEPTANCE CRITERIA:",
    ...story.acceptance.map((a, i) => `${i + 1}. ${a}`),
    ...(maxCases ? ["", `CASE BUDGET: at most ${maxCases} cases for this story.`] : []),
    languageDirective(lang),
  ].join("\n");
}

/** JSON Schema for guided decoding: same shape the parser expects, sent to the endpoint. */
export const STORIES_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
          requirementId: { type: "string" },
          // Guided decoding constrains the reply to this schema, so a field the prompt asks
          // for and the schema omits is a field the model is not allowed to produce.
          source: { type: "string" },
        },
        required: ["id", "title"],
      },
    },
  },
  required: ["stories"],
} as const;

export const CASES_SCHEMA = {
  type: "object",
  properties: {
    cases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          designMethod: {
            type: "string",
            enum: ["equivalence", "boundary", "state-transition", "decision-table", "negative"],
          },
          precondition: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: { type: "string" } },
          expected: { type: "string" },
          tier: { type: "integer", enum: [1, 2, 3] },
          // Guided decoding constrains the reply to this schema, so an oracle the prompt
          // asks for and the schema omits is an oracle the model cannot produce.
          oracle: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["text", "noText", "url", "count", "delta"] },
              value: { type: "string" },
              op: { type: "string", enum: ["eq", "gte", "lte"] },
              n: { type: "integer" },
              direction: { type: "string", enum: ["increased", "decreased", "unchanged"] },
              by: { type: "integer" },
            },
            required: ["kind", "value"],
          },
          key: { type: "string" },
        },
        required: ["title", "designMethod", "steps", "expected", "tier", "key"],
      },
    },
  },
  required: ["cases"],
} as const;

/**
 * 把材料整理成标准规格。
 *
 * 整理的对立面是创作。用户给的文档可能缺章少节、可能自相矛盾、可能有一半是背景故事；
 * 观察记录则根本不是规格。整理者要做的是**归并与结构化**，不是补全——
 * 材料没说的，归到「没有答案的地方」，而不是凭常识写一条看起来很合理的规则。
 *
 * 这一步是整个下游的地基：故事从规则来，用例从故事来，断言引用的界面文案要能查回材料。
 * 这里编一句，后面每一层都会把它当成事实。
 */
export const COMPOSE_STABLE = [
  "You organise raw material into a specification. You do not write the specification's",
  "content — you organise what is already there.",
  "",
  "Output JSON: { title, summary, flows: [{ id, name, purpose }],",
  "  rules: [{ id, text, evidence, altitude, about }], unknowns: [string] }",
  "",
  "A specification has ALTITUDES. A document that states only what is on each screen is a",
  "screen inventory, not a specification — everything derived from it can only ever check",
  "that the screens still look the same.",
  "",
  "- `flows`: the material may come with paths already computed from the product's",
  "  transition graph, listed under 「算出来的流程」. Those paths are FACTS — do not invent,",
  "  merge or drop them. Your job is the part a graph cannot show: give each one a `name` a",
  "  user would recognise and a `purpose` saying what it accomplishes for them. Keep the",
  "  given ids. If the material lists no such paths, return an empty array — never make",
  "  flows up from screen descriptions.",
  "- `rules` is the substance: one checkable statement each, in the material's own terms.",
  "  `id` is R-1, R-2, … `evidence` MUST be a phrase copied verbatim from the material.",
  "  A rule you cannot quote for is a rule you invented — leave it out.",
  "- Every rule states its `altitude`:",
  '    "screen" — what one screen shows or contains',
  '    "flow"   — what happens when the user moves: an action and its consequence',
  '    "domain" — a statement that holds regardless of screen: a calculation, a policy,',
  "               a constraint between values",
  "  and its `about`: the screen/route or the flow id it constrains.",
  "- A specification made only of `screen` rules is a weak one. Look at the transitions in",
  "  the material: each one that changed something is a `flow` rule waiting to be written",
  "  (\"clicking X on screen A leads to B\", \"after doing X the button reads Y\").",
  "  But still: only what the material shows. Do not promote a guess to a flow rule.",
  "- Quote interface text exactly as the material writes it. Downstream assertions are",
  "  checked against these strings, so an approximation becomes a false failure later.",
  "- `unknowns`: what the material does not settle — a screen it never describes, a rule it",
  "  contradicts itself on, a flow it mentions without saying what happens. This is not",
  "  optional and an empty list is a strong claim. A specification that omits its own blind",
  "  spots reads as complete, and everything derived from it inherits that claim.",
  "- Never resolve a contradiction by choosing: record both, and put it in `unknowns`.",
  "- Never add a rule because it is normal for this kind of product.",
].join("\n");

export const composeVariable = (
  material: string,
  origin: string,
  derivedFrom: string,
  lang?: string,
): string =>
  [
    lang ? `Write in ${lang}.` : "",
    // 材料是怎么来的，整理者必须知道：观察记录写的是现状，把它整理成"应该如此"是越权。
    derivedFrom === "exploration"
      ? "This material is OBSERVATION of a running product. It records what the product does, not what it should do. Write rules as statements of current behaviour; never phrase one as a requirement."
      : derivedFrom === "codebase"
        ? "This material was derived from source code. It records what is implemented, not what was intended."
        : "This material is documentation written by people. It records intent.",
    `ORIGIN: ${origin}`,
    "",
    "MATERIAL:",
    material,
  ]
    .filter(Boolean)
    .join("\n");

/** Guided decoding for the compose step: a field the schema omits is one the model cannot produce. */
export const COMPOSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    // Guided decoding constrains the reply to this schema, so a field the prompt asks for
    // and the schema omits is a field the model is not allowed to produce. 分层要落地，
    // 就得在这里有位置——把要求写进提示词而不写进 schema，等于没有要求。
    flows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          purpose: { type: "string" },
        },
        required: ["id", "name"],
      },
    },
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          evidence: { type: "string" },
          altitude: { type: "string", enum: ["screen", "flow", "domain"] },
          about: { type: "string" },
        },
        required: ["id", "text", "evidence"],
      },
    },
    unknowns: { type: "array", items: { type: "string" } },
  },
  required: ["rules", "unknowns"],
} as const;
