// dsh-model-manager 插件入口(node 半)
// P0:9 个 agent tools(服务启停/注册 + 参数 profile 版本管理)+ 2 条只读 webServer 路由。
// 红线:绝不 pkill、绝不停保护端口 11437、绝不自动重启 dsh。
import { join } from "node:path";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mmHome } from "./lib/store.js";
import { createManager } from "./lib/lifecycle.js";
import { validateProfile } from "./lib/validate.js";

export const name = "dsh-model-manager";
export const inject = ["tools", "webServer"];

const CLIENT_HEADER = "x-dsh-model-manager-client";
const CLIENT_VALUE = "v1";

function present(title, text) {
  return {
    card: "generic",
    title,
    content: [{ type: "text", text: String(text) }],
  };
}

function sendJSON(res, code, payload) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

// 同源纪律(dsh-cap-profile 同款):必带 client header;Origin/Referer 与 host 比对;
// 浏览器同源 GET 不发 Origin → Referer 兜底;两者都无 → 403。
function originMatches(req) {
  const host = req.headers && req.headers.host;
  if (!host) return false;
  const candidate =
    (req.headers && (req.headers.origin || req.headers.referer)) || null;
  if (!candidate) return false;
  try {
    const u = new URL(candidate);
    return (
      (u.protocol === "http:" || u.protocol === "https:") && u.host === host
    );
  } catch {
    return false;
  }
}

// 读路由(GET)与动作路由(POST)共用:client header + 同源校验;再按各自允许的 method 放行。
function guard(req, res) {
  if (req.headers[CLIENT_HEADER] !== CLIENT_VALUE) {
    sendJSON(res, 403, { error: "forbidden: client header missing or wrong" });
    return false;
  }
  if (!originMatches(req)) {
    sendJSON(res, 403, { error: "forbidden: origin mismatch" });
    return false;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJSON(res, 405, { error: "method not allowed" });
    return false;
  }
  return true;
}

