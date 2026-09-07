import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * 模型配置的落盘层。
 *
 * 这一组钉的是三条硬要求，每一条都对应一次真实的误诊：
 *
 * ① **不配置就必须原样回落到今天的 env 行为**——现有运行不允许被弄坏。
 *    这句话要有一条能跑的断言，而不是一句承诺。
 * ② **密钥永不落成明文，也永不出服务端**。此前界面会复制出 `MIDSCENE_MODEL_API_KEY=****`，
 *    粘进 .env 之后每一次调用都 401，而 401 读起来像模型服务坏了。
 * ③ **空串一律视为「没配」**。网关侧用 `||`、运行侧用 `??`，同一份 .env 里一行空的
 *    `OPENAI_API_KEY=` 会让探活报绿而运行 401——和 ② 一模一样的失败形状，另一个入口。
 */

let dir: string;
const load = async () => {
  vi.resetModules();
  return {
    cfg: await import("../src/config.js"),
    mc: await import("../src/modelconfig.js"),
  };
};

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "tp-modelcfg-"));
  process.env.TP_DATA_DIR = dir;
  /**
   * `config.ts` 顶上是 `import "dotenv/config"`，`vi.resetModules()` 之后它会**再读一次**
   * `server/.env`——而那个文件里真的配着端点。所以光删 `process.env` 不够，
   * 要把 dotenv 指到一个空文件上，否则这一组测的是「这台机器怎么配的」，
   * 而不是「解析逻辑对不对」。
   */
  writeFileSync(resolve(dir, "empty.env"), "");
  process.env.DOTENV_CONFIG_PATH = resolve(dir, "empty.env");
  for (const k of [
    "OPENAI_BASE_URL", "OPENAI_API_KEY", "MIDSCENE_MODEL_BASE_URL",
    "MIDSCENE_MODEL_API_KEY", "MIDSCENE_MODEL_NAME", "TP_MODEL_THINK",
  ]) delete process.env[k];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TP_DATA_DIR;
  delete process.env.DOTENV_CONFIG_PATH;
});

describe("没配置时，原样回落今天的行为", () => {
  it("三个字段逐字等于此前的硬编码默认值", async () => {
    const { cfg } = await load();
    expect(cfg.resolveModelConfig()).toEqual({
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "1234",
      modelName: "Qwen3.8-27B-4bit",
    });
  });

  it("env 配了就用 env，并如实标出来源", async () => {
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.MIDSCENE_MODEL_NAME = "m-1";
    const { cfg } = await load();
    const r = cfg.resolveModelRuntime();
    expect(r.baseUrl).toBe("https://example.test/v1");
    expect(r.modelName).toBe("m-1");
    expect(r.sources.baseUrl).toBe("env");
    expect(r.sources.apiKey).toBe("default");
  });

  it("落盘只设一项时，其余仍然从 env 来", async () => {
    process.env.MIDSCENE_MODEL_NAME = "from-env";
    const { cfg, mc } = await load();
    mc.saveModelConfig({ baseUrl: "https://saved.test/v1" });
    const r = cfg.resolveModelRuntime();
    expect(r.baseUrl).toBe("https://saved.test/v1");
    expect(r.sources.baseUrl).toBe("saved");
    expect(r.modelName).toBe("from-env");
    expect(r.sources.modelName).toBe("env");
  });
});

describe("空串一律当作没配（网关侧 || 与运行侧 ?? 的分叉）", () => {
  it("空的 OPENAI_API_KEY 会继续下落到 MIDSCENE_MODEL_API_KEY", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.MIDSCENE_MODEL_API_KEY = "real-key";
    const { cfg } = await load();
    expect(cfg.resolveModelConfig().apiKey).toBe("real-key");
  });

  it("只有空白的值也不算配过", async () => {
    process.env.OPENAI_BASE_URL = "   ";
    const { cfg } = await load();
    expect(cfg.resolveModelConfig().baseUrl).toBe("http://127.0.0.1:8000/v1");
  });
});

