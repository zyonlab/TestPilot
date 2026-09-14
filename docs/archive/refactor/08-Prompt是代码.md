# 08　Prompt 是代码

> 版本管理、快照测试、回归防护。
>
> 这一章不提新机制。指纹、消融臂的构造纪律、拒绝比较的检查——**全都已经写好了**。
> 问题是这套机制盖住的范围比它宣称的小得多，而它的宣称是被相信的。
> 本章的全部内容就是：把洞找出来、堵上、并且让下一个洞会红。

## 前置

- [第 02 章](./02-三条不可动摇的性质.md)：`stable` 的前缀字节不能动
  （`packages/harness-core/src/model/client.ts:7-11`，实测 ~9k 请求里 ~6k 命中前缀缓存）。
  本章任何一处改动都必须能证明它**没有**动到发给模型的字节。
- [第 07 章](./07-SystemPrompt结构化设计.md)：`stable` / `variable` 的切分，以及输出契约在 schema 而不在正文。
- [第 14 章](./14-评测体系.md)：消融臂、配对评测、`ABLATABLE`。本章保护的正是那套东西的可信度。
- 已有代码前置（**都不需要重写**）：`util/digest.ts`、`promptSources()`、`runPromptDigest()`、
  `promptDrift()`、`subtract()`。

---

## 问题

### 一、两次跑完的配对评测，报告说两臂的提示词一模一样。它们不一样。

仓库里有六份评测定义，只有两份带 `result`。我把它们在 `server/.data/evals.db` 里的行取出来：

| 评测 | 臂 | `ablate` | 记录下来的 `prompts.combined` |
|---|---|---|---|
| `eval-mtfp02ly`（`evals/case-priority.json`） | A 问优先级 | `[]` | `e5b80c75` |
| | B 不问优先级 | `["case-priority"]` | **`e5b80c75`** |
| `eval-mtfqqa50`（`evals/case-cleanup.json`） | A 要求清理 | `[]` | `e5b80c75` |
| | B 不要求清理 | `["case-cleanup"]` | **`e5b80c75`** |

两臂的 `entries` 逐键完全相同，十个键一个不差。

而实际发出去的 `stable` 不同——这本来就是这次评测的**唯一变量**：

| 实际发给模型的文本 | 字符数 | sha8（当前工作副本） | 在指纹里吗 |
|---|---|---|---|
| `CASES_STABLE`（A 臂） | 4656 | `a95cd1fd` | ✅ 记为 `design.cases` |
| `CASES_STABLE_NO_PRIORITY`（case-priority 的 B 臂） | 3803 | `fc9d2fe7` | ❌ **没有任何一处记过它** |
| `CASES_STABLE_NO_CLEANUP`（case-cleanup 的 B 臂） | 4105 | `a60ebae1` | ❌ **同上** |

这两条 sha8 在整个 `evals.db` 的 48 行里一次都没出现过。
**这个仓库唯二两次跑完的配对评测，它们的 B 臂用的是什么提示词，没有留下任何记录。**

要说清楚这件事的性质：它此刻**没有**造成错误结论。两臂确实只差一件事，差的就是那一段，
`evals/case-priority.json` 的读数是可信的。危险在于这个记录**说不出**这件事——
它说的是"两臂被告知了同样的话"，而这句话是假的。指纹存在的全部理由，
就是替一次比较回答这一个问题。

### 二、`spec.compose` 是整条流水线的上游，它可以在两臂之间被改写而什么都不报

G1 的图是四条边（`packages/harness-testing/src/casegen/graph.ts:61-66`）：

```
docs → spec → stories → design → gate
       ↑ spec.compose
```

`spec.compose`（节点定义 `casegen/nodes.ts:394`，调用 `nodes.ts:456-462`）把材料整理成那份**唯一的**
标准规格。规则从它来，故事从规则来，用例从故事来，断言要能查回材料。它的提示词
`COMPOSE_STABLE`（`casegen/prompts.ts:451`，3754 字符 / 51 行，当前 sha8 `eeaa3b9e`）
是 `export` 的，而 `promptSources()`（`packages/harness-testing/src/prompts.ts:18-27`）里没有它。

它不是一份从没动过的静态文本。`git log -L 451,511:packages/harness-testing/src/casegen/prompts.ts`
显示这块正文在 **5 个提交**里改过，最近一次是 `716649b`（2026-08-30，"屏幕有了业务名（问模型要的）"）——
和那两次配对评测同一天。这五次改动全部没有进过任何一次运行记录。

