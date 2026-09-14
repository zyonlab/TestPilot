# 07　System Prompt 的结构化设计

> **状态：这个主题已经有强版本了。**
> 分半（stable / variable）是为前缀缓存分的、输出契约是一份 JSON Schema 而不是提示词里
> 那句 `Return JSON only`、`required` 而不是 `properties`——这三件事都不是本章要引入的，
> 它们已经在代码里，而且每一件都有一次事故垫在下面。
>
> 所以本章的主体是两半：**为什么现在这样是对的**，以及**三处正在漏的接缝**。
> 最后一节有一条反对意见：`required` 买到的是「在场」，不是「内容」——
> 这句话是 `evals/case-cleanup.json` 量出来的，它反对本书 [第 00 章](./00-方法与约定.md)
> 那条推论的强版本。

## 前置

| 依赖 | 是什么 |
|---|---|
| [第 02 章](./02-三条不可动摇的性质.md) | 前缀缓存是否决项。本章每一处改动都要先算字节账 |
| [第 08 章](./08-Prompt是代码.md) | 指纹与快照。本章动了提示词的字节，指纹就该动，而有两个消融臂根本没被指纹覆盖 |
| [第 10 章](./10-上下文压缩.md) | `variable` 那一半怎么被裁。本章只管 `stable` |
| [第 14 章](./14-评测体系.md) | 消融臂是从 `stable` 原文里减出来的，本章的变更一会连锁到减法的端标记 |

代码前置（读之前打开这几处会快很多）：

- `packages/harness-core/src/model/client.ts:13-24` —— `ChatRequest`，四个字段定死了提示词的形状；
- `packages/harness-testing/src/casegen/prompts.ts:58` —— `CASES_STABLE`，全仓库最长、被改得最多的一份；
- `packages/harness-testing/src/casegen/prompts.ts:58` —— `CASES_SCHEMA`，真正的输出契约；
- `packages/harness-testing/test/casegen.test.ts:707` —— 把两者钉在一起的那条测试。

---

## 问题

**不是「没有结构」，是「结构在三个接缝上悄悄失效」。** 三处都已核实：

| # | 接缝 | 现象 | 位置 |
|---|---|---|---|
| ① | 一段话被从中间劈开 | 每次 `design.cases` 调用都发出一个断句 + 一个小写起头的孤儿从句 | `casegen/prompts.ts:121-124` |
| ② | 追加物加在输出契约**之后** | 两臂差的不只是那段文字，还有「格式说明是不是最后一句」 | `casegen/nodes.ts:997`、`casegen/revise.ts:21`、`critic.ts:182` |
| ③ | 同一条纪律有两份实现 | `subtract()` 要求端标记在起标记之后，抄的那份不要求 | `casegen/prompts.ts:177` vs `:203-212` |

这三处都属于 [第 00 章](./00-方法与约定.md) 的**形状二**：一条规则的正确性建立在另一处的行为上，
而那处行为可以被单独改掉。改动本身都很小，值钱的是它们的连锁——变更一那一处，
**修法的直觉版本会把一个消融臂改坏，而现有的测试仍然全绿**。

另外还有一处不在提示词里、但属于同一件事的洞：复核队列的「重新生成」把用例的
`covers` 与 `oracle` 丢掉了（`casegen/revise.ts:57-69` 与 `:93`）。这是形状一，
「要求写了，数据没给」——上游算出来了、也传进来了，就是没写进模型真正读的那段材料。

---

## 技术点

一份 system prompt 有四段：**角色、约束、示例、输出契约**。前三段是给模型读的，
第四段是给**机器**读的——这是本章唯一一条真正的技术主张：

> 输出契约如果只存在于提示词里，它就不是契约，是一句请求。

契约有四种落点，可执行程度依次递减：

