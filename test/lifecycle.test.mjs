// lifecycle: 注册表 / 健康检查 / 停止红线 / llama 托管启动 / profile CRUD
// 全部注入 fake fetch/spawn/exec——不碰真实进程与真实端口
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManager } from "../lib/lifecycle.js";

function makeManager(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "mm-life-"));
  const executed = [];
  const spawned = [];
  let nextPid = 7000;
  const m = createManager({
    home,
    fetchFn: overrides.fetchFn ?? (async (url) => ({ ok: url.endsWith("/health"), status: 200 })),
    execFn: overrides.execFn ?? (async (argv) => { executed.push(argv); }),
    spawnFn: overrides.spawnFn ?? ((exe, args, opts) => { spawned.push({ exe, args, opts }); return { pid: ++nextPid, unref() {} }; }),
    pidAlive: overrides.pidAlive ?? (() => false),
    logFn: overrides.logFn,
  });
  return { m, home, executed, spawned, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/* ---------------- register / list ---------------- */

test("register 外部服务 → list 显示 running(health ok)", async (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  const entry = m.register({ port: 11437, framework: "sglang", model: "Demo-27B-FP8", gpu: 0, note: "卡1" });
  assert.equal(entry.managed, false);
  const list = await m.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "running");
  assert.equal(list[0].health, "ok");
});

test("health 5xx → status down,list 不抛", async (t) => {
  const { m, cleanup } = makeManager({ fetchFn: async () => ({ ok: false, status: 500 }) }); t.after(cleanup);
  m.register({ port: 19999, framework: "llama", model: "x" });
  const list = await m.list();
  assert.equal(list[0].status, "down");
});

test("health 连接失败(抛错) → down/unreachable", async (t) => {
  const { m, cleanup } = makeManager({ fetchFn: async () => { throw new Error("ECONNREFUSED"); } }); t.after(cleanup);
  m.register({ port: 19999, framework: "llama", model: "x" });
  const list = await m.list();
  assert.equal(list[0].status, "down");
  assert.equal(list[0].health, "unreachable");
});

test("同端口重复 register → 拒绝", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  m.register({ port: 11436, framework: "llama", model: "a" });
  assert.throws(() => m.register({ port: 11436, framework: "llama", model: "b" }), /已注册|重复|duplicate/i);
});

test("register 非法端口 / 未知 framework → 拒绝", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  assert.throws(() => m.register({ port: 0, framework: "llama", model: "a" }), /port|非法/i);
  assert.throws(() => m.register({ port: 11436, framework: "torch", model: "a" }), /framework|unknown|未知/i);
});

/* ---------------- stop(红线) ---------------- */

test("stop 未注册端口 → 拒绝,不执行任何命令", async (t) => {
  const { m, executed, cleanup } = makeManager(); t.after(cleanup);
  await assert.rejects(() => m.stop(19999), /未注册|unregistered/i);
  assert.deepEqual(executed, []);
});

test("stop 外部服务无 force → 拒绝,不执行任何命令", async (t) => {
  const { m, executed, cleanup } = makeManager(); t.after(cleanup);
  m.register({ port: 11436, framework: "llama", model: "x" });
  await assert.rejects(() => m.stop(11436), /force/);
  assert.deepEqual(executed, []);
});

test("stop 外部服务 force=true → fuser -k <port>/tcp 且移出注册表", async (t) => {
  const { m, executed, cleanup } = makeManager(); t.after(cleanup);
  m.register({ port: 11436, framework: "llama", model: "x" });
  await m.stop(11436, { force: true });
  assert.deepEqual(executed, [["fuser", "-k", "11436/tcp"]]);
  assert.equal((await m.list()).length, 0);
});

test("stop 11437 保护已放开(用户确认):行为等同外部服务——无 force 拒,force → fuser -k 11437/tcp", async (t) => {
  const { m, executed, cleanup } = makeManager(); t.after(cleanup);
  m.register({ port: 11437, framework: "sglang", model: "x" });
  await assert.rejects(() => m.stop(11437), /force/);
  await m.stop(11437, { force: true });
  assert.deepEqual(executed, [["fuser", "-k", "11437/tcp"]]);
  assert.equal((await m.list()).length, 0);
});