describe("密钥永不落成明文，也永不出服务端", () => {
  it("盘上只有密文；describe 里既没有明文也没有星号", async () => {
    const { mc } = await load();
    mc.saveModelConfig({ apiKey: "sk-CANARY-abc" });
    const raw = readFileSync(resolve(dir, "model.json"), "utf8");
    expect(raw).not.toContain("sk-CANARY-abc");
    expect(raw).toContain("apiKeyEnc");
    const desc = JSON.stringify(mc.describeModelConfig());
    expect(desc).not.toContain("sk-CANARY-abc");
    expect(desc).not.toContain("****");
    expect(mc.describeModelConfig().apiKey.set).toBe(true);
  });

  it("落盘的密钥会被解析路读到", async () => {
    const { cfg, mc } = await load();
    mc.saveModelConfig({ apiKey: "sk-CANARY-abc" });
    expect(cfg.resolveModelConfig().apiKey).toBe("sk-CANARY-abc");
    expect(cfg.resolveModelRuntime().sources.apiKey).toBe("saved");
  });

  it("传空串 = 清除落盘密钥，回落到 env", async () => {
    process.env.MIDSCENE_MODEL_API_KEY = "env-key";
    const { cfg, mc } = await load();
    mc.saveModelConfig({ apiKey: "sk-CANARY-abc" });
    mc.saveModelConfig({ apiKey: "" });
    expect(cfg.resolveModelConfig().apiKey).toBe("env-key");
    expect(mc.describeModelConfig().apiKey.set).toBe(false);
  });

  it("解不开时降级为「未配置」，不抛——否则配置页会被自己的密钥打死", async () => {
    const { mc } = await load();
    mc.saveModelConfig({ apiKey: "sk-CANARY-abc" });
    rmSync(resolve(dir, "secret.key"), { force: true });
    const { mc: mc2 } = await load(); // 重新加载 → 生成一把新密钥 → 旧密文解不开
    expect(() => mc2.describeModelConfig()).not.toThrow();
    expect(mc2.describeModelConfig().apiKey.state).toBe("undecryptable");
    expect(mc2.describeModelConfig().apiKey.set).toBe(false);
  });
});

describe("applyModelEnv 把生效值写回 process.env（子进程靠它继承）", () => {
  it("落盘的值会覆盖 env，思考开关也一起写", async () => {
    process.env.OPENAI_BASE_URL = "https://old.test/v1";
    const { cfg, mc } = await load();
    mc.saveModelConfig({ baseUrl: "https://new.test/v1", think: false });
    cfg.applyModelEnv();
    expect(process.env.OPENAI_BASE_URL).toBe("https://new.test/v1");
    expect(process.env.MIDSCENE_MODEL_BASE_URL).toBe("https://new.test/v1");
    expect(process.env.TP_MODEL_THINK).toBe("0");
  });

  /**
   * 这一条是实测撞出来的：清掉落盘之后 `effective` 仍然是刚被清掉的那个值，
   * 只是来源变成了「env」——一个刚被删掉的值被报告成「这是你环境变量里配的」。
   * 根因是 `applyModelEnv` 把落盘值写进了 process.env 而没有回退路径。
   */
  it("清掉落盘之后必须还原成原始 env，而不是把旧值留在里面", async () => {
    process.env.MIDSCENE_MODEL_NAME = "from-env";
    const { cfg, mc } = await load();
    mc.saveModelConfig({ modelName: "canary" });
    cfg.applyModelEnv();
    expect(process.env.MIDSCENE_MODEL_NAME).toBe("canary");

    mc.saveModelConfig({ modelName: "" });
    cfg.applyModelEnv();
    expect(process.env.MIDSCENE_MODEL_NAME).toBe("from-env");
    expect(cfg.resolveModelRuntime().sources.modelName).toBe("env");
  });

  it("原始 env 里本来就没有的项，清掉后要真的消失，不能留一个空值", async () => {
    delete process.env.MIDSCENE_MODEL_NAME;
    const { cfg, mc } = await load();
    mc.saveModelConfig({ modelName: "canary" });
    cfg.applyModelEnv();
    mc.saveModelConfig({ modelName: "" });
    cfg.applyModelEnv();
    expect(process.env.MIDSCENE_MODEL_NAME).toBeUndefined();
    expect(cfg.resolveModelConfig().modelName).toBe("Qwen3.8-27B-4bit");
  });
});

describe("落盘不写空串占位——「缺省即穿透」是靠字段不存在实现的", () => {
  it("传空串会把这一项从盘上删掉，而不是存一个空值", async () => {
    const { mc } = await load();
    mc.saveModelConfig({ baseUrl: "https://x.test/v1" });
    mc.saveModelConfig({ baseUrl: "" });
    const raw = JSON.parse(readFileSync(resolve(dir, "model.json"), "utf8")) as Record<string, unknown>;
    expect("baseUrl" in raw).toBe(false);
  });

  it("写盘失败要抛，不能像 settings 那样吞掉", async () => {
    const { mc } = await load();
    // 目录被删掉之后写盘必然失败——接口不能悄悄返回成功。
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
    expect(() => mc.saveModelConfig({ baseUrl: "https://y.test/v1" })).toThrow();
  });
});
