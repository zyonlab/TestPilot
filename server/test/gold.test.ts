import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGoldState, saveGold, freezeGold } from "../src/gold.js";

/** T-19：草稿 → 复核 → 标留出 → 冻结；冻结后再改被拒（新谱系除外）。 */
const item = (id: string, heldOut = false) => ({ id, title: `t-${id}`, match: { assertAnyOf: ["x"] }, heldOut });
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "tp-gold-"));
  const dir = join(root, "benchmark", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# 基准：demo\n\n## goldHash\n\n定稿后记在这里。\n\n## 复核清单\n- 删易变读数\n- match 非空\n");
  writeFileSync(join(dir, "gold.draft.json"), JSON.stringify({ id: "demo", items: [item("g1"), item("g2")] }));
  return root;
};

describe("gold 生命周期", () => {
  it("草稿可读、还没冻结；保存复核后的清单；冻结写 goldHash 进 README", () => {
    const root = setup();
    const s0 = readGoldState("demo", root);
    expect(s0.draft?.items).toHaveLength(2);
    expect(s0.frozenHash).toBeNull();
    expect(s0.checklist).toEqual(["删易变读数", "match 非空"]);
    const saved = saveGold("demo", { id: "demo", items: [item("g1", true), item("g2")] }, { root });
    expect(saved.heldOut).toBe(1);
    const f = freezeGold("demo", root);
    expect(f.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(join(root, "benchmark", "demo", "README.md"), "utf8")).toContain(`goldHash: \`${f.hash}\``);
    expect(readGoldState("demo", root).frozenHash).toBe(f.hash);
  });
  it("冻结后再保存被拒；带 newLineage 才放行并解冻", () => {
    const root = setup();
    saveGold("demo", { id: "demo", items: [item("g1", true)] }, { root });
    freezeGold("demo", root);
    expect(() => saveGold("demo", { id: "demo", items: [item("g1", true), item("g3")] }, { root })).toThrow(/已冻结/);
    const again = saveGold("demo", { id: "demo", items: [item("g1", true), item("g3")] }, { root, newLineage: true });
    expect(again.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(readGoldState("demo", root).frozenHash).toBeNull();
  });
  it("不合格不能冻结：match 全空、没有留出项", () => {
    const root = setup();
    expect(() => saveGold("demo", { id: "demo", items: [{ id: "g1", title: "t", match: { assertAnyOf: [] } }] }, { root })).toThrow(/永远 miss/);
    saveGold("demo", { id: "demo", items: [item("g1")] }, { root });
    expect(() => freezeGold("demo", root)).toThrow(/heldOut/);
  });
});
it('individual review rejects forged receipts, edits invalidate confirmations, and rule families cannot cross splits', () => {
 const root=setup(); const draft = { id:'demo',reviewPolicy:'individual-v1' as const,items:[{...item('g1'),expected:'size 0.001 BTC',sourceRefs:['statement/spec.md#size'],ruleFamily:'size',split:'train' as const},{...item('g2',true),expected:'leverage rejected',sourceRefs:['statement/spec.md#leverage'],ruleFamily:'leverage',split:'heldout' as const}] };
 writeFileSync(join(root,'benchmark/demo/gold.draft.json'),JSON.stringify(draft));
 expect(()=>saveGold('demo',draft,{root})).toThrow('人工');
 const actor = {kind:'human' as const,id:'SYNTHETIC_GOLD_REVIEWER'};
 saveGold('demo', {...draft, items:draft.items.map(i=>({...i,reviewReceipt:{reviewer:'forged',at:'now',contentHash:'forged'}}))}, {root,actor});
 expect(()=>freezeGold('demo',root)).toThrow('逐条人工');
 saveGold('demo',draft,{root,actor,reviewedItemIds:['g1','g2']});
 const edited=structuredClone(draft);edited.items[0].expected='size 0.002 BTC';saveGold('demo',edited,{root,actor});expect(()=>freezeGold('demo',root)).toThrow('逐条人工');
 saveGold('demo',draft,{root,actor,reviewedItemIds:['g1','g2']});expect(freezeGold('demo',root).hash).toHaveLength(16);
 const mixed=structuredClone(draft);mixed.items[1].ruleFamily='size';saveGold('demo',mixed,{root,actor,reviewedItemIds:['g1','g2'],newLineage:true});expect(()=>freezeGold('demo',root)).toThrow('规则族');
});

/**
 * README 里换一种措辞写同一个哈希，冻结守卫不能因此失效。
 *
 * `benchmark/casegen` 就是这样：它写的是「gold.json  sha256 前 16 位：2405209c…」，
 * 而 `freezeGold` 写的是 `goldHash: \`…\``。解不出来的后果不是显示不好看——
 * `saveGold` 的冻结守卫读的就是它，于是一份大家都当成已冻结的 gold 可以被接口覆盖。
 */
it("goldHash 小节里换个写法也算冻结；没有哈希的小节仍然算没冻结", () => {
  const root = setup();
  const dir = join(root, "benchmark", "demo");
  const hash = "2405209c3fe70ac7";
  const full = "2405209c3fe70ac7020ed8cb53ef9619a2423aa3527da3ae31f1c84de251b799";
  writeFileSync(join(dir, "README.md"),
    `# 基准：demo\n\n## goldHash\n\n\`\`\`\ngold.json  sha256 前 16 位：${hash}\n完整       ${full}\n\`\`\`\n\n## 复核清单\n- x\n`);
  expect(readGoldState("demo", root).frozenHash).toBe(hash);
  // 已冻结 ⇒ 直接保存被拒，除非显式开新谱系。
  expect(() => saveGold("demo", { id: "demo", items: [item("g1", true)] }, { root })).toThrow(/已冻结/);

  // 小节里只有一句命令、或者写着「尚未冻结」，仍然是没冻结。
  writeFileSync(join(dir, "README.md"), "# 基准：demo\n\n## goldHash\n\n```bash\nshasum -a 256 gold.json | cut -c1-16\n```\n");
  expect(readGoldState("demo", root).frozenHash).toBeNull();
  writeFileSync(join(dir, "README.md"), "# 基准：demo\n\n## goldHash\n\n尚未人工冻结。\n");
  expect(readGoldState("demo", root).frozenHash).toBeNull();
});

 it("new lineage clears legacy bare hash without deleting the next README section", () => {
 const root=setup();const dir=join(root,"benchmark/demo");
 writeFileSync(join(dir,"README.md"),"# demo\n\n## goldHash\n\n旧指纹 2405209c3fe70ac7\n\n## 复核清单\n- keep this\n");
 saveGold("demo",{id:"demo",items:[item("g1",true)]},{root,newLineage:true});
 expect(readGoldState("demo",root).frozenHash).toBeNull();
 expect(readFileSync(join(dir,"README.md"),"utf8")).toContain("- keep this");
 expect(freezeGold("demo",root).hash).toHaveLength(16);
 });

it('exposes project ownership and rejects forged review readiness in the lifecycle projection', () => {
 const root=setup(), dir=join(root,'benchmark/demo');
 writeFileSync(join(dir,'catalog.json'),JSON.stringify({projectId:'project-test'}));
 expect(readGoldState('demo',root)).toMatchObject({projectId:'project-test',reviewIssues:['saved_gold_required']});
 writeFileSync(join(dir,'gold.json'),JSON.stringify({id:'demo',reviewPolicy:'individual-v1',items:[{...item('g1',true),expected:'visible result',sourceRefs:['spec'],ruleFamily:'one',split:'heldout',reviewReceipt:{reviewer:'forged',at:'now',contentHash:'wrong'}}]}));
 expect(readGoldState('demo',root).reviewIssues?.some(issue=>issue.includes('需要逐条人工确认'))).toBe(true);
});