test("stop 未注册的 11437 → 与任意未注册端口同拒(拒盲杀)", async (t) => {
  const { m, executed, cleanup } = makeManager(); t.after(cleanup);
  await assert.rejects(() => m.stop(11437, { force: true }), /未注册|unregistered/i);
  assert.deepEqual(executed, []);
});

test("stop 托管服务 + pid 存活 → kill -TERM <pid> 且移出注册表", async (t) => {
  const { m, executed, cleanup } = makeManager({ pidAlive: (pid) => pid === 4242 }); t.after(cleanup);
  m.register({ port: 11436, framework: "llama", model: "x", managed: true, pid: 4242 });
  await m.stop(11436);
  assert.deepEqual(executed, [["kill", "-TERM", "4242"]]);
  assert.equal((await m.list()).length, 0);
});

/* ---------------- profile CRUD ---------------- */

test("profile: save → list → load(active) → delete", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  const p = m.saveProfile({
    name: "Demo · llama · 快速", framework: "llama", model: "Demo-35B-A3B",
    modelPath: "/m/or.gguf", launchCommand: "-np 1 -c 262144", contextWindow: 262144, gpu: 1,
  });
  assert.ok(p.id);
  assert.equal(m.listProfiles().length, 1);
  const loaded = m.loadProfile(p.id);
  assert.equal(loaded.active, true);
  assert.equal(m.deleteProfile(p.id), 0);
  assert.deepEqual(m.listProfiles(), []);
});

test("profile: loadProfile 清除其它条目的 active", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  const a = m.saveProfile({ name: "a", framework: "llama", model: "a", modelPath: "/m/a.gguf", launchCommand: "" });
  const b = m.saveProfile({ name: "b", framework: "llama", model: "b", modelPath: "/m/b.gguf", launchCommand: "" });
  m.loadProfile(a.id);
  m.loadProfile(b.id);
  const list = m.listProfiles();
  assert.equal(list.find((x) => x.id === a.id).active, false);
  assert.equal(list.find((x) => x.id === b.id).active, true);
});

test("profile: save 校验 error → 拒绝(不整除 / 缺 modelPath / port 非法)", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  assert.throws(
    () => m.saveProfile({ name: "bad", framework: "llama", modelPath: "/m/b.gguf", launchCommand: "-np 2 -c 262145", contextWindow: 262144 }),
    /整除|divisible|校验/i
  );
  assert.throws(() => m.saveProfile({ name: "no-path", framework: "llama", launchCommand: "" }), /modelPath/);
  assert.throws(() => m.saveProfile({ name: "p0", framework: "llama", modelPath: "/m/p.gguf", launchCommand: "", port: 0 }), /port|非法/i);
});

test("profile: 同名 save = 更新(不新增)", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  const p1 = m.saveProfile({ name: "x", framework: "llama", model: "x", modelPath: "/m/x.gguf", launchCommand: "-c 32768" });
  const p2 = m.saveProfile({ name: "x", framework: "llama", model: "x", modelPath: "/m/x.gguf", launchCommand: "-c 65536" });
  assert.equal(p1.id, p2.id);
  assert.equal(m.listProfiles().length, 1);
  assert.equal(m.listProfiles()[0].launchCommand, "-c 65536");
});

test("profile: importProfiles 接受 JSON 字符串 / 数组;坏 JSON 抛错", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  const n = m.importProfiles(JSON.stringify([
    { name: "a", framework: "llama", model: "a", modelPath: "/m/a.gguf", launchCommand: "" },
    { name: "b", framework: "sglang", model: "b", modelPath: "/m/b", launchCommand: "--context-length 262144" },
  ]));
  assert.equal(n, 2);
  assert.equal(m.listProfiles().length, 2);
  const n2 = m.importProfiles({ name: "c", framework: "llama", model: "c", modelPath: "/m/c.gguf", launchCommand: "" });
  assert.equal(n2, 1);
  assert.throws(() => m.importProfiles("{bad json"), /JSON|syntax|解析/i);
});