// POST 请求体读取(node:http IncomingMessage 流),限 100KB,解析 JSON。
function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        if (req.destroy) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 动作路由统一壳:guard → 方法校验 → 读 body → 跑 manager 函数 → 200/400。
// 红线(绝不 pkill / 未注册拒盲杀 / 外部需 force)全在 manager 内,路由层只负责传输。
// 11437 保护已降级:「DSH 在用」标记仅作 UI 提示,面板侧有二次确认。
function actionHandler(method, fn) {
  return async (req, res) => {
    if (!guard(req, res)) return;
    if (req.method !== method) {
      sendJSON(res, 405, { error: "method not allowed" });
      return;
    }
    let input;
    try {
      const raw = await readBody(req);
      input = raw ? JSON.parse(raw) : {};
    } catch (err) {
      sendJSON(res, 400, { error: `invalid JSON body: ${err.message}` });
      return;
    }
    try {
      sendJSON(res, 200, await fn(input, req));
    } catch (err) {
      sendJSON(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

function getHandler(method, fn) {
  return async (req, res) => {
    if (!guard(req, res)) return;
    if (req.method !== method) {
      sendJSON(res, 405, { error: "method not allowed" });
      return;
    }
    try {
      sendJSON(res, 200, await fn(req));
    } catch (err) {
      sendJSON(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

function makeTool(def) {
  return {
    output: {
      schema: { type: "string" },
      render: (_a, v) => [{ type: "text", text: String(v) }],
    },
    presentCall: (args) => present(def.name, JSON.stringify(args ?? {})),
    ...def,
  };
}

export function apply(ctx) {
  // ctx.deps 仅存在于测试注入的 plain ctx;生产 cordis ctx 是 proxy,直接读未 inject 的 props 会抛
  // "without inject"。`in` 走 has trap:生产环境对未注册的 "deps" 返回 false,不会触发 get trap。
  const injectedDeps = ctx && "deps" in ctx ? ctx.deps : undefined;
  const home = mmHome();
  // 真实 spawn:子进程日志落 <home>/servers/<port>.log(就绪锚点/排障用)
  const realSpawn = (exe, args, opts) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logPath = join(home, "servers", `${opts.port}.log`);
    const sink = (s) => {
      if (s)
        s.on("data", (c) => {
          try {
            appendFileSync(logPath, c);
          } catch {}
        });
    };
    sink(child.stdout);
    sink(child.stderr);
    if (child.unref) child.unref();
    return child;
  };
  const manager = createManager({
    home,
    // 允许测试注入 fake spawn(injectedDeps.spawnFn),避免真起进程
    spawnFn: (injectedDeps && injectedDeps.spawnFn) || realSpawn,
    // 允许测试注入 fake detect(injectedDeps.detectFn),避免真实 GPU 检测
    // (沙箱无 GPU:realGpuExec 会同步 spawn python3/nvidia-smi 子进程,超时最长 40s)
    detectFn: injectedDeps && injectedDeps.detectFn,
  });

  const tools =
    (ctx && (ctx.get ? ctx.get("tools") : undefined)) || (ctx && ctx.tools);
  if (!tools || typeof tools.register !== "function") return;

  // ---------- 服务管理(4) ----------
  tools.register(
    makeTool({
      name: "mm_server_register",
      description:
        "把一个已在本机运行的推理服务(llama.cpp / vLLM / SGLang)登记进模型管理器。" +
        "参数:port(必填)、framework(llama|vllm|sglang,必填)、model(模型显示名)、gpu(CUDA_VISIBLE_DEVICES 值;" +
        "取值为 CUDA 设备序号 0/1/…,以面板「获取显卡」检测的实际落卡为准)、note(备注)。" +
        "只登记不启动;健康状态用 mm_server_list 查看。",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "服务端口(1–65535)" },
          framework: { type: "string", enum: ["llama", "vllm", "sglang"] },
          model: { type: "string", description: "模型显示名" },
          gpu: { type: "number", description: "CUDA_VISIBLE_DEVICES 值" },
          note: { type: "string", description: "备注" },
        },
        required: ["port", "framework"],
      },
      async execute(args) {
        const e = manager.register(args);
        return `已登记:${e.port} [${e.framework}] ${e.model || "-"}(managed=${e.managed}${e.gpu !== null && e.gpu !== undefined ? `, gpu=${e.gpu}` : ""})`;
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_server_list",
      description:
        "列出已登记的推理服务及实时健康状态(running/down,health 检查)。只读。",
      parameters: { type: "object", properties: {} },
      async execute() {
        const list = await manager.list();
        if (!list.length)
          return "注册表为空。用 mm_server_register 登记,或 mm_server_start 托管启动。";
        return list
          .map(
            (e) =>
              `${e.status === "running" ? "●" : "○"} ${e.port} [${e.framework}] ${e.model || "-"} ` +
              `${e.managed ? `托管 pid=${e.pid}` : "外部"} health=${e.health}${e.note ? ` | ${e.note}` : ""}`,
          )
          .join("\n");
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_server_stop",
      description:
        "停止一个已登记的推理服务。外部(非本插件启动)服务必须显式传 force=true " +
        "(执行 fuser -k <port>/tcp);托管服务直接 kill 自己 spawn 的 PID。未注册端口拒绝盲杀。" +
        "11437 为 DSH 自用服务,停止它会中断当前会话——调用前须得到用户明确确认。本插件绝不使用 pkill。",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number" },
          force: {
            type: "boolean",
            description: "仅对外部服务生效:确认用 fuser -k 停止",
          },
        },
        required: ["port"],
      },
      async execute(args) {
        const r = await manager.stop(args.port, { force: !!args.force });
        return `已停止 ${args.port}(执行:${r.argv.join(" ")})`;
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_server_start",
      description:
        "按参数 profile 托管启动推理服务。支持 llama.cpp / SGLang / vLLM 三类 profile(exe 走 frameworks.json 配置链)。" +
        "gpu 缺省取 profile.gpu,再缺省 0。启动后写 pid 文件并登记为托管服务;端口已被注册表占用则拒绝。",
      parameters: {
        type: "object",
        properties: {
          profile: { type: "string", description: "profile 名称或 id" },
          port: { type: "number", description: "启动端口" },
          gpu: {
            type: "number",
            description: "CUDA_VISIBLE_DEVICES 值;缺省取 profile.gpu",
          },
        },
        required: ["profile", "port"],
      },
      async execute(args) {
        const e = manager.start(args);
        return `已托管启动:${e.port} pid=${e.pid}(${e.note})。日志:服务器目录 servers/${e.port}.log`;
      },
    }),
  );

  // ---------- profile 参数版本(5) ----------
  const PROFILE_PARAMS = {
    type: "object",
    properties: {
      name: { type: "string" },
      framework: { type: "string", enum: ["llama", "vllm", "sglang"] },
      model: { type: "string" },
      modelPath: { type: "string" },
      launchCommand: {
        type: "string",
        description: "启动参数字符串(llama 的 -m/--port 等托管参数禁止写入)",
      },
      contextWindow: { type: "number", description: "模型原生最大上下文" },
      gpu: { type: "number" },
      port: { type: "number", description: "可选:固定端口,保存时做占用校验" },
      kvBytesPerToken: {
        type: "number",
        description: "KV 显存估算用,bytes/token(如 6400=q4_0,KV 6.25KB)",
      },
    },
    required: ["name", "framework", "modelPath"],
  };

  tools.register(
    makeTool({
      name: "mm_profile_save",
      description:
        "保存一个参数 profile(命名的启动参数快照)。保存前校验:llama -c 必须被 -np 整除(约定 -c=原生×-np)、" +
        "端口合法性与注册表冲突、托管参数越权;KV 超显存、per-slot 低于原生上下文、SGLang 缺 --enable-cache-report 等为 warning 不阻断。" +
        "同名 profile 覆盖更新。",
      parameters: {
        type: "object",
        properties: { profile: PROFILE_PARAMS },
        required: ["profile"],
      },
      async execute(args) {
        const p = manager.saveProfile(args.profile);
        const v = validateProfile(args.profile, { registry: [] });
        const warn = v.warnings.length ? `\n⚠ ${v.warnings.join("\n⚠ ")}` : "";
        return `已保存 profile ${p.id}:${p.name}[${p.framework}]${warn}`;
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_profile_list",
      description:
        "列出全部参数 profile(名称/框架/模型路径/参数/激活状态)。只读。",
      parameters: { type: "object", properties: {} },
      async execute() {
        const list = manager.listProfiles();
        if (!list.length) return "没有已保存的 profile。";
        return list
          .map(
            (p) =>
              `${p.active ? "▶" : " "} ${p.name}[${p.framework}] ${p.modelPath}\n  ${p.launchCommand || "(无参数)"}${p.port ? ` port=${p.port}` : ""}${p.gpu !== undefined && p.gpu !== null ? ` gpu=${p.gpu}` : ""}`,
          )
          .join("\n");
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_profile_load",
      description:
        "激活一个参数 profile(名称或 id)。激活=标记为当前使用;同一时间只有一个 active。",
      parameters: {
        type: "object",
        properties: { profile: { type: "string" } },
        required: ["profile"],
      },
      async execute(args) {
        const p = manager.loadProfile(args.profile);
        return `已激活 profile:${p.name}(${p.id})[${p.framework}]`;
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_profile_delete",
      description: "按名称或 id 删除一个参数 profile。",
      parameters: {
        type: "object",
        properties: { profile: { type: "string" } },
        required: ["profile"],
      },
      async execute(args) {
        const n = manager.deleteProfile(args.profile);
        return `已删除。剩余 profile:${n}`;
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_profile_import",
      description:
        "批量导入 profile(JSON 字符串:数组或单个对象;亦可直接传对象/数组)。每条都过保存前校验,坏 JSON 直接报错。",
      parameters: {
        type: "object",
        properties: {
          data: {
            type: ["string", "object", "array"],
            description: "JSON 字符串,或直接传对象/数组",
          },
        },
        required: ["data"],
      },
      async execute(args) {
        const n = manager.importProfiles(args.data);
        return `已导入 ${n} 个 profile。`;
      },
    }),
  );

  // ---------- 框架路径配置(3) ----------
  tools.register(
    makeTool({
      name: "mm_framework_list",
      description:
        "列出三个推理框架(llama.cpp / SGLang / vLLM)的可执行文件路径配置。exe 为空表示用 PATH 默认。",
      parameters: { type: "object", properties: {} },
      async execute() {
        const { frameworks, defaults } = manager.getFrameworks();
        return Object.entries(frameworks)
          .map(
            ([fw, c]) =>
              `${fw}: exe=${c.exe || "(默认 " + defaults[fw] + ")"}\n${fw} 路径:`,
          )
          .join("\n");
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_framework_save",
      description:
        "设置某框架的可执行文件路径(framework=llama|sglang|vllm,exe=绝对路径;传空串恢复 PATH 默认)。路径不存在会报错。",
      parameters: {
        type: "object",
        properties: {
          framework: { type: "string", enum: ["llama", "sglang", "vllm"] },
          exe: {
            type: "string",
            description: "可执行文件绝对路径;空串 = 用 PATH 默认",
          },
        },
        required: ["framework", "exe"],
      },
      async execute(args) {
        const r = manager.setFramework({
          framework: args.framework,
          exe: args.exe,
        });
        const c = r.frameworks[args.framework];
        return `已保存 ${args.framework} exe=${c.exe || "(默认 " + r.defaults[args.framework] + ")"}`;
      },
    }),
  );

  tools.register(
    makeTool({
      name: "mm_framework_probe",
      description:
        "探测某框架可执行文件是否可用并返回版本号(llama 跑 --version,sglang/vllm 跑 python -c import)。exe 留空则用已配置值或默认。只读。",
      parameters: {
        type: "object",
        properties: {
          framework: { type: "string", enum: ["llama", "sglang", "vllm"] },
          exe: {
            type: "string",
            description: "可选,指定要探测的路径;不传用当前配置",
          },
        },
        required: ["framework"],
      },
      async execute(args) {
        const r = manager.probeFramework({
          framework: args.framework,
          exe: args.exe || "",
        });
        return r.ok
          ? `${args.framework} 可用:${r.line}`
          : `${args.framework} 不可用(${r.exe}):${r.line}`;
      },
    }),
  );

  // ---------- 一键测速(1) ----------
  tools.register(
    makeTool({
      name: "mm_bench",
      description:
        "对已登记的端口跑一键测速:发固定 prompt 非流式生成 256 token,计算 tok/s 并落盘 benchmarks.json。",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "已登记的推理服务端口" },
          profile: { type: "string", description: "可选,关联的 profile 名" },
          maxTokens: { type: "number", description: "生成长度,默认 256" },
        },
        required: ["port"],
      },
      async execute(args) {
        const r = await manager.bench(Number(args.port), {
          profile: args.profile || null,
          maxTokens: args.maxTokens,
        });
        return `测速完成 @${r.port}(${r.model || "?"}):${r.tps} tok/s · ${r.tokens} tokens · ${r.ms}ms${r.profile ? " · profile=" + r.profile : ""}`;
      },
    }),
  );

  // ---------- webServer 同源路由:面板数据通道(GET)+ 动作通道(POST) ----------
  const webServer = ctx.webServer;
  if (webServer && typeof webServer.register === "function") {
    // 只读
    webServer.register({
      kind: "exact",
      path: "/api/mm/servers",
      handler: getHandler("GET", async () => manager.list()),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/profiles",
      handler: getHandler("GET", async () => manager.listProfiles()),
    });
    // 实测数据(benchmarks.json,最近 50 条;POST /api/mm/bench 写入)
    webServer.register({
      kind: "exact",
      path: "/api/mm/benchmarks",
      handler: getHandler("GET", async () => manager.listBenchmarks()),
    });
    // 框架路径配置(~/.dsh/model-manager/frameworks.json)
    webServer.register({
      kind: "exact",
      path: "/api/mm/frameworks",
      handler: getHandler("GET", async () => manager.getFrameworks()),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/frameworks/save",
      handler: actionHandler("POST", async (input) => {
        const r = manager.setFramework(input);
        return { ok: true, ...r };
      }),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/frameworks/probe",
      handler: actionHandler("POST", async (input) =>
        manager.probeFramework(input),
      ),
    });
    // 显卡检测结果(~/.dsh/model-manager/gpus.json):首次启动自动获取一次,之后仅手动
    webServer.register({
      kind: "exact",
      path: "/api/mm/gpus",
      handler: getHandler("GET", async () => manager.gpus()),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/gpus/detect",
      handler: actionHandler("POST", async () => {
        const gpus = manager.detectGpusNow();
        return { ok: true, gpus };
      }),
    });
    // 一键测速:对已登记端口跑固定 prompt 非流式生成,记 tok/s 并落盘 benchmarks.json
    webServer.register({
      kind: "exact",
      path: "/api/mm/bench",
      handler: actionHandler("POST", async (input) => {
        const r = await manager.bench(Number(input.port), {
          profile: input.profile || null,
          maxTokens: input.maxTokens,
        });
        return { ok: true, result: r };
      }),
    });
    // 启动日志尾部(读 <home>/servers/<port>.log,最多 200 行;不要求在注册表——停止后仍可回看)
    // 自定义 handler(不用 getHandler):非法/未登记走 400/404 语义,而非 500
    webServer.register({
      kind: "exact",
      path: "/api/mm/log",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== "GET") {
          sendJSON(res, 405, { error: "method not allowed" });
          return;
        }
        try {
          const port = Number(
            new URL(req.url || "/", "http://localhost").searchParams.get(
              "port",
            ),
          );
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            sendJSON(res, 400, { error: `port 非法: ${port}` });
            return;
          }
          // 不要求端口在注册表:服务停止后注册表已清,日志文件仍在磁盘,停止后也要能看日志
          const p = join(manager.home, "servers", `${port}.log`);
          if (!existsSync(p)) {
            sendJSON(res, 200, {
              port,
              lines: [],
              note: "暂无日志文件(该服务不是插件托管启动,或尚未写入)",
              registered: manager.registry().some((s) => s.port === port),
            });
            return;
          }
          const lines = readFileSync(p, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .slice(-200);
          sendJSON(res, 200, {
            port,
            lines,
            registered: manager.registry().some((s) => s.port === port),
          });
        } catch (err) {
          sendJSON(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // 动作(红线全在 manager/lifecycle/safety 内)
    webServer.register({
      kind: "exact",
      path: "/api/mm/register",
      handler: actionHandler("POST", async (input) => {
        const e = manager.register(input);
        return { ok: true, entry: e };
      }),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/stop",
      handler: actionHandler("POST", async (input) => {
        const r = await manager.stop(Number(input.port), {
          force: !!input.force,
        });
        return { ok: true, port: r.port, executed: r.argv };
      }),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/start",
      handler: actionHandler("POST", async (input) => {
        const e = manager.start(input);
        return { ok: true, entry: e };
      }),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/profile/save",
      handler: actionHandler("POST", async (input) => {
        const p = manager.saveProfile(input.profile ?? input);
        const v = validateProfile(p, { registry: manager.registry() });
        return { ok: true, profile: p, warnings: v.warnings };
      }),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/profile/load",
      handler: actionHandler("POST", async (input) => {
        const p = manager.loadProfile(String(input.profile ?? ""));
        return { ok: true, profile: p };
      }),
    });
    webServer.register({
      kind: "exact",
      path: "/api/mm/profile/delete",
      handler: actionHandler("POST", async (input) => {
        const remaining = manager.deleteProfile(String(input.profile ?? ""));
        return { ok: true, remaining };
      }),
    });
  }
}
