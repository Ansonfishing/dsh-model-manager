// 生命周期:服务注册表 / 健康检查 / 停止(红线) / 托管启动(llama/sglang/vllm) / profile 版本 CRUD
// 全部依赖可注入(fetchFn / execFn / spawnFn / pidAlive),测试全 fake,不碰真实进程与端口。
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createStore, mmHome } from "./store.js";
import { stopPlan, assertNoPkill, realPidAlive } from "./safety.js";
import { validateProfile } from "./validate.js";
import { detectGpus, loadBuiltinGpus } from "./gpu.js";
import { adapters, getAdapter } from "./adapters/index.js";

export function createManager(deps = {}) {
  const home = deps.home || mmHome();
  const store = createStore(home);
  const pidAlive = deps.pidAlive || realPidAlive;

  // 探测超时 2500ms:SGLang 繁忙时 /health 实测 ~1s(事件循环忙),800ms 会误报 unreachable
  // 默认 fetch 必须转发调用方 options(method/body/signal),否则 streamBench 的 POST 退化成 GET
  // → llama 404 / sglang 405(2026-09-01 campaign 事故根因)。默认 2.5s 超时,调用方可自带 signal 覆盖。
  const fetchImpl = deps.fetchFn || ((url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(2500), ...opts }));
  const execImpl = deps.execFn || ((argv) => {
    assertNoPkill(argv);
    execFileSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: 15000 });
  });
  const spawnImpl = deps.spawnFn || ((exe, args, opts) => spawn(exe, args, { ...opts, stdio: "ignore" }));
  // vllm 满上下文证据源:托管日志 servers/<port>.log(可注入,测试用)
  const logFn = deps.logFn || ((port) => {
    try { return readFileSync(join(home, "servers", `${port}.log`), "utf8"); } catch { return ""; }
  });

  // ---------- GPU 显卡信息(gpus.json):首次启动自动获取一次,之后全手动 ----------
  // 卡编号口径 = CUDA_VISIBLE_DEVICES 值(CUDA 序),不是 nvidia-smi(NVML)物理序
  // (部分机器上 NVML 物理序与 CUDA 设备序相反)。NVML 降级只产 count+names,绝不写编号→卡名/显存映射(cards=null)。
  // 自动获取失败/文件损坏永不阻塞插件启动:记录 lastError,UI 显示,按钮可重试。
  let gpuLastError = null;
  let gpuCorruptError = null;
  const loadGpus = () => {
    try {
      return store.loadJSON("gpus.json", null);
    } catch (err) {
      gpuCorruptError = err.message;
      return null;
    }
  };

  function detectGpusNow() {
    const d = (deps.detectFn || (() => detectGpus()))();
    const stored = {
      source: d.source,
      detectedAt: new Date().toISOString(),
      cards: d.source === "cuda" ? d.cards : null,
    };
    if (d.source === "nvml") {
      stored.count = d.count;
      stored.names = d.names;
    }
    store.saveJSON("gpus.json", stored);
    gpuLastError = null;
    gpuCorruptError = null;
    return stored;
  }

  function gpus() {
    const stored = loadGpus();
    const parts = [];
    if (gpuCorruptError) parts.push(`gpus.json 损坏: ${gpuCorruptError}`);
    if (gpuLastError) parts.push(gpuLastError);
    return { gpus: stored, lastError: parts.length ? parts.join(" | ") : null, builtin: loadBuiltinGpus(home) };
  }

  function ensureGpusOnce() {
    try {
      if (loadGpus()) return; // 已有(含上次 NVML 降级结果)→ 不再自动,全手动
      detectGpusNow();
    } catch (err) {
      gpuLastError = err instanceof Error ? err.message : String(err);
    }
  }
  ensureGpusOnce();

  // ---------- 服务注册表 ----------
  const loadRegistry = () => store.loadJSON("servers.json", []);
  const saveRegistry = (entries) => store.saveJSON("servers.json", entries);

  function register(input) {
    const { port, framework, model = null, gpu = null, note = null, managed = false, pid = null } = input || {};
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port 非法: ${port}(必须是 1–65535 的整数)`);
    }
    if (!adapters[framework]) {
      throw new Error(`未知 framework (unknown): ${framework}(支持 llama / vllm / sglang)`);
    }
    const reg = loadRegistry();
    if (reg.some((e) => e.port === port)) {
      throw new Error(`port ${port} 已注册 (duplicate),先 stop 再重新 register`);
    }
    const entry = {
      port, framework, model, gpu, note, managed, pid,
      registeredAt: new Date().toISOString(),
    };
    reg.push(entry);
    saveRegistry(reg);
    return entry;
  }

  // 健康探测:15s TTL 缓存 + 并行探测,避免面板每次轮询都串行等探测
  const HEALTH_TTL_MS = 15000;
  const healthCache = new Map();

  async function healthOf(entry, { force = false } = {}) {
    const cached = healthCache.get(entry.port);
    if (!force && cached && Date.now() - cached.at < HEALTH_TTL_MS) {
      return { status: cached.status, health: cached.health };
    }
    const url = getAdapter(entry.framework).healthUrl(entry.port);
    let h;
    try {
      const res = await fetchImpl(url);
      if (res.ok) h = { status: "running", health: "ok" };
      else h = { status: "down", health: `http ${res.status}` };
    } catch {
      h = { status: "down", health: "unreachable" };
    }
    h.at = Date.now();
    healthCache.set(entry.port, h);
    return { status: h.status, health: h.health };
  }

  async function list() {
    const entries = loadRegistry();
    // 全部并行探测;TTL 内的直接读缓存,不会真正发请求
    const results = await Promise.all(entries.map((e) => healthOf(e)));
    return entries.map((entry, i) => ({ ...entry, ...results[i] }));
  }

  async function stop(port, { force = false } = {}) {
    const entry = loadRegistry().find((e) => e.port === port) || null;
    // stopPlan 内部:未注册 → 托管/外部,依次判定并抛错
    const argv = stopPlan(port, entry, { force, pidAlive });
    assertNoPkill(argv);
    await execImpl(argv);
    saveRegistry(loadRegistry().filter((e) => e.port !== port));
    return { port, argv };
  }

  // 注册表端口快照(校验用,不做健康检查)
  function registry() {
    return loadRegistry();
  }

  // ---------- profile 参数版本 ----------
  const loadProfiles = () => store.loadJSON("profiles.json", []);
  const saveProfiles = (list) => store.saveJSON("profiles.json", list);

  function saveProfile(input) {
    const reg = loadRegistry().map((e) => ({ port: e.port }));
    // 显存校验用检测值(CUDA 序编号→GiB);NVML 降级(cards=null)时不传,回退内置表
    const g = loadGpus();
    const gpuCap = g && Array.isArray(g.cards) && g.cards.length
      ? Object.fromEntries(g.cards.map((c) => [c.index, c.memGb]))
      : undefined;
    const v = validateProfile(input, { registry: reg, gpuCap });
    if (!v.ok) {
      throw new Error(`profile 校验失败 (validation): ${v.errors.join(";")}`);
    }
    const list = loadProfiles();
    const existing = list.find((p) => p.name === input.name);
    const profile = {
      ...input,
      id: existing ? existing.id : `p-${Date.now()}-${randomUUID().slice(0, 8)}`,
      active: existing ? existing.active : false,
      updatedAt: new Date().toISOString(),
    };
    if (existing) {
      list.splice(list.indexOf(existing), 1, profile);
    } else {
      list.push(profile);
    }
    saveProfiles(list);
    return profile;
  }

  function listProfiles() {
    return loadProfiles();
  }

  function loadProfile(ref) {
    const list = loadProfiles();
    const idx = list.findIndex((p) => p.id === ref || p.name === ref);
    if (idx === -1) throw new Error(`profile 不存在 (not found): ${ref}`);
    list.forEach((p, i) => { p.active = i === idx; });
    saveProfiles(list);
    return list[idx];
  }

  function deleteProfile(ref) {
    const list = loadProfiles();
    const idx = list.findIndex((p) => p.id === ref || p.name === ref);
    if (idx === -1) throw new Error(`profile 不存在 (not found): ${ref}`);
    list.splice(idx, 1);
    saveProfiles(list);
    return list.length;
  }

  function importProfiles(input) {
    let data = input;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (err) {
        throw new Error(`JSON 解析失败 (parse): ${err.message}`);
      }
    }
    const arr = Array.isArray(data) ? data : [data];
    let n = 0;
    for (const item of arr) {
      saveProfile(item);
      n += 1;
    }
    return n;
  }

  // ---------- 框架路径配置(~/.dsh/model-manager/frameworks.json) ----------
  // 每框架一个 exe 路径:llama=llama-server 可执行文件;sglang/vllm=python(通常 venv 内)。
  // 启动 exe 解析链:profile.exePath → frameworks[fw].exe → adapter.defaultExe。
  const loadFrameworks = () => store.loadJSON("frameworks.json", {});
  const saveFrameworks = (fw) => store.saveJSON("frameworks.json", fw);

  function getFrameworks() {
    const fw = loadFrameworks();
    const frameworks = {};
    const defaults = {};
    for (const k of Object.keys(adapters)) {
      frameworks[k] = { exe: (fw[k] && typeof fw[k].exe === "string") ? fw[k].exe : "" };
      defaults[k] = adapters[k].defaultExe;
    }
    return { frameworks, defaults };
  }

  function setFramework({ framework, exe = "" } = {}) {
    if (!adapters[framework]) {
      throw new Error(`未知 framework (unknown): ${framework}(支持 llama / vllm / sglang)`);
    }
    const path = String(exe || "").trim();
    if (path && !existsSync(path)) {
      throw new Error(`路径不存在 (path not found): ${path}`);
    }
    const fw = loadFrameworks();
    fw[framework] = { exe: path };
    saveFrameworks(fw);
    return getFrameworks();
  }

  // 探测版本:llama 用 --version;sglang/vllm 用 <python> -c "import <fw>; print(__version__)"
  function probeFramework({ framework, exe = "" } = {}) {
    if (!adapters[framework]) {
      throw new Error(`未知 framework (unknown): ${framework}`);
    }
    const saved = (loadFrameworks()[framework] || {}).exe || "";
    const exePath = String(exe || "").trim() || saved || adapters[framework].defaultExe;
    const argv = framework === "llama"
      ? [exePath, "--version"]
      : [exePath, "-c", `import ${framework} as _mm; print(_mm.__version__)`];
    assertNoPkill(argv);
    try {
      const out = execFileSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
      const line = String(out || "").trim().split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      return { framework, exe: exePath, ok: true, line: line.slice(0, 200) };
    } catch (err) {
      return { framework, exe: exePath, ok: false, line: String((err && (err.stderr || err.message)) || err).trim().slice(0, 200) };
    }
  }

  // ---------- 一键测速(benchmarks.json,保留最近 50 条) ----------
  // 非流式 /v1/chat/completions,max_tokens 固定生成,usage.completion_tokens 计速。
  // tps 用 (tokens-1)/(ms/1000),把首 token 时延(TTFT)剔出分子。
  const BENCH_PROMPT = "请写一篇不少于300字的短文,介绍大语言模型的发展。";
  const loadBench = () => store.loadJSON("benchmarks.json", []);
  const saveBench = (list) => store.saveJSON("benchmarks.json", list.slice(-50));

  function listBenchmarks() {
    return loadBench();
  }

  async function bench(port, { profile = null, maxTokens = 256 } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port 非法 (invalid): ${port}`);
    }
    const reg = loadRegistry().find((e) => e.port === port);
    if (!reg) throw new Error(`port ${port} 未登记 (not registered),先 register`);
    const base = `http://127.0.0.1:${port}`;
    let model = null;
    try {
      const r = await fetchImpl(`${base}/v1/models`);
      if (r.ok) {
        const d = await r.json();
        const first = (d.data || [])[0];
        model = (first && first.id) || null;
      }
    } catch {}
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model || reg.model || "local",
          messages: [{ role: "user", content: BENCH_PROMPT }],
          max_tokens: Number(maxTokens) || 256,
          temperature: 0.8,
          stream: false,
        }),
        signal: AbortSignal.timeout(180000),
      });
    } catch (err) {
      throw new Error(`测速请求失败 (request failed): ${err instanceof Error ? err.message : String(err)}`);
    }
    const ms = Date.now() - t0;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`测速失败 (http ${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
    const tokens = data.usage && data.usage.completion_tokens;
    if (!Number.isInteger(tokens) || tokens < 1) {
      throw new Error("服务未返回 usage.completion_tokens(usage missing),无法计速");
    }
    const tps = ms > 0 ? Math.round(((tokens - 1) / (ms / 1000)) * 10) / 10 : null;
    const entry = {
      at: new Date().toISOString(), port, profile, model,
      tokens, ms, tps, maxTokens: Number(maxTokens) || 256,
    };
    saveBench([...loadBench(), entry]);
    return entry;
  }

  // ---------- 满上下文热测速(scheme full-ctx-warm-v2) ----------
  // 口径(2026-09-01 用户定):服务按满上下文参数启动 → 校验实际可用上下文 ≥ ctxTarget →
  // 1 次流式 warmup(丢弃)+ 1 次流式测量(单并发串行)。SSE 逐块计时:
  // ttfbMs=首 token 时延、prefillTps=prompt_tokens/ttfb、tps(=decode)=(tokens-1)/(ms-ttfb)。
  // 满上下文证据源按框架:sglang=/get_server_info.max_total_tokens、
  // llama=/slots 首槽 n_ctx(per-slot)、vllm=servers/<port>.log 正则 "GPU KV cache size: N tokens"。
  // 校验不达 → 抛错不落盘(宁可排除不可虚报);流式失败(含 http 5xx)→ 抛错不落盘。
  async function streamBench(base, model, maxTokens) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetchImpl(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: BENCH_PROMPT }],
          max_tokens: Number(maxTokens) || 256,
          temperature: 0,
          stream: true,
          // llama.cpp(server-task.cpp:502)/vLLM 均支持:最后一个流式块带 usage.prompt_tokens;
          // 不支持的框架忽略此字段(无副作用)。
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(600000),
      });
    } catch (err) {
      throw new Error(`测速请求失败 (request failed): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const body = typeof res.text === "function" ? await res.text().catch(() => "") : "";
      throw new Error(`测速失败 (http ${res.status}): ${String(body).slice(0, 200)}`);
    }
    const dec = new TextDecoder();
    let buf = "";
    let ttfb = null;
    let tokens = 0;
    let promptTokens = null;
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        const choice = (obj.choices || [])[0] || {};
        const delta = choice.delta || {};
        // reasoning 模型(sglang reasoning_parser)思考阶段 token 走 delta.reasoning_content,
        // decode 吞吐按"所有生成 token"计 → 思考 token 必须计入(否则纯思考流被误判 0 token)
        const hasToken = (typeof delta.content === "string" && delta.content.length > 0)
          || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0)
          || (Array.isArray(delta.token_ids) && delta.token_ids.length > 0);
        if (hasToken) {
          if (ttfb == null) ttfb = Date.now() - t0;
          tokens += 1;
        }
        if (obj.usage && Number.isInteger(obj.usage.prompt_tokens)) promptTokens = obj.usage.prompt_tokens;
      }
    }
    // 回退:流式 chunk 未带 usage.prompt_tokens 时(llama.cpp 旧行为),发一次非流式请求取 prompt_tokens。
    // 用同样 prompt 保证 prefillTps = prompt_tokens/ttfb 口径不变。
    if (promptTokens == null) {
      try {
        const r2 = await fetchImpl(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: BENCH_PROMPT }],
            max_tokens: 1,
            temperature: 0,
            stream: false,
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (r2.ok) {
          const j = await r2.json().catch(() => null);
          promptTokens = j?.usage?.prompt_tokens ?? null;
        }
      } catch { /* 回退失败不阻断:promptTokens 保持 null,prefillTps=null */ }
    }
    const ms = Date.now() - t0;
    if (tokens < 1) throw new Error("流式响应无 token 产出,无法计速");
    const ttfbMs = ttfb == null ? ms : ttfb;
    const decodeMs = Math.max(1, ms - ttfbMs);
    return {
      tokens, ms, ttfbMs,
      prefillTps: promptTokens && ttfbMs > 0 ? Math.round((promptTokens / (ttfbMs / 1000)) * 10) / 10 : null,
      tps: Math.round(((tokens - 1) / (decodeMs / 1000)) * 10) / 10,
      promptTokens,
    };
  }

  async function benchFullCtx(port, { profile = null, ctxTarget = 262144, maxTokens = 256 } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port 非法 (invalid): ${port}`);
    }
    const reg = loadRegistry().find((e) => e.port === port) || null;
    // framework 以 profile 为准(调用方声明被服的真实框架),注册表条目只作兜底。
    // 回归事故(2026-08-30):11436 残留 stale 条目(framework=vllm,死 pid)曾让 sglang
    // 满上下文校验误走 vllm 日志分支,把旧进程的 "GPU KV cache size: 1,692,759" 当成当前服务。
    const profObj =
      profile && typeof profile === "object"
        ? profile
        : typeof profile === "string"
          ? loadProfiles().find((p) => p.name === profile || p.id === profile) || null
          : null;
    const fw = (profObj && profObj.framework) || (reg && reg.framework) || null;
    if (!fw) throw new Error(`port ${port} 未登记 (not registered) 且 profile 无 framework,先 register 或传带 framework 的 profile`);
    const base = `http://127.0.0.1:${port}`;
    let model = null;
    try {
      const r = await fetchImpl(`${base}/v1/models`);
      if (r.ok) {
        const d = await r.json();
        const first = (d.data || [])[0];
        model = (first && first.id) || null;
      }
    } catch {}
    // —— 满上下文校验:达不到 ctxTarget 直接拒,不虚报 ——
    let ctxAllocated = null;
    try {
      if (fw === "sglang") {
        const r = await fetchImpl(`${base}/get_server_info`);
        if (r.ok) {
          const d = await r.json();
          // 新 sglang(/server_info):实际分配 KV 在 scheduler_info.max_total_num_tokens;
          // 老版本/ServerArgs 残留字段是 max_total_tokens(可能是未解析的 None)。两者都认。
          const kv = Number.isInteger(d.max_total_num_tokens) ? d.max_total_num_tokens
            : (Number.isInteger(d.max_total_tokens) ? d.max_total_tokens : null);
          if (kv != null) ctxAllocated = kv;
        }
      } else if (fw === "llama") {
        const r = await fetchImpl(`${base}/slots`);
        if (r.ok) {
          const d = await r.json();
          const first = Array.isArray(d) ? d[0] : null;
          if (first && Number.isInteger(first.n_ctx)) ctxAllocated = first.n_ctx;
        }
      } else if (fw === "vllm") {
        // 追加式日志可能含历史启动记录 → 取最后一次匹配(=当前进程)
        const all = [...String(logFn(port) || "").matchAll(/GPU KV cache size:\s*([\d,]+)/g)];
        if (all.length) ctxAllocated = Number(all[all.length - 1][1].replace(/,/g, "")); // 千分位逗号 → 数字
      }
    } catch {}
    let fullCtx = false;
    let ctxNote = null;
    if (ctxAllocated == null) {
      ctxNote = "未取得实际上下文数值,视为未验证满上下文";
      fullCtx = false;
    } else if (ctxAllocated < ctxTarget) {
      throw new Error(`未达满上下文 (full-ctx not met): 实际 ${ctxAllocated} < 目标 ${ctxTarget}`);
    } else {
      fullCtx = true;
    }
    // —— 热启动:先 1 次 warmup(丢弃)再 1 次测量,单并发串行 ——
    const useModel = model || (reg && reg.model) || "local";
    await streamBench(base, useModel, maxTokens); // warmup(丢弃);失败=服务状态不佳,直接抛
    let m;
    try {
      m = await streamBench(base, useModel, maxTokens);
    } catch (err) {
      // spec:测速请求失败重试 1 次,仍失败抛错跳过(不落盘)
      m = await streamBench(base, useModel, maxTokens);
      void err;
    }
    const entry = {
      at: new Date().toISOString(), port, profile, model,
      scheme: "full-ctx-warm-v2",
      promptTokens: m.promptTokens != null ? m.promptTokens : null,
      tokens: m.tokens, maxTokens: Number(maxTokens) || 256,
      ttfbMs: m.ttfbMs, prefillTps: m.prefillTps, tps: m.tps, ms: m.ms,
      warm: true,
      ctxTarget, ctxAllocated, fullCtx, ctxNote,
    };
    saveBench([...loadBench(), entry]);
    return entry;
  }

  // ---------- 启动(托管) ----------
  function start({ profile: ref, port, gpu } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port 非法: ${port}`);
    }
    const prof = loadProfiles().find((p) => p.id === ref || p.name === ref);
    if (!prof) throw new Error(`profile 不存在 (not found): ${ref}`);
    if (!adapters[prof.framework]) {
      throw new Error(`未知 framework (unknown): ${prof.framework}(支持 llama / sglang / vllm)`);
    }
    let reg = loadRegistry();
    const existing = reg.find((e) => e.port === port);
    if (existing) {
      // 死托管记录自动清理:managed 且记录的 pid 已亡(或无 pid)→ 删除后继续启动。
      // 外部(非托管)条目维持原拒绝——面板走「停止(fuser)」清理,不替用户盲删。
      const staleManaged = existing.managed && (existing.pid == null || !pidAlive(Number(existing.pid)));
      if (!staleManaged) {
        throw new Error(`port ${port} 已被注册表占用 (in use)`);
      }
      saveRegistry(reg.filter((e) => e.port !== port));
    }
    // gpu 口径 = CUDA_VISIBLE_DEVICES 值:显式传参优先;缺省取 profile.gpu;再缺省 0。
    // 双卡表达:gpu 为 null 或字符串 "1,0"(多卡逗号串)直接透传;单卡仍为数字 0/1。
    const g = gpu !== undefined
      ? (gpu === null ? "1,0" : gpu)
      : (prof.gpu !== undefined ? (prof.gpu === null ? "1,0" : prof.gpu) : 0);
    const built = getAdapter(prof.framework).buildArgs(prof, { port });
    // exe 解析链:profile.exePath → frameworks.json[fw].exe → adapter.defaultExe
    const fwExe = ((loadFrameworks()[prof.framework]) || {}).exe || "";
    const exe = (prof.exePath || fwExe) || built.exe;
    const args = built.args;
    // flashinfer-python 与 flashinfer-cubin 版本不一致时,sglang/vllm import 即崩
    // (实测事故:flashinfer-python 与 flashinfer-cubin 版本不一致 → import 即 RuntimeError)。
    // 与手动启动命令一致地跳过 cubin 版本检查;根本修复=pip 对齐版本。
    const skipFlashinferCheck = prof.framework === "sglang" || prof.framework === "vllm";
    const opts = {
      cwd: home,
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: String(g),
        ...(skipFlashinferCheck ? { FLASHINFER_DISABLE_VERSION_CHECK: "1" } : {}),
      },
      port,
    };
    const child = spawnImpl(exe, args, opts);
    const pid = child && child.pid;
    if (!pid) throw new Error("spawn 未返回 pid,无法登记托管");
    writeFileSync(join(home, "servers", `${port}.pid`), String(pid));
    register({
      port,
      framework: prof.framework,
      model: prof.model || prof.name,
      gpu: g,
      note: `managed:${prof.name}`,
      managed: true,
      pid,
    });
    return loadRegistry().find((e) => e.port === port);
  }

  return {
    home,
    register,
    registry,
    list,
    stop,
    gpus,
    detectGpusNow,
    saveProfile,
    listProfiles,
    loadProfile,
    deleteProfile,
    importProfiles,
    start,
    getFrameworks,
    setFramework,
    probeFramework,
    listBenchmarks,
    bench,
    benchFullCtx,
  };
}