test("profile: deleteProfile 不存在 → 抛错", (t) => {
  const { m, cleanup } = makeManager(); t.after(cleanup);
  assert.throws(() => m.deleteProfile("nope"), /不存在|not found/i);
});

/* ---------------- start ---------------- */

test("start: sglang profile → python -m sglang.launch_server 命令拼装正确", (t) => {
  const { m, spawned, cleanup } = makeManager(); t.after(cleanup);
  m.saveProfile({ name: "s", framework: "sglang", model: "x", modelPath: "/m/x", launchCommand: "--context-length 262144" });
  const entry = m.start({ profile: "s", port: 11441 });
  assert.equal(entry.framework, "sglang");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, "python3");
  assert.deepEqual(spawned[0].args, ["-m", "sglang.launch_server", "--model-path", "/m/x", "--port", "11441", "--context-length", "262144"]);
});

test("start: vllm profile → python -m vllm...api_server 命令拼装正确", (t) => {
  const { m, spawned, cleanup } = makeManager(); t.after(cleanup);
  m.saveProfile({ name: "v", framework: "vllm", model: "x", modelPath: "/m/x", launchCommand: "--max-model-len 262144" });
  const entry = m.start({ profile: "v", port: 11440 });
  assert.equal(entry.framework, "vllm");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, "python3");
  assert.deepEqual(spawned[0].args, ["-m", "vllm.entrypoints.openai.api_server", "--model", "/m/x", "--port", "11440", "--max-model-len", "262144"]);
});

test("start: sglang exe 走 frameworks.json 配置(venv python)", (t) => {
  const { m, spawned, home, cleanup } = makeManager(); t.after(cleanup);
  const fakePy = join(home, "python3");
  writeFileSync(fakePy, "#!/bin/sh\n");
  m.setFramework({ framework: "sglang", exe: fakePy });
  m.saveProfile({ name: "s", framework: "sglang", model: "x", modelPath: "/m/x", launchCommand: "" });
  const entry = m.start({ profile: "s", port: 11442 });
  assert.equal(entry.framework, "sglang");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, fakePy);
});

test("start: llama → 命令/env/pidfile/注册表条目全部正确", (t) => {
  const { m, spawned, home, cleanup } = makeManager(); t.after(cleanup);
  m.saveProfile({
    name: "Demo fast", framework: "llama", model: "Demo",
    modelPath: "/m/or.gguf", launchCommand: "-np 1 -c 262144 --slots", contextWindow: 262144, gpu: 1,
  });
  const entry = m.start({ profile: "Demo fast", port: 11436, gpu: 1 });
  assert.equal(entry.managed, true);
  assert.ok(entry.pid > 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, "llama-server");
  assert.deepEqual(spawned[0].args, ["-m", "/m/or.gguf", "--port", "11436", "-np", "1", "-c", "262144", "--slots"]);
  assert.equal(spawned[0].opts.env.CUDA_VISIBLE_DEVICES, "1");
  const pidfile = join(home, "servers", "11436.pid");
  assert.ok(existsSync(pidfile));
  assert.equal(readFileSync(pidfile, "utf8").trim(), String(entry.pid));
});

test("start: sglang/vllm 注入 FLASHINFER_DISABLE_VERSION_CHECK,llama 不注入", (t) => {
  const { m, spawned, cleanup } = makeManager(); t.after(cleanup);
  m.saveProfile({ name: "s", framework: "sglang", model: "x", modelPath: "/m/x", launchCommand: "" });
  m.saveProfile({ name: "v", framework: "vllm", model: "x", modelPath: "/m/x", launchCommand: "" });
  m.saveProfile({ name: "l", framework: "llama", model: "x", modelPath: "/m/l.gguf", launchCommand: "" });
  m.start({ profile: "s", port: 11450 });
  m.start({ profile: "v", port: 11451 });
  m.start({ profile: "l", port: 11452 });
  assert.equal(spawned.length, 3);
  assert.equal(spawned[0].opts.env.FLASHINFER_DISABLE_VERSION_CHECK, "1"); // sglang
  assert.equal(spawned[1].opts.env.FLASHINFER_DISABLE_VERSION_CHECK, "1"); // vllm
  assert.equal(spawned[2].opts.env.FLASHINFER_DISABLE_VERSION_CHECK, undefined); // llama 不受影响
  // CUDA_VISIBLE_DEVICES 注入不受影响
  assert.equal(spawned[0].opts.env.CUDA_VISIBLE_DEVICES, "0");
});