| 落点 | 谁执行 | 什么时候失效 | 本仓库的例子 |
|---|---|---|---|
| JSON Schema `required` | 端点的约束解码，在**生成时** | 端点把约束解码当建议 | `CASES_SCHEMA.required`（`prompts.ts:434`） |
| JSON Schema `properties` | 同上，但只是「允许」 | 模型直接不写这个键 | 见下 |
| zod 二次校验 | 我们自己，在**解析时** | 已经付过一次模型调用了 | `parseJson()`（`casegen/nodes.ts:50`） |
| 提示词里的一句话 | 没有人 | 随时 | `Return JSON only:`（`prompts.ts:141`） |

第五种：**契约表达不成 JSON 时，用语法解析 + 门禁顶上**。`codegen.case` 产出的是代码，
`chat()` 调用里根本没有 `schema` 字段（`codegen/nodes.ts:84-90`），契约由
`parseCode()` 加门禁②的规则执行：`no-assertion`（`codegen/gate.ts:140`）、
`goal-action`（`:173`）、`inline-secret`（`:150`）。

### 两条从事故里长出来的规矩

**规矩一：`properties` 是允许，`required` 才是要求。**
实测记在 `prompts.ts:426`——`priority` 和 `postSteps` 进了 `properties` 之后，
8 条用例仍然一条都不带 `priority`；而同样可选的 `oracle` 与 `covers` 却产得好好的。
差别在提示词的语气：那两个写的是 `you MUST also give`、`copy that id into`，是命令；
`priority` 那一段是描述。作者的结论是「靠语气不如靠约束」，于是把它们放进了 `required`。

**规矩二：提示词里的要求，schema 里不给位置，等于没有要求**（`prompts.ts:349`）。
这条踩过四次，每次形状一样：字段加进了提示词、加进了 zod，独独漏了 schema。
第四次的代价写在 `prompts.ts:406-419`：一次跑完的配对评测两臂产出完全相同，
**McNemar 检验的是两组相同的数**。注释拦不住第五次，所以现在由
`test/casegen.test.ts:707` 那条测试拦。

---

## 现状

### 一、分半：`stable` / `variable`

`ChatRequest`（`client.ts:13-24`）只有四个字段，但它强迫每个调用方回答一个问题：
**哪一半永远不变**。理由写在 `client.ts:13-17`，是一个实测数字：

> 本项目端点上，一次 ~9k token 的请求里 ~6k 是前缀缓存命中——
> 而这只在**调用之间开头的字节完全相同**时才会发生。

执行只有一处：`openai.ts:81-84` 把 `stable` 放进 `system`、`variable` 放进 `user`。
纪律靠三条测试兜着，都是「不该出现在 stable 里的东西不在里面」的形状：

| 测试 | 盯什么 |
|---|---|
| `test/casegen.test.ts:157-158` | 用例预算这种每次都变的数，必须在 `variable` 里 |
| `test/casegen.test.ts:183` | `ORACLE_STRICT` 必须留在 `stable` 里——一次运行内它是常量 |
| `test/revise.test.ts:58` | 被重写的那条用例不能进 `stable`，否则每次重写都错过缓存 |

**没有任何一条测试断言「前缀在两次调用之间逐字节相同」。** 这是本章的「无法证伪」那一栏，
后面会再说一次。

### 二、四段在代码里的位置

| prompt | 角色 | 约束 | 示例 | 输出契约 | 契约由谁执行 |
|---|---|---|---|---|---|
| `plan.stories` | `prompts.ts:12` | `:18-53` | 混在约束里 | `:55-57` | `STORIES_SCHEMA:293` + 每次运行现算的 `storiesSchema():351` |
| `design.cases` | `prompts.ts:59-60` | `:62-139` | `:66-70`、`:80-85` | `:141-143` | `CASES_SCHEMA:361` |
| `spec.compose` | `prompts.ts:452-453` | `:458-` | — | `:455-456` | `COMPOSE_SCHEMA:535` |
| `codegen.case` | `codegen/prompts.ts:7` | `:14-` | `:9-11` | 无 schema | `parseCode()` + 门禁② |
| `revise` | `revise.ts:23` | `:24-31` | 继承 `CASES_STABLE` | `:31`「Return exactly one case」 | **没人**：`CASES_SCHEMA` 里没有 `maxItems` |
| `harness.critic` | `critic.ts:60-61` | `:68-81` | — | `:83-84` | **没人**：这个调用不带 schema |
| `chat.*`（网关四种） | `chat.ts:66/75/92/109` | 各自 | 各自 | 各自 | `SCHEMAS`（`chat.ts:144`）+ `check*` 校验器 |

