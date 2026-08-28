// contract: 插件入口契约——node --check 全源文件(含 client 半) + package.json/cordis 形状
//          + apply(fake ctx) 全量 P0 验收(9 工具 + 9 路由 + 安全纪律 + 红线)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));

test("node --check 通过全部源文件", () => {
  const files = [
    "index.js",
    "lib/store.js",
    "lib/safety.js",
    "lib/validate.js",
    "lib/lifecycle.js",
    "lib/adapters/index.js",
    "lib/adapters/llama.js",
    "lib/adapters/vllm.js",
    "lib/adapters/sglang.js",
    "lib/client.js",
  ];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", join(root, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `node --check ${f} failed: ${r.stderr}`);
  }
});

test("package.json + cordis.patch.yml 形状", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "dsh-model-manager");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./index.js");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-slots"));
  assert.match(readFileSync(join(root, "cordis.patch.yml"), "utf8"), /id:\s*model-manager/);
});

test("apply(fake ctx): 9 工具 + 2 路由 + 安全纪律 + P0 验收", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mm-contract-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  const mod = await import("../index.js");
  assert.equal(mod.name, "dsh-model-manager");
  assert.deepEqual(mod.inject, ["tools", "webServer"]);

  const tools = [];
  const routes = [];
  const ctx = {
    effect: (fn) => { fn(); },
    webServer: { register: (r) => routes.push(r) },
    get: (k) => (k === "tools" ? { register: (d) => tools.push(d) } : undefined),
    logger: { warn: () => {} },
    deps: { detectFn: () => { throw new Error("contract: skip real GPU detect"); } },
  };
  mod.apply(ctx);

  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    "mm_bench",
    "mm_framework_list", "mm_framework_probe", "mm_framework_save",
    "mm_profile_delete", "mm_profile_import", "mm_profile_list", "mm_profile_load", "mm_profile_save",
    "mm_server_list", "mm_server_register", "mm_server_start", "mm_server_stop",
  ]);
  assert.deepEqual(routes.map((r) => r.path).sort(), [
    "/api/mm/bench",
    "/api/mm/benchmarks",
    "/api/mm/frameworks",
    "/api/mm/frameworks/probe",
    "/api/mm/frameworks/save",
    "/api/mm/gpus",
    "/api/mm/gpus/detect",
    "/api/mm/log",
    "/api/mm/profile/delete",
    "/api/mm/profile/load",
    "/api/mm/profile/save",
    "/api/mm/profiles",
    "/api/mm/register",
    "/api/mm/servers",
    "/api/mm/start",
    "/api/mm/stop",
  ]);

  // 面板 banner id 必须与 cordis entry name 一致(client 半经 __ModuleLoader__ 注册)
  const clientSrc = readFileSync(join(root, "lib/client.js"), "utf8");
  assert.match(clientSrc, /id:\s*"dsh-model-manager"/);
  assert.match(clientSrc, /x-dsh-model-manager-client/);

  const by = (n) => tools.find((x) => x.name === n);

  // P0 验收 1:注册(不存在的端口,只读健康检查 → down 但不抛)→ list 可见
  await by("mm_server_register").execute({ port: 19999, framework: "sglang", model: "Smoke-Test", gpu: 0, note: "contract smoke" });
  const listText = await by("mm_server_list").execute({});
  assert.match(listText, /19999/);
  assert.match(listText, /Smoke-Test/);

  // 11437 保护已降级:行为等同外部服务——外部无 force 拒、force 可停。
  // 注意:绝不通过真实路由对已注册 11437 调 stop(测试进程与真实服务共享网络命名空间,
  // 会 fuser -k 杀掉真实服务!)——行为断言全部走 stopPlan 纯函数,路由层只验「未注册拒盲杀」。
  const { stopPlan, assertNoPkill, DEFAULT_PROTECTED_PORTS } = await import("../lib/safety.js");
  assert.ok(DEFAULT_PROTECTED_PORTS.includes(11437), "11437 仍保留为 DSH 在用 UI 标记");
  await assert.rejects(() => by("mm_server_stop").execute({ port: 11437, force: true }), /未注册|unregistered/);
  // stopPlan 纯函数:11437 与任意外部端口行为一致
  assert.deepEqual(stopPlan(11437, { port: 11437, managed: false }, { force: true }), ["fuser", "-k", "11437/tcp"]);
  assert.throws(() => stopPlan(11437, { port: 11437, managed: false }), /force/);
  assert.throws(() => stopPlan(11437, null, { force: true }), /未注册|unregistered/);
  assert.throws(() => assertNoPkill(["pkill", "-f", "sglang"]), /pkill/);
  await by("mm_server_register").execute({ port: 11437, framework: "sglang", model: "PRO6000" });
  await assert.rejects(() => by("mm_server_stop").execute({ port: 19999 }), /force/);

  // P0 验收 2:profile save → list 可见
  const savedText = await by("mm_profile_save").execute({
    profile: {
      name: "Demo · llama · 快速", framework: "llama", model: "Demo-35B-A3B",
      modelPath: "/models/or.gguf", launchCommand: "-np 1 -c 262144 --slots",
      contextWindow: 262144, gpu: 1,
    },
  });
  assert.match(savedText, /Demo · llama · 快速/);
  const pText = await by("mm_profile_list").execute({});
  assert.match(pText, /Demo · llama · 快速/);

  // webServer 安全纪律:无 header → 403;跨域 Origin → 403;header + 同源 → 200;非 GET → 405
  const route = routes.find((r) => r.path === "/api/mm/servers");
  const mkRes = () => {
    const res = { code: 0, headers: {}, body: "" };
    res.writeHead = (c, h) => { res.code = c; res.headers = h ?? {}; };
    res.end = (b) => { res.body = b ?? ""; };
    return res;
  };
  const req = (headers, method = "GET") => ({ method, headers });

  let res = mkRes();
  await route.handler(req({ host: "127.0.0.1:3080" }), res);
  assert.equal(res.code, 403);

  res = mkRes();
  await route.handler(req({ host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://evil.example" }), res);
  assert.equal(res.code, 403);

  res = mkRes();
  await route.handler(req({ host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://127.0.0.1:3080" }), res);
  assert.equal(res.code, 200);
  const payload = JSON.parse(res.body);
  assert.ok(Array.isArray(payload));
  assert.ok(payload.some((s) => s.port === 11437));
  assert.match(res.headers["content-type"] ?? "", /application\/json/);
  assert.match(res.headers["cache-control"] ?? "", /no-store/);

  res = mkRes();
  await route.handler(req({ host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://127.0.0.1:3080" }, "POST"), res);
  assert.equal(res.code, 405);

  // ---------- 框架路径配置(P1):非法框架/不存在路径拒;空路径=恢复默认;探测不存在可执行文件→不可用 ----------
  await assert.rejects(() => by("mm_framework_save").execute({ framework: "nope", exe: "" }), /unknown|未知 framework/);
  await assert.rejects(() => by("mm_framework_save").execute({ framework: "llama", exe: "/no/such/llama-server" }), /not found|不存在/);
  const fwOk = await by("mm_framework_save").execute({ framework: "llama", exe: "" });
  assert.match(fwOk, /llama/);
  assert.match(await by("mm_framework_list").execute({}), /llama/);
  assert.match(await by("mm_framework_probe").execute({ framework: "llama", exe: "/no/such/llama-server" }), /unavailable|不可用/);

  // ---------- 一键测速(P1):未登记端口拒;fake fetch → tok/s 计算 + 落盘 ----------
  await assert.rejects(() => by("mm_bench").execute({ port: 17777 }), /not registered|未登记|invalid/);
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/v1/models")) return { ok: true, json: async () => ({ data: [{ id: "fake-model" }] }) };
      return { ok: true, json: async () => ({ usage: { completion_tokens: 256 } }) };
    };
    try {
      const out = await by("mm_bench").execute({ port: 19999, profile: "Smoke-Test" });
      assert.match(out, /256 tokens/);
      assert.match(out, /tok\/s/);
    } finally {
      globalThis.fetch = realFetch;
    }
    const bres = mkRes();
    await routes.find((r) => r.path === "/api/mm/benchmarks").handler(
      req({ host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://127.0.0.1:3080" }), bres);
    const blist = JSON.parse(bres.body);
    assert.equal(bres.code, 200);
    assert.equal(blist.length, 1);
    assert.equal(blist[0].tokens, 256);
    assert.equal(blist[0].profile, "Smoke-Test");
  }
});

// ---------- POST 动作路由(面板按钮走这里)----------
test("POST 动作路由:登记/保存/激活/删除/启动P2拒绝/停止红线/403/405", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mm-contract-post-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  const mod = await import("../index.js");
  const routes = [];
  const spawned = [];
  const ctx = {
    effect: (fn) => { fn(); },
    webServer: { register: (r) => routes.push(r) },
    get: (k) => (k === "tools" ? { register: () => {} } : undefined),
    logger: { warn: () => {} },
    deps: {
      spawnFn: (exe, args, opts) => { spawned.push({ exe, args, opts }); return { pid: 99999, unref() {} }; },
      detectFn: () => { throw new Error("contract: skip real GPU detect"); },
    },
  };
  mod.apply(ctx);
  const route = (path) => routes.find((r) => r.path === path);

  const mkRes = () => {
    const res = { code: 0, headers: {}, body: "" };
    res.writeHead = (c, h) => { res.code = c; res.headers = h ?? {}; };
    res.end = (b) => { res.body = b ?? ""; };
    return res;
  };
  // POST:带 body 的 stream + 合法 header + 同源 origin
  const post = (body) => {
    const r = Readable.from([Buffer.from(JSON.stringify(body))]);
    r.method = "POST";
    r.headers = { host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://127.0.0.1:3080" };
    return r;
  };
  const getReq = (extra = {}) => ({ method: "GET", headers: { host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://127.0.0.1:3080", ...extra } });
  const json = (res) => JSON.parse(res.body);

  // 未带 header 的 POST → 403
  let res = mkRes();
  const badPost = Readable.from([Buffer.from("{}")]); badPost.method = "POST"; badPost.headers = { host: "127.0.0.1:3080" };
  await route("/api/mm/register").handler(badPost, res);
  assert.equal(res.code, 403);

  // 跨域 POST → 403
  res = mkRes();
  const evil = Readable.from([Buffer.from("{}")]); evil.method = "POST"; evil.headers = { host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://evil.example" };
  await route("/api/mm/register").handler(evil, res);
  assert.equal(res.code, 403);

  // 登记(外部服务) → 200
  res = mkRes();
  await route("/api/mm/register").handler(post({ port: 18888, framework: "llama", model: "UI-Smoke", gpu: 1, note: "panel" }), res);
  assert.equal(res.code, 200);
  assert.equal(json(res).entry.port, 18888);

  // 停止:外部服务不带 force → 400
  res = mkRes();
  await route("/api/mm/stop").handler(post({ port: 18888 }), res);
  assert.equal(res.code, 400);
  assert.match(json(res).error, /force/);

  // 停止:未注册端口即使 force → 400 拒盲杀(11437 保护已放开,绝不走真实 stop 路由测 11437)
  res = mkRes();
  await route("/api/mm/stop").handler(post({ port: 11999, force: true }), res);
  assert.equal(res.code, 400);
  assert.match(json(res).error, /未注册|unregistered/);

  // 保存 profile(llama, -c 被 -np 整除 → 合法) → 200 + warnings
  res = mkRes();
  await route("/api/mm/profile/save").handler(post({ profile: { name: "UI-A", framework: "llama", modelPath: "/models/a.gguf", launchCommand: "-np 2 -c 524288", contextWindow: 262144, gpu: 0 } }), res);
  assert.equal(res.code, 200);
  assert.ok(Array.isArray(json(res).warnings));

  // 保存:llama 托管参数 -m 越权 → 400
  res = mkRes();
  await route("/api/mm/profile/save").handler(post({ profile: { name: "UI-bad", framework: "llama", modelPath: "/a.gguf", launchCommand: "-m /x.gguf -np 1" } }), res);
  assert.equal(res.code, 400);
  assert.match(json(res).error, /托管|managed/);

  // 激活 → 200 active=true
  res = mkRes();
  await route("/api/mm/profile/load").handler(post({ profile: "UI-A" }), res);
  assert.equal(res.code, 200);
  assert.equal(json(res).profile.active, true);

  // 保存一个 vllm profile,启动它 → 200(P2 已支持,走 python -m vllm 托管 spawn,fake 不碰真实进程)
  res = mkRes();
  await route("/api/mm/profile/save").handler(post({ profile: { name: "UI-V", framework: "vllm", modelPath: "/models/v/", launchCommand: "--max-model-len 32768" } }), res);
  assert.equal(res.code, 200);
  res = mkRes();
  await route("/api/mm/start").handler(post({ profile: "UI-V", port: 19001 }), res);
  assert.equal(res.code, 200);
  assert.equal(json(res).entry.managed, true);
  assert.equal(json(res).entry.framework, "vllm");
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(0, 2), ["-m", "vllm.entrypoints.openai.api_server"]);
  assert.ok(spawned[0].args.includes("--model") && spawned[0].args.includes("/models/v/"));

  // 删除 UI-A → 200,remaining 递减
  res = mkRes();
  await route("/api/mm/profile/delete").handler(post({ profile: "UI-A" }), res);
  assert.equal(res.code, 200);
  assert.equal(json(res).remaining, 1);

  // GET /api/mm/benchmarks → 200 []
  res = mkRes();
  await route("/api/mm/benchmarks").handler(getReq(), res);
  assert.equal(res.code, 200);
  assert.deepEqual(json(res), []);

  // GET /api/mm/gpus:首启自动检测被 fake detectFn 拦截 → 200,gpus=null + lastError + 内置回退表
  res = mkRes();
  await route("/api/mm/gpus").handler(getReq(), res);
  assert.equal(res.code, 200);
  assert.equal(json(res).gpus, null);
  assert.match(json(res).lastError, /contract: skip real GPU detect/);
  assert.ok(json(res).builtin, "暴露内置回退表供 UI");

  // POST /api/mm/gpus/detect:detectFn 抛错 → 400(错误透传,UI 弹提示)
  res = mkRes();
  await route("/api/mm/gpus/detect").handler(post({}), res);
  assert.equal(res.code, 400);
  assert.match(json(res).error, /contract: skip real GPU detect/);

  // GET /api/mm/log:未登记端口(已停止)→ 200 + lines:[] + registered:false(停止后可回看);非法端口 → 400;已登记但无日志文件 → 200 + lines:[]
  const logGet = (url) => ({ method: "GET", url, headers: { host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://127.0.0.1:3080" } });
  res = mkRes();
  await route("/api/mm/log").handler(logGet("/api/mm/log?port=19999"), res);
  assert.equal(res.code, 200);
  assert.deepEqual(json(res).lines, []);
  assert.equal(json(res).registered, false);
  res = mkRes();
  await route("/api/mm/log").handler(logGet("/api/mm/log?port=abc"), res);
  assert.equal(res.code, 400);
  res = mkRes();
  await route("/api/mm/log").handler(logGet("/api/mm/log?port=18888"), res);
  assert.equal(res.code, 200);
  assert.deepEqual(json(res).lines, []);

  // POST 到只读路由 → 405;GET 到动作路由 → 405
  res = mkRes();
  const postServers = Readable.from([Buffer.from("{}")]); postServers.method = "POST"; postServers.headers = { host: "127.0.0.1:3080", "x-dsh-model-manager-client": "v1", origin: "http://127.0.0.1:3080" };
  await route("/api/mm/servers").handler(postServers, res);
  assert.equal(res.code, 405);

  res = mkRes();
  await route("/api/mm/stop").handler(getReq(), res);
  assert.equal(res.code, 405);
});
