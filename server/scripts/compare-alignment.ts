/** 只读：两次运行的「用例与故事对齐度」对照。直接读单元产物，不依赖合并。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { acceptanceIndex, acceptanceIsActionable, acceptanceWhen } = await import("../src/acceptanceIndex.js");
const l = runLedger();
const projectId = process.argv[2]!;
const NAV = /^\s*(打开|访问|导航|前往|进入|open|navigate|go to)/i;
const ACT = /(?<![节终观重焦特优缺地时起热盲难要看论支据零冰卖买基]) ?点(?![差位评子心缀])|单击|双击|敲|按下|按住|长按|填入|填写|键入|粘贴|输入(?!框)|勾选|取消勾选|勾上|选择(?!器|框)|选中|选定|切换(?!器)|切到|滚动|拖动|拖拽|悬停|提交|上传|清空|设置|设为|设成|执行|打开|关闭|展开|收起|滑动|调整|修改|启用|停用|连接|断开|下单|撤单|撤掉|撤销|取消|平仓|开仓|转账|充值|提现|划转|刷新|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press/i;
const LOOK = /^\s*(查看|看一?下|观察|留意|注意|浏览|确认|验证|检查|断言|校验|读取|look|observe|inspect|view|assert|verify|ensure|check|confirm)/i;
const norm = (x: string) => x.replace(/[\s“”"'（）()、,，。.]/g, "");

function collect(runId: string) {
  const revs = l.listRevisions(projectId, runId);
  const stRev = revs.filter((r: any) => r.name === "validated/stories").at(-1)!;
  const stories: any[] = (l.readRevision(stRev.id, projectId).content as any).stories;
  const caseRevs = revs.filter((r: any) => /^units\/cases\//.test(r.name));
  let cases: any[] = caseRevs.flatMap((r: any) => (l.readRevision(r.id, projectId).content as any).cases ?? []);
  if (!cases.length) {
    const cRev = revs.filter((r: any) => r.name === "validated/cases").at(-1);
    cases = cRev ? (l.readRevision(cRev.id, projectId).content as any).cases : [];
  }
  return { stories, cases };
}

function report(label: string, runId: string) {
  const { stories, cases } = collect(runId);
  const entries = acceptanceIndex(stories);
  const known = new Set(entries.map((e) => e.id));
  const hasAction = (c: any) => (c.steps ?? []).some((s: string) => !NAV.test(s) && ACT.test(s) && !LOOK.test(s));
  let refs = 0, byId = 0, verbatim = 0, invented = 0;
  for (const c of cases) for (const r of (c.acRefs ?? [])) {
    refs++;
    if (known.has(r)) byId++;
    else if (entries.some((e) => e.storyId === c.storyId && norm(e.text) === norm(r))) verbatim++;
    else invented++;
  }
  const steps = cases.map((c: any) => (c.steps ?? []).length);
  const dist = new Map<number, number>(); for (const n of steps) dist.set(n, (dist.get(n) ?? 0) + 1);
  const noAct = cases.filter((c: any) => !hasAction(c));
  // 动作型准则被真做过的比例
  const actionable = entries.filter((e) => e.actionable);
  const covered = actionable.filter((e) => cases.some((c: any) => (c.acRefs ?? []).some((r: string) => r === e.id || norm(r) === norm(e.text)) && hasAction(c)));
  console.log(`\n===== ${label}  (${runId.slice(0, 12)}) =====`);
  console.log(`故事 ${stories.length} · 验收准则 ${entries.length}（要动手 ${actionable.length}）· 用例 ${cases.length}`);
  console.log(`acRefs ${refs} 条：按编号 ${byId} · 逐字原文 ${verbatim} · **自己编的 ${invented}**（${refs ? Math.round(invented / refs * 100) : 0}%）`);
  console.log(`步数：${[...dist].sort((a, z) => a[0] - z[0]).map(([k, v]) => `${k}步 ${v}条`).join(" · ")} · 平均 ${(steps.reduce((a, b) => a + b, 0) / steps.length).toFixed(1)}`);
  console.log(`除了导航什么都不做的用例：${noAct.length}/${cases.length}（${Math.round(noAct.length / cases.length * 100)}%）`);
  console.log(`要动手的准则被「真做了动作的用例」覆盖：${covered.length}/${actionable.length}（${actionable.length ? Math.round(covered.length / actionable.length * 100) : 0}%）`);
  const subsumed = new Set(stories.flatMap((s: any) => s.subsumes ?? []));
  if (subsumed.size) console.log(`长故事覆盖短故事：${stories.filter((s: any) => (s.subsumes ?? []).length).length} 条覆盖方 · ${subsumed.size} 条被覆盖（少出 ${subsumed.size} 个用例单元）`);
}
for (const [label, runId] of process.argv.slice(3).reduce((a: string[][], x, i, arr) => (i % 2 ? a : [...a, [x, arr[i + 1]!]]), []))
  report(label, runId);
