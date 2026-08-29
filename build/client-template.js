/**
 * dsh-model-manager — 本地模型管理面板(browser 半)v3
 *
 * 会话区 conversation.view tab「模型管理」(白底,llamastash 范式):
 *   左栏 = 模型·参数版本树(按 framework+模型路径 分组;一张卡一个模型,互斥)
 *   右栏 = 版本详情:参数表(参数|值|说明,按框架官方顺序排,说明=中文·悬停英文,
 *          值直接编辑,推荐值=该模型激活版本的实测值,偏离标橙,官方目录加参数,版本对比)
 *   顶栏 = GPU 卡占用实时状态 · 服务注册表(停止红线由 node 半强制)
 *   抽屉 = 健康检查(客户端校验 + 服务健康,纯派生)
 *   启动/接管/停止/保存/删除/另存 = 现有 /api/mm/* 路由;日志 = /api/mm/log?port=
 *
 * 数据通道:同源 webServer 路由(带 client header):
 *   GET  /api/mm/servers /api/mm/profiles /api/mm/benchmarks /api/mm/log?port=
 *        /api/mm/gpus
 *   POST /api/mm/register /api/mm/stop /api/mm/start
 *        /api/mm/profile/save|load|delete
 *        /api/mm/gpus/detect
 * 显卡自动获取:node 半首次启动自动检测一次(CUDA 枚举序==CUDA_VISIBLE_DEVICES 选择序),
 *   之后仅手动(顶栏「⟳ 获取显卡」);NVML 降级只存卡数+名称,不写编号映射(部分机器上 NVML 物理序与 CUDA 设备序相反)。
 *   卡数/卡名跟随检测结果;未检测时回退服务端内置表(/api/mm/gpus → builtin,来自用户本机文件,不入库)。
 * launchCommand 字符串格式不变:客户端 parse/build 与 lib/command.js 同构(无损往返)。
 * 样式与官方参数目录/中文说明由 build-client.js 从 mockup-v3.html 注入(单一来源)。
 * client 半改动仅 F5 生效;node 半(路由)改动需用户手动重启 dsh。
 */