一次配对评测的两臂是**串行**跑的：`evals/case-priority.json` 里 A 臂 `ms=1358565`、
B 臂 `ms=1484909`，合计 **47 分钟**。在这 47 分钟里改一个字，
`promptDrift()`（`server/src/evals.ts:330-335`）返回 `undefined`，报告照常打印。

### 三、这个洞是这份文件自己预言过的

`packages/harness-testing/src/prompts.ts:14-17`：

> 手写而不是扫描：一个被人忘了加进来的提示词，就是一个可以变而指纹不动的提示词，
> **而一个有洞的指纹比没有指纹更糟——它会被相信。**

这句话是对的，代价也是对的。它唯一没做到的是让"忘了加"这件事会红。
按 [第 00 章](./00-方法与约定.md) 的分类，这是**形状二**：
`promptDrift()` 的正确性建立在 `promptSources()` 完整这个前提上，
而后来加提示词的人没有维护那个前提。

---

## 技术点

"Prompt 是代码"落到这个仓库，是四件互不替代的事：

| 性质 | 回答的问题 | 这里靠什么 | 状态 |
|---|---|---|---|
| **身份** | 这次运行是被哪份指令产出的 | `sha8` / `digestTexts`（`util/digest.ts:15,24`） | 已有，覆盖不全 |
| **变更日志** | 它**变成了什么** | git diff（手写文本）／checked-in fixture（派生与拼装文本） | 手写的有，派生的**完全没有** |
| **覆盖** | 有没有漏掉的指令 | `promptSources()` 手工名单 | 有洞，且无人检查 |
| **回归防护** | 漏了会不会被发现 | 单元测试 | **不存在** |

两条必须分清的界线：

**指纹说不出"变成了什么"，这是设计上的取舍，不是缺陷。** `util/digest.ts:12-13` 写死了：

> A digest is not the prompt: it cannot tell you what changed. It can tell you THAT
> something changed, which is the part a comparison needs in order to refuse.

一次比较只需要"要不要拒绝"，8 个十六进制字符就够了，也不该把 4656 字符抄进每一条运行记录。
但"变成了什么"是**另一个人在另一个时刻**要问的问题，它需要另一个载体。

**手写的文本和派生的文本，要的载体不一样。** `CASES_STABLE` 改了，git diff 就是它的变更日志，
再存一份快照是重复。但 `CASES_STABLE_NO_PRIORITY` 在源码里**不存在**——
它是 `subtract()` 在模块加载时算出来的（`casegen/prompts.ts:190-201`）；
`design.cases` 真正发出去的那串字节是 `CASES_STABLE + ORACLE_STRICT`（`nodes.ts:986-997`），
5297 字符，源码里任何一个文件都没有它。**这两类文本，git 看不见。**

---

## 现状

### 已经做对的部分（不要改）

| 机制 | 位置 | 为什么它是对的 |
|---|---|---|
| 消融臂由**原文相减**生成，不手写第二份 | `casegen/prompts.ts:177-187` | 单变量由构造保证。`prompts.ts:151-165` 记着代价：第一版手写的第二份 46 行只留 26 行，顺手砍掉整段判据规范，于是 B 组门禁崩到 0.017（55 条 tier-unbacked、21 条 oracle-vague）——**那次消融回答不了它自己声称的问题**（实测） |
| 找不到标记就**在模块加载时抛**，不是静默降级 | `prompts.ts:181-182` | 报错原文："消融臂会变成和现状一样，那比跑不起来更糟" |
| 指纹进运行记录 + 进 trace 标签 | `server/src/graphs.ts:519`、`:546` | 见 [第 12 章](./12-Langfuse可观测性.md)：`prompts:<12>` 让两个提示词版本在 Langfuse 上可筛 |
| 指纹不同就**拒绝把这次比较读成比较** | `server/src/evals.ts:312-317` | 它报的是被移动的**键名**，不是一句"变了" |
| `digestTexts` 排序后再合成 | `util/digest.ts:26` | 键序不影响 `combined`。`digest.test.ts:10-15` 钉住 |
| `ORACLE_STRICT` 做成节点参数而不是就地改文本 | `prompts.ts:214-243`、`nodes.ts:997` | critic 提的改进建议因此可以被跑，而不是只能被采纳 |
| schema ⟷ zod 对齐做成测试而不是注释 | `test/casegen.test.ts:700-739` | 注释拦了三次没拦住，第四次改成测试。`prompts.ts:426-434` 记着第三次的代价：一次跑完的配对评测两臂产出完全相同 |