`chat.ts` 那四份是全仓库写得最整齐的一组：约束全部写成**失败模式**而不是风格规则
（`chat.ts:98-100`：「你没写的参数不是保持原样，它会落回默认值，而默认值会悄悄换掉这次运行读哪个文件」），
契约同时用于约束解码和事后校验。**这里不用改。**

### 三、`storiesSchema()`：把提示词里的要求钉成枚举

`prompts.ts:351` 是本仓库对「结构化」理解最深的一处。`activity` 是故事地图的横轴；
放开成自由字符串的后果实测到了（`prompts.ts:345`）：模型把三千多字符的规格正文抄进了这一栏，
整页当场不可读。现在它是一个**按这次运行自己的模块名现算出来的枚举**。

这条路子是本章后面所有「加约束」提案的模板：**能在 harness 里算出合法值域的，
就钉进 schema，别写进提示词让模型自觉。**

### 四、消融臂由减法生成

`subtract()`（`prompts.ts:177-187`）从原文里减掉一段，而不是手写第二份。
这条纪律是买来的，账记在 `prompts.ts:154`：

> 第一版是手写的第二份提示词，46 行里只留了 26 行——除了方法名，还顺手砍掉了整段判据规范。
> 于是那次消融跑出来的结果回答不了它声称的问题：B 组门禁崩到 0.017，
> **不是因为没点名方法**，是因为判据规范被一起砍了。

`subtract()` 找不到标记就抛，注释写着「消融臂会变成和现状一样，那比跑不起来更糟」。
三个臂里两个（`:190` `:197`）走这条路，一个（`:203-212`）是抄的——见变更三。

### 五、这里不用改的

写出来，免得被后来的人当成缺口重做一遍：

- **不要从 zod 派生 JSON Schema**（AI SDK 的 `generateObject`、`zod-to-json-schema`，任何一种）。
  `casegen/types.ts:89` 是 `priority: z.enum([...]).optional()`、`:98` 是 `postSteps: ....default([])`，
  而 `CASES_SCHEMA` 把这两个都写进了 `required`（`prompts.ts:434`）。**这个分叉是故意的**，
  理由是 `prompts.ts:426` 那次实测。任何派生都会把它抹平，精确地复现那次「两臂完全一样」的配置。
- **不要把提示词搬进 Langfuse Prompt Management。** 它们必须逐字节稳定（前缀缓存），
  而且是编译进 agent 进程的；一个从网络取回的提示词会让运行指纹依赖于一个服务的状态，
  这正好是 `util/digest.ts:6` 要防的事。
- **不要让模型自己决定渲染。** `prompts.ts:345`（三千字的列头）与 `:105`（看板三列恒空）
  是这件事的两个方向的实测代价。

---

## 变更

五处，按价值排。**前三处合成一个提交**——理由在「代价与风险」。

### 变更一：把被劈开的那段话接回去（`prompts.ts:121-124`）

现在发出去的字面是这样：

```
  is still worth more than the happy path of a P2 one. Most stories are not P0 —
  You MUST give every case a priority. Refusing to choose is itself a choice, and it
  lands every case in the same bucket, which is the same as having no priorities at all.
  a batch where everything is P0 has said nothing.
```

「Most stories are not P0 —」的下半句被两行 MUST 挤到了三行之后，读起来是一个断句
加一个小写起头的孤儿从句。**每一次 `design.cases` 调用都在发这个。**

直觉的修法是把最后一行搬回第一行后面。**这个修法会把一个消融臂改坏，而测试全绿。**
原因是 `CASES_STABLE_NO_PRIORITY`（`prompts.ts:190-194`）的**端标记就是那一行**：

```ts
subtract(CASES_STABLE, "- `priority` says how much it costs", "a batch where everything is P0 has said nothing.")
```

