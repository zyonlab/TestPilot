import { z } from "zod";

/**
 * One declarative place for the knobs that were scattered across env vars.
 *
 * Env still wins — an operator changing concurrency for one run should not have to edit a
 * file — but the file is what you read to find out *what knobs exist*, which env vars are
 * famously bad at.
 */

export interface CapabilityRecipe {
  id: string;
  /** What it is, for the UI: a chain, the model proxy, a mock service, a device bridge. */
  kind: "chain" | "model" | "mock" | "device" | "other";
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Started with the gateway, or only when a person (or a run) asks for it. */
  autostart?: boolean;
  /** How to tell it is actually up. Without one, "running" only means "not exited". */
  healthcheck?:
    | { kind: "tcp"; host?: string; port: number }
    | { kind: "http"; url: string; expectStatus?: number; headers?: Record<string, string> }
    | { kind: "rpc"; url: string; method: string };
  healthIntervalMs?: number;
}

export interface HarnessConfig {
  model: {
    /** Admission slots for the model endpoint. One self-hosted VL model means 1. */
    concurrency: number;
  };
  execution: {
    /** Concurrent case runs. */
    queueConcurrency: number;
    /** Runner processes. A runner executes one case at a time, so this tracks the queue. */
    runnerCount: number;
  };
  events: {
    keepLast: number;
    trimMs: number;
  };
  /** Defaults for the phase-1 loop layer: a run stops on whichever fires first. */
  budget: {
    calls: number;
    usd: number;
    ms: number;
  };
  /** Components switched off for an ablation run. Reported alongside every result. */
  ablate: string[];
  guard: {
    /** Hosts a destructive step is allowed to touch. */
    allowHosts: string[];
    /** Block irreversible-looking steps outside the allowlist. */
    blockIrreversible: boolean;
    /** Refuse to run against a host that is not on the allowlist at all. Off by default. */
    allowlistOnly: boolean;
  };
  capabilities: CapabilityRecipe[];
}

export type HarnessConfigInput = {
  [K in keyof HarnessConfig]?: HarnessConfig[K] extends Array<infer _T>
    ? HarnessConfig[K]
    : Partial<HarnessConfig[K]>;
};

/** Identity helper so a config file gets types and autocomplete. */
export function defineHarnessConfig(cfg: HarnessConfigInput): HarnessConfigInput {
  return cfg;
}

/**
 * The same recipe, as a runtime schema.
 *
 * The interface above is enough while recipes are written by hand in a config file. They
 * are not, any more: the point of a declarative recipe was always that a person could ask
 * the agent for one, and anything a model wrote has to be checked before it is stored —
 * let alone before a supervisor is asked to execute it.
 */
export const CapabilityRecipeSchema = z.object({
  id: z
    .string()
    .min(1)
    // Ids become process ids and appear in event scopes; keep them boring.
    .regex(/^[a-z0-9][a-z0-9-]*$/, "an id is lowercase letters, digits and dashes"),
  kind: z.enum(["chain", "model", "mock", "device", "other"]),
  description: z.string().optional(),
  command: z
    .string()
    .min(1)
    // A recipe is exec-style: a program in `command`, its arguments in `args`. Nothing
    // here reaches a shell, so shell syntax in this field cannot do what its author
    // intended — and a field that looks like it works but does not is worse than a
    // refusal. The rule is therefore the strict one: a bare program name.
    .refine((c) => !/[\s;&|`$><'"\n]/.test(c), "a command is a bare program name; its arguments go in args")
    // A shell as the program is the loophole that makes the rest of this pointless: the
    // recipe a person reviewed would be `sh`, and what actually runs would be whatever is
    // in args. Refused outright — every capability so far is a program, not a script.
    .refine(
      (c) => !/^(\/.*\/)?(sh|bash|zsh|dash|fish|ksh|csh|cmd|cmd\.exe|powershell|pwsh)$/i.test(c),
      "a shell cannot be the command: what runs would be the arguments, not the line reviewed",
    ),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  autostart: z.boolean().optional(),
  healthcheck: z
    .union([
      z.object({ kind: z.literal("tcp"), host: z.string().optional(), port: z.number().int().min(1).max(65535) }),
      z.object({
        kind: z.literal("http"),
        url: z.string().url(),
        expectStatus: z.number().int().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
      z.object({ kind: z.literal("rpc"), url: z.string().url(), method: z.string().min(1) }),
    ])
    .optional(),
  healthIntervalMs: z.number().int().min(200).max(60_000).optional(),
});