**这一章不打算动上面任何一行。** 消融臂的构造纪律尤其不能动：
`eval-system` 勘察里写得很清楚——把提示词搬进注册表或数据库当真相源，
等于把"人可以手写一条消融臂"这条路重新打开，而那正是 `prompts.ts:151` 那次事故的入口。

### 注册表盖住了多少

全仓库有 **9 处** `model.chat({...})` 调用。`promptSources()` 有 **6 个** key。

| # | 调用点 | `stable` 是什么 | 登记情况 |
|---|---|---|---|
| 1 | `casegen/nodes.ts:873` `spec.compose` | `COMPOSE_STABLE`（`prompts.ts:451`） | ❌ **已 export，未登记** |
| 2 | `casegen/nodes.ts:873` `plan.stories` | `STORIES_STABLE`（`prompts.ts:11`） | ✅ `plan.stories` |
| 3 | `casegen/nodes.ts:873` `design.cases` | 四选一 + 可选后缀 | ✅ 2 臂 ／ ❌ 2 臂（见下） |
| 4 | `codegen/nodes.ts:84` `codegen.case` | `CODEGEN_STABLE` | ✅ `codegen.case` |
| 5 | `codegen/nodes.ts:241` `repair.loop` | `REPAIR_STABLE` | ✅ `repair.loop` |
| 6 | `casegen/revise.ts:20` `revise:<id>` | `REVISE_STABLE`（`revise.ts:20`） | ❌ **模块私有 `const`，想登记都登记不了** |
| 7 | `critic.ts:59` `harness.critic` | `STABLE`（`critic.ts:59`） | ❌ 模块私有 |
| 8 | `eval/semantic.ts:39` `eval.adjudicate` | `STABLE`（`semantic.ts:39`） | ❌ 模块私有 |
| 9 | `server/src/chat.ts:377` `chat:<intent>` | 四选一（`chat.ts:66/75/92/109`） | ❌ 四份都没有 |

第 3 行展开——`design.cases` 一次调用可以发出的 `stable` 有 4×2 = 8 种组合：

| 臂 | 常量 | sha8 | 登记情况 |
|---|---|---|---|
| 现状 | `CASES_STABLE`（`prompts.ts:58`） | `a95cd1fd` | ✅ `design.cases` |
| `design-methods` | `CASES_STABLE_PLAIN`（`:203`） | `175f8078` | ✅ `design.cases:no-methods` |
| `case-priority` | `CASES_STABLE_NO_PRIORITY`（`:190`） | `fc9d2fe7` | ❌ |
| `case-cleanup` | `CASES_STABLE_NO_CLEANUP`（`:197`） | `a60ebae1` | ❌ |
| 任意臂 + `oracleGuidance:"strict"` | 上面任一 + `ORACLE_STRICT` | 例：`d5bc756b` | ⚠️ 只登记了 641 字符的**片段**，没有登记拼出来的整体 |

`ABLATABLE`（`packages/harness-core/src/eval/ablation.ts:9-24`）里有三个开关直接改提示词正文，
**其中两个的产物没有任何指纹**。而 `ablation.ts:9-13` 说的是"一个改不了任何东西的开关会让消融报告说谎"——
这里是它的对偶：一个改了东西却不留痕的开关，让运行记录说谎。

### 已经能看见的、被登记的那一臂，确实独立漂过

把 `evals.db` 里 12 行带指纹的记录按键统计不同取值：

| key | 历史上出现过几个不同的 sha8 |
|---|---|
| `design.cases` | 3 |
| `design.cases:no-methods` | **4** |
| `codegen.case` | 2 |
| `plan.stories` / `repair.loop` / `design.cases:oracle-strict` / `settings:*` × 4 | 各 1 |

派生臂比它的原文多动了一次。原因可查：`METHOD_BLOCK_START` / `METHOD_BLOCK_END`
（`prompts.ts:167-168`）是两个独立的 `const`，`git log -L 167,168` 显示它们在 `e8bcfee`
（"消融臂改成从原文里减"）里动过——**改标记就能改臂，而原文一个字没动**（推断：我没有逐提交重算 sha8，
但两个数字对不上只有这一种解释路径）。

这条正好把问题说完整：`design.cases:no-methods` 被登记了，所以这次独立漂移**留下了痕迹**；
另外两条臂同样会漂，只是漂了没人看得见。

