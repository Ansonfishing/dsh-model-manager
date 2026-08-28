// 生命周期:服务注册表 / 健康检查 / 停止(红线) / 托管启动(llama/sglang/vllm) / profile 版本 CRUD
// 全部依赖可注入(fetchFn / execFn / spawnFn / pidAlive),测试全 fake,不碰真实进程与端口。
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
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
  const fetchImpl = deps.fetchFn || ((url) => fetch(url, { signal: AbortSignal.timeout(2500) }));
  const execImpl = deps.execFn || ((argv) => {
    assertNoPkill(argv);
    execFileSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: 15000 });
  });
  const spawnImpl = deps.spawnFn || ((exe, args, opts) => spawn(exe, args, { ...opts, stdio: "ignore" }));

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
    // stopPlan 内部:未注册 → 托管/外部,依次判定并抛错(11437 保护已降级)
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
    const g = Number.isInteger(gpu) ? gpu : (Number.isInteger(prof.gpu) ? prof.gpu : 0);
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
  };
}
