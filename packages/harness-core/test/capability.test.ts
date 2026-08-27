import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { capabilityToSpec, healthProbe } from "../src/harness/capability.js";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function serve(handler: (url: string) => { status: number; body: unknown }): Promise<string> {
  server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((r) =>
    server!.listen(0, () => r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)),
  );
}

it("turns a recipe into a supervised spec that restarts — a dead capability strands its work", () => {
  const spec = capabilityToSpec({
    id: "anvil-local",
    kind: "chain",
    command: "anvil",
    args: ["--port", "8545"],
  });
  expect(spec).toMatchObject({ id: "anvil-local", kind: "exec", restart: "always" });
});

it("reports a capability as unhealthy until it actually answers", async () => {
  const url = await serve(() => ({ status: 503, body: { error: "starting" } }));
  const probe = healthProbe({ id: "x", kind: "other", command: "x", healthcheck: { kind: "http", url } });
  expect(await probe()).toBe(false);
});

it("treats an RPC that returns a result as healthy — holding the port open is not readiness", async () => {
  const url = await serve(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: "0x7a69" } }));
  const probe = healthProbe({
    id: "chain",
    kind: "chain",
    command: "anvil",
    healthcheck: { kind: "rpc", url, method: "eth_chainId" },
  });
  expect(await probe()).toBe(true);
});

it("treats an RPC error response as unhealthy", async () => {
  const url = await serve(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, error: { message: "nope" } } }));
  const probe = healthProbe({
    id: "chain",
    kind: "chain",
    command: "anvil",
    healthcheck: { kind: "rpc", url, method: "eth_chainId" },
  });
  expect(await probe()).toBe(false);
});

it("reports an unreachable port as unhealthy instead of throwing", async () => {
  const probe = healthProbe({
    id: "dead",
    kind: "other",
    command: "x",
    healthcheck: { kind: "tcp", port: 9 },
  });
  expect(await probe()).toBe(false);
});