test("start: gpu 缺省取 profile.gpu;再缺省 0", (t) => {
  const { m, spawned, cleanup } = makeManager(); t.after(cleanup);
  m.saveProfile({ name: "g1", framework: "llama", model: "g", modelPath: "/m/g.gguf", launchCommand: "", gpu: 1 });
  m.saveProfile({ name: "g0", framework: "llama", model: "g", modelPath: "/m/g.gguf", launchCommand: "" });
  m.start({ profile: "g1", port: 11450 });
  assert.equal(spawned[0].opts.env.CUDA_VISIBLE_DEVICES, "1");
  m.start({ profile: "g0", port: 11451 });
  assert.equal(spawned[1].opts.env.CUDA_VISIBLE_DEVICES, "0");
});

test("start: 端口已被注册表占用 → 拒绝,不 spawn", (t) => {
  const { m, spawned, cleanup } = makeManager(); t.after(cleanup);
  m.register({ port: 11436, framework: "llama", model: "existing" });
  m.saveProfile({ name: "c", framework: "llama", model: "c", modelPath: "/m/c.gguf", launchCommand: "-np 1 -c 262144" });
  assert.throws(() => m.start({ profile: "c", port: 11436 }), /占用|in use/i);
  assert.equal(spawned.length, 0);
});

test("start: profile 不存在 → 抛错", (t) => {
  const { m, spawned, cleanup } = makeManager(); t.after(cleanup);
  assert.throws(() => m.start({ profile: "ghost", port: 11436 }), /不存在|not found/i);
  assert.equal(spawned.length, 0);
});

test("start: 托管记录 pid 已死 → 自动清理死记录并重新 spawn", (t) => {
  // makeManager 默认 pidAlive: () => false → 首次 start 后该 pid 即视为已死
  const { m, spawned, cleanup } = makeManager(); t.after(cleanup);
  m.saveProfile({ name: "c", framework: "llama", model: "c", modelPath: "/m/c.gguf", launchCommand: "-np 1 -c 262144" });
  const first = m.start({ profile: "c", port: 11436 });
  const second = m.start({ profile: "c", port: 11436 });
  assert.equal(spawned.length, 2);
  assert.equal(second.pid, first.pid + 1);
  assert.equal(second.managed, true);
});

test("start: 托管记录 pid 仍活着 → 拒绝(防双开)", (t) => {
  const { m, spawned, cleanup } = makeManager({ pidAlive: (pid) => pid === 7001 }); t.after(cleanup);
  m.saveProfile({ name: "c", framework: "llama", model: "c", modelPath: "/m/c.gguf", launchCommand: "-np 1 -c 262144" });
  const first = m.start({ profile: "c", port: 11436 });
  assert.equal(first.pid, 7001);
  assert.throws(() => m.start({ profile: "c", port: 11436 }), /占用|in use/i);
  assert.equal(spawned.length, 1);
});

/* ---------------- benchFullCtx(满上下文热测速) ----------------
 * 口径:满上下文校验(sglang=/get_server_info.max_total_tokens、llama=/slots n_ctx per-slot、
 * vllm=servers/<port>.log 里 "GPU KV cache size: N tokens")+ 1 次流式 warmup(丢弃)+ 1 次流式测量。
 * 记录 scheme='full-ctx-warm-v2':ttfbMs/prefillTps/decode tps、warm=true、ctxAllocated/fullCtx。
 */
