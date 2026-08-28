// lifecycle: 注册表 / 健康检查 / 停止红线 / llama 托管启动 / profile CRUD
// 全部注入 fake fetch/spawn/exec——不碰真实进程与真实端口
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
