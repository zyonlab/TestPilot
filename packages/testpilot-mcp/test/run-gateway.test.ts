import { expect, it, vi } from "vitest";
import { RunGateway } from "../src/run-gateway.js";
it("keeps run grants inside MCP memory and scopes writes to that run", async () => {
  const send = vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify(url.endsWith("register")
    ? { runId: "run-1", writeToken: "private-grant", created: true } : { ok: !!init.headers }), { headers: { "content-type": "application/json" } }));
  const gateway = new RunGateway("http://gateway.test", send as unknown as typeof fetch);
  const value = await gateway.register("project", { externalId: "host" });
  expect(value).not.toHaveProperty("writeToken");
  await gateway.call("run-1", "artifacts", { name: "cases" });
  expect(send.mock.calls[1][0]).toBe("http://gateway.test/api/projects/project/workflow-runs/run-1/artifacts");
  expect(send.mock.calls[1][1].headers).toMatchObject({ authorization: "Bearer private-grant" });
  await expect(gateway.call("run-other", "artifacts", {})).rejects.toThrow("run_not_registered_in_this_mcp_session");
  expect(send).toHaveBeenCalledTimes(2);
});
