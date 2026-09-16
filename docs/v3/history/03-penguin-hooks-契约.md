# PenguinHarness hook 契约

> 本仓库第一份关于 hook 的记录。**全部来自读 PenguinHarness 源码与一次真实 trace，不是猜的。**
> 依据：`packages/core/src/hooks/{index,answer,prompt-hook,tool-hook,stop-hook,script-hook}.ts`、
> `packages/core/src/plugins/index.ts`、`packages/core/src/state/agent-state.ts`、
> `plugins/README.md`、`packages/docs/content/agent-loop.en.md`，
> 以及 Phase 0 那次跑的 trace（`agents/testpilot/traces/2026-09-03/session-…-e3d948ee_001.jsonl`）。
> Phase 1B 的三个校验 hook 就建在这份契约上；契约错了，那三个 hook 全是空的。

## 1. 三个 hook 点，只有三个

| 点 | 什么时候跑 | 谁触发 | 能不能拦 | 能不能把话说回给模型 |
|---|---|---|---|---|
| `pre_tool_use` | **每一次完整的工具调用之前、审批之前** | `context_engine`，自动 | **能**（`deny`） | **能**——但**只有 deny 的 `reason` 进模型上下文** |
| `stop` | 一个 Task 结束时（模型给出不带工具调用的最终答复，或被截断） | `Session.run` 的循环，自动 | 不能拦，但**能不让它结束**（`continue`） | **能**——`input` 直接成为下一个 Task 的 user 消息 |
| `user_prompt` | 宿主接受一条用户输入、且该输入属于这个包拥有的流程时 | **宿主显式调** `Session.runUserPromptHook(name, prompt, extras)` | 不能 | 能（`context` 跟在用户消息后面发出） |

**没有别的点。** 没有 tool 之后（post_tool_use）、没有 turn 结束、没有 session 结束。
`stop` 是「Task 结束」，不是「session 结束」——一次 `penguin run` 里每个 Task 结束都会问一遍。

`user_prompt` 对我们没用：它要**宿主**主动调，而宿主（CLI / server）只为 goal 模式调过。
一个装进 `agent_state/hooks/` 的包并不会因为装了就被 `penguin run` 触发这个点。
**结论：TestPilot 能用的只有 `pre_tool_use` 和 `stop`。**

## 2. 进程契约

hook 是**子进程**，不是被 load 进 Session 进程的代码（`script-hook.ts`）：

- 启动方式：`spawn(process.execPath, [script])`，即用 Node 跑，`ELECTRON_RUN_AS_NODE=1`。
- **cwd = hook 包自己的目录**（`agent_state/hooks/<plugin>/`），不是 workspace。`command` 相对这个目录解析。
- stdin：一行 JSON。stdout：一个 JSON 对象，**空 stdout = 弃权**。
- 退出码非 0 = 失败，stderr 末尾 400 字符成为 `reason`。
- 超时：`hooks.json` 里那条命令的 `timeout` 秒；不写则 **60 秒**（`DEFAULT_HOOK_TIMEOUT_S`）。超时 SIGKILL。
- **崩溃 / 超时 / 打印非 JSON 的 hook 一律记一条 `hook` 事件然后当作弃权**，绝不会把这次 run 弄死（`answer.ts` 的 `failedAnswer`）。
  ——这条对我们是双刃的：**一个写错的校验 hook 不会报错，它会静悄悄地什么都不拦。**

### stdin 的确切形状

```jsonc
// stop
{ "hook": "stop", "session_id": "session-…", "trace_path": "/abs/…/session-…_001.jsonl" }

// pre_tool_use —— 多三个字段，调用本身就在里面
{ "hook": "pre_tool_use", "session_id": "…", "trace_path": "/abs/…",
  "tool_name": "write_file",
  "tool_call_id": "chatcmpl-tool-…",
  "arguments": "{\"file_path\":\"…\",\"content\":\"…\"}" }   // ← 字符串，不是对象

// user_prompt —— 没有 trace_path，换成 scratchpad_dir
{ "hook": "user_prompt", "session_id": "…", "scratchpad_dir": "/abs/…", "prompt": "…", …extras }
```