把它上移之后，`subtract()` 减到那一行为止，两行 MUST 留在臂里——
于是「不问优先级」那一臂仍然在命令模型必须给每条用例一个优先级。
而现有的测试（`test/ablation.test.ts:110-117`）只断言臂里不含
`` `priority` says how much it costs ``，它会照常通过。

所以这一处是**三个动作，缺一不可**：

1. 重排 `prompts.ts:121-124`，让句子在 MUST 块之前收尾；
2. 把 `:193` 的端标记换成新的末行（`lands every case in the same bucket, …`）；
3. 在 `test/ablation.test.ts` 里换一条更硬的钉子——照抄 `test/casegen.test.ts:674-683`
   对 `PLAIN` 臂用的那个形状（算出被减掉的行集合，断言条数与内容），
   `not.toContain` 这种单点断言拦不住整段位移。

### 变更二：输出契约独立成段，追加物插在它**之前**

三处都在往 `stable` 的尾巴上追加，而三处的尾巴都是输出契约：

| 位置 | 追加的是什么 | 追加后契约还在最后吗 |
|---|---|---|
| `casegen/nodes.ts:997` | `ORACLE_STRICT`（`prompts.ts:225`） | 否 |
| `casegen/revise.ts:21-31` | REVISION MODE 六行 | 否，而且第 31 行是**第二份契约**（「Return exactly one case」） |
| `critic.ts:182` | `AVAILABLE ABLATION SWITCHES: …` | 否 |

以 `oracleGuidance` 为例。两臂的文本差集**确实**只有 `ORACLE_STRICT` 一段——
这一点我核过，把插入文本减掉之后两臂逐字节相同。差的是**位置**：
默认臂以格式说明收尾，strict 臂以「把第二类断言改写成第一类」收尾。

> ⚠️ 我没有实测证据说这个位置差影响了产出——这是**推断**，理由是指令跟随对位置敏感。
> 单独量它要三臂（默认 / 追加在后 / 插入在前），成本是三次完整运行，几十分钟一次。
> **我不打算量它，我打算消除它**：修法的字节代价可以做到零，而 `oracleGuidance`
> 至今没有任何一份评测跑过（`evals/` 下六份定义里没有它），所以现在修不作废任何结论。

做法：

```ts
const CASES_BODY = [ …58-139 行… ].join("\n");
export const OUTPUT_CONTRACT = ["", 'Return JSON only: {"cases":[…', …].join("\n");
export const CASES_STABLE = CASES_BODY + "\n" + OUTPUT_CONTRACT;   // 字节与今天完全相同
```

节点侧（`nodes.ts:986-997`）变成：

```ts
stable: armBody() + (params.oracleGuidance === "strict" ? ORACLE_STRICT : "") + "\n" + OUTPUT_CONTRACT
```

字节账（逐个算过）：

| 文本 | 字节变化 |
|---|---|
| `CASES_STABLE`（默认臂） | **不变** |
| `CASES_STABLE_PLAIN`、`CASES_STABLE_NO_PRIORITY` | **不变**（减掉的段都在 body 中间） |
| `CASES_STABLE_NO_CLEANUP` | **多一个空行**——清理段是 body 的最后一段，`subtract()` 里那句「顺手吃掉后面的空行」在新形状下没东西可吃 |
| strict 臂 | 变（这正是要改的东西） |
| `REVISE_STABLE` | 变（它本来就该有自己的契约，见变更五） |

那个多出来的空行值得停一下：`CASES_STABLE_NO_CLEANUP` **不在 `promptSources()` 里**
（`packages/harness-testing/src/prompts.ts:18-27` 只列了六个，两个新臂不在其中），
所以它的字节动了、指纹一动不动。这件事的正确归属是 [第 08 章](./08-Prompt是代码.md)，
但它在这里第一次现形。

### 变更三：删掉 `CASES_STABLE_PLAIN` 的 IIFE（`prompts.ts:203-212`）

十行，是 `subtract()` 的复制品，只有一处分叉：

```ts
// subtract():177-180
const to = lines.findIndex((l, i) => i >= from && l.includes(endsWith));
// IIFE:206
const to = lines.findIndex((l) => l.includes(METHOD_BLOCK_END));
```