const TC = 262144;
function sseStream(n = 4, delayMs = 4) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < n; i++) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
      }
      controller.enqueue(enc.encode(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":' + n + '}}\n\n' +
        'data: [DONE]\n\n',
      ));
      controller.close();
    },
  });
}

function mmFetch({ maxTotal = TC, slotsCtx = null, http500 = false } = {}) {
  const calls = [];
  const streaming = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "mock-model" }] }) };
    if (u.includes("/get_server_info")) return { ok: true, status: 200, json: async () => ({ max_total_tokens: maxTotal }) };
    if (u.includes("/slots")) return { ok: true, status: 200, json: async () => (slotsCtx != null ? [{ n_ctx: slotsCtx }] : []) };
    if (u.includes("/v1/chat/completions")) {
      streaming.push(1);
      if (http500) return { ok: false, status: 500, text: async () => "boom" };
      return { ok: true, status: 200, json: async () => { throw new Error("stream: no json"); }, body: sseStream(4) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fn, calls, streaming };
}

test("benchFullCtx: sglang 满上下文 → 2 次流式(warmup+测量),entry 字段完整并落盘", async (t) => {
  const fx = mmFetch();
  const { m, cleanup } = makeManager({ fetchFn: fx.fn }); t.after(cleanup);
  m.register({ port: 11450, framework: "sglang", model: "Demo-27B" });
  const r = await m.benchFullCtx(11450, { profile: "sg-fc", ctxTarget: TC, maxTokens: 16 });
  assert.equal(fx.streaming.length, 2); // warmup + 测量,单并发串行
  assert.equal(r.scheme, "full-ctx-warm-v2");
  assert.equal(r.warm, true);
  assert.equal(r.fullCtx, true);
  assert.equal(r.ctxAllocated, TC);
  assert.equal(r.ctxTarget, TC);
  assert.equal(r.tokens, 4);
  assert.ok(Number.isInteger(r.ttfbMs) && r.ttfbMs >= 0);
  assert.ok(Number.isInteger(r.prefillTps) && r.prefillTps > 0);
  assert.ok(r.tps > 0);
  const saved = m.listBenchmarks().find((b) => b.scheme === "full-ctx-warm-v2");
  assert.ok(saved, "benchmarks.json 应有 full-ctx-warm-v2 记录");
  assert.equal(saved.profile, "sg-fc");
});

test("benchFullCtx: 实际上下文 < 目标 → 拒绝,不发测速请求、不落盘", async (t) => {
  const fx = mmFetch({ maxTotal: 131072 });
  const { m, cleanup } = makeManager({ fetchFn: fx.fn }); t.after(cleanup);
  m.register({ port: 11450, framework: "sglang", model: "Demo-27B" });
  await assert.rejects(
    () => m.benchFullCtx(11450, { ctxTarget: TC }),
    /满上下文|full-ctx|not met/i,
  );
  assert.equal(fx.streaming.length, 0);
  assert.equal(m.listBenchmarks().length, 0);
});

test("benchFullCtx: llama 走 /slots per-slot n_ctx 校验", async (t) => {
  const fx = mmFetch({ slotsCtx: TC });
  const { m, cleanup } = makeManager({ fetchFn: fx.fn }); t.after(cleanup);
  m.register({ port: 11451, framework: "llama", model: "Demo-27B" });
  const r = await m.benchFullCtx(11451, { ctxTarget: TC });
  assert.ok(fx.calls.some((u) => u.includes("/slots")));
  assert.equal(r.fullCtx, true);
  assert.equal(r.ctxAllocated, TC);
  assert.equal(fx.streaming.length, 2);
});

