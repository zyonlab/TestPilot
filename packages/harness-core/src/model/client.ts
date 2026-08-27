import { createHash } from "node:crypto";
import { withModel } from "./lease.js";

/**
 * What a node asks the model for.
 *
 * The split between `stable` and `variable` is not cosmetic: the endpoint caches prompt
 * prefixes, and on a self-hosted model that cache is most of the speed. Measured on this
 * project's endpoint, ~6k of a ~9k-token request came back as a prefix-cache hit — which
 * only happens when the leading bytes are identical between calls. So the shape forces the
 * caller to say which half never changes.
 */
export interface ChatRequest {
  /** Never varies within a node type: role, method, output schema. Goes first. */
  stable: string;
  /** This call's material. Goes last. */
  variable: string;
  images?: string[];
  /** JSON Schema for guided decoding; also used to validate the reply. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  /** Label for cost attribution and for reading a recording. */
  label?: string;
}

export interface ChatResponse {
  text: string;
  tokens: number;
  ms: number;
  /** True when the answer came from a recording rather than the model. */
  replayed?: boolean;
  /** True when the model stopped because it ran out of budget, not because it was finished. */
  truncated?: boolean;
}

export interface ModelClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/**
 * Stable key for a request. Images are hashed rather than included: a screenshot is
 * megabytes, and what matters for identity is only that it is the same screenshot.
 */
export function requestKey(req: ChatRequest): string {
  const h = createHash("sha256");
  h.update(req.stable);
  h.update(" ");
  h.update(req.variable);
  h.update(" ");
  h.update(JSON.stringify(req.schema ?? null));
  h.update(" ");
  for (const img of req.images ?? []) h.update(createHash("sha256").update(img).digest("hex"));
  return h.digest("hex").slice(0, 32);
}

/**
 * Deterministic stand-in for the model.
 *
 * Unit tests must not depend on a 27B model being up, being fast, or being in the same
 * mood as yesterday — and a suite that takes minutes per assertion stops being run.
 */
export class FakeModel implements ModelClient {
  readonly calls: ChatRequest[] = [];

  constructor(
    private reply: string | ((req: ChatRequest, n: number) => string) = "ok",
    private opts: { tokens?: number; ms?: number } = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const text = typeof this.reply === "function" ? this.reply(req, this.calls.length - 1) : this.reply;
    return { text, tokens: this.opts.tokens ?? 0, ms: this.opts.ms ?? 0 };
  }
}

export interface Recording {
  [key: string]: { label?: string; text: string; tokens: number; ms: number };
}

/**
 * VCR: replay real answers, record new ones.
 *
 * Recordings come from real runs, so a graph-level test exercises the replies the model
 * actually gave without paying forty seconds a call. In `replay` mode an unknown request
 * is an error rather than a silent live call: a test that quietly starts hitting the model
 * would pass on one machine and hang on another.
 */
export class RecordedModel implements ModelClient {
  constructor(
    private recording: Recording,
    private opts: { mode?: "replay" | "record"; upstream?: ModelClient; onRecord?: (r: Recording) => void } = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = requestKey(req);
    const hit = this.recording[key];
    if (hit) return { text: hit.text, tokens: hit.tokens, ms: hit.ms, replayed: true };
    if ((this.opts.mode ?? "replay") === "replay" || !this.opts.upstream)
      throw new Error(
        `no recording for ${req.label ?? "request"} (${key}). Re-record with mode "record", or fix the prompt that changed.`,
      );
    const res = await this.opts.upstream.chat(req);
    this.recording[key] = { label: req.label, text: res.text, tokens: res.tokens, ms: res.ms };
    this.opts.onRecord?.(this.recording);
    return res;
  }
}

/** Wrap any client so every call passes the process-wide admission gate. */
export function gated(client: ModelClient): ModelClient {
  return { chat: (req) => withModel(() => client.chat(req)) };
}