`arguments` 是**模型原样写出来的 JSON 字符串**，要自己 `JSON.parse`，而且要准备好它解析不出来
（模型写坏了 JSON 也会走到 hook 这里）。

### stdout 的确切形状

```jsonc
// pre_tool_use（parsePreToolUseResult）
{ "decision": "allow" | "deny",              // 别的值一律丢掉 = 弃权
  "reason": "一句话",                          // deny 时这句进模型上下文
  "output": { "k": "标量" } }                  // 只保留 string/number/boolean 的键

// stop（parseStopHookResult）
{ "decision": "continue" | "stop",
  "input": "下一个 Task 的 user 消息",          // continue 必须带，否则 continue 不生效
  "reason": "…", "output": { … },
  "subagent": { "prompt": "…", "agent_id": "…" } }
```

解析是**宽容的**：不认识的字段丢掉、类型不对的忽略、`output` 只留标量。
所以「写了但没生效」的失败方式是存在的，而且不报错。

## 3. 拒绝与注回，具体能到什么程度

**`pre_tool_use` 能真的拒绝。** `deny` 直接绕过审批回调，模型读到的工具输出就是这次拒绝，
里面带 hook 的 `name` 和 `reason`。两条边界由构造保证：

- project 的命令策略**压过** hook 的 `allow`（hook 住在 agent 可写的 state 里，策略是 project 拥有的安全配置）；
- 所以 hook 只能**收窄**，`deny` 永远安全，`allow` 不一定被兑现。

**注回消息只有两条真通道：**

1. `pre_tool_use` 的 **deny + reason** —— 模型一定读到（它就是那次工具调用的输出）。
2. `stop` 的 **continue + input** —— 成为下一个 Task 的 user 消息，模型一定读到。

**`allow` 的 `reason` 不进模型上下文**，只进 `hook` 事件（trace + 流）。
这一条直接决定了 Phase 1B 的设计：门禁**过了**的时候没法把数字塞给模型，
只能写进 `runs/<id>/gate.json` 再由 SKILL 正文要求模型自己去读。**这是一处退化，记在这里。**

`stop` 的两条限制：被截断（用户中断 / LLM 失败 / max_turns）之后，或 signal 已 abort，
`continue` 会被记录但**不执行**——用户的中断压过任何 hook。所以 stop hook 不能用来做死循环。

## 4. hook 能读到什么

stdin 只给 `session_id` 和 `trace_path`。**workspace 路径不在 stdin 里。**
但 trace 的第一行是 `session_meta`，payload 里有：

```jsonc
{ "session_id": "…", "provider": "custom", "model_id": "…",
  "agent_state": "/…/agents/<id>/agent_state",
  "workspace":   "/…/agents/<id>/workspaces/<name>" }   // ← 就是它
```

**读 trace 第一行拿 workspace**，是 hook 定位 `runs/<runId>/` 的唯一正当办法。
（`pre_tool_use` 还有第二条路：`write_file` 的 `arguments.file_path` 本身就是绝对路径。）

hook 是普通 Node 子进程，**对文件系统没有额外限制**：能读 workspace、能写 `runs/<id>/gate.json`、
能读 `agent_state/`。「hook 只能只读」不是真的。

## 5. 安装形态：`hooks.json` 是**生成**的，不是手写的

库里的 plugin 长这样（`plugins/README.md` + `plugins/index.ts`）：

```
plugins/<name>/
├── plugin.json          ← 唯一的元数据来源，含 hooks.{stop,pre_tool_use,user_prompt} 命令表
├── icon.svg             ← plugin 的图标，装出去的 skill 和 hook 包都继承它
├── skills/<skill>/SKILL.md
└── hooks/*.mjs
```

装到 agent 上之后（`agent-state.ts` 的 `installHook`）：