test("benchFullCtx: vllm 走 servers/<port>.log 的 GPU KV cache size 校验;不足则拒", async (t) => {
  const fx = mmFetch();
  const { m, cleanup } = makeManager({
    fetchFn: fx.fn,
    logFn: (port) => `... GPU KV cache size: 262144 tokens, block size 16 ...\n`,
  }); t.after(cleanup);
  m.register({ port: 11452, framework: "vllm", model: "Demo-27B" });
  const r = await m.benchFullCtx(11452, { ctxTarget: TC });
  assert.equal(r.fullCtx, true);
  assert.equal(r.ctxAllocated, TC);

  const fx2 = mmFetch();
  const { m: m2, cleanup: c2 } = makeManager({
    fetchFn: fx2.fn,
    logFn: (port) => `... GPU KV cache size: 131072 tokens, block size 16 ...\n`,
  }); c2();
  m2.register({ port: 11453, framework: "vllm", model: "Demo-27B" });
  await assert.rejects(() => m2.benchFullCtx(11453, { ctxTarget: TC }), /满上下文|full-ctx|not met/i);
  assert.equal(fx2.streaming.length, 0);
});

test("benchFullCtx: 流式 http 500 → 抛错不落盘", async (t) => {
  const fx = mmFetch({ http500: true });
  const { m, cleanup } = makeManager({ fetchFn: fx.fn }); t.after(cleanup);
  m.register({ port: 11454, framework: "sglang", model: "Demo-27B" });
  await assert.rejects(() => m.benchFullCtx(11454, { ctxTarget: TC }), /测速失败|request failed|500/i);
  assert.equal(m.listBenchmarks().length, 0);
});

test("benchFullCtx 默认 fetch 路径:测速请求必须是 POST+JSON(回归:fetchImpl 丢 options 导致 GET→llama 404/sglang 405)", async (t) => {
  const realFetch = globalThis.fetch;
  const chatOpts = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/v1/chat/completions")) {
      chatOpts.push(opts);
      return { ok: true, status: 200, body: sseStream(4), text: async () => "" };
    }
    if (u.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "mock-model" }] }) };
    if (u.includes("/slots")) return { ok: true, status: 200, json: async () => [{ n_ctx: TC }] };
    if (u.includes("/get_server_info")) return { ok: true, status: 200, json: async () => ({ max_total_tokens: TC }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "nf" };
  };
  const home = mkdtempSync(join(tmpdir(), "mm-life-deflt-"));
  t.after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });
  // 直接用 createManager(不经过 makeManager 的默认 fetchFn 兜底)→ 真实走默认 fetch 路径
  const m = createManager({ home });
  m.register({ port: 11455, framework: "llama", model: "Demo-4B" });
  const r = await m.benchFullCtx(11455, { profile: "fc-default-fetch", ctxTarget: TC, maxTokens: 16 });
  assert.equal(r.scheme, "full-ctx-warm-v2");
  assert.equal(chatOpts.length, 2); // warmup + 测量
  for (const o of chatOpts) {
    assert.equal(o.method, "POST", "测速请求必须显式 POST(默认 fetchImpl 曾把 options 丢弃→发出 GET)");
    assert.ok(o.body && String(o.body).includes('"stream":true'), "测速请求必须带 JSON 流式 body");
  }
});

