/** 把 product/model-candidate 渲染成 product-model.md（只读）。 */
import { readFileSync, writeFileSync } from "node:fs";
import { describeProductModel } from "@testpilot/harness-testing/domain";
const [inp, out] = process.argv.slice(2);
writeFileSync(out!, describeProductModel(JSON.parse(readFileSync(inp!, "utf8")) as never));