`subtract()` 从起标记之后找端标记，IIFE 从 0 开始找。端标记跑到起标记前面时，
`subtract()` 抛错，IIFE 产出一个 `to < from` 的垃圾臂——`slice` 不会报错，
它会安静地返回一份和原文几乎一样的文本。而「消融臂变成和现状一样」正是
`prompts.ts:207` 那句报错原话说「比跑不起来更糟」的东西：这份代码在注释里说得清清楚楚，
在实现里没做到。

换成 `subtract(CASES_BODY, METHOD_BLOCK_START, METHOD_BLOCK_END)`，产出字节不变。

### 变更四：`revise` 把用例的证据丢了（`revise.ts:57-69`、`:93`）

`server/src/review.ts:764-770` 很小心地把 `covers` 和 `postSteps` 从产物里取出来传进
`ReviseInput`，注释写着「否则重写出来的版本会丢掉它挂在产品模型上的那根线」。
然后 `revise.ts:34-46` 只把 `{title, designMethod, precondition, steps, expected, tier, key}`
序列化进材料——`covers` 和 `oracle` **没进去**；`:93` 又用
`{...parsed.cases[0], id, storyId}` 整条替换。

于是：模型没见过 `oracle`，`CASES_SCHEMA` 也不要求它（`prompts.ts:434` 的 required 里没有
`oracle` 和 `covers`），模型自然不写——**一条 tier-1 的用例重写完变成没有机器判据的 tier-1**，
门禁①的 `tier-unbacked`（`casegen/gate.ts:105-110`）立刻报它，结构覆盖率的分子少一条。
连 `test/revise.test.ts:24-35` 的夹具都长这样：模型把 tier 从 3 抬到 1，一个 `oracle` 都没给。
（那是夹具，不是实测——但它说明这个形状连写测试的人都没觉得不对。）

修法有两个，选后者：

- 把 `covers`/`oracle` 加进材料的 JSON 块，并在 `REVISE_STABLE` 里说「除非异议点名，
  原样带回来」——要动 `REVISE_STABLE` 的字节；
- **在返回处合并**：`{...input.kase, ...parsed.cases[0], id, storyId}`，
  外加一份显式保留名单。一小时，不动任何提示词字节。

顺带一条更小的：异议在 `review.ts:753-758` 被拍平成 `` `[${f.rule}] ${f.message}` ``，
`severity` / `field` / `args` 全丢了——而门禁**正是为了不丢它们**才把这三样和 `message`
分开产出的（`casegen/gate.ts:47-56`：「那句话在这里就拼死了，过了河是个常量」）。
一条 `block` 和一条 `info` 到模型那里长得一模一样。把 `ReviseInput.objections`
从 `string[]` 改成结构体，渲染时把 severity 放在最前面。

### 变更五：给 `revise` 一份自己的契约

`REVISE_STABLE` 现在同时携带两句互相矛盾的格式说明：继承来的
`Return JSON only: {"cases":[…]}`（复数）和第 31 行的 `Return exactly one case.`。
schema 里没有 `maxItems`，所以「exactly one」这条要求**没有任何执行者**——
正是 `prompts.ts:349` 那条规矩点名的形状。代码靠 `:93` 取 `[0]` 兜住，
但兜住的只是正确性，兜不住成本：`maxTokens` 在 `:82` 是硬编码的 1200，
而同一份 schema 在 `design.cases` 那边是 9000（`nodes.ts:934`），
且 `required` 里有 `priority` 和 `postSteps`。多产一条用例就可能被截断，
而截断在 `parseJson` 里会被正确地报成预算问题（`nodes.ts:56-58`）——但那时钱已经花了。

做法照抄 `storiesSchema()`（`prompts.ts:351`）的模板：一个
`casesSchema({ maxItems })` 函数，`revise` 传 1。同时把 `maxTokens` 抬到 2500 左右。

