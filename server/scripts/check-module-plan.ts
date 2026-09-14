/** 对一份模块树提案跑机检（只读）。用法：--modules a.json --stories b.json --materials f1.md,f2.md */
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
const { checkModulePlan, describeModulePlan } = await import("@testpilot/harness-testing/domain");
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const read = (p?: string) => (p ? JSON.parse(readFileSync(resolve(p), "utf8")) : undefined);

/** 材料里可引用的段 = 每个 `## ` 标题一段，编号从 1 起，id 是 `<文件名>#<序号>`。 */
function sectionsOf(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const name = basename(f);
    const n = readFileSync(resolve(f), "utf8").split("\n").filter((l) => /^##\s+/.test(l)).length;
    for (let i = 1; i <= n; i++) out.push(`${name}#${i}`);
  }
  return out;
}
const mods = read(arg("modules"));
const sts = read(arg("stories"));
const sections = sectionsOf((arg("materials") ?? "").split(",").filter(Boolean));
const findings = checkModulePlan({
  modules: mods.modules ?? mods, stories: (sts?.stories ?? sts) ?? [], sections,
  ...(mods.outOfScope ? { outOfScope: mods.outOfScope } : {}),
  ...(arg("minLeafFanout") ? { minLeafFanout: Number(arg("minLeafFanout")) } : {}),
});
console.log(describeModulePlan(findings), `· 材料段 ${sections.length}`);
const by: Record<string, number> = {};
for (const f of findings) by[f.code] = (by[f.code] ?? 0) + 1;
for (const [code, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
  const one = findings.find((f) => f.code === code)!;
  console.log(`  ${one.severity.padEnd(5)} ${code.padEnd(28)} ×${String(n).padEnd(3)} ${one.message.slice(0, 62)}`);
  if (code === "material_section_unclaimed")
    console.log(`        没人认领的段：${findings.filter((f) => f.code === code).map((f) => f.sectionId).join(" ")}`);
  if (code === "leaf_without_story")
    console.log(`        没有故事的叶子：${findings.filter((f) => f.code === code).map((f) => f.moduleId).join(" ")}`);
}