### 一个正好摆在那里的例子：改个错字就能改掉一条臂

`casegen/prompts.ts:114-124` 这一段是坏的：

```
121   Judge the STORY's importance, not the case's difficulty: an edge case of a P0 story
      is still worth more than the happy path of a P2 one. Most stories are not P0 —
122   You MUST give every case a priority. Refusing to choose is itself a choice, and it
123   lands every case in the same bucket, which is the same as having no priorities at all.
124   a batch where everything is P0 has said nothing.
```

第 121 行的句子被两行 MUST 打断，它自己的后半句掉到了 :124，成了一个小写开头的孤儿。
每一次 `design.cases` 调用都在发这段破句子。

而 :124 那一行的字面量，**正是 `CASES_STABLE_NO_PRIORITY` 的结束标记**（`prompts.ts:193`）。

所以：把 :124 挪回 :121 后面——一次纯排版修复，零 token 变化——
`case-priority` 那条臂会从"删掉 :114–:124 共 11 行"变成"删掉 :114–:121 共 8 行"，
两行 MUST 从被删变成保留。**臂变了，而 `evals/case-priority.json` 里那句
"B 臂 P0 零个"的结论现在描述的是一份不再存在的提示词。**
`design.cases` 的 sha8 会动（因为 `CASES_STABLE` 动了），但没有任何一个数字告诉你
B 臂动得比 A 臂多。

### 没有 CI，没有钩子，`pnpm test` 还漏一块

| 事实 | 证据 |
|---|---|
| 没有 CI | 仓库根**没有 `.github/`** |
| 没有 git 钩子 | `.git/hooks/` 全是 `.sample`；`package.json` 里无 husky / lint-staged |
| 根 `pnpm test` 只跑 4 个包 | `"test": "pnpm -r --filter './packages/**' --filter './apps/**' test"`。实跑 `pnpm -r --filter ... exec pwd` 输出：harness-core、harness-testing、runner、agent |
| `server/` 的 20 个测试文件**不在里面** | `server` 在 `pnpm-workspace.yaml` 里，但路径不匹配 `./packages/**` |
| 一个快照测试都没有 | 全仓库 `toMatchSnapshot` / `__snapshots__` 命中数为 **0** |
| 但跑得很快 | `packages/harness-testing`：20 文件 / **341 测试 / 1.5 秒** |

结论直接决定这一章的落点：**任何防护都必须放进 `packages/harness-testing/test/`**，
放进 `server/test/` 的等于没放。而 1.5 秒的代价意味着"跑得慢所以没人跑"这个借口不成立。

---

## 变更

### 变更一：把注册表补全，并把"哪些该进"写成代码

先定边界，否则补全会变成一场无休止的加法。判据是**这份文本影响谁**：

| 档 | 判据 | 谁 | 落在哪 |
|---|---|---|---|
| **产出指纹** | 改了它，这次运行的产物就不同 | `COMPOSE_STABLE`、`CASES_STABLE_NO_PRIORITY`、`CASES_STABLE_NO_CLEANUP`、`REVISE_STABLE` | `promptSources()` → `runPromptDigest()` |
| **量具指纹** | 改了它，产物不变而**分数**变 | `critic.ts:59`、`eval/semantic.ts:39` | 新增 `judgeSources()`，进 `PairedEvalResult` 而**不进** `RunDetail.prompts` |
| **不进** | 产物是给人看的草稿，落地时会变成别的被登记的东西 | `chat.ts` 的四份、`server/src/model.ts:173/:261` 两句系统提示 | 豁免名单，**每一条写理由** |

第二档单独分出来是有原因的：把判官提示词折进 `runPromptDigest()`，
会让每一次普通运行的 `combined` 在判官改动时跟着动——而那次运行根本没调用判官。
一个会因为无关变动而移动的指纹，和一个有洞的指纹是同一种毛病。

具体改动：

```
packages/harness-testing/src/casegen/revise.ts:20   const → export const REVISE_STABLE
packages/harness-testing/src/critic.ts:59           const STABLE → export const CRITIC_STABLE
packages/harness-core/src/eval/semantic.ts:39       const STABLE → export const JUDGE_STABLE
packages/harness-testing/src/prompts.ts:18          promptSources() 加 4 个 key
packages/harness-testing/src/prompts.ts             新增 judgeSources()
server/src/evals.ts:80-96                           ArmResult 旁边加 judgePrompts?: TextDigest
```

