// adapters: 三框架命令拼装 + 就绪锚点 + 健康端点
import { test } from "node:test";
import assert from "node:assert/strict";
import { llama } from "../lib/adapters/llama.js";
import { vllm } from "../lib/adapters/vllm.js";
import { sglang } from "../lib/adapters/sglang.js";
import { adapters, getAdapter } from "../lib/adapters/index.js";

test("llama.buildArgs: exe + -m <model> --port <port> + launchCommand 原序参数", () => {
  const { exe, args } = llama.buildArgs(
    { modelPath: "/m/x.gguf", launchCommand: "-np 1 -c 262144 --slots" },
    { port: 11436 }
  );
  assert.equal(exe, "llama-server");
  assert.deepEqual(args, ["-m", "/m/x.gguf", "--port", "11436", "-np", "1", "-c", "262144", "--slots"]);
});

test("llama.buildArgs: exePath 可覆盖(自定义构建路径)", () => {
  const { exe } = llama.buildArgs({ exePath: "/opt/llama.cpp/build/bin/llama-server", modelPath: "/m/x.gguf", launchCommand: "" }, { port: 1 });
  assert.equal(exe, "/opt/llama.cpp/build/bin/llama-server");
});

test("llama 就绪锚点命中 server-context.cpp:1177 日志行", () => {
  const line = "llama_context: initializing, n_slots = 2, n_ctx_slot = 262144";
  assert.ok(llama.readyRe.some((re) => re.test(line)));
});

test("llama 就绪锚点不误报普通行", () => {
  assert.ok(!llama.readyRe.some((re) => re.test("loading model...")));
});

test("llama 健康/元数据端点", () => {
  assert.equal(llama.healthUrl(11437), "http://127.0.0.1:11437/health");
  assert.equal(llama.modelsUrl(11437), "http://127.0.0.1:11437/v1/models");
});

test("vllm.buildArgs: python3 -m vllm.entrypoints.openai.api_server --model --port + 原序参数", () => {
  const { exe, args } = vllm.buildArgs(
    { modelPath: "/m/x", launchCommand: "--max-model-len 262144" },
    { port: 11440 }
  );
  assert.equal(exe, "python3");
  assert.deepEqual(args, [
    "-m", "vllm.entrypoints.openai.api_server",
    "--model", "/m/x", "--port", "11440",
    "--max-model-len", "262144",
  ]);
});

test("sglang.buildArgs: python3 -m sglang.launch_server --model-path --port + 原序参数", () => {
  const { exe, args } = sglang.buildArgs(
    { modelPath: "/m/x", launchCommand: "--context-length 262144 --enable-cache-report" },
    { port: 11441 }
  );
  assert.equal(exe, "python3");
  assert.deepEqual(args, [
    "-m", "sglang.launch_server",
    "--model-path", "/m/x", "--port", "11441",
    "--context-length", "262144", "--enable-cache-report",
  ]);
});

test("getAdapter: 按名取 adapter,未知名抛错", () => {
  assert.equal(getAdapter("llama"), llama);
  assert.equal(getAdapter("vllm"), vllm);
  assert.equal(getAdapter("sglang"), sglang);
  assert.ok(Object.keys(adapters).length >= 3);
  assert.throws(() => getAdapter("torch"), /unknown|未知/i);
});

test("每个 adapter 都有 name/readyRe/healthUrl/modelsUrl", () => {
  for (const a of Object.values(adapters)) {
    assert.ok(typeof a.name === "string");
    assert.ok(Array.isArray(a.readyRe) && a.readyRe.length > 0);
    assert.ok(typeof a.healthUrl(1) === "string");
    assert.ok(typeof a.modelsUrl(1) === "string");
    assert.ok(typeof a.buildArgs({ modelPath: "/m", launchCommand: "" }, { port: 1 }).args.length === "number");
  }
});
