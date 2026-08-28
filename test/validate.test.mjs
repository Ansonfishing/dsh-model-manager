// validate: launchCommand 解析 + profile 保存前校验
// 约定:llama per-slot 上下文 = 模型原生最大上下文,-c = 原生 × -np
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试用独立 DSH_HOME,避免读到本机 ~/.dsh/model-manager 的 builtin-gpus.local.json
// (必须在 import validate.js → gpu.js 前设置:BUILTIN_GPUS 在模块加载时求值)。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "mm-validate-test-"));

const { parseLaunchCommand, buildLaunchCommand, validateProfile } = await import("../lib/validate.js");

test("parseLaunchCommand: 参数/值对保序", () => {
  assert.deepEqual(parseLaunchCommand("-np 1 -c 524288 --cache-type-k q4_0 --temp 1.0"), [
    { flag: "-np", value: "1" },
    { flag: "-c", value: "524288" },
    { flag: "--cache-type-k", value: "q4_0" },
    { flag: "--temp", value: "1.0" },
  ]);
});

test("parseLaunchCommand: 无值 flag", () => {
  assert.deepEqual(parseLaunchCommand("--metrics --slots"), [
    { flag: "--metrics", value: "" },
    { flag: "--slots", value: "" },
  ]);
});

test("parseLaunchCommand: 空串 → []", () => {
  assert.deepEqual(parseLaunchCommand(""), []);
});

test("parseLaunchCommand: 支持 --flag=value", () => {
  assert.deepEqual(parseLaunchCommand("--tp=2"), [{ flag: "--tp", value: "2" }]);
});

test("buildLaunchCommand: 往返", () => {
  assert.equal(
    buildLaunchCommand([{ flag: "-c", value: "524288" }, { flag: "--slots", value: "" }]),
    "-c 524288 --slots"
  );
});

const base = { name: "t", framework: "llama", modelPath: "/m/x.gguf", launchCommand: "-np 1 -c 262144" };

test("合法 profile → 无 error", () => {
  const r = validateProfile({ ...base, port: 11436, contextWindow: 262144, gpu: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("per-slot < 原生上下文 → warning 不阻断(-c 262144 -np 2 对 262K 原生模型)", () => {
  const r = validateProfile({ ...base, launchCommand: "-np 2 -c 262144", port: 11436, contextWindow: 262144 });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /per-slot|262144/.test(w)));
});

test("-c 不能被 -np 整除 → error", () => {
  const r = validateProfile({ ...base, launchCommand: "-np 2 -c 262145", port: 11436 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /整除|divisible/i.test(e)));
});

test("port 越界 → error(0 和 70000)", () => {
  const r1 = validateProfile({ ...base, port: 0 });
  assert.ok(r1.errors.some((e) => /port|端口/.test(e)));
  const r2 = validateProfile({ ...base, port: 70000 });
  assert.ok(r2.errors.some((e) => /port|端口/.test(e)));
});

test("port 与注册表冲突 → error", () => {
  const r = validateProfile({ ...base, port: 11436 }, { registry: [{ port: 11436 }] });
  assert.ok(r.errors.some((e) => /占用|in use/i.test(e)));
});

test("不带 port(保存时) → 不报 port 错", () => {
  const r = validateProfile(base);
  assert.equal(r.errors.filter((e) => /port|端口/.test(e)).length, 0);
});

test("llama launchCommand 含插件托管 flag(-m / --port) → error", () => {
  const r1 = validateProfile({ ...base, launchCommand: "--port 8080 -np 1", port: 11436 });
  assert.ok(r1.errors.some((e) => /托管|managed/i.test(e)));
  const r2 = validateProfile({ ...base, launchCommand: "-m /other.gguf -np 1", port: 11436 });
  assert.ok(r2.errors.some((e) => /托管|managed/i.test(e)));
});

test("KV 估算超 GPU 容量(显式 gpuCap)→ warning(2097152 × 64KiB ≈ 137G > 48G)", () => {
  const r = validateProfile(
    { ...base, launchCommand: "-np 1 -c 2097152", port: 11436, gpu: 1, kvBytesPerToken: 65536 },
    { gpuCap: { 1: 48 } }
  );
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /KV/i.test(w)));
});

test("无 gpuCap 且无内置表 → 不猜卡容量,无 KV warning(新契约:未知卡跳过校验)", () => {
  const r = validateProfile({ ...base, launchCommand: "-np 1 -c 2097152", port: 11436, gpu: 1, kvBytesPerToken: 65536 });
  assert.equal(r.ok, true);
  assert.ok(!r.warnings.some((w) => /KV 估算/.test(w)), JSON.stringify(r.warnings));
});

test("KV 估算在容量内 → 无 KV warning(262144 × 6.25KiB ≈ 1.6G)", () => {
  const r = validateProfile({ ...base, launchCommand: "-np 1 -c 262144", port: 11436, gpu: 1, kvBytesPerToken: 6400 });
  assert.ok(!r.warnings.some((w) => /KV/i.test(w)));
});

test("SGLang --speculative-num-draft-tokens → warning(须=草稿 block_size)", () => {
  const r = validateProfile({
    name: "t", framework: "sglang", modelPath: "/m/x",
    launchCommand: "--speculative-num-draft-tokens 16 --context-length 262144 --enable-cache-report",
    port: 11437,
  });
  assert.ok(r.warnings.some((w) => /block_size/i.test(w)));
});

test("SGLang 缺 --enable-cache-report → warning(否则缓存命中恒 0%)", () => {
  const r = validateProfile({ name: "t", framework: "sglang", modelPath: "/m/x", launchCommand: "--context-length 262144", port: 11437 });
  assert.ok(r.warnings.some((w) => /cache-report/i.test(w)));
});

test("缺 name / modelPath → error", () => {
  const r = validateProfile({ framework: "llama", launchCommand: "", port: 11436 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2);
});

test("未知 framework → error", () => {
  const r = validateProfile({ name: "t", framework: "torch", modelPath: "/m/x", launchCommand: "", port: 11436 });
  assert.ok(r.errors.some((e) => /framework/.test(e)));
});

test("save 时 port 非法 → error(port=0)", () => {
  const r = validateProfile({ ...base, port: 0 });
  assert.equal(r.ok, false);
});