> 端点是否兑现 `maxItems` 我没验过（**推断**）。约束解码在这个端点上本来就是建议不是强制
> ——`nodes.ts:71-77` 记着「schema 要求对象，回来的是 `[{…},{…}]`」——
> 所以 `:93` 的 `[0]` 必须留着当第二道防线。

---

## 收益

| 变更 | 收益 | 可测量 |
|---|---|---|
| 一 | 每次 `design.cases` 调用不再发一个断句；`case-priority` 臂真的不再要求优先级 | 是：新钉子直接断言臂里没有 MUST 那两行 |
| 二 | `oracleGuidance` 这个「提示词片段作为节点参数」的样板恢复成单变量**由构造保证** | 部分：位置效应本身要三臂才量得到，我们选择消除而不是测量 |
| 三 | 「单变量」这条纪律只剩一份实现 | 是：删十行，臂的字节不变 |
| 四 | 复核重写不再把 tier-1 降级成模型判决 | 是：门禁①的 `tier-unbacked` 计数，重写前后不该涨 |
| 五 | 重写调用的截断风险消失；「只要一条」有了执行者 | 是：单测 |

变更二还有一个附带产物：`OUTPUT_CONTRACT` 一旦是个独立常量，
[第 08 章](./08-Prompt是代码.md)想做的「按段落指纹」就有了第一段。

---

## 代价与风险

**三笔账，动 `CASES_STABLE` 字节的改动要一次付清。**

| 账 | 谁收 | 说明 |
|---|---|---|
| 前缀缓存 | 端点 | 开头字节一变，缓存重建一次。实测口径见 `client.ts:7-11`（~9k 里 ~6k） |
| 运行指纹 | `runPromptDigest()`（`server/src/graphs.ts:802-808`） | `design.cases` 的 sha8 变，此后的运行与之前的不再「按指纹可比」 |
| 录制夹具 | `RecordedModel`（`client.ts:157-177`） | `requestKey()`（`:73-83`）把 stable+variable+schema 一起哈希。回放模式会以 `no recording for …` 失败，而且是在**图级测试**里报，读起来不像提示词问题 |

按变更分：

- **变更一是唯一真正付账的那个**（它改 `CASES_STABLE` 的正文）。
- **变更二、三对默认臂和两个消融臂字节中性**，只有 `NO_CLEANUP` 多一个空行、strict 臂变。
- 变更四（合并法）与变更五不动任何 `stable` 字节，可以单独走。

**什么情况下不该做**：正在跑评测的时候一个字都别改。这条写在项目记忆里，
理由是一次运行几十分钟到几小时，而 `resumeRun()`（`graphs.ts:882`）恢复时
会重算指纹并覆盖写（`:518`）——一次跨越提示词修改的恢复，
`detail.prompts` 记的是后半段的指令，前半段的产出没有任何记录说它出自别的文本。

### 一条反对意见：`required` 买到的是「在场」，不是「内容」

[第 00 章](./00-方法与约定.md)的形状三给了一条推论：新增 schema 字段都必须进 `required`。
**这条推论是对的，但它的强版本被两次实测反对了。**

`evals/case-priority.json` 的结果（2026-08-30，`eval-mtfp02ly`，qwen3-8-27b）：

| 臂 | 覆盖率 | 用例 | P0 | P1 | P2 |
|---|---|---|---|---|---|
| A：问优先级（现状） | 0.889 | 24 | 7 | 12 | 5 |
| B：**提示词里删掉整段优先级口径** | 0.889 | 29 | **0** | 22 | 7 |

B 臂删的是提示词，`CASES_SCHEMA` 没动，所以 `priority` 仍在 `required` 里——
**29 条用例全都带着优先级回来了，只是 P0 一条都没有**。
`ABLATABLE` 里 `casePriority` 的注释写的是「every case comes back without one」
（`eval/ablation.ts:9`），代码做的不是这件事。这不是 bug，是这个消融臂的真实含义：
**schema 决定这个字段存不存在，提示词决定它有没有意义。** 但注释该改，
否则读评测报告的人会以为 B 臂没有优先级。

`evals/case-cleanup.json` 把话说得更透（同日，`eval-mtfqqa50`）：