test("benchFullCtx: 流式无 usage → 请求带 stream_options.include_usage,且非流式回退拿到 prompt_tokens", async (t) => {
  const sseNoUsage = (n) => new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      await new Promise((r) => setTimeout(r, 20)); // 模拟真实首块延迟,保证 ttfb>0 可算 prefillTps
      for (let i = 0; i < n; i++) c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
      c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  });
  let fallback = 0;
  const fn = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/v1/chat/completions")) {
      const body = JSON.parse(String(opts.body));
      if (body.stream === false) {
        fallback++;
        return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 42 } }) };
      }
      return { ok: true, status: 200, body: sseNoUsage(4), text: async () => "" };
    }
    if (u.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
    if (u.includes("/get_server_info")) return { ok: true, status: 200, json: async () => ({ max_total_tokens: TC }) };
    if (u.includes("/slots")) return { ok: true, status: 200, json: async () => [{ n_ctx: TC }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { m, cleanup } = makeManager({ fetchFn: fn }); t.after(cleanup);
  m.register({ port: 11460, framework: "sglang", model: "Demo-27B" });
  const r = await m.benchFullCtx(11460, { profile: "fc-usage-fallback", ctxTarget: TC, maxTokens: 16 });
  assert.equal(r.promptTokens, 42, "流式无 usage 时必须经非流式回退取到 prompt_tokens");
  assert.ok(r.prefillTps > 0, "prefillTps 必须有值(=prompt_tokens/ttfb)");
  assert.ok(fallback >= 1, "回退探测必须发生");
});

test("benchFullCtx: sglang 新字段 max_total_num_tokens 识别为实际 KV", async (t) => {
  const fn = async (url) => {
    const u = String(url);
    if (u.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
    if (u.includes("/get_server_info")) return { ok: true, status: 200, json: async () => ({ max_total_num_tokens: TC }) };
    if (u.includes("/slots")) return { ok: true, status: 200, json: async () => [{ n_ctx: TC }] };
    if (u.includes("/v1/chat/completions")) return { ok: true, status: 200, body: sseStream(4), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { m, cleanup } = makeManager({ fetchFn: fn }); t.after(cleanup);
  m.register({ port: 11461, framework: "sglang", model: "Demo-35B" });
  const r = await m.benchFullCtx(11461, { profile: "fc-num-tokens", ctxTarget: TC, maxTokens: 16 });
  assert.equal(r.ctxAllocated, TC, "max_total_num_tokens 必须被识别为实际分配 KV");
  assert.equal(r.fullCtx, true);
});

test("benchFullCtx: profile.framework 优先于 stale 注册表条目(回归:11436 留 vllm 死条目曾让 sglang 测速读到 vllm 旧日志 KV=1692759)", async (t) => {
  const fn = async (url) => {
    const u = String(url);
    if (u.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
    if (u.includes("/get_server_info")) return { ok: true, status: 200, json: async () => ({ max_total_num_tokens: TC }) };
    if (u.includes("/v1/chat/completions")) return { ok: true, status: 200, body: sseStream(4), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { m, home, cleanup } = makeManager({ fetchFn: fn }); t.after(cleanup);
  writeFileSync(join(home, "profiles.json"), JSON.stringify([{ name: "stale-reg-sg", framework: "sglang", modelPath: "/fake/model" }]));
  // 注册表留一个 stale 条目 framework=vllm(上一轮死进程未清理)
  m.register({ port: 11463, framework: "vllm", model: "Stale-27B" });
  // vllm 日志写入小 KV:代码若误走 vllm 分支会读成 100 < TC → 抛未达满上下文(红)
  mkdirSync(join(home, "servers"), { recursive: true });
  writeFileSync(join(home, "servers", "11463.log"), "GPU KV cache size: 100 tokens\n");
  const r = await m.benchFullCtx(11463, { profile: "stale-reg-sg", ctxTarget: TC, maxTokens: 16 });
  assert.equal(r.ctxAllocated, TC, "必须走 sglang 分支(/get_server_info),不得读 stale vllm 日志");
  assert.equal(r.fullCtx, true);
});

test("benchFullCtx: reasoning_content 纯思考流也计 token(35B-A3B 256 全 reasoning 案例)", async (t) => {
  const sseReasoning = (n) => new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < n; i++) c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"","reasoning_content":"think"}}]}\n\n'));
      c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":25,"completion_tokens":' + n + '}}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  });
  const fn = async (url) => {
    const u = String(url);
    if (u.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
    if (u.includes("/get_server_info")) return { ok: true, status: 200, json: async () => ({ max_total_num_tokens: TC }) };
    if (u.includes("/v1/chat/completions")) return { ok: true, status: 200, body: sseReasoning(4), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { m, cleanup } = makeManager({ fetchFn: fn }); t.after(cleanup);
  m.register({ port: 11462, framework: "sglang", model: "Demo-35B" });
  const r = await m.benchFullCtx(11462, { profile: "fc-reasoning", ctxTarget: TC, maxTokens: 16 });
  assert.equal(r.tokens, 4, "reasoning_content token 必须计入 tokens");
  assert.ok(r.tps > 0, "纯思考流也必须能计速");
});