```
agent_state/hooks/<plugin>/
├── hooks.json           ← 装的时候从 plugin.json 生成，JSON.stringify(manifest, null, 2)
├── icon.svg
└── *.mjs                ← hooks/ 下的文件原样拷过来（递归，子目录保留）
```

`hooks.json` 的形状（`HookManifest`）：

```jsonc
{ "name": "testpilot", "description": "…", "description_zh": "…", "version": "YYYY-MM-DD.N",
  "stop":          [ { "command": "require-gate.mjs", "timeout": 60 } ],
  "pre_tool_use":  [ { "command": "validate-stories.mjs", "timeout": 60 } ],
  "user_prompt":   [] }
```

三个键**都必须在**（安装器写的是 `?? []`），`command` 相对 hook 包目录。
`listInstalledHooks` 靠 `hooks.json` 认包：**目录里没有 hooks.json 就不是 hook 包**，会被跳过——
又一个静默失败。目录名是身份，manifest 里写别的名字会被纠正。

### 我们为什么不能走 `penguin plugin install`

`pluginRoots()` 只认**宿主 package.json 的 `dependencies` 里 `@penguinharness/` 开头的包**，
用 `require.resolve` 从 core 自己的位置解析。`plugins/testpilot/` 是本仓库的目录，
不是装在 penguin 的 node_modules 里的 npm 包，**库里根本看不见它**。
所以 Phase 1B 自带 `install.sh`：把 `skills/*` 拷进 `agent_state/skills/`、
`hooks/*` 拷进 `agent_state/hooks/testpilot/`，并**按上面的形状自己生成 `hooks.json`**。
这不是绕路，是这个安装形态下唯一的路——生成的东西和官方安装器写的一模一样。

## 6. 版本与 frontmatter

- 版本是 `YYYY-MM-DD.N`（`PLUGIN_VERSION_PATTERN`），plugin.json 和每个 skill 都带。
  不匹配这个正则的版本读成 `""`，排序时**比任何真版本都旧**。
- 库里的 `SKILL.md` frontmatter **只带 `name` 和 `description`**；
  `version` / `short_description(_zh)` 由 loader 从 plugin.json 盖进去（`stampSkill`），
  装出去的那份 frontmatter 是**生成的完整版**。我们的 install.sh 照做。
- frontmatter 解析器是手写的，**不是 YAML**：只认第一个 `---` 块里的 `key: value`，
  按第一个冒号切，值可以再含冒号。**别在 frontmatter 里写多行、写数组、写引号技巧**——解析不出来。
- 目录名就是 skill 名（覆盖 frontmatter 里写的）；名字必须匹配 `^[A-Za-z0-9_-]+$`。

## 7. 工具名：MCP 工具带前缀

Phase 0 的 trace 第 30 行是个现成的教训：模型按 SKILL.md 写的调 `run_pipeline`，
拿到 `Unknown tool: run_pipeline`，第 36 行改成 **`mcp__testpilot__run_pipeline`** 才成。

对 hook 的影响：`pre_tool_use` 的 `tool_name` 收到的是**带前缀的全名**。
要拦 MCP 工具就得匹配 `mcp__<server>__<tool>`；内建工具是裸名（`write_file` / `read_file` / `exec_command` / …）。

内建工具全表（Phase 0 trace 第 5 行 `tool_list_ready`）：
`read_file` · `edit_file` · `write_file`(`file_path`,`content`) · `exec_command` · `input_command` ·
`run_subagent` · `input_subagent` · `read_image`。

## 8. 对 Phase 1B 的直接后果

