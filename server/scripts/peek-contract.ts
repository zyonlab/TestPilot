/** 只读：打印用例节点的结构契约（整份路径与单元路径拿到的是同一份）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { caseStructureContract } = await import("../src/workUnits.js");
const c = caseStructureContract();
console.log("字数:", c.length);
for (const pat of [/AT LEAST \d+% OF THE CASES.{0,180}/, /The verdict is read from the SCREEN.{0,120}/, /Numbers that move.{0,110}/]) {
  const m = pat.exec(c);
  console.log("·", m ? m[0].replace(/\s+/g, " ") : "✗ 缺 " + String(pat).slice(0, 40));
}
console.log("· 仍教接口判据?", /api oracle is the right answer/.test(c) ? "是（没修干净）" : "否 ✓");