`REVISE_STABLE` 是 `CASES_STABLE + 修订说明`（`revise.ts:20-21`），
登记它会把 `CASES_STABLE` 的字节数过一遍——这没关系，它是**实际发出去的那串**，
而复核台改写出来的用例会写回用例集（`revise.ts:93`），是产物。

顺手删掉 `prompts.ts:29` 的 `promptDigest()`：全仓库零调用点，且它比
`runPromptDigest()`（`graphs.ts:802-808`）少了 `settings:*` 那一半。
两份算同一件事的实现，一份没人用——将来有人用了它，会得到一个和运行记录对不上的指纹。

### 变更二：把 `design.cases` 的选择器抽成纯函数，并登记它的全部产物

现在的选择器是一个内联 IIFE（`casegen/nodes.ts:986-997`），
上面的注释写着"同时开两个时按顺序减"，而函数体是三个 `if ... return`——第一个命中就走。
**声明两个开关的臂，实际只减了一段，报告照两段写。**

```ts
// packages/harness-testing/src/casegen/prompts.ts —— 新增，导出
export function casesStable(opts: {
  ablated: ReadonlySet<string>;
  oracleGuidance?: "default" | "strict";
}): { key: string; text: string };
```

- 内部改成对 `CASES_STABLE` **连续调用 `subtract()`**，一个开关减一次——注释说的那个行为；
- 返回值带上 `key`，就是它在 `promptSources()` 里的名字（如
  `design.cases:no-priority+no-cleanup`），于是"发了什么"和"记了什么"由同一个函数决定，
  不可能对不上；
- `nodes.ts:986-997` 缩成一次调用；
- `promptSources()` 遍历这个函数的全部合法输入来生成键值。手工名单只保留其余提示词。

**一个必须保住的性质**：现在 `CASES_STABLE_NO_PRIORITY` 是模块加载期常量，
标记漂了就在 `import` 时抛。改成运行时计算会把这声爆炸推迟到某个节点的 `run()` 里——
一次跑了四十分钟的运行在中途炸掉，比启动时炸掉贵得多。
所以：**保留一个模块加载期的自检**，把八种组合各算一遍，只为触发 `subtract()` 的抛错。
八次字符串切片，成本可以忽略。

### 变更三：只给"派生的与拼装的"文本做快照，不给手写的做

新增目录 `packages/harness-testing/test/prompts/`：

```
prompts/
  design.cases.no-priority.txt              ← subtract() 的产物
  design.cases.no-cleanup.txt
  design.cases.no-methods.txt
  design.cases.no-priority+no-cleanup.txt
  design.cases.strict.txt                   ← CASES_STABLE + ORACLE_STRICT，实际发出去的整串
  revise.txt                                ← CASES_STABLE + 修订说明
  digests.json                              ← { key: sha8 }，覆盖全部登记项（含手写的）
```

**手写的 `CASES_STABLE` / `COMPOSE_STABLE` 不存 `.txt`。** 它们的变更日志就是那次提交的 diff，
再存一份等于让每次改提示词都要改两个文件，而第二个文件的 diff 和第一个一模一样——
这种测试的唯一结局是被人机械地"更新一下"。这不是我的顾虑，是这个仓库自己的判断
（`server/src/evals.ts:114-118`）：

> **它不是一个通过/失败**。一个会红的评测会被人调到绿为止，而那正是评测本该防住的事。

派生文本不一样：它在源码里没有第二份可看。改 `CASES_STABLE` 的那次提交，
diff 里会同时出现四份 `.txt` 的变化——**那才是"这次改动对每条臂各做了什么"的唯一呈现方式**。
上面那个错字修复，会在 `design.cases.no-priority.txt` 里显示成"多留了两行 MUST"，一眼可见。

`digests.json` 对所有登记项都存，因为它便宜（每条 8 字符）、且它是那道"你没改错东西"的钉子。

更新方式是一条显式脚本而不是 `vitest -u`：

```
pnpm --filter @testpilot/harness-testing prompts:bless
```

区别在于 `-u` 会顺手把别的快照也刷了，而 `prompts:bless` 只重写这一个目录，
并且必须作为**一次单独的、内容就是文本 diff 的提交**出现。

### 变更四：`digestDiff` 分三类，让"补登记项"不再永久污染历史