| 臂 | 用例 | 真的在撤销 | 只是重新打开页面 | 没有 |
|---|---|---|---|---|
| A：要求清理 | 36 | 7 | 18 | 11 |
| B：不要求清理 | 36 | 0 | 0 | 36 |

作者自己的读法：

> 模型把必填的字段用无意义的内容填满了，而不是留空。
> 这正是把 `postSteps` 放进 required 时押的注：「空数组是诚实回答」。**押错了一半。**

有效率 28%。18 条「重新打开 /testlogin」在看板上、在导出器的 teardown 分支里，
和真正的撤销长得一模一样。**`required` 制造了一个新的失败面：在场但空转，
而且它比缺席更难发现——缺席是 0，空转是一个看起来正常的数。**

所以这一章给第 00 章那条推论加一个后半句：

> 新增字段进 `required` 之后，**必须同时有一条判据能分辨「填了」和「填对了」**。
> `postSteps` 那条判据存在（门禁①的 `no-cleanup`），但它当时的动词表里没有「登录」，
> 两臂命中都是 0（`casegen/gate.ts:288-320` 记着这次漏报和它的修法）。

---

## 怎么证伪

| 手段 | 内容 |
|---|---|
| **单元测试** | 三根新钉子。(1) `test/ablation.test.ts`：三个臂各算一次「被减掉的行集合」，断言条数与内容——`not.toContain` 拦不住整段位移，变更一就是被它放过去的。(2) `test/casegen.test.ts:163-184` 扩一条：strict 臂减去 `ORACLE_STRICT` 之后必须逐字节等于默认臂，**且两臂的最后一行相同**（后半句是变更二的判据）。(3) `test/revise.test.ts`：给一条带 `oracle` 与 `covers` 的用例，模型回一条不带的，断言返回值里两者都还在。 |
| **配对评测** | 新增 `evals/oracle-guidance.json`，用 `paramOverrides` 打在 `design.cases` 上而不是 `ablate`——这是仓库里唯一一个「提示词片段作为参数」的样板，却是唯一没有评测文件的。它量的是 strict 值不值，不是位置效应值不值。 |
| **门禁规则** | 变更四的判据现成：跑一次复核重写，比较重写前后这批用例的 `tier-unbacked` 条数。今天它必然涨，改完必然不涨。这个数已经在门禁报告里，不用新写。 |
| **无法证伪的部分** | **「`stable` 的前缀在两次调用之间逐字节相同」没有任何自动检查。** 唯一的执行点是 `openai.ts:81-84` 的约定，唯一的三条测试都只查「某段文字在不在里面」。往 `stable` 里塞一个时间戳、一个 run id，或者只是重排两段——全部测试仍绿，代价是这条流水线大半的速度，而且没有任何一处会报。能做而尚未做的是把每个 `*_STABLE` 的 sha8 钉进 fixture（[第 08 章](./08-Prompt是代码.md)），**如实记在这里**。 |

---

## 验收

1. `packages/harness-testing/src/casegen/prompts.ts:190-193` 那段话读起来是一句完整的话，
   并且 `CASES_STABLE_NO_PRIORITY` 里搜不到 `You MUST give every case a priority`。
2. `CASES_STABLE`、`CASES_STABLE_PLAIN`、`CASES_STABLE_NO_PRIORITY` 三者在变更二、三前后
   sha8 不变；`CASES_STABLE_NO_CLEANUP` 变化仅为一个空行（diff 可核）。
3. `oracleGuidance: strict` 与 `default` 两次调用的 `stable`，最后一行相同。
4. `prompts.ts` 里只剩一个 `subtract`，没有 IIFE。
5. 从复核队列重写一条 tier-1 用例，重写后它仍带 `oracle` 与 `covers`，
   门禁①不新增 `tier-unbacked`。
6. `evals/oracle-guidance.json` 存在，且跑完之后 `result` 里有数——
   哪怕结论是 `no-difference`。`evals/README.md` 说过 `"unknown"` 是诚实的答案，
   但一个从没跑过的评测定义连 `"unknown"` 都不是。
