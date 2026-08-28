import { z } from "zod";
import { ABLATABLE, type ModelClient, type NodeDef } from "@testpilot/harness-core";
import { GatedBundleSchema, KIND } from "../casegen/types.js";
import { CODEGEN_STABLE, REPAIR_STABLE, codegenVariable, repairVariable } from "./prompts.js";
import { expandActions, extractFragments, parseCode, parseParams, refold } from "./parse.js";
import { blockedCases, runCodeGate } from "./gate.js";
import type { MachineOracle } from "../exec/oracle.js";
import { classifyRepair, shouldContinue, tally } from "./repair.js";
import {
  CODE_KIND,
  CodeBundleSchema,
  GatedCodeBundleSchema,
  RepairedBundleSchema,
  type CodeCase,
  type ExecOutcome,
  type RepairChange,
  type RepairRound,
} from "./types.js";

/**
 * G2: text case → code → gate ② → bounded repair.
 *
 * The loop lives inside the repair node rather than as a cycle in the graph. That is the
 * "thin graph, thick module" rule: the graph stays a DAG that can be validated, ordered
 * and partially re-run, and the iteration — which needs its own stopping rules, its own
 * budget and its own honesty checks — stays where those rules can be read in one place.
 */

/** How a case is actually executed. The graph does not know about browsers or runners. */
export interface CaseExecutor {
  run(input: {
    caseId: string;
    title: string;
    actions: Array<{ kind: "action" | "input" | "assert"; text: string; field?: string }>;
    /**
     * The text case's machine-checkable oracle, when it has one. It travels with the work
     * rather than being re-derived from the generated code: the code is a translation, and
     * the verdict should not depend on the translation surviving intact.
     */
    oracle?: MachineOracle;
  }): Promise<ExecOutcome>;
}

export interface CodeGenNodeOptions {
  model: ModelClient;
  executor?: CaseExecutor;
}