`util/digest.ts:34-37` 现在的实现是 `a.entries[n] !== b.entries[n]`。
一个新增的键在旧指纹里是 `undefined`，于是被算成"移动"。
补完注册表之后，任何新运行与那 12 行历史记录相比，**永远**会报出这几个新键在动。

```ts
// packages/harness-core/src/util/digest.ts
export interface DigestDelta { moved: string[]; added: string[]; removed: string[]; }
export function digestDelta(a: TextDigest, b: TextDigest): DigestDelta;
// digestDiff 保留：= [...moved, ...added, ...removed].sort()，现有调用点不动
```

`promptDrift()`（`evals.ts:330-335`）改成只在 `moved.length > 0` 时拒绝，
`added` / `removed` 单独说成"这两次之间注册表本身变过"。

这一条把"代价"变成"分类"。它同时把 `digest.test.ts:24-31`
（"多出来一个提示词也算变化"）的意图保住了——它仍然是变化，只是有了类别。

### 变更五：settings 那一半，git 看不见，就让 DB 看见

`runPromptDigest()`（`graphs.ts:802-808`）会把四份可在界面上编辑的模板
（`server/src/settings.ts:81-92`）折进指纹，键名 `settings:*`。指纹是有了，
**文本没有任何历史**——它们住在 DB 里，还能被模型改写（`server/src/chat.ts:363-374` 的
`intent === "prompt"`）。

`prompt_versions(digest TEXT, name TEXT, text TEXT, at TEXT, PRIMARY KEY(digest,name))`，
由 `runPromptDigest()` 顺手 upsert。写入是幂等的，一份没改过的模板一辈子只写一行。
于是 `promptDrift()` 报出 `settings:explore` 移动时，那两个 sha8 都能被解回正文。

对源码里的提示词也一并写入——多花几十行存储，换来的是"这条运行记录里的
`design.cases: a95cd1fd` 到底是什么"在两年后仍然答得出来，而不必去翻某个提交。

### 变更六：**不做**的三件事

| 不做 | 理由 |
|---|---|
| 把提示词搬到 Langfuse Prompt Management | 前缀缓存要求字节逐次相同（`client.ts:7-11`）；提示词编译在 agent 进程里，指纹算在网关进程里；一份网络拉取的提示词会让运行的指纹取决于外部服务的状态，正好和 `digest.ts:4-14` 的目的相反 |
| 把提示词搬进 DB / 注册表当真相源 | 那等于重新打开"人手写一条消融臂"的路。`prompts.ts:151-165` 记着这条路的价钱：一次回答不了自己问题的消融 |
| 给这套指纹加一个开关 | 一个能关掉的指纹等于没有指纹。它不进 `ABLATABLE` |

---

## 收益

| 收益 | 可测量吗 |
|---|---|
| 三条消融臂**全部**有指纹，两臂的 `combined` 不再在真的不同时相等 | 能：跑一次 `ablate:["case-priority"]`，`RunDetail.prompts.entries` 里出现 `design.cases:no-priority = fc9d2fe7`，与 A 臂不同 |
| `spec.compose` 进入指纹 | 能：新运行的 `entries` 从 10 个键变成 14 个 |
| 双开关消融真的减两段 | 能：单元测试断言两段都不在，且结果是原文的子集 |
| "变了什么"从"变了"里长出来 | 能：改 `CASES_STABLE` 一行，`pnpm test` 红在四份 `.txt` 上，diff 直接是文本差异 |
| 加登记项不再让历史永久不可比 | 能：`digestDelta` 对 `eval-mtfp02ly` 的旧指纹报 `added:[4]`、`moved:[]` |
| 判官提示词有独立指纹 | 能：`PairedEvalResult.judgePrompts` 出现；且普通运行的 `combined` 不因判官改动而移动 |
| 下一个新提示词漏登记会红 | 能：删掉 `promptSources()` 任意一行，新测试红并点名 |

有一条**不能**测量，写清楚：这些都不会让模型产出变好。这一章交付的是
"结论的可信度"，不是覆盖率。它的价值只在下一次有人问"那次 0.889 是哪份提示词跑的"时兑现。

---

## 代价与风险