| 想做的事 | 能不能做 | 怎么做 |
|---|---|---|
| 模型写 `stories.json` 时校验 schema，不过就拒 | **能** | `pre_tool_use` 拦 `write_file`，`file_path` 命中 `stories.json`，`JSON.parse(arguments)` 后 zod 校验，失败 `deny` + zod 报错进 `reason` |
| 同上，`cases.json` | **能** | 同上 |
| 跑门禁并把 findings 数 / negativeRatio / 阈值告诉模型 | **一半** | 门禁**不过**时：`deny` + 注回，可靠；门禁**过**时：`allow` 的 reason 模型看不见，只能写 `gate.json` 让模型自己读 |
| `stopAfter`：分数低于阈值就不许进下一步 | **能** | 门禁 hook 拦住写 `meta.json` 那一次调用；写不出 meta.json，这次运行就没有产物签名 |
| 宣布完成前必须有 `gate.json` | **能** | `stop` hook：缺东西就 `continue` + `input` 说缺什么。**必须自带计数上限**，否则模型不配合时会来回拉扯 |
| tool **之后**做点什么（比如落盘后校验） | **不能** | 没有这个点。只能提前到 `pre_tool_use`（校验的是**将要写的内容**，不是已写的文件） |
| session 结束时收尾 | **不能** | `stop` 是 Task 结束，不是 session 结束 |

**最后一条，也是最容易被忘的**：hook 崩溃 = 弃权 = 静默放行。
所以每个 hook 脚本自己要 try/catch 到底，并且**在拿不准的时候倾向于 deny**，
而不是让一个异常把整道门禁变成一个装饰。

## 9. **已安装的这个版本还没有 hook**（2026-09-03 实测）

上面整份契约是从 `Prism-Shadow/penguin-harness` 的 **main 分支源码**读出来的，它是准确的。
但这台机器上装的**发布版没有实现它**：

```
@prismshadow/penguin-cli   0.2.9
@prismshadow/penguin-core  0.2.9   （随 CLI 一起装）
```

对整个 CLI 包（含所有嵌套 node_modules）grep：

| 字符串 | 命中文件数 |
|---|---|
| `pre_tool_use` | **0** |
| `listInstalledHooks` | **0** |
| `runStopHooks` | **0** |
| `runPreToolUseHooks` | **0** |
| `"hooks.json"` | **0** |
| `scriptStopHook` | **0** |
| —— 对照 —— | |
| `mcpServers` | 28 |
| `session_meta` | 20 |
| `agent_state` | 24 |

对照那三行说明 grep 本身是有效的。上游那条 changelog 也还躺在
**`changelog/unreleased/2026-08-29-stop-hook-goal-mode.md`**——**未发布**。

### 实测后果

Phase 1B 的 C 臂真跑了一次（`testpilot_c` / workspace `phase1b` /
trace `session-2026-09-03-10-59-08-7a464502_001.jsonl`，393 行）：

- **`hook` 事件 0 条。** 11 次 `write_file` 调用（其中 6 次写 `runs/<id>/*.json`）
  没有任何一次被 `pre_tool_use` 看见；Task 结束时 `stop` 也没被问。
- `agent_state/hooks/testpilot/` 装得完全正确（`hooks.json` + 4 个脚本 + `tp-config.json`），
  但**没有任何东西去读它**。
- 于是 `gate.json` 没有自动生成，agent 自己手跑了 `gate1.mjs` 补上（它如实报告了这件事）。

**四个 hook 脚本本身是好的**——用构造出来的 stdin 逐个测过，
拒绝、放行、注回、计数封顶都对（见下）；把真产物喂给它们也给出正确答案。
缺的是**harness 这一侧的触发**。

### 这条对 Phase 3 的约束

**在装上带 hook 的版本之前，C 臂与 A 臂的差别不止「Agent State 版本」一件事**——
C 臂的校验与门禁没有在运行中执行，而 A 臂的 `run_pipeline` 内部执行了。
拿这两臂做配对评测，比的不是「提示词进 skill 有没有用」，
而是「有门禁 vs 没门禁」。**那个数字会很好看，而且是假的。**

升级之前，退化路径是 §8 表格最后一行的那个：把顺序与校验写进 SKILL.md 正文，
靠模型自觉。`testpilot-run-c` 已经这么写了（「不许跳步 / 不许自评 / 不许绕过 hook」），
但**指令不是门禁**：它拦不住一个决定绕过去的模型，也不会留下拦截记录。