const cleanCode = (text: string): string =>
  text
    .replace(/```[a-z]*\n?/gi, "")
    .split("\n")
    .filter((l) => !/^\s*(import|export)\s/.test(l))
    .join("\n")
    .trim();

/** Text cases → code, one model call per case. */
export function codegenNode(opts: CodeGenNodeOptions): NodeDef<
  { maxTokens: number; extractFragments: boolean },
  z.infer<typeof GatedBundleSchema>,
  z.infer<typeof CodeBundleSchema>
> {
  return {
    type: "codegen.case",
    title: "Generate code",
    description: "Turn each text case into runnable Midscene code",
    inKind: KIND.gatedCases,
    outKind: CODE_KIND.code,
    params: z.object({
      maxTokens: z.number().int().min(200).max(8000).default(1200),
      extractFragments: z.boolean().default(true),
    }),
    input: GatedBundleSchema,
    output: CodeBundleSchema,
    run: async (bundle, params, ctx) => {
      let code: CodeCase[] = [];
      const failed: Array<{ caseId: string; message: string }> = [];

      for (const kase of bundle.cases) {
        if (ctx.signal.aborted) break;
        try {
          const res = await opts.model.chat({
            stable: CODEGEN_STABLE,
            // 判决归谁，代码生成必须知道——否则它会写一句 aiAssert，
            // 而那句话跑在机器判据之前，可以把它的结论否掉。
            variable: codegenVariable({ ...kase, oracle: kase.oracle }),
            maxTokens: params.maxTokens,
            label: `codegen:${kase.id}`,
          });
          ctx.spend({ calls: 1, tokens: res.tokens });
          const source = cleanCode(res.text);
          const parsed = parseCode(source);
          if (!parsed.actions.length) throw new Error("the reply contained no usable calls");
          code.push({
            caseId: kase.id,
            title: kase.title,
            code: source,
            actions: parsed.actions,
            uses: [],
            params: parseParams(source),
          });
        } catch (e) {
          // One case failing to generate is a fact about that case, not a reason to lose
          // the rest of the batch. It is reported and it counts against the gate.
          failed.push({ caseId: kase.id, message: (e as Error).message });
          ctx.emit("log", { stream: "codegen", text: `case ${kase.id}: ${(e as Error).message}` });
        }
      }

      let fragments: Array<{ name: string; actions: CodeCase["actions"]; usedBy: string[] }> = [];
      if (params.extractFragments && !ctx.ablated.has(ABLATABLE.fragments)) {
        const folded = extractFragments(code);
        code = folded.cases;
        fragments = folded.fragments;
      }

      ctx.emit("wf.node.output", { nodeId: ctx.nodeId, produced: code.length, failed: failed.length });
      return { origin: bundle.origin, cases: bundle.cases, fragments, code, failed };
    },
  };
}

/** Gate ②. Static only: nothing here runs the code. */
export function gateCodeNode(): NodeDef<
  { maxActions: number; minReuseRatio: number },
  z.infer<typeof CodeBundleSchema>,
  z.infer<typeof GatedCodeBundleSchema>
> {
  return {
    type: "gate.code",
    title: "Gate: code quality",
    description: "Check the generated code against the test-development rules",
    inKind: CODE_KIND.code,
    outKind: CODE_KIND.gatedCode,
    params: z.object({
      maxActions: z.number().int().min(1).max(50).default(12),
      minReuseRatio: z.number().min(0).max(1).default(0),
    }),
    input: CodeBundleSchema,
    output: GatedCodeBundleSchema,
    run: async (bundle, params, ctx) => {
      const gate = runCodeGate(bundle, params);
      ctx.emit("gate.result", {
        nodeId: ctx.nodeId,
        gate: "code",
        score: gate.score,
        stats: gate.stats,
        blocked: [...blockedCases(gate)],
      });
      return { ...bundle, gate };
    },
  };
}

/**
 * Execute, and repair what fails — within limits.
 *
 * Every round records what it changed, so the report can publish two pass rates: the plain
 * one, and the one that discounts cases which only went green after their assertion was
 * weakened. Without that pair, a loop optimising for green has no counter-pressure at all.
 */
export function repairNode(opts: CodeGenNodeOptions): NodeDef<
  { maxRounds: number; maxWithoutProgress: number; only: string[]; limit: number },
  z.infer<typeof GatedCodeBundleSchema>,
  z.infer<typeof RepairedBundleSchema>
> {
  return {
    type: "repair.loop",
    title: "Execute and repair",
    description: "Run each case and try, within bounds, to fix what fails",
    inKind: CODE_KIND.gatedCode,
    outKind: CODE_KIND.repaired,
    params: z.object({
      maxRounds: z.number().int().min(0).max(10).default(2),
      maxWithoutProgress: z.number().int().min(1).max(5).default(2),
      /** Case ids to run; empty means all that the gate let through. */
      only: z.array(z.string()).default([]),
      /** Cap on how many cases to execute — a vision-model run costs minutes each. */
      limit: z.number().int().min(1).max(200).default(50),
    }),
    input: GatedCodeBundleSchema,
    output: RepairedBundleSchema,
    run: async (bundle, params, ctx) => {
      const executor = opts.executor;
      if (!executor) throw new Error("repair.loop has no executor wired in");

      const blocked = blockedCases(bundle.gate);
      const runnable = bundle.code
        .filter((c) => !blocked.has(c.caseId))
        .filter((c) => !params.only.length || params.only.includes(c.caseId))
        .slice(0, params.limit);

      const rounds: RepairRound[] = [];
      const outcomes: ExecOutcome[] = [];
      const degraded = new Set<string>();
      const stoppedBecause: Record<string, string> = {};
      const code = [...bundle.code];

      for (const kase of runnable) {
        if (ctx.signal.aborted) break;
        let current = code.find((c) => c.caseId === kase.caseId)!;
        let round = 0;
        let withoutProgress = 0;
        // The oracle comes from the text case, not from the generated code: repair rewrites
        // the code, and a verdict that travelled inside it would be rewritten with it.
        const machineOracle = bundle.cases.find((c) => c.id === current.caseId)?.oracle;
        let outcome = await executor.run({
          caseId: current.caseId,
          title: current.title,
          actions: expandActions(current, bundle.fragments),
          oracle: machineOracle,
        });
        ctx.emit("run.finished", { caseId: current.caseId, status: outcome.status, failKind: outcome.failKind });

        while (outcome.status === "failed" && !ctx.ablated.has(ABLATABLE.repair)) {
          const cont = shouldContinue({
            round,
            maxRounds: params.maxRounds,
            roundsWithoutProgress: withoutProgress,
            maxWithoutProgress: params.maxWithoutProgress,
            lastFailKind: outcome.failKind,
          });
          if (!cont.go) {
            stoppedBecause[current.caseId] = cont.because;
            break;
          }
          round += 1;

          let changes: RepairChange[] = ["none"];
          let note = "";
          try {
            const res = await opts.model.chat({
              stable: REPAIR_STABLE,
              variable: repairVariable({
                title: current.title,
                code: current.code,
                failure: outcome.message ?? "",
                failKind: outcome.failKind,
                round,
              }),
              maxTokens: 1200,
              label: `repair:${current.caseId}`,
            });
            ctx.spend({ calls: 1, tokens: res.tokens });

            if (res.text.includes('"verdict"') && res.text.includes("product-defect")) {
              // The model is allowed to refuse: "the product does not do this" is a real
              // answer, and forcing a fix here is exactly how a test gets weakened.
              stoppedBecause[current.caseId] = "reported as a product defect, not a test fault";
              note = res.text.slice(0, 200);
              rounds.push({ caseId: current.caseId, round, before: outcome, changes: ["none"], note });
              break;
            }

            const source = cleanCode(res.text);
            const parsed = parseCode(source);
            if (!parsed.actions.length) throw new Error("the fix contained no usable calls");
            const folded = refold(current, bundle.fragments, parsed.actions);
            const next: CodeCase = {
              ...current,
              code: source,
              actions: folded.actions,
              uses: folded.uses,
              params: parseParams(source),
            };
            // Compare what actually RUNS, not what is stored: one side may have its shared
            // prologue folded into a fragment and the other may not, and that difference
            // would masquerade as a structural change.
            changes = classifyRepair(
              { ...current, actions: expandActions(current, bundle.fragments) },
              { ...next, actions: expandActions(next, bundle.fragments) },
            );
            if (changes.includes("assertion-semantics") || changes.includes("case-removed"))
              degraded.add(current.caseId);
            if (changes.length === 1 && changes[0] === "none") withoutProgress += 1;
            else withoutProgress = 0;
            current = next;
            const i = code.findIndex((c) => c.caseId === current.caseId);
            code[i] = current;
          } catch (e) {
            withoutProgress += 1;
            note = (e as Error).message;
          }

          rounds.push({ caseId: current.caseId, round, before: outcome, changes, note });
          ctx.emit("repair.round", { caseId: current.caseId, round, changes, failKind: outcome.failKind });

          outcome = await executor.run({
            caseId: current.caseId,
            title: current.title,
            actions: expandActions(current, bundle.fragments),
            oracle: machineOracle,
          });
          ctx.emit("run.finished", { caseId: current.caseId, status: outcome.status, failKind: outcome.failKind });
        }

        outcomes.push(outcome);
      }

      const rates = tally(outcomes, degraded);
      ctx.emit("gate.result", { nodeId: ctx.nodeId, gate: "repair", ...rates, rounds: rounds.length });
      return {
        ...bundle,
        code,
        repair: { rounds, outcomes, ...rates, stoppedBecause },
      };
    },
  };
}

export function codeGenNodes(opts: CodeGenNodeOptions): Array<NodeDef<never, never, never>> {
  return [codegenNode(opts), gateCodeNode(), repairNode(opts)] as unknown as Array<NodeDef<never, never, never>>;
}