| 项 | 说明 |
|---|---|
| 工作量 | 变更一 ~2 小时；变更二 ~半天（含改选择器与测试）；变更三 ~2 小时；变更四 ~1 小时；变更五 ~半天。合计**一天半到两天**，不含跑评测 |
| export 即公共面 | 三个模块私有 `const` 变成包的导出。`REVISE_STABLE`、`CRITIC_STABLE` 无所谓；`JUDGE_STABLE` 在 `harness-core` 里，它的导出会被外部当成可替换的扩展点——文档注释要写明"导出是为了被指纹读到，不是为了被替换" |
| 历史不可比 | 见变更四。**不做变更四就不要做变更一**：那会把 12 行历史记录变成永久噪音，比现在更糟 |
| 快照被机械刷绿 | 真实风险，无法用代码消除。缓解手段是把"改文本"和"刷 fixture"放进**同一次提交**并让 diff 自解释；以及只对派生文本做快照，让红的次数少到值得看一眼 |
| 模块加载期自检变贵 | 八种组合各切一遍字符串。实测 `packages/harness-testing` 全套 341 个测试 1.5 秒，这点开销读不出来 |
| 没有 CI，一切靠手跑 | 这是这一章最大的未解风险。它不该由这一章解决（起 CI 是独立的一件事），但**必须写下来**：本章的全部防护等价于"有人在提交前敲了 `pnpm test`" |
| 根 `pnpm test` 不含 `server/` | 所以新测试一律进 `packages/harness-testing/test/`。同时建议把根脚本改成 `pnpm -r test`——这是一行改动，但它会把 20 个此刻没人跑的测试文件拉进来，**很可能不全绿**，属于另一件事 |

### 一个补完注册表也解决不了的问题（推断）

`runPromptDigest()` 在**网关**进程里求值（`graphs.ts:802`，模块副本在网关启动时加载）；
真正发给模型的文本在 **agent** 进程里（`server/src/procs.ts:121-139` fork
`apps/agent/src/main.ts`，`restart: "always"`，`heartbeatMs: 1000`）。
两个进程各有一份编译产物，加载时刻不同，而**指纹从不跨越这条边界**——
`apps/agent/src/main.ts` 里 grep 不到 `digest` 或 `prompts` 任何一处。

所以指纹严格说来记的是"运行开始那一刻，网关那一份副本长什么样"。
agent 因心跳超时被重启并重新加载了改过的源码时，两者会分叉（推断：我没有构造出这次分叉，
但两个模块实例和 `restart: "always"` 是代码事实）。

要真正关掉这条缝，得让 agent 在 `startRun` 的应答里回报它自己算的
`promptSources()` 指纹，网关比对不一致就拒绝启动。**本章不做**：
它需要动 RPC 协议（`packages/harness-core/src/harness/protocol.ts`），
而 dev 下网关是 `tsx watch`（`server/package.json:7`），改源码会重启网关、
连带重启 agent、把正在跑的运行判成 `interrupted`——这条路径实际发生的概率比看上去低。
记在这里，免得以后有人以为补完注册表就万无一失了。

---

## 怎么证伪

四种手段里，这一章能用的是**单元测试**，其余三种要说清为什么不能用。

### 单元测试（新增 `packages/harness-testing/test/prompts.test.ts`）

| # | 断言 | 会红在什么情况 |
|---|---|---|
| T1 | 两个提示词模块的命名空间里，每个以 `_STABLE` 结尾或名为 `ORACLE_STRICT` 的导出，都必须是 `promptSources()` 的一个值，或在豁免名单里**并写明理由** | 新加一个提示词、忘了登记 |
| T2 | `casesStable()` 在全部 4×2 种输入下的返回值，`key` 都在 `promptSources()` 里，`sha8(text)` 都等于登记值 | 新加一个改正文的消融开关、忘了登记它的臂 |
| T3 | 同时消融 `case-priority` 与 `case-cleanup`，结果里两段都不在，且是 `CASES_STABLE` 的子集 | 选择器退回"第一个命中就走" |
| T4 | 每份派生 `.txt` 与当场算出来的文本逐字相等；`digests.json` 与 `promptSources()` 逐键相等 | 任何提示词或标记的改动 |
| T5 | 豁免名单里每一项都有非空理由字符串 | 有人用空理由把 T1 关掉 |

T1 和 T5 是照抄 `test/casegen.test.ts:713-722` 那份 `filledByHarness` 的形状：
豁免可以有，但每一条要说得出为什么，"一个没有理由的豁免就是把这条测试关掉"。
那份写法已经在这个仓库里挡住了第四次同类事故，直接复用比另发明一种好。

