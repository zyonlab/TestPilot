# `runs/<runId>/meta.json` 的形状

它是 P3「来源印记」的载体。数据契约 §2 的拒收规则：
**`skillVersion` / `promptsDigest` / `model` / `materialsHash` 缺任一项 → `score_run` 抛错，不打分。**
所以这个文件不是收尾的装饰，它是这次运行**能不能被称量**的前提。

```json
{
  "runId": "20260903T101530",
  "stage": "g1",
  "skillVersion": "2026-09-03.1",
  "promptsDigest": {
    "entries": {
      "testpilot-design/REFERENCE-oracle.md": "1a2b3c4d",
      "testpilot-design/SKILL.md": "5e6f7a8b",
      "testpilot-stories/SKILL.md": "9c0d1e2f"
    },
    "combined": "3a4b5c6d"
  },
  "params": { "limit": 2 },
  "ablated": [],
  "model": { "baseUrl": "https://…/v1", "model": "…", "thinking": true },
  "materialsHash": "0123456789abcdef",
  "startedAt": "2026-09-03T10:15:30Z",
  "finishedAt": "2026-09-03T10:24:11Z",
  "spend": { "calls": 0, "tokens": 0, "ms": 0 }
}
```

## 每个值从哪来

| 字段 | 怎么取 |
|---|---|
| `runId` | 第 0 步 `date -u +%Y%m%dT%H%M%S` 的那个值 |
| `stage` | `"g1"`（从材料生成文本用例这一段永远是 g1） |
| `skillVersion` | **你正在用的这套 skill 的版本**：`agent_state/skills/testpilot-run-c/SKILL.md` 的 frontmatter 里那行 `version:` |
| `promptsDigest` | 下面那条命令 |
| `params` | 这次运行带的参数。用户说了「最多 2 条故事」就写 `{"limit": 2}`；什么都没说就写 `{}` |
| `ablated` | 这次**卸掉了哪些 REFERENCE**。正常运行是 `[]`；消融实验里写被卸掉的文件名 |
| `model` | 一个对象，**恰好三个键**：`baseUrl`（模型端点的 base URL，形如 `https://…/v1`，取自 Environment 的 base_url，或运行环境里的 `$OPENAI_BASE_URL`）、`model`（Model ID）、`thinking`（当前 thinking level 是否开着，布尔）。**键名就是 `baseUrl` 不是 `provider`**——写成 `provider` 会让 `score_run` 按 P3 拒收这次运行（binding 不完整就等于没有 binding）。见上方例子 |
| `materialsHash` | 下面那条命令 |
| `startedAt` / `finishedAt` | 第 0 步记的那个，和写 meta 时的 `date -u +%Y-%m-%dT%H:%M:%SZ` |
| `spend` | C 臂的模型调用发生在 agent 自己身上，你数不出准确的 token 数。**三个都填 0**，不要编。数字要从 trace 里读，那是 server 的事 |

### `promptsDigest`

C 臂的「提示词」就是你读过的那些 SKILL.md 与 REFERENCE。
**摘要必须覆盖它们全部**——只摘 SKILL.md 而漏掉 REFERENCE，
两次卸载了不同 REFERENCE 的运行会得到同一个 digest，于是配对评测在比两批**不同**的东西
而以为它们相同。这正是 `digest.ts` 开头说的「唯一一种每个数字都对、但结论是假的比较」。

```bash
S="<app_data_dir>/agents/<agent_id>/agent_state/skills"
cd "$S" && for f in $(find testpilot-stories testpilot-design testpilot-run-c -type f -name '*.md' | sort); do
  printf '%s %s\n' "$f" "$(shasum -a 256 "$f" | cut -c1-8)"
done
```

`entries` 是「文件名 → 前 8 位」的对象（**按文件名排序**）；
`combined` 是把 `名字:摘要` 用 `|` 连起来再取一次 sha256 前 8 位：

```bash
cd "$S" && find testpilot-stories testpilot-design testpilot-run-c -type f -name '*.md' | sort \
  | while read -r f; do printf '%s:%s|' "$f" "$(shasum -a 256 "$f" | cut -c1-8)"; done \
  | sed 's/|$//' | shasum -a 256 | cut -c1-8
```

（管道最后那个 `sed` 去掉末尾的 `|`——多一个字符就是另一个摘要。）

### `materialsHash`

材料目录内容的 sha256 **前 16 位**：

```bash
cd "<workspace>/materials" && find . -type f | sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16
```

## 为什么 `spend` 填 0 不算撒谎

`RunMeta` 要求这个键在，但没要求你去猜。**编一个看起来合理的 token 数，
比填 0 坏得多**——0 明显是「没测量」，而 12480 会被当成测量结果，
然后进到某张成本对比表里。