window.__ModuleLoader__.load({
  id: "dsh-model-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const e = React.createElement;

    const REFRESH_MS = 30000;
    const CLIENT_HEADER = "x-dsh-model-manager-client";
    const CLIENT_VALUE = "v1";
    const PROTECTED_PORTS = [];
    /* 内置回退表(未检测到显卡时用):来自服务端 builtin-gpus.local.json → /api/mm/gpus 的 builtin 字段,
       用户本机约定不入库;仓库默认无内置表,卡名显示 "GPU n"。 */

    /* 显卡检测结果(gpus.json,CUDA 枚举序;NVML 降级 cards=null 不写编号映射)。
       模块级缓存:loadAux/doGpuDetect 更新 _lastGpuInfo,gpuName/gpuLabel/卡列表读它。 */
    let _lastGpuInfo = null;
    function detectedCards() {
      const g = _lastGpuInfo && _lastGpuInfo.gpus;
      return g && Array.isArray(g.cards) && g.cards.length ? g.cards : null;
    }
    function detectedCard(idx) {
      const cs = detectedCards();
      if (!cs) return null;
      for (const c of cs) if (c.index === idx) return c;
      return null;
    }
    /* 服务端内置回退表(builtin-gpus.local.json → /api/mm/gpus → builtin) */
    function builtinGpus() {
      const b = _lastGpuInfo && _lastGpuInfo.builtin;
      return b && typeof b === "object" ? b : {};
    }
    /* 卡列表:检测 cards 优先(卡数跟随检测结果);未检测回退服务端内置表 */
    function gpuCardList() {
      const cs = detectedCards();
      if (cs) return cs;
      const b = builtinGpus();
      return Object.keys(b).map((k) => {
        const c = b[k] || {};
        return { index: Number(k), shortName: c.name || ("GPU " + k), name: (c.name || "GPU " + k) + "(内置)", memGb: c.memGb };
      });
    }
    /* 顶栏 meta 行:检测状态 / NVML 警示 / 失败原因 */
    function gpuMetaLine(info) {
      if (!info) return " · 显卡:未检测(内置回退)";
      const g = info.gpus;
      if (g && g.source === "nvml") return " · 显卡:NVML 降级(" + (g.count != null ? g.count + " 卡" : "卡数未知") + ")— NVML 序不写入卡编号映射";
      if (g && Array.isArray(g.cards) && g.cards.length) return " · 显卡:" + g.cards.length + " 卡已检测(CUDA 序)" + (g.detectedAt ? " " + String(g.detectedAt).slice(0, 10) : "");
      if (info.lastError) return " · ⚠ 显卡:获取失败(" + info.lastError + ")— 点「⟳ 获取显卡」重试";
      return " · 显卡:未检测(内置回退)";
    }
    const FRAMEWORKS = { llama: "llama.cpp", sglang: "SGLang", vllm: "vLLM" };

    /* ================= 样式(白底,自 mockup-v3 注入,作用域 .mm-root) ================= */
    const CSS = `/*__CSS__*/`;

    /* ================= 官方参数目录 + 中文说明(自 mockup-v3 注入:
       CAT_LLAMA / CAT_SGLANG / CATS / ALIAS / ZH / ZH_OVERRIDES / zhFor /
       GROUP_ZH / norm / catItem / sortedParams / recFor / isOn / recMismatch) ================= */
    /*__CATS__*/

    /* 推荐值 recFor 覆盖:真实 store 版本读 profile.launchCommand(非演示 params) */
    function recFor(m, f) {
      const vs = m.versions || [];
      const v = vs.find((x) => x.active) || vs[0];
      if (!v) return null;
      for (const p of parseLaunchCommand(v.launchCommand || "")) if (norm(p[0]) === norm(f)) return p[1];
      return null;
    }

    /* 已知不可用条目(树徽章 + 详情红字;按完整 profile 名索引)。
       仓库默认空;个人调机记录请写在本机,不要提交。 */
    const KNOWN_DEAD = {};

    /* ---------- 工具 ---------- */
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
    function fmtK(n) { n = Number(n) || 0; if (n >= 1000000) return Math.round(n / 1000000) + "M"; if (n >= 1000) return Math.floor(n / 1000) + "K"; return String(n); }
    /* profile 名约定(版本号已废弃):"<模型> · <框架> · <卡>"——首段=模型,卡段=命名用 */
    function modelOf(name) { const s = String(name || ""); const i = s.indexOf(" · "); return i > 0 ? s.slice(0, i) : s; }
    /* 卡名:检测短名优先(gpus.json,短名已去 NVIDIA/GeForce/RTX/架构词),未检测回退服务端内置表 */
    function gpuName(g) {
      if (g == null) return "双卡";
      const c = detectedCard(g);
      const bn = ((builtinGpus()[g]) || {}).name;
      return c ? c.shortName : (bn || ("GPU" + g));
    }
    function shortPath(p) { const pre = "/models/"; const i = String(p || "").lastIndexOf(pre); return i >= 0 ? String(p).slice(i + pre.length) : String(p || ""); }
    function gpuLabel(g) {
      if (g == null) return "双卡(1,0)";
      const c = detectedCard(g);
      return c ? c.shortName : (((builtinGpus()[g]) || {}).name || ("GPU " + g));
    }
    function defaultPort(gpu) { return gpu === 0 ? 11436 : 11437; }

    /* launchCommand 解析/构建(与 lib/command.js 同构;返回 [[flag,value],...]) */
    function parseLaunchCommand(str) {
      if (typeof str !== "string") return [];
      const tokens = str.trim().split(/\s+/).filter(Boolean);
      const out = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (!t.startsWith("-")) { out.push([t, ""]); continue; }
        const eq = t.indexOf("=");
        if (eq > 0) { out.push([t.slice(0, eq), t.slice(eq + 1)]); continue; }
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("-")) { out.push([t, next]); i++; }
        else out.push([t, ""]);
      }
      return out;
    }
    function buildLaunchCommand(flags) { return flags.map(([f, v]) => (v === "" ? f : f + " " + v)).join(" "); }
    function flagVal(flags, f) { const x = flags.find((y) => y[0] === f); return x ? x[1] : null; }

    /* ---------- 数据派生 ---------- */
    function buildGroups(profiles) {
      // 顶层 = checkpoint(=modelPath,版本1 要选的模型);其下 framework 子组(版本2 参数版本树)
      const cpMap = new Map();
      for (const p of profiles) {
        let cg = cpMap.get(p.modelPath);
        if (!cg) {
          cg = { id: p.modelPath, path: p.modelPath, short: p.model || String(p.modelPath).split("/").pop(), fwGroups: [] };
          cpMap.set(p.modelPath, cg);
        }
      }
      const sgMap = new Map();
      for (const p of profiles) {
        const key = p.modelPath + "::" + p.framework;
        let sg = sgMap.get(key);
        if (!sg) {
          sg = { id: key, fw: p.framework, fwLabel: FRAMEWORKS[p.framework] || p.framework, path: p.modelPath, versions: [] };
          sgMap.set(key, sg);
          cpMap.get(p.modelPath).fwGroups.push(sg);
        }
        sg.versions.push(p);
      }
      const list = [...cpMap.values()];
      // 组内版本排序:卡序(卡0 → 卡1 → 双卡)→ 名序(版本号已废弃,不再按编号)
      const gkey = (p) => (p.gpu === 0 ? 0 : p.gpu === 1 ? 1 : 2);
      for (const cg of list) {
        for (const sg of cg.fwGroups) {
          sg.versions.sort((a, b) => (gkey(a) - gkey(b)) || String(a.name).localeCompare(String(b.name)));
          sg.activeV = sg.versions.find((v) => v.active) || sg.versions[0] || null;
        }
      }
      return list;
    }

    /* 运行匹配:托管服务按 note=managed:<name> 精确认领;外部服务按 gpu+framework+模型名 认领该组激活版本 */
    function matchRun(servers, groups, profiles) {
      const out = new Map();
      const running = servers.filter((s) => s.status === "running");
      for (const s of running) {
        if (s.managed && typeof s.note === "string" && s.note.indexOf("managed:") === 0) {
          const name = s.note.slice(8);
          for (const p of profiles) if (p.name === name) { out.set(p.id, { port: s.port, ext: false, server: s }); break; }
        }
      }
      for (const s of running) {
        if (s.managed) continue;
        let best = null, bestScore = 0;
        for (const cg of groups) {
          for (const sg of cg.fwGroups) {
            const act = sg.activeV; if (!act) continue;
            if (s.framework !== sg.fw) continue;
            if (s.gpu == null || s.gpu === undefined || s.gpu !== act.gpu) continue;
            const sm = String(s.model || "").toLowerCase(), am = String(act.model || "").toLowerCase();
            let score = 0;
            if (sm && am) { if (sm === am) score = 2; else if (am.indexOf(sm) !== -1 || sm.indexOf(am) !== -1) score = 1; }
            if (score > bestScore) { bestScore = score; best = act; }
          }
        }
        if (best) out.set(best.id, { port: s.port, ext: true, server: s });
      }
      return out;
    }

    /* 客户端校验(node 半 validate.js 的派生镜像,只读展示) */
    function validateLocal(p) {
      const out = [];
      const flags = parseLaunchCommand(p.launchCommand || "");
      const val = (f) => flagVal(flags, f);
      if (p.framework === "llama") {
        if (flags.some((x) => ["-m", "--model", "--port", "--host"].indexOf(x[0]) !== -1)) out.push({ tone: "bad", msg: "含托管参数(-m/--port/--host),启动会冲突" });
        const c = Number(val("-c")) || 0;
        const np = val("-np") == null ? 1 : Number(val("-np"));
        if (c > 0) {
          if (!Number.isInteger(np) || np < 1 || c % np !== 0) out.push({ tone: "bad", msg: "-c " + c + " 不能被 -np " + np + " 整除(per-slot 上下文必须为整数)" });
          else if (p.contextWindow && c / np < p.contextWindow) out.push({ tone: "warn", msg: "per-slot " + fmtK(c / np) + " 低于原生 " + fmtK(p.contextWindow) + "(DSH compaction 80% 阈值会算错)" });
          const cap = p.gpu != null ? (detectedCard(p.gpu) ? detectedCard(p.gpu).memGb : (((builtinGpus()[p.gpu]) || {}).memGb)) : undefined;
          if (cap) {
            const kvGb = c * (Number(p.kvBytesPerToken) || 65536) / 1e9;
            if (kvGb > cap - 1) out.push({ tone: "warn", msg: "KV 估算 ~" + Math.round(kvGb) + "G 超 " + cap + "G 容量(未计权重,OOM 风险更高)" });
          }
        }
      }
      if (p.framework === "sglang") {
        if (val("--enable-cache-report") == null) out.push({ tone: "warn", msg: "缺 --enable-cache-report(DSH 底部缓存命中率恒 0%)" });
        if (val("--speculative-num-draft-tokens") != null) out.push({ tone: "warn", msg: "--speculative-num-draft-tokens 必须等于草稿模型 block_size(不等启动即崩)" });
      }
      return out;
    }

    function doctorFindings(servers, groups) {
      const f = [];
      for (const s of servers) {
        if (PROTECTED_PORTS.indexOf(s.port) !== -1) f.push({ tone: "warn", where: String(s.port), msg: "health " + (s.health || "-") + " · " + (s.model || "") + " · DSH 在用:面板可两次点击确认停止(停止将中断当前会话)" });
        else f.push({ tone: s.status === "running" ? "ok" : "bad", where: String(s.port), msg: s.status === "running" ? "health " + (s.health || "") + " · " + (s.model || "") : "离线" });
      }
      gpuCardList().forEach((c) => {
        const occ = servers.find((s) => s.status === "running" && (s.gpu == null || s.gpu === c.index));
        if (!occ) f.push({ tone: "ok", where: c.shortName, msg: "空闲 · " + defaultPort(c.index) + " 可启动托管版本" });
      });
      const total = groups.reduce((n, cg) => n + cg.fwGroups.reduce((m, sg) => m + sg.versions.length, 0), 0);
      let ok = 0;
      for (const cg of groups) for (const sg of cg.fwGroups) for (const p of sg.versions) {
        const issues = validateLocal(p);
        if (issues.length) { for (const it of issues) f.push({ tone: it.tone, where: modelOf(p.name) + " · " + gpuName(p.gpu), msg: it.msg }); }
        else ok++;
      }
      f.push({ tone: ok > 0 ? "ok" : "warn", where: "版本", msg: ok + " / " + total + " 通过校验(上下文约定 / 托管参数 / 缓存回报)" });
      return f;
    }

    /* ---------- HTML 片段(字符串;事件走 data-act 委托) ---------- */
    // 顶层 checkpoint 默认选中的框架(内存默认=每 checkpoint 第一个子组;实际选中态由 selFw[cg.id] 驱动)
    function selectedFw(cg, selFw) {
      return (selFw && selFw[cg.id] != null) ? selFw[cg.id] : (cg.fwGroups.length ? cg.fwGroups[0].fw : null);
    }
    function treeHtml(groups, selId, runMap, q, selFw) {
      if (!groups.length) return '<div class="mm-loading">暂无参数版本<br>保存的 profile 会出现在这里</div>';
      const qL = (q || "").toLowerCase();
      let h = "";
      let shown = 0;
      for (const cg of groups) {
        // 顶层命中:路径/模型名,或有任一字组版本匹配(命中则整组可见,下拉+版本行都渲染)
        let cpHit = !qL || String(cg.path).toLowerCase().indexOf(qL) !== -1 || String(cg.short).toLowerCase().indexOf(qL) !== -1;
        let sg = cg.fwGroups.find((x) => x.fw === selectedFw(cg, selFw)) || null;
        let rows = qL ? [] : (sg ? sg.versions : []);
        if (qL) {
          // 有搜索:跨子组聚合命中行(按版本名/模型路径),并标顶层命中
          for (const x of cg.fwGroups) for (const v of x.versions) {
            if (v.name.toLowerCase().indexOf(qL) !== -1 || String(v.modelPath || "").toLowerCase().indexOf(qL) !== -1) { rows.push(v); cpHit = true; }
          }
        }
        if (!cpHit && !rows.length) continue;
        shown += rows.length;
        // 顶层标题(仅模型路径;框架标签下移到下拉)
        h += '<div class="mm-mGroup"><div class="mm-mHead"><span class="mm-mp" title="' + esc(cg.path) + '">' + esc(shortPath(cg.path)) + "</span></div>";
        // 框架下拉:选项 = 该 checkpoint 已存在的 framework 集合(不去重),选中态走 onChange(data-act=sel-fw)
        if (cg.fwGroups.length) {
          const curFw = selectedFw(cg, selFw);
          h += '<div class="mm-fwRow"><select class="mm-sel" data-act="sel-fw" data-cp="' + esc(cg.id) + '" title="选择本模型的推理框架">' +
            cg.fwGroups.map((x) => '<option value="' + esc(x.fw) + '"' + (x.fw === curFw ? " selected" : "") + ">" + esc(x.fwLabel) + "</option>").join("") +
            "</select></div>";
        }
        // 版本行(版本2:同 checkpoint+框架 的不同参数/解码方案;gpuName+modelOf+run/dead 徽章)
        for (const v of rows) {
          const isSel = v.id === selId;
          const run = runMap.get(v.id);
          const dead = KNOWN_DEAD[v.name];
          h += '<div class="mm-ver' + (isSel ? " mm-ver--sel" : "") + (run ? " mm-ver--run" : "") + (dead ? " mm-ver--fail" : "") + '" data-act="select" data-id="' + esc(v.id) + '">';
          h += '<span class="mm-vt">' + esc(gpuName(v.gpu)) + (v.active ? " ▶" : "") + "</span>";
          h += '<span class="mm-vn" title="' + esc(v.name) + '">' + esc(modelOf(v.name)) + "</span>";
          if (run) h += '<span class="mm-vr">● @' + run.port + (run.ext ? " · 外" : "") + "</span>";
          else if (dead) h += '<span class="mm-vf">' + (v.framework === "vllm" ? "⚠ vLLM" : "✗ 不可行") + "</span>";
          h += "</div>";
        }
        h += "</div>";
      }
      if (qL && !shown) h += '<div class="mm-loading">无匹配「' + esc(q) + '」</div>';
      return h;
    }

    function metaStripHtml(g, v, benchmarks, run) {
      const flags = parseLaunchCommand(v.launchCommand || "");
      const val = (f) => flagVal(flags, f);
      let ctx = "—";
      if (g.fw === "llama") {
        const c = Number(val("-c")) || 0;
        const np = val("-np") == null ? 1 : Math.max(1, Number(val("-np")));
        ctx = c > 0 ? (fmtK(c / np) + "/slot ×" + np) : (v.contextWindow ? fmtK(v.contextWindow) + "(默认)" : "—");
      } else {
        const cl = val(g.fw === "sglang" ? "--context-length" : "--max-model-len");
        ctx = cl ? fmtK(Number(cl)) : "auto";
      }
      let kv = "—";
      if (g.fw === "vllm") kv = "(vLLM 默认)";
      else {
        const type = g.fw === "llama" ? (val("-ctk") || "f16") : (val("--kv-cache-dtype") || "auto");
        const cTok = g.fw === "llama" ? (Number(val("-c")) || 0) : (Number(val("--context-length")) || Number(v.contextWindow) || 0);
        if (cTok > 0 && v.kvBytesPerToken) kv = "~" + (cTok * v.kvBytesPerToken / 1e9).toFixed(cTok * v.kvBytesPerToken / 1e9 < 10 ? 1 : 0) + "G (" + type + ")";
        else if (cTok > 0) kv = type;
      }
      const cap = v.gpu != null ? (detectedCard(v.gpu) ? detectedCard(v.gpu).memGb : (((builtinGpus()[v.gpu]) || {}).memGb)) : undefined;
      const mine = (benchmarks || []).filter((b) => b.profile === v.name || (run && b.port === run.port));
      const last = mine[mine.length - 1];
      const benchPill = last
        ? '<span class="mm-pill mm-mini" style="margin-left:auto" title="最新测速(固定 prompt · 非流式 ' + (last.maxTokens != null ? last.maxTokens : 256) + " tokens,点下方「测速记录」看历史)\">⚡ <b>" + (last.tps != null ? last.tps : "-") + "</b> tok/s · @" + last.port + "</span>"
        : "";
      return '<span class="mm-pill mm-mini"><b>' + esc(gpuLabel(v.gpu)) + "</b></span>" +
        '<span class="mm-pill mm-mini">上下文 <b>' + esc(ctx) + "</b></span>" +
        '<span class="mm-pill mm-mini">KV <b>' + esc(kv) + "</b></span>" +
        (cap ? '<span class="mm-pill mm-mini">显存 <b>容量 ' + cap + "G</b></span>" : "") +
        benchPill;
    }

    function paramsTableHtml(g, v, draft) {
      const enums = [...new Set((CATS[g.fwLabel] || []).filter((x) => x.t === "enum").flatMap((x) => (x.d || "").replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim()).filter(Boolean)))];
      let h = '<div class="mm-secLabel">启动参数(' + draft.length + ")</div>";
      if (enums.length) h += '<datalist id="mmDl">' + enums.map((x) => '<option value="' + esc(x) + '"></option>').join("") + "</datalist>";
      h += '<div class="mm-pTable"><div class="mm-pHead"><span>参数</span><span>值</span><span>说明(中文 · 悬停=英文原文)</span></div>';
      const rows = sortedParams(g.fwLabel, draft);
      for (const [f, val0] of rows) {
        const i = draft.findIndex((x) => x[0] === f);
        const cat = catItem(g.fwLabel, f);
        const rec = recFor(g, f);
        const diff = recMismatch(cat, val0, rec);
        let cell;
        if (cat && cat.t === "bool") {
          cell = '<input type="checkbox"' + (!(val0 === "false" || val0 === "off") ? " checked" : "") + ' data-bool="' + i + '">';
        } else {
          const dl = cat && cat.t === "enum" ? ' list="mmDl"' : "";
          const ph = cat && cat.d && cat.d !== "" ? cat.d.replace(/^\[/, "").replace(/\]$/, "").slice(0, 24) : "";
          cell = '<input type="text"' + (diff ? ' class="mm-rec-diff"' : "") + ' value="' + esc(val0) + '" placeholder="' + esc(ph) + '" data-i="' + i + '"' + dl + ">";
        }
        let desc;
        if (!cat) desc = '<span class="mm-pDesc">(自定义参数,不在官方目录)</span>';
        else {
          const zh = zhFor(g.fwLabel, cat.f) || cat.z || cat.s;
          let recHtml = "";
          if (rec != null) { const rd = cat.t === "bool" ? (isOn(rec) ? "开" : "关") : rec; if (rd !== "") recHtml = ' <span class="mm-recChip">推荐 ' + esc(rd) + "</span>"; }
          const dflt = cat.d && cat.d !== "" ? (' <span class="mm-dflt">默认 ' + esc(cat.d) + "</span>") : "";
          desc = '<span class="mm-pDesc" title="' + esc(cat.s + ((cat.d && cat.d !== "") ? (" 默认 " + cat.d) : "")) + '">' + esc(zh) + recHtml + dflt + "</span>";
        }
        h += '<div class="mm-pRow"><span class="mm-pFlag" title="' + esc(f) + '">' + esc(f) + '</span><span class="mm-pVal">' + cell + "</span>" + desc + '<span class="mm-pDel" title="删除参数" data-act="delparam" data-f="' + esc(f) + '">×</span></div>';
      }
      h += "</div>";
      return h;
    }

    function diffHtml(g, v, base, draft) {
      const curMap = new Map();
      for (const [f, val] of draft) curMap.set(norm(f), [f, val]);
      const basePairs = parseLaunchCommand(base.launchCommand || "");
      const baseMap = new Map();
      for (const x of basePairs) baseMap.set(norm(x[0]), x);
      const unionFlags = [];
      for (const x of basePairs) if (!unionFlags.some((f) => norm(f) === norm(x[0]))) unionFlags.push(x[0]);
      for (const [f] of draft) if (!unionFlags.some((x) => norm(x) === norm(f))) unionFlags.push(f);
      const sortedFlags = sortedParams(g.fwLabel, unionFlags.map((f) => [f, ""])).map((x) => x[0]);
      let h = '<div class="mm-secLabel">参数对比 <span class="mm-meta">' + esc(modelOf(v.name)) + "(当前,含未保存改动)vs " + esc(modelOf(base.name)) + "(基线)· 只显示差异行 · 官方顺序</span></div>";
      h += '<div class="mm-diffLegend"><span class="mm-lg"><span class="mm-sw mm-sw--chg"></span>改动</span><span class="mm-lg"><span class="mm-sw mm-sw--add"></span>新增</span><span class="mm-lg"><span class="mm-sw mm-sw--del"></span>删除</span></div>';
      h += '<div class="mm-pTable"><div class="mm-pHead mm-pHead3"><span>参数</span><span>' + esc(modelOf(base.name)) + "(基线)</span><span>" + esc(modelOf(v.name)) + "(当前)</span></div>";
      for (const f of sortedFlags) {
        const inB = baseMap.has(norm(f)), inC = curMap.has(norm(f));
        if (!inB && !inC) continue;
        const bv = inB ? baseMap.get(norm(f))[1] : null;
        const cv = inC ? curMap.get(norm(f))[1] : null;
        const cat = catItem(g.fwLabel, f);
        const isB = cat && cat.t === "bool";
        const normB = isB ? (inB ? isOn(bv) : false) : bv;
        const normC = isB ? (inC ? isOn(cv) : false) : cv;
        if (inB && inC && normB === normC) continue;
        const cls = inB && inC ? "mm-pRow--chg" : (inB ? "mm-pRow--del" : "mm-pRow--add");
        const showB = isB ? (inB ? (isOn(bv) ? "✓" : "—") : "—") : (inB ? esc(bv) : "—");
        const showC = isB ? (inC ? (isOn(cv) ? "✓" : "—") : "—") : (inC ? esc(cv) : "—");
        h += '<div class="mm-pRow mm-pRow3 ' + cls + '"><span class="mm-pFlag">' + esc(f) + '</span><span class="mm-pBase"><span class="mm-txt">' + showB + '</span></span><span class="mm-pCur"><span class="mm-txt">' + showC + "</span></span></div>";
      }
      h += "</div>";
      return h;
    }

    function pickerHtml(g, v, draft, q) {
      const cat = CATS[g.fwLabel] || [];
      const have = new Set(draft.map((x) => norm(x[0])));
      const qL = (q || "").toLowerCase();
      const items = cat.filter((x) => !have.has(x.f) && (!q || x.f.toLowerCase().indexOf(qL) !== -1 || (x.s || "").toLowerCase().indexOf(qL) !== -1 || (zhFor(g.fwLabel, x.f) || "").indexOf(q) !== -1));
      let h = ""; let lastG = null;
      for (const x of items) {
        if (x.g !== lastG) { h += '<div class="mm-pkGroup">' + (GROUP_ZH[x.g] || x.g) + "</div>"; lastG = x.g; }
        const dflt = x.d && x.d !== "" ? x.d : "(开/关)";
        const rec = recFor(g, x.f);
        let recHtml = "";
        if (rec != null) { const rd = x.t === "bool" ? (rec === "" ? "开" : "关") : rec; if (rd !== "") recHtml = '<span class="mm-recChip">推荐 ' + esc(rd) + "</span>"; }
        const zh = zhFor(g.fwLabel, x.f) || x.z || x.s;
        h += '<div class="mm-pkItem" data-act="pickparam" data-param="' + esc(x.f) + '"><span class="mm-f">' + esc(x.f) + '</span><span class="mm-d">' + esc(dflt) + '</span><span class="mm-s" title="' + esc(x.s) + '">' + esc(zh) + "</span>" + recHtml + "</div>";
      }
      if (!items.length) h += '<div class="mm-pkGroup">(无匹配)</div>';
      return h;
    }

    function benchBoxHtml(v, run, benchmarks) {
      const mine = (benchmarks || []).filter((b) => b.profile === v.name || (run && b.port === run.port));
      if (!mine.length && !run) return "";
      let h = '<div class="mm-benchBox"><div class="mm-logHead"><span class="mm-lt">测速记录</span><span class="mm-meta">固定 prompt · 非流式 ' + (mine.length ? mine[mine.length-1].maxTokens : 256) + ' tokens · tok/s=(tokens-1)/生成时长</span><div class="mm-spacer"></div>';
      if (run) h += '<button class="mm-btn mm-btn--sm" data-act="bench" data-port="' + run.port + '">重新测速</button>';
      h += "</div>";
      if (mine.length) {
        h += '<div class="mm-benchList">';
        for (const b of mine.slice(-3).reverse()) {
          const d = new Date(b.at);
          const ts = (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
          h += '<div class="mm-benchRow"><span class="mm-benchTps"><b>' + (b.tps != null ? b.tps : "-") + '</b> tok/s</span><span class="mm-meta">' + b.tokens + " tokens · " + (b.ms / 1000).toFixed(1) + "s · @" + b.port + " · " + ts + "</span></div>";
        }
        h += "</div>";
      } else {
        h += '<div class="mm-meta mm-benchEmpty">暂无测速记录' + (run ? "(点上方『重新测速』)" : " · 运行后点『一键测速』") + "</div>";
      }
      h += "</div>";
      return h;
    }

    function tailHtml(g, v, run, logState, dead, draft, benchmarks, autoScroll) {
      let h = "";
      h += '<div class="mm-secLabel">托管参数(自动,只读)</div><div class="mm-pTable">';
      const mflag = g.fw === "llama" ? "-m" : (g.fw === "sglang" ? "--model-path" : "--model");
      h += '<div class="mm-pRow mm-pRow--locked"><span class="mm-pFlag">' + mflag + '</span><span class="mm-pVal"><span class="mm-txt">' + esc(v.modelPath) + '</span></span><span class="mm-pDesc">插件托管</span></div>';
      const portHint = run ? ("@" + run.port) : (v.gpu === 0 ? "11436(卡0 推断)" : (v.gpu == null ? "11437(双卡推断)" : "11437(卡1 推断)"));
      h += '<div class="mm-pRow mm-pRow--locked"><span class="mm-pFlag">--port</span><span class="mm-pVal"><span class="mm-txt">' + esc(portHint) + '</span></span><span class="mm-pDesc">插件托管</span></div>';
      h += "</div>";
      h += '<div class="mm-vFoot">';
      if (g.fw === "llama") {
        const c = Number(flagVal(draft, "-c")) || 0;
        const np = flagVal(draft, "-np") == null ? 1 : Number(flagVal(draft, "-np"));
        if (c > 0 && np >= 1 && c % np === 0) h += '<div class="mm-okLine">✓ -c ' + c + " ÷ -np " + np + " = " + fmtK(c / np) + "(per-slot)</div>";
      }
      const issues = validateLocal({ ...v, launchCommand: buildLaunchCommand(draft) });
      for (const it of issues) h += '<div class="' + (it.tone === "bad" ? "mm-errLine" : "mm-warnLine") + '">' + (it.tone === "bad" ? "✗ " : "⚠ ") + esc(it.msg) + "</div>";
      if (dead) h += '<div class="mm-errLine">✗ ' + esc(dead) + "</div>";
      if (!issues.length && !dead) h += '<div class="mm-okLine">✓ 校验通过(端口 / 托管参数 / 上下文约定)</div>';
      h += "</div>";
      const logPort = run ? run.port : (v ? defaultPort(v.gpu) : null);
      if (logPort) {
        h += '<div class="mm-logBox"><div class="mm-logHead"><span class="mm-lt">启动日志</span><span class="mm-meta">' + (run ? "运行中 · " : "已停止 · ") + "…/servers/" + logPort + ".log" + (run && run.ext ? " · 外部服务(仅插件托管启动才有日志)" : "") + '</span><div class="mm-spacer"></div><label class="mm-autoScroll" title="开启后新日志自动滚到底部">自动滚动<input type="checkbox" data-act="autoscroll"' + (autoScroll ? " checked" : "") + '></label><button class="mm-btn mm-btn--sm" data-act="copylog">复制</button></div><div class="mm-logBody" id="mmLogBody">';
        if (logState) {
          if (logState.lines.length) {
            for (const ln of logState.lines) {
              if (/ERROR|Traceback|exiting|CUDA_ERROR/i.test(ln)) h += '<span class="mm-err">' + esc(ln) + "</span>";
              else if (/fired up|listening|Uvicorn running|initializing, n_slots| 200 /i.test(ln)) h += '<span class="mm-ln mm-okl">' + esc(ln) + "</span>";
              else h += '<span class="mm-ln">' + esc(ln) + "</span>";
            }
          } else h += '<span class="mm-ln">' + esc(logState.note || "(暂无日志)") + "</span>";
        } else h += '<span class="mm-ln">加载中…</span>';
        h += "</div></div>";
      }
      h += benchBoxHtml(v, run, benchmarks);
      return h;
    }

    /* ---------- API ---------- */
    async function apiGet(path) {
      const res = await fetch(path, { headers: { [CLIENT_HEADER]: CLIENT_VALUE } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
      return data;
    }
    async function apiPost(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", [CLIENT_HEADER]: CLIENT_VALUE },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
      return data;
    }

    /* 模块级缓存:tab 切走组件卸载,切回先渲染上次数据再后台刷新(秒开) */
    let _lastServers = null, _lastProfiles = null, _lastFrameworks = null, _lastBench = null;
    /* _lastGpuInfo 已在文件头声明(GPUS 附近):gpuName/gpuLabel/卡列表 直接读模块级检测缓存 */

    /* ---------- 组件 ---------- */
    function RegisterForm(props) {
      const [port, setPort] = React.useState("");
      const [framework, setFramework] = React.useState("llama");
      const [model, setModel] = React.useState("");
      const [gpu, setGpu] = React.useState("");
      const [note, setNote] = React.useState("");
      return e("div", { className: "mm-regForm" },
        e("input", { className: "mm-input", type: "number", placeholder: "端口(如 11438)", value: port, onChange: (ev) => setPort(ev.target.value) }),
        e("select", { className: "mm-sel", value: framework, onChange: (ev) => setFramework(ev.target.value) }, Object.keys(FRAMEWORKS).map((k) => e("option", { key: k, value: k }, FRAMEWORKS[k]))),
        e("input", { className: "mm-input", placeholder: "模型名(可选)", value: model, onChange: (ev) => setModel(ev.target.value) }),
        e("select", { className: "mm-sel", value: gpu, onChange: (ev) => setGpu(ev.target.value) },
          e("option", { value: "" }, "双卡 (1,0)"),
          (props.gpus || gpuCardList()).map((c) => e("option", { key: c.index, value: String(c.index) }, c.shortName + " (卡" + c.index + ")" + (c.memGb ? " · " + c.memGb + "G" : "")))),
        e("input", { className: "mm-input", placeholder: "备注(可选)", value: note, onChange: (ev) => setNote(ev.target.value) }),
        e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: props.busy || !port, onClick: () => props.onSubmit({ port: Number(port), framework, model: model || null, gpu: gpu === "" ? null : Number(gpu), note: note || null }) }, props.busy ? "登记中…" : "登记"),
        e("button", { className: "mm-btn mm-btn--sm", onClick: props.onCancel }, "取消"),
      );
    }

    function ModelManagerPanel() {
      const [servers, setServers] = React.useState(() => _lastServers || []);
      const [profiles, setProfiles] = React.useState(() => _lastProfiles || []);
      const [frameworks, setFrameworks] = React.useState(() => _lastFrameworks || null);
      const [fwReady, setFwReady] = React.useState(true);
      const [fwEdit, setFwEdit] = React.useState({});
      const [fwProbe, setFwProbe] = React.useState({});
      const [benchmarks, setBenchmarks] = React.useState(() => _lastBench || []);
      const [gpuInfo, setGpuInfo] = React.useState(() => _lastGpuInfo || null);
      const [treeQ, setTreeQ] = React.useState("");
      const [selId, setSelId] = React.useState(null);
      const [diffBase, setDiffBase] = React.useState(null);
      const [selFw, setSelFw] = React.useState({}); // 顶层 checkpoint→框架选择(内存,不持久化;默认每 checkpoint 第一个子组)
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const [pickerQ, setPickerQ] = React.useState("");
      const [logState, setLogState] = React.useState(null);
      const [autoScroll, setAutoScroll] = React.useState(true); // 日志自动滚动(默认开)
      const [treeCollapsed, setTreeCollapsed] = React.useState(false); // 左侧「模型·参数版本」收起
      const [drawer, setDrawer] = React.useState(false);
      const [flashMsg, setFlashMsg] = React.useState(null);
      const [busy, setBusy] = React.useState("");
      const [tick, setTick] = React.useState(0);
      const [showRegister, setShowRegister] = React.useState(false);
      const [showFwCfg, setShowFwCfg] = React.useState(false); // 框架路径:平时不用,默认收起
      const [armedStop, setArmedStop] = React.useState(null); // 已 arm 的停止端口(null=正常态);二次确认护栏
      const rootRef = React.useRef(null);
      const draftRef = React.useRef([]);
      const dirtyRef = React.useRef(false);
      const profilesRef = React.useRef([]);
      const armTimerRef = React.useRef(null);
      React.useEffect(() => () => clearTimeout(armTimerRef.current), []);
      profilesRef.current = profiles;

      function flash(kind, text) {
        setFlashMsg({ kind, text });
        clearTimeout(flash._t);
        flash._t = setTimeout(() => setFlashMsg(null), 6000);
      }

      async function load() {
        try {
          const [s, p] = await Promise.all([apiGet("/api/mm/servers"), apiGet("/api/mm/profiles")]);
          _lastServers = Array.isArray(s) ? s : [];
          _lastProfiles = Array.isArray(p) ? p : [];
          setServers(_lastServers);
          setProfiles(_lastProfiles);
        } catch (err) {
          if (!_lastServers) flash("err", "数据加载失败:" + err.message);
        }
      }
      function loadAux() {
        apiGet("/api/mm/frameworks").then((r) => { _lastFrameworks = r; setFrameworks(r); }).catch(() => setFwReady(false));
        apiGet("/api/mm/benchmarks").then((b) => { _lastBench = Array.isArray(b) ? b : []; setBenchmarks(_lastBench); }).catch(() => {});
        apiGet("/api/mm/gpus").then((r) => { _lastGpuInfo = r; setGpuInfo(r); }).catch(() => {
          if (!_lastGpuInfo) {
            const r = { gpus: null, lastError: "端点未生效(重启 dsh 后自动可用)", builtin: null };
            _lastGpuInfo = r; setGpuInfo(r);
          }
        });
      }
      /* 手动重取显卡:POST /api/mm/gpus/detect 覆盖 gpus.json,再拉 /api/mm/gpus 回显 */
      function doGpuDetect() {
        setBusy("gpus");
        apiPost("/api/mm/gpus/detect").then(async () => {
          try {
            const r = await apiGet("/api/mm/gpus");
            _lastGpuInfo = r; setGpuInfo(r);
          } catch {}
          const g = _lastGpuInfo && _lastGpuInfo.gpus;
          if (g && Array.isArray(g.cards) && g.cards.length) {
            flash("ok", "已获取显卡(CUDA 序=CUDA_VISIBLE_DEVICES 选择序):" + g.cards.map((c) => "卡" + c.index + "=" + c.shortName + (c.memGb ? " " + c.memGb + "G" : "")).join(" · "));
          } else if (g) {
            flash("ok", "已获取显卡(NVML 降级," + (g.count != null ? g.count : "?") + " 卡)— NVML 序不写入卡编号映射");
          } else {
            flash("err", "获取显卡失败:" + ((_lastGpuInfo && _lastGpuInfo.lastError) || "未知原因"));
          }
        }).catch((err) => flash("err", "获取显卡失败:" + err.message)).then(() => setBusy(""));
      }
      React.useEffect(() => {
        load();
        loadAux();
        const iv = setInterval(() => { load(); loadAux(); }, REFRESH_MS);
        return () => clearInterval(iv);
      }, []);

      const groups = React.useMemo(() => buildGroups(profiles), [profiles]);
      const runMap = React.useMemo(() => matchRun(servers, groups, profiles), [servers, groups, profiles]);
      const running = servers.filter((s) => s.status === "running");

      /* 选择:无效时默认 = 运行中版本 > 激活版本 > 第一个 */
      React.useEffect(() => {
        if (!profiles.length) return;
        if (!selId || !profiles.some((p) => p.id === selId)) {
          const runId = runMap.size ? [...runMap.keys()][0] : null;
          setSelId(runId || (profiles.find((p) => p.active) || profiles[0]).id);
        }
      }, [profiles, selId, runMap]);

      /* 选中变化 → 初始化编辑草稿 */
      React.useEffect(() => {
        const v = profilesRef.current.find((p) => p.id === selId);
        if (v) { draftRef.current = parseLaunchCommand(v.launchCommand || ""); dirtyRef.current = false; }
        setDiffBase(null); setPickerOpen(false); setPickerQ("");
      }, [selId]);

      /* 选中变化 → 拉日志(路由 404 时降级提示;停止后按该版本托管端口取,历史日志可回看) */
      React.useEffect(() => {
        setLogState(null);
        if (!selId) return;
        const v = profilesRef.current.find((p) => p.id === selId);
        if (!v) return;
        const run = runMap.get(selId);
        const logPort = run ? run.port : defaultPort(v.gpu);
        let alive = true;
        apiGet("/api/mm/log?port=" + logPort).then(
          (r) => { if (alive) setLogState({ lines: r.lines || [], note: r.note || "" }); },
          (err) => { if (alive) setLogState({ lines: [], note: /404|route/.test(String(err.message)) ? "日志端点未生效——你手动重启一次 dsh 后自动可用" : ("日志读取失败:" + err.message) }); },
        );
        return () => { alive = false; };
      }, [selId, runMap]);

      /* 自动滚动:新日志内容到达后滚到日志框底部(可关) */
      React.useEffect(() => {
        if (!autoScroll || !logState) return;
        const el = rootRef.current && rootRef.current.querySelector("#mmLogBody");
        if (el) el.scrollTop = el.scrollHeight;
      }, [logState, autoScroll]);

      function curVer() { return profilesRef.current.find((p) => p.id === selId) || null; }
      // 定位选中版本所在的 framework 子组(按 modelPath 找顶层 checkpoint,再按 framework 找子组)
      function groupForVersion(v) {
        if (!v) return null;
        const cg = groups.find((x) => x.id === v.modelPath); if (!cg) return null;
        return cg.fwGroups.find((x) => x.fw === v.framework) || null;
      }
      function curGroup() { const v = curVer(); return groupForVersion(v); }

      function markDirty() {
        if (dirtyRef.current) return;
        dirtyRef.current = true;
        const root = rootRef.current; if (!root) return;
        const pill = root.querySelector("#mmDirtyPill"); if (pill) pill.style.display = "inline-flex";
        const btn = root.querySelector("#mmBtnSave"); if (btn) btn.disabled = false;
      }

      /* 参数编辑:改草稿 ref(不触发重渲染,避免输入框失焦)+ 直接更新 rec-diff 样式 */
      function editParam(i, val) {
        const g = curGroup(); const v = curVer(); if (!g || !v) return;
        const flags = draftRef.current;
        if (i < 0 || i >= flags.length) return;
        flags[i][1] = val;
        const cat = catItem(g.fwLabel, flags[i][0]);
        const rec = recFor(g, flags[i][0]);
        const el = rootRef.current && rootRef.current.querySelector('input[data-i="' + i + '"]');
        if (el) el.classList.toggle("mm-rec-diff", !!recMismatch(cat, val, rec));
        markDirty();
      }
      function editBool(i, checked) {
        const v = curVer(); if (!v) return;
        const flags = draftRef.current;
        if (i < 0 || i >= flags.length) return;
        flags[i][1] = checked ? "" : "false";
        markDirty();
      }
      function delParam(f) {
        const v = curVer(); if (!v) return;
        if (!window.confirm("删除参数 " + f + "?")) return;
        const flags = draftRef.current;
        const i = flags.findIndex((x) => norm(x[0]) === norm(f));
        if (i >= 0) flags.splice(i, 1);
        setTick((t) => t + 1);
        markDirty();
      }
      function pickParam(f) {
        const g = curGroup(); const v = curVer(); if (!g || !v) return;
        const cat = catItem(g.fwLabel, f);
        const rec = recFor(g, f);
        let val = "";
        const noDflt = !cat || ["required", "null", "null(=model max)", "null(=auto)", "read from model"].indexOf(cat.d || "") !== -1;
        if (cat && cat.t !== "bool") {
          if (rec != null && rec !== "") val = rec;
          else if (!noDflt) val = cat.d || "";
        } else if (cat && cat.t === "bool" && rec === "") val = "";
        draftRef.current.push([f, val]);
        setPickerQ(""); setPickerOpen(false);
        setTick((t) => t + 1);
        markDirty();
      }

      /* 动作(全走现有路由;红线由 node 半强制:未注册拒盲杀/外部需 force/绝不 pkill) */
      /* 停止 = 两次点击二次确认(面板内优雅护栏,无原生弹窗):
         第一次点击 arm(按钮变实心红「确认停止?」,4 秒未再点自动解除);第二次点击才真停。
         11437 保护已降级,arm 态对它显示「将中断当前会话」。 */
      function requestStop(port, managed) {
        if (busy !== "") return;
        if (armedStop === port) {
          clearTimeout(armTimerRef.current);
          setArmedStop(null);
          doStopNow(port, managed);
          return;
        }
        setArmedStop(port);
        clearTimeout(armTimerRef.current);
        armTimerRef.current = setTimeout(() => setArmedStop((a) => (a === port ? null : a)), 4000);
      }
      function doStopNow(port, managed) {
        setBusy("stop:" + port);
        apiPost("/api/mm/stop", { port, force: !managed }).then(async (r) => {
          flash("ok", "已停止 " + port + " · " + (r.argv || []).join(" "));
          await load();
        }).catch((err) => flash("err", "停止失败:" + err.message)).then(() => setBusy(""));
      }
      function doStart() {
        const v = curVer(); if (!v) return;
        const port = defaultPort(v.gpu);
        setBusy("start");
        apiPost("/api/mm/start", { profile: v.name, port, gpu: v.gpu == null ? undefined : v.gpu }).then(async (r) => {
          flash("ok", "已托管启动 @" + r.entry.port + "(pid " + r.entry.pid + ")· 盯 readyRe 锚点,失败即存日志");
          await load();
        }).catch((err) => flash("err", "启动失败:" + err.message)).then(() => setBusy(""));
      }
      function doTakeover() {
        const v = curVer(); if (!v) return;
        const occ = running.find((s) => s.gpu === v.gpu);
        if (!occ) return;
        const port = occ.port;
        const occWarn = PROTECTED_PORTS.indexOf(port) !== -1 ? "(⚠ DSH 在用服务,停止将中断当前会话)" : "";
        if (!window.confirm("卡互斥:先停止在跑的 " + (occ.model || "") + "(@" + port + occWarn + "),再在 " + port + " 启动 " + modelOf(v.name) + "?")) return;
        setBusy("takeover");
        (async () => {
          try {
            await apiPost("/api/mm/stop", { port, force: !occ.managed });
            const r = await apiPost("/api/mm/start", { profile: v.name, port, gpu: v.gpu == null ? undefined : v.gpu });
            flash("ok", "接管完成 @" + port + ":" + (occ.model || "") + " 已停 → " + modelOf(v.name) + " 已启动(pid " + r.entry.pid + ")");
            await load();
          } catch (err) { flash("err", "接管失败:" + err.message); }
          setBusy("");
        })();
      }
      function doSave() {
        const v = curVer(); if (!v) return;
        const cmd = buildLaunchCommand(draftRef.current);
        setBusy("save");
        apiPost("/api/mm/profile/save", { profile: { ...v, launchCommand: cmd } }).then(async (r) => {
          flash("ok", "已保存 " + v.name + (r.warnings && r.warnings.length ? " · ⚠ " + r.warnings.join(" / ") : ""));
          dirtyRef.current = false;
          await load();
        }).catch((err) => flash("err", "保存失败:" + err.message)).then(() => setBusy(""));
      }
      function doSaveAs() {
        const v = curVer(); if (!v) return;
        const names = new Set(profiles.map((p) => p.name));
        let name = v.name + " 副本", n = 2;
        while (names.has(name)) { name = v.name + " 副本" + n; n += 1; }
        const cmd = buildLaunchCommand(draftRef.current);
        setBusy("saveas");
        apiPost("/api/mm/profile/save", { profile: { ...v, name, launchCommand: cmd, active: false } }).then(async (r) => {
          flash("ok", "已另存为 " + name);
          dirtyRef.current = false;
          await load();
          if (r && r.profile) setSelId(r.profile.id);
        }).catch((err) => flash("err", "保存失败:" + err.message)).then(() => setBusy(""));
      }
      function doDelete() {
        const v = curVer(); if (!v) return;
        if (!window.confirm("删除参数版本 \"" + v.name + "\"?\n不可撤销。")) return;
        setBusy("delete");
        apiPost("/api/mm/profile/delete", { profile: v.name }).then(async (r) => {
          flash("ok", "已删除 · 余 " + r.remaining);
          await load();
        }).catch((err) => flash("err", "删除失败:" + err.message)).then(() => setBusy(""));
      }
      function doRegister(body) {
        setBusy("register");
        apiPost("/api/mm/register", body).then(async (r) => {
          flash("ok", "已登记 " + r.entry.port + " [" + r.entry.framework + "]");
          setShowRegister(false);
          await load();
        }).catch((err) => flash("err", "登记失败:" + err.message)).then(() => setBusy(""));
      }
      /* 一键测速:node 半对端口跑固定 prompt 非流式生成,落盘 benchmarks.json */
      function doBench(port) {
        const v = curVer();
        setBusy("bench:" + port);
        apiPost("/api/mm/bench", { port, profile: v ? v.name : null }).then(async (r) => {
          const res = (r && r.result) || r;
          flash("ok", "测速完成 @" + res.port + ":" + res.tps + " tok/s · " + res.tokens + " tokens · " + (res.ms / 1000).toFixed(1) + "s");
          try { const b = await apiGet("/api/mm/benchmarks"); _lastBench = Array.isArray(b) ? b : []; setBenchmarks(_lastBench); } catch {}
        }).catch((err) => flash("err", /404|route/i.test(String(err.message)) ? "测速端点未生效——你手动重启一次 dsh 后自动可用" : "测速失败:" + err.message)).then(() => setBusy(""));
      }
      function doFwProbe(fw) {
        setFwProbe((m) => ({ ...m, [fw]: { ok: null, line: "探测中…" } }));
        apiPost("/api/mm/frameworks/probe", { framework: fw, exe: (fwEdit[fw] || "").trim() }).then((r) => {
          setFwProbe((m) => ({ ...m, [fw]: r }));
        }).catch((err) => {
          setFwProbe((m) => ({ ...m, [fw]: { ok: null, line: /404|route/i.test(String(err.message)) ? "端点未生效——重启 dsh 后可用" : err.message } }));
        });
      }
      function doFwSave(fw) {
        setBusy("fw:" + fw);
        apiPost("/api/mm/frameworks/save", { framework: fw, exe: (fwEdit[fw] || "").trim() }).then((r) => {
          _lastFrameworks = r; setFrameworks(r);
          flash("ok", (FRAMEWORKS[fw] || fw) + " 路径已保存:" + ((r.frameworks && r.frameworks[fw] && r.frameworks[fw].exe) || "(恢复默认)"));
        }).catch((err) => flash("err", "保存失败:" + err.message)).then(() => setBusy(""));
      }
      function copyLog() {
        if (!logState || !logState.lines.length) return;
        const txt = logState.lines.join("\n");
        const done = () => flash("ok", "已复制日志尾部 " + logState.lines.length + " 行");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
        } else fallbackCopy(txt, done);
      }
      function fallbackCopy(txt, done) {
        const ta = document.createElement("textarea");
        ta.value = txt; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (err2) { flash("err", "复制失败"); }
        document.body.removeChild(ta);
      }

      /* 事件委托(动态 innerHTML 子树) */
      function onRootClick(ev) {
        const t = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
        if (!t) return;
        const act = t.dataset.act;
        if (act === "select") setSelId(t.dataset.id);
        else if (act === "save") doSave();
        else if (act === "saveas") doSaveAs();
        else if (act === "delete") doDelete();
        else if (act === "start") doStart();
        else if (act === "takeover") doTakeover();
        else if (act === "stop" || act === "stopsrv") requestStop(Number(t.dataset.port), t.dataset.managed === "true");
        else if (act === "drawer") setDrawer((d) => !d);
        else if (act === "delparam") delParam(t.dataset.f);
        else if (act === "openpicker") { setPickerQ(""); setPickerOpen(true); }
        else if (act === "pickparam") pickParam(t.dataset.param);
        else if (act === "copylog") copyLog();
        else if (act === "autoscroll") setAutoScroll((s) => !s);
        else if (act === "tree-collapse") setTreeCollapsed(true);
        else if (act === "tree-expand") setTreeCollapsed(false);
        else if (act === "refresh") load();
        else if (act === "gpu-detect") doGpuDetect();
        else if (act === "bench") doBench(Number(t.dataset.port));
        else if (act === "fw-probe") doFwProbe(t.dataset.fw);
        else if (act === "fw-save") doFwSave(t.dataset.fw);
        else if (act === "register-toggle") setShowRegister((s) => !s);
        else if (act === "fw-cfg-toggle") setShowFwCfg((s) => !s);
      }
      function onRootInput(ev) {
        const el = ev.target;
        if (el && el.dataset && el.dataset.i !== undefined) editParam(+el.dataset.i, el.value);
      }
      function onRootChange(ev) {
        const el = ev.target;
        if (el && el.dataset && el.dataset.bool !== undefined) editBool(+el.dataset.bool, el.checked);
        else if (el && el.dataset && el.dataset.act === "sel-fw") setSelFw((s) => ({ ...s, [el.dataset.cp]: ev.target.value }));
      }

      const v = profiles.find((p) => p.id === selId) || null;
      const g = v ? groupForVersion(v) || null : null;
      const run = v ? runMap.get(v.id) : undefined;
      const dead = v ? KNOWN_DEAD[modelOf(v.name)] : undefined;
      const draft = draftRef.current;
      const baseV = (v && diffBase && g) ? g.versions.find((o) => o.id === diffBase) : null;
      const anyBusy = busy !== "";

      /* 停止按钮:两次点击二次确认。armed 态=实心红「确认停止?」;11437 追加会话中断警告 */
      function stopBtn(port, managed, act, label) {
        const prot = PROTECTED_PORTS.indexOf(port) !== -1;
        if (armedStop === port) {
          return e("button", { className: "mm-btn mm-btn--sm mm-btn--danger-solid", disabled: busy !== "", "data-act": act, "data-port": String(port), "data-managed": String(!!managed), title: "再点一次确认停止(4 秒后自动解除)" }, prot ? "⚠ 再点确认停止?将中断当前 DSH 会话" : "确认停止?");
        }
        return e("button", { className: "mm-btn mm-btn--sm mm-btn--danger", disabled: anyBusy, "data-act": act, "data-port": String(port), "data-managed": String(!!managed), title: managed ? "停止托管服务(kill 托管 pid,日志归档)" : "停止外部服务(fuser -k " + port + "/tcp)" + (prot ? " ⚠ DSH 在用:停止将中断当前会话" : "") }, label);
      }

      /* 启动/停止按钮(卡互斥 + 停止二次确认) */
      let startBtn = null;
      if (v && g) {
        if (run) {
          const prot = PROTECTED_PORTS.indexOf(run.port) !== -1;
          startBtn = stopBtn(run.port, !!(run.server && run.server.managed), "stop", "停止 @" + run.port + ((run.server && !run.server.managed) ? "(fuser)" : "") + (prot ? " · DSH 在用" : ""));
        } else if (v.gpu == null) {
          startBtn = e("button", { className: "mm-btn mm-btn--sm", disabled: true, title: "双卡(1,0)托管启动暂不支持(P2)" }, "双卡启动 (P2)");
        } else {
          const occ = running.find((s) => s.gpu === v.gpu);
          if (occ) {
            startBtn = e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "takeover" }, "启动 · 接管 " + occ.port);
          } else {
            startBtn = e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "start" }, "启动 (" + defaultPort(v.gpu) + ")");
          }
        }
      }

      /* 一键测速(运行中才显示;结果落 benchmarks.json 并回显详情) */
      let benchBtn = null;
      if (v && run) {
        benchBtn = e("button", { className: "mm-btn mm-btn--sm", disabled: busy === "bench:" + run.port, "data-act": "bench", "data-port": String(run.port) }, busy === "bench:" + run.port ? "测速中…" : "一键测速");
      }

      function serverChip(s) {
        const isRun = s.status === "running";
        const prot = PROTECTED_PORTS.indexOf(s.port) !== -1;
        return e("span", { key: s.port, className: "mm-srv" },
          e("span", { className: "mm-dot " + (isRun ? "mm-dot--on" : "mm-dot--off") }),
          e("b", { style: { fontSize: "12px", fontWeight: 600 } }, s.model || ("端口 " + s.port)),
          e("span", { className: "mm-fw mm-fw--" + s.framework }, FRAMEWORKS[s.framework] || s.framework),
          prot ? e("span", { className: "mm-pill mm-pill--hot mm-mini" }, "⚠ DSH 在用") : null,
          e("span", { className: "mm-meta" }, s.port + " · " + gpuLabel(s.gpu) + " · " + (s.managed ? ("托管 pid=" + s.pid) : "外部") + " · health=" + (s.health || "-")),
          isRun ? stopBtn(s.port, !!s.managed, "stopsrv", s.managed ? "停止" : "停止(fuser)") : null,
        );
      }

      return e("div", { ref: rootRef, className: "mm-root", onClick: onRootClick, onInput: onRootInput, onChange: onRootChange },
        e("style", null, CSS),
        /* 顶栏 */
        e("div", { className: "mm-head" },
          e("div", { className: "mm-headRow" },
            e("span", { className: "mm-title" }, "本地模型管理"),
            e("span", { className: "mm-pill mm-pill--ok" }, e("span", { className: "mm-dot mm-dot--on" }), e("b", null, running.length), " 运行中"),
            e("span", { className: "mm-pill" }, e("b", null, groups.length), " 模型 · ", e("b", null, profiles.length), " 参数版本"),
            gpuCardList().map((c) => {
              const occ = running.find((s) => s.gpu === c.index);
              const prot = occ && PROTECTED_PORTS.indexOf(occ.port) !== -1;
              const title = (c.name || c.shortName) + (c.memGb ? " · " + c.memGb + "G" : "");
              return occ
                ? e("span", { key: c.index, className: "mm-pill" + (prot ? " mm-pill--hot" : " mm-pill--warn"), title }, c.shortName, prot ? " · DSH 在用" : " 占用", e("b", null, (occ.model || "") + " @" + occ.port))
                : e("span", { key: c.index, className: "mm-pill", title }, c.shortName, e("b", null, "空闲"), " · " + (c.index === 0 || c.index === 1 ? defaultPort(c.index) + " 可用" : "可启动"));
            }),
            e("div", { className: "mm-spacer" }),
            e("button", { className: "mm-btn mm-btn--sm", disabled: busy === "gpus", "data-act": "gpu-detect", title: "重新检测本机显卡(首次启动自动获取一次,之后全手动)" }, busy === "gpus" ? "获取中…" : "⟳ 获取显卡"),
            e("button", { className: "mm-btn mm-btn--sm", disabled: anyBusy, "data-act": "refresh" }, "刷新"),
            e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", "data-act": "drawer" }, "健康检查"),
          ),
          e("div", { className: "mm-meta" }, "30s 自动刷新 · 卡互斥(一张卡一个模型)· 参数按框架官方顺序 · 说明=中文(悬停看英文)· 推荐值=该模型激活版本实测" + gpuMetaLine(gpuInfo)),
        ),
        flashMsg ? e("div", { className: "mm-flash" + (flashMsg.kind === "err" ? " mm-flash--err" : "") }, flashMsg.text) : null,
        /* 服务注册表 */
        e("div", { className: "mm-extStrip" },
          e("span", { className: "mm-kicker" }, "服务注册表"),
          servers.length ? servers.map(serverChip) : e("span", { className: "mm-meta" }, "暂无已登记服务"),
          e("div", { className: "mm-spacer" }),
          e("button", { className: "mm-btn mm-btn--sm", "data-act": "register-toggle" }, showRegister ? "收起" : "+ 登记服务"),
          e("button", { className: "mm-btn mm-btn--sm", "data-act": "fw-cfg-toggle" }, showFwCfg ? "收起框架路径" : "+ 框架路径"),
        ),
        showRegister ? e(RegisterForm, { busy: busy === "register", onSubmit: doRegister, onCancel: () => setShowRegister(false), gpus: gpuCardList() }) : null,
        /* 框架路径配置(llama.cpp=可执行文件;SGLang/vLLM=venv 内 python)——平时用不到,默认收起,服务注册表行「+ 框架路径」展开 */
        showFwCfg ? e("div", { className: "mm-extStrip" },
          e("span", { className: "mm-kicker" }, "框架路径"),
          frameworks ? Object.keys(FRAMEWORKS).map((fw) => {
            const cur = (frameworks.frameworks[fw] || {}).exe || "";
            const pv = fwProbe[fw];
            return e("span", { key: fw, className: "mm-fwCfg" },
              e("span", { className: "mm-fw mm-fw--" + fw }, FRAMEWORKS[fw]),
              e("input", { className: "mm-input mm-input--fw", placeholder: "(默认 " + ((frameworks.defaults || {})[fw] || "") + " @ PATH)", value: fwEdit[fw] != null ? fwEdit[fw] : cur, onChange: (ev) => setFwEdit((m) => ({ ...m, [fw]: ev.target.value })) }),
              e("button", { className: "mm-btn mm-btn--sm", disabled: anyBusy, "data-act": "fw-probe", "data-fw": fw }, "探测"),
              e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "fw-save", "data-fw": fw }, "保存"),
              e("span", { className: "mm-fwProbe " + (pv ? (pv.ok ? "mm-fOk" : pv.ok === false ? "mm-fBad" : "mm-meta") : "mm-meta") }, pv ? (pv.ok ? "✓ " : "✗ ") + pv.line : ""),
            );
          }) : (fwReady ? e("span", { className: "mm-meta" }, "加载框架配置…") : e("span", { className: "mm-meta" }, "框架配置端点未生效——你手动重启一次 dsh 后可用")),
        ) : null,
        /* 主体:左树 · 右详情 */
        e("div", { className: "mm-body" + (treeCollapsed ? " mm-body--collapsed" : "") },
          e("div", { className: "mm-paneL" },
            treeCollapsed
              ? null
              : (
                e("div", { className: "mm-paneLInner" },
                  e("div", { className: "mm-kickerRow" },
                    e("span", { className: "mm-kicker" }, "模型 · 参数版本"),
                    e("div", { className: "mm-spacer" }),
                    e("button", { className: "mm-btn mm-btn--sm", "data-act": "tree-collapse", title: "收起侧栏" }, "⟨")),
                  e("input", { className: "mm-search", type: "text", placeholder: "搜索(模型 / 路径 / 框架)…", value: treeQ, onChange: (ev) => setTreeQ(ev.target.value) }),
                  e("div", { dangerouslySetInnerHTML: { __html: treeHtml(groups, selId, runMap, treeQ, selFw) } }))),
          ),
          e("div", { className: "mm-paneR" },
            !v || !g
              ? e("div", { className: "mm-loading" },
                treeCollapsed ? e("button", { className: "mm-btn mm-btn--sm", "data-act": "tree-expand", title: "展开「模型 · 参数版本」列表" }, "≡ 版本") : null,
                "在左侧选择一个参数版本…")
              : e("div", { key: v.id + ":" + tick },
                e("div", { className: "mm-vHead" },
                  treeCollapsed ? e("button", { className: "mm-btn mm-btn--sm", "data-act": "tree-expand", title: "展开「模型 · 参数版本」列表" }, "≡ 版本") : null,
                  e("span", { className: "mm-vTitle" }, v.name),
                  e("span", { className: "mm-meta" }, shortPath(v.modelPath || "")),
                  v.active ? e("span", { className: "mm-pill mm-mini" }, "激活") : null,
                  run ? e("span", { className: "mm-pill mm-pill--ok mm-mini" }, "● 运行中 @" + run.port + (run.ext ? " · 外部" : "")) : null,
                  dead ? e("span", { className: "mm-pill mm-pill--fail mm-mini" }, g.fw === "vllm" ? "⚠ vLLM 不可用" : "✗ 不可行") : null,
                  e("span", { id: "mmDirtyPill", className: "mm-pill mm-pill--warn mm-mini", style: { display: dirtyRef.current ? "inline-flex" : "none" } }, "● 未保存"),
                  e("div", { className: "mm-spacer" }),
                  startBtn,
                  benchBtn,
                  e("button", { id: "mmBtnSave", className: "mm-btn mm-btn--sm", disabled: !dirtyRef.current || anyBusy, "data-act": "save" }, "保存"),
                  e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "saveas" }, "另存为版本"),
                  g.versions.length > 1 ? e("select", { className: "mm-sel", value: diffBase || "", onChange: (ev) => setDiffBase(ev.target.value || null) },
                    e("option", { value: "" }, "对比…"),
                    g.versions.filter((o) => o.id !== v.id).map((o) => e("option", { key: o.id, value: o.id }, "对比 " + modelOf(o.name) + "(基线)"))) : null,
                  e("button", { className: "mm-btn mm-btn--sm mm-btn--danger", disabled: anyBusy, "data-act": "delete" }, "删除"),
                ),
                e("div", { className: "mm-metaStrip", dangerouslySetInnerHTML: { __html: metaStripHtml(g, v, benchmarks, run) } }),
                baseV
                  ? e("div", { dangerouslySetInnerHTML: { __html: diffHtml(g, v, baseV, draft) } })
                  : e("div", { dangerouslySetInnerHTML: { __html: paramsTableHtml(g, v, draft) } }),
                pickerOpen
                  ? e("div", { className: "mm-picker" },
                    e("input", { type: "text", placeholder: "搜索参数(中文/英文,如 speculative / cache / top-k)…", value: pickerQ, onChange: (ev) => setPickerQ(ev.target.value) }),
                    e("div", { dangerouslySetInnerHTML: { __html: pickerHtml(g, v, draft, pickerQ) } }))
                  : e("div", { className: "mm-pAdd", "data-act": "openpicker" }, "＋ 从官方目录添加参数(按框架顺序插入,带候选/默认值)"),
                e("div", { dangerouslySetInnerHTML: { __html: tailHtml(g, v, run, logState, dead, draft, benchmarks, autoScroll) } }),
              ),
          ),
        ),
        /* 统一端点规划 */
        e("div", { className: "mm-unified" },
          e("span", { className: "mm-tag" }, "统一端点 · P3 规划"),
          e("span", null, "一个端口跑所有模型:"),
          e("code", null, "http://127.0.0.1:11435/v1"),
          e("span", { className: "mm-routes" }, "按 body.model 路由 · 流式字节透传 · 切模型自动接管占用的卡"),
        ),
        /* 健康检查抽屉 */
        e("div", { className: "mm-drawer" + (drawer ? " mm-drawer--open" : "") },
          e("div", { className: "mm-drawerHead" }, "健康检查", e("span", { className: "mm-meta" }, "客户端校验 + 服务健康(纯派生,不依赖新路由)")),
          doctorFindings(servers, groups).map((f, i) =>
            e("div", { key: i, className: "mm-finding" },
              e("span", { className: "mm-fIcon " + (f.tone === "ok" ? "mm-fOk" : f.tone === "warn" ? "mm-fWarn" : "mm-fBad") }, f.tone === "ok" ? "✓" : f.tone === "warn" ? "⚠" : "✗"),
              e("span", { className: "mm-where" }, f.where),
              e("span", { className: "mm-msg" }, f.msg),
            )),
        ),
      );
    }

    /* ---------- 插件主体 ---------- */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: "model-manager",
        order: 41,
        label: "模型管理",
      }, ModelManagerPanel));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