**T1 有一个说清楚的边界**：它只看得见 `export` 的标识符。
`REVISE_STABLE` / `CRITIC_STABLE` / `JUDGE_STABLE` 是在变更一里被导出之后才落进 T1 的网；
一个未来的作者完全可以再写一个模块私有的 `const STABLE` 并直接发出去，T1 抓不到。
真正抓得到的是对 9 个 `model.chat` 调用点做源码扫描——但那要正则匹配源文本，
在这个仓库里是新的一类脆弱。**取舍是接受这个洞，并把它写进 T1 的注释**，
理由是：被导出是提示词复用的必经之路，而模块私有的一次性提示词至少不会被第二处引用。

### 配对评测：不适用，并且必须证明它不适用

这一章的改动**不该改变任何发给模型的字节**。跑 A/B 是在问一个已经知道答案的问题。

反过来，"它有没有偷偷改了字节"才是要证的，而这有现成的办法：

```
pnpm --filter @testpilot/harness-testing g1 --replay
```

`fixtures/recordings/g1.json` 有 **15 条**录像，键是 `requestKey()`
（`client.ts:73-83`，`sha256(stable + variable + schema)` 取前 32 位）。
任何一个 `stable` 字节的变动都会让重放报
`no recording for design.cases:US-01 (...). Re-record with mode "record", or fix the prompt that changed.`
（`client.ts:130`）。**全部 15 条命中 = 这一轮改动一个字节都没碰到线上。**

（顺带更正一处容易被记错的事：这些录像**不在 `pnpm test` 里**——
`grep RecordedModel packages/*/test/` 命中数为 0，唯一读它的是 `scripts/run-g1.ts:33-55`。
所以"改提示词会弄红一堆测试"这句话在这个仓库里**不成立**，改提示词今天不会弄红任何东西。
这恰恰是本章存在的理由。）

### 门禁规则：不适用

按 [第 00 章](./00-方法与约定.md) 的口径，门禁指 `casegen/gate.ts` / `codegen/gate.ts` ——
它们逐条标记**产物**。提示词的完整性不是产物的性质，硬塞进门禁会得到一条
"跟本批用例无关却会把它标红"的规则。不做。

### 消融开关：**不该**有

见变更六。一个能被关掉的指纹不是指纹。这一栏的答案是"故意没有"，不是"没想到"。

---

## 验收

1. `promptSources()` 的键从 6 个变成 14 个（含 `spec.compose`、三条 `design.cases` 组合臂、`revise`），
   `judgeSources()` 有 2 个键。
2. `pnpm --filter @testpilot/harness-testing test` 全绿，测试数从 **341** 涨到 341+k，耗时仍在 2 秒内。
3. 从 `promptSources()` 里删掉任意一行 → T1 红，报错点名缺失的那个 key。
4. 把 `COMPOSE_STABLE` 里任意一个字改掉 → T4 红在 `digests.json` 上；
   把 `CASES_STABLE` 里任意一个字改掉 → T4 红在四份 `.txt` 上，且 `git diff` 直接显示每条臂各变了哪几行。
5. 把 `nodes.ts` 的选择器改回三个 `if...return` → T3 红。
6. `pnpm --filter @testpilot/harness-testing g1 --replay`：15 条录像全命中——证明整轮改动没有动到发给模型的字节。
7. 跑一次 `ablate: ["case-priority"]` 的真实运行，`GET /api/wf/runs/<id>` 的
   `detail.prompts.entries` 里出现 `design.cases:no-priority`，值为 `fc9d2fe7`，且与同图 A 臂的
   `design.cases` 值不同。**这条是本章的中心断言，其余都是它的支架。**
8. 跑一次 `ablate: ["case-priority","case-cleanup"]`，agent 日志里的 `stable` 两段都不在，
   `entries` 里出现合成臂的键。
9. 拿新运行的指纹与 `evals.db` 里 `eval-mtfp02ly` 的旧指纹做 `digestDelta`：
   `added` 有 4 项，`moved` 为空（若期间没改过提示词）。
10. `prompt_versions` 表里查得到 `eeaa3b9e` 的正文，且长度为 3754。

---

## 附：一句话总结这一章为什么值得做

`packages/harness-testing/src/prompts.ts:16` 那句话是这个仓库自己写下的，
而它此刻描述的是自己：

> 一个有洞的指纹比没有指纹更糟——它会被相信。

两次跑完的配对评测里，那个洞已经在了。它这次没有让结论出错，
但它让"这两臂被告知了同样的话"这句假话，以 `e5b80c75` 的形式被写进了记录并留了下来。
