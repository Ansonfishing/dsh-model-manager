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
    const CSS = `.mm-root{
    --bg:#ffffff; --page:#eef1f5; --layer:#f6f8fa; --layer2:#eef1f4; --line:#d0d7de; --line2:#b6bec7;
    --text:#1f2328; --muted:#57606a; --faint:#8c959f;
    --accent:#0969da; --success:#1a7f37; --warn:#9a6700; --danger:#cf222e;
    --warn-bg:#fff8c5; --add-bg:#dafbe1; --del-bg:#ffebe9;
    --hover:rgba(175,184,193,.22);
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    --code:ui-monospace,SFMono-Regular,"JetBrains Mono",Consolas,monospace;
  }
.mm-root *{box-sizing:border-box;margin:0;padding:0;}
.mm-root{background:var(--page);color:var(--text);font-family:var(--font);font-size:12.5px;line-height:1.5;padding:24px;display:flex;justify-content:center;}
.mm-root{width:1220px;max-width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:0 12px 36px rgba(31,35,40,.10);}
.mm-root .mm-head{padding:14px 16px 12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px;}
.mm-root .mm-headRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.mm-root .mm-title{font-size:14px;font-weight:600;}
.mm-root .mm-spacer{flex:1;}
.mm-root .mm-pill{display:inline-flex;align-items:center;gap:5px;min-height:22px;padding:0 9px;border:1px solid var(--line);border-radius:999px;background:var(--layer);color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.mm-root .mm-pill b{font-weight:600;color:var(--text);}
.mm-root .mm-pill--ok{border-color:color-mix(in srgb,var(--success) 34%,var(--line));color:var(--success);background:color-mix(in srgb,var(--success) 7%,var(--bg));}
.mm-root .mm-pill--fail{border-color:color-mix(in srgb,var(--danger) 42%,var(--line));color:var(--danger);background:color-mix(in srgb,var(--danger) 6%,var(--bg));}
.mm-root .mm-pill--hot{border-color:color-mix(in srgb,var(--warn) 42%,var(--line));background:color-mix(in srgb,var(--warn) 8%,var(--bg));}
.mm-root .mm-pill--hot b{color:var(--warn);font-weight:500;}
.mm-root .mm-pill--warn{border-color:color-mix(in srgb,var(--warn) 40%,var(--line));color:var(--warn);background:color-mix(in srgb,var(--warn) 8%,var(--bg));}
.mm-root .mm-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;}
.mm-root .mm-dot--on{background:var(--success);box-shadow:0 0 6px color-mix(in srgb,var(--success) 60%,transparent);}
.mm-root .mm-dot--off{background:var(--faint);}
.mm-root .mm-dot--fail{background:var(--danger);box-shadow:0 0 6px color-mix(in srgb,var(--danger) 60%,transparent);}
.mm-root .mm-btn{min-height:30px;padding:4px 12px;border:1px solid var(--line2);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap;transition:background-color .12s,border-color .12s,transform .12s;font-family:var(--font);}
.mm-root .mm-btn:hover{background:var(--hover);}
.mm-root .mm-btn:active{transform:translateY(1px);}
.mm-root .mm-btn:disabled{opacity:.4;cursor:default;}
.mm-root .mm-btn--primary{border-color:color-mix(in srgb,var(--accent) 45%,var(--line2));color:var(--accent);font-weight:500;background:color-mix(in srgb,var(--accent) 5%,var(--bg));}
.mm-root .mm-btn--danger{border-color:color-mix(in srgb,var(--danger) 45%,var(--line2));color:var(--danger);font-weight:500;}
.mm-root .mm-btn--sm{min-height:26px;padding:2px 10px;font-size:11px;}
.mm-root .mm-meta{color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums;}
.mm-root select.mm-sel{min-height:26px;padding:2px 8px;border:1px solid var(--line2);border-radius:8px;background:var(--bg);color:var(--muted);font-size:11px;font-family:var(--font);cursor:pointer;}
.mm-root .mm-extStrip{display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--layer);flex-wrap:wrap;}
.mm-root .mm-fw{flex:none;border:1px solid var(--line);border-radius:999px;padding:0 7px;font-size:10.5px;line-height:18px;color:var(--muted);background:var(--bg);white-space:nowrap;}
.mm-root .mm-fw--llama{color:#6e40c9;border-color:color-mix(in srgb,#6e40c9 34%,var(--line));}
.mm-root .mm-fw--sglang{color:#116329;border-color:color-mix(in srgb,#116329 34%,var(--line));}
.mm-root .mm-fw--vllm{color:#9a3412;border-color:color-mix(in srgb,#9a3412 34%,var(--line));}
.mm-root .mm-body{display:grid;grid-template-columns:320px 1fr;}
.mm-root .mm-paneL{border-right:1px solid var(--line);padding:10px 8px;max-height:700px;overflow:auto;background:color-mix(in srgb,var(--layer) 55%,var(--bg));}
.mm-root .mm-kicker{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--muted);padding:4px 8px;}
.mm-root .mm-mGroup{margin-bottom:12px;}
.mm-root .mm-mHead{padding:5px 8px;display:flex;gap:6px;align-items:center;min-width:0;}
.mm-root .mm-mHead .mm-mp{font-family:var(--code);font-size:10.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.mm-root .mm-ver{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent;min-width:0;}
.mm-root .mm-ver:hover{background:var(--hover);}
.mm-root .mm-ver--sel{background:var(--bg);border-color:var(--line);box-shadow:0 1px 2px rgba(31,35,40,.06);}
.mm-root .mm-ver .mm-vt{font-family:var(--code);font-size:10.5px;border:1px solid var(--line2);border-radius:5px;padding:0 5px;line-height:16px;color:var(--text);flex:none;}
.mm-root .mm-ver--run .mm-vt{border-color:color-mix(in srgb,var(--success) 52%,var(--line2));color:var(--success);}
.mm-root .mm-ver--fail .mm-vt{border-color:color-mix(in srgb,var(--danger) 52%,var(--line2));color:var(--danger);}
.mm-root .mm-ver .mm-vn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11.5px;min-width:0;}
.mm-root .mm-ver .mm-vr{font-family:var(--code);font-size:10px;color:var(--success);flex:none;}
.mm-root .mm-ver .mm-vf{font-family:var(--code);font-size:10px;color:var(--danger);flex:none;}
.mm-root .mm-ver .mm-vpend{font-size:9.5px;color:var(--faint);border:1px solid var(--line2);border-radius:999px;padding:0 5px;line-height:15px;flex:none;white-space:nowrap;}
.mm-root .mm-bench{font-size:10px;color:var(--faint);border:1px solid var(--line);border-radius:999px;padding:0 6px;line-height:15px;flex:none;}
.mm-root .mm-paneR{padding:12px 16px 16px;max-height:700px;overflow:auto;}
.mm-root .mm-vHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.mm-root .mm-vTitle{font-size:14px;font-weight:600;margin-right:2px;}
.mm-root .mm-dirtyPill{display:none;}
.mm-root .mm-dirtyPill--on{display:inline-flex;}
.mm-root .mm-metaStrip{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px;}
.mm-root .mm-secLabel{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--muted);margin:14px 0 6px;display:flex;align-items:center;gap:8px;}
.mm-root .mm-secLabel .mm-meta{margin-left:auto;font-weight:400;letter-spacing:0;}
.mm-root /* 参数表:参数 | 值 | 说明 */
  .mm-pTable{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);}
.mm-root .mm-pHead{display:grid;grid-template-columns:185px 240px 1fr;padding:6px 10px;background:var(--layer);border-bottom:1px solid var(--line);font-size:11px;color:var(--faint);}
.mm-root .mm-pHead3{grid-template-columns:185px 240px 240px;}
.mm-root .mm-pRow{display:grid;grid-template-columns:185px 240px 1fr 24px;align-items:center;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);}
.mm-root .mm-pRow:last-child{border-bottom:none;}
.mm-root .mm-pRow3{grid-template-columns:185px 240px 240px;}
.mm-root .mm-pRow:hover{background:color-mix(in srgb,var(--hover) 55%,transparent);}
.mm-root .mm-pFlag{font-family:var(--code);font-size:11px;color:var(--accent);padding:5px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mm-root .mm-pVal{padding:3px 6px;min-width:0;}
.mm-root .mm-pVal input[type=text]{width:100%;min-width:0;background:transparent;border:1px solid transparent;border-radius:5px;color:var(--text);font-family:var(--code);font-size:11px;padding:3px 7px;}
.mm-root .mm-pVal input[type=text]:focus{outline:none;border-color:color-mix(in srgb,var(--accent) 55%,var(--line2));background:var(--bg);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 14%,transparent);}
.mm-root .mm-pVal input[type=text]::placeholder{color:var(--faint);opacity:.75;}
.mm-root .mm-pVal input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;margin:0 8px;}
.mm-root .mm-pVal .mm-txt{font-family:var(--code);font-size:11px;color:var(--text);padding:3px 7px;word-break:break-all;}
.mm-root .mm-pDesc{font-size:10.5px;color:var(--muted);padding:4px 10px;line-height:1.45;white-space:normal;word-break:break-word;}
.mm-root .mm-pDesc .mm-dflt{color:var(--faint);font-family:var(--code);font-size:10px;}
.mm-root .mm-pBase .mm-txt, .mm-root .mm-pCur .mm-txt{font-family:var(--code);font-size:11px;padding:5px 10px;word-break:break-all;}
.mm-root .mm-pDel{padding:4px 8px;text-align:center;color:var(--faint);cursor:pointer;font-size:11px;user-select:none;grid-column:4;justify-self:end;}
.mm-root .mm-pDel:hover{color:var(--danger);}
.mm-root .mm-pRow--locked{opacity:.55;background:var(--layer);}
.mm-root .mm-pRow--locked .mm-pVal input{cursor:default;}
.mm-root .mm-pRow--locked .mm-pFlag{color:var(--faint);}
.mm-root /* 添加参数 picker */
  .mm-pAdd{padding:6px 10px;font-size:11.5px;color:var(--accent);cursor:pointer;display:flex;gap:6px;align-items:center;}
.mm-root .mm-pAdd:hover{background:var(--hover);}
.mm-root .mm-picker{border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));border-radius:0 0 8px 8px;border-top:none;background:var(--layer);max-height:230px;overflow:auto;padding:6px 0;}
.mm-root .mm-picker input{width:calc(100% - 20px);margin:2px 10px 6px;padding:5px 9px;border:1px solid var(--line2);border-radius:6px;font-size:11.5px;font-family:var(--font);}
.mm-root .mm-picker input:focus{outline:none;border-color:var(--accent);}
.mm-root .mm-pkGroup{font-size:10.5px;font-weight:600;letter-spacing:.05em;color:var(--muted);padding:5px 12px 2px;}
.mm-root .mm-pkItem{display:grid;grid-template-columns:175px 90px 1fr auto;padding:3px 12px;cursor:pointer;gap:8px;align-items:baseline;}
.mm-root .mm-recChip{flex:none;font-size:10px;color:var(--success);border:1px solid color-mix(in srgb,var(--success) 34%,var(--line));background:color-mix(in srgb,var(--success) 7%,var(--bg));border-radius:999px;padding:0 6px;line-height:15px;white-space:nowrap;}
.mm-root .mm-pVal input.mm-rec-diff{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,var(--line2));background:color-mix(in srgb,var(--warn-bg) 55%,transparent);}
.mm-root .mm-pkItem:hover{background:var(--hover);}
.mm-root .mm-pkItem .mm-f{font-family:var(--code);font-size:11px;color:var(--accent);}
.mm-root .mm-pkItem .mm-d{font-family:var(--code);font-size:10px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mm-root .mm-pkItem .mm-s{font-size:10.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mm-root /* diff 状态 */
  .mm-pRow--chg{background:color-mix(in srgb,var(--warn-bg) 55%,transparent);}
.mm-root .mm-pRow--chg .mm-pBase .mm-txt{color:var(--faint);text-decoration:line-through;}
.mm-root .mm-pRow--chg .mm-pCur .mm-txt{color:var(--warn);font-weight:600;}
.mm-root .mm-pRow--add{background:color-mix(in srgb,var(--add-bg) 45%,transparent);}
.mm-root .mm-pRow--add .mm-pFlag{color:var(--success);}
.mm-root .mm-pRow--add .mm-pCur .mm-txt{color:var(--success);font-weight:600;}
.mm-root .mm-pRow--del{background:color-mix(in srgb,var(--del-bg) 45%,transparent);}
.mm-root .mm-pRow--del .mm-pFlag{color:var(--danger);text-decoration:line-through;}
.mm-root .mm-diffLegend{display:flex;gap:12px;font-size:11px;color:var(--muted);margin:6px 0;}
.mm-root .mm-diffLegend .mm-lg{display:inline-flex;align-items:center;gap:5px;}
.mm-root .mm-sw{width:9px;height:9px;border-radius:3px;display:inline-block;}
.mm-root .mm-sw--chg{background:var(--warn-bg);border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));}
.mm-root .mm-sw--add{background:var(--add-bg);border:1px solid color-mix(in srgb,var(--success) 40%,var(--line));}
.mm-root .mm-sw--del{background:var(--del-bg);border:1px solid color-mix(in srgb,var(--danger) 40%,var(--line));}
.mm-root .mm-vFoot{margin-top:10px;display:flex;flex-direction:column;gap:4px;}
.mm-root .mm-okLine{color:var(--success);font-size:11.5px;}
.mm-root .mm-warnLine{color:var(--warn);font-size:11.5px;}
.mm-root .mm-errLine{color:var(--danger);font-size:11.5px;}
.mm-root /* 启动日志 */
  .mm-logBox{margin-top:12px;border:1px solid var(--line);border-radius:8px;overflow:hidden;}
.mm-root .mm-logHead{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--layer);border-bottom:1px solid var(--line);}
.mm-root .mm-logHead .mm-lt{font-size:11.5px;font-weight:600;}
.mm-root .mm-logBox--fail{border-color:color-mix(in srgb,var(--danger) 45%,var(--line));}
.mm-root .mm-logBox--fail .mm-logHead{background:color-mix(in srgb,var(--danger) 5%,var(--bg));}
.mm-root .mm-logBody{background:#f6f8fa;padding:8px 10px;font-family:var(--code);font-size:10.5px;line-height:1.55;max-height:180px;overflow:auto;color:#424a53;white-space:pre-wrap;word-break:break-all;}
.mm-root .mm-logBody .mm-ln{display:block;}
.mm-root .mm-logBody .mm-err{color:var(--danger);font-weight:600;background:color-mix(in srgb,var(--danger) 7%,transparent);display:block;border-radius:3px;}
.mm-root .mm-logBody .mm-okl{color:var(--success);}
.mm-root .mm-unified{margin:12px 16px 0;border:1px dashed color-mix(in srgb,var(--accent) 40%,var(--line));border-radius:8px;background:color-mix(in srgb,var(--accent) 3%,var(--bg));padding:8px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;}
.mm-root .mm-unified .mm-tag{border:1px solid color-mix(in srgb,var(--accent) 34%,var(--line));color:var(--accent);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;background:color-mix(in srgb,var(--accent) 7%,var(--bg));}
.mm-root .mm-unified code{font-family:var(--code);font-size:11.5px;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 6px;}
.mm-root .mm-unified .mm-routes{color:var(--muted);font-family:var(--code);font-size:11px;}
.mm-root .mm-unified .mm-routes b{color:var(--success);font-weight:500;}
.mm-root .mm-drawer{margin:0 16px 16px;border:1px solid var(--line);border-radius:8px;background:var(--layer);display:none;flex-direction:column;gap:2px;overflow:hidden;}
.mm-root .mm-drawer--open{display:flex;}
.mm-root .mm-drawerHead{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;}
.mm-root .mm-finding{display:flex;gap:8px;align-items:flex-start;padding:6px 12px;font-size:11.5px;border-top:1px solid color-mix(in srgb,var(--line) 60%,transparent);}
.mm-root .mm-finding:first-of-type{border-top:none;}
.mm-root .mm-fIcon{flex:none;width:14px;text-align:center;}
.mm-root .mm-fOk{color:var(--success);}
.mm-root .mm-fWarn{color:var(--warn);}
.mm-root .mm-fBad{color:var(--danger);}
.mm-root .mm-finding .mm-where{font-family:var(--code);color:var(--faint);font-size:10.5px;flex:none;}
.mm-root .mm-finding .mm-msg{color:var(--muted);}
.mm-root .mm-finding .mm-msg b{color:var(--text);font-weight:500;}
.mm-root .mm-toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(8px);background:#24292f;border:1px solid #24292f;color:#f6f8fa;border-radius:8px;padding:8px 16px;font-size:12px;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;box-shadow:0 8px 24px rgba(31,35,40,.35);max-width:70vw;}
.mm-root .mm-toast--show{opacity:1;transform:translateX(-50%) translateY(0);}
.mm-root .mm-toast b{color:#7ee787;}

  @media (prefers-reduced-motion:reduce){.mm-root *{transition:none!important;}}
/* ===== 面板布局覆盖(面板容器内,非独立页) ===== */
.mm-root{padding:0;height:100%;width:auto;max-width:none;display:flex;flex-direction:column;background:var(--bg);border:none;box-shadow:none;font-size:12.5px;line-height:1.5;}
.mm-body{flex:1;min-height:0;display:grid;grid-template-columns:320px 1fr;}
.mm-paneL{border-right:1px solid var(--line);padding:10px 8px;overflow:auto;max-height:none;background:color-mix(in srgb,var(--layer) 55%,var(--bg));}
.mm-paneR{padding:12px 16px 16px;overflow:auto;max-height:none;}
.mm-mini{min-height:18px;line-height:16px;padding:0 6px;font-size:10px;}
.mm-srv{display:inline-flex;align-items:center;gap:7px;margin-right:16px;}
.mm-flash{margin:0 16px 8px;padding:7px 12px;border-radius:8px;border:1px solid color-mix(in srgb,var(--success) 34%,var(--line));background:color-mix(in srgb,var(--success) 6%,var(--bg));color:var(--success);font-size:12px;word-break:break-all;}
.mm-flash--err{border-color:color-mix(in srgb,var(--danger) 34%,var(--line));background:color-mix(in srgb,var(--danger) 6%,var(--bg));color:var(--danger);}
.mm-regForm{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--layer);flex-wrap:wrap;}
.mm-input{min-height:26px;padding:3px 9px;border:1px solid var(--line2);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;width:150px;}
.mm-lt{font-size:11.5px;font-weight:600;}
.mm-loading{padding:40px 0;text-align:center;font-size:12px;color:var(--faint);}
/* ===== 追加:搜索框 / 框架路径配置 / 测速记录 ===== */
.mm-search{width:calc(100% - 8px);margin:0 0 8px;padding:4px 10px;border:1px solid var(--line2);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;}
.mm-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent);}
.mm-fwCfg{display:flex;align-items:center;gap:7px;margin-right:18px;flex-wrap:wrap;}
.mm-input--fw{width:300px;font-family:var(--code);font-size:11px;}
.mm-fwProbe{font-size:11px;font-family:var(--code);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mm-benchBox{margin-top:10px;}
.mm-benchList{padding:4px 0;}
.mm-benchRow{display:flex;align-items:baseline;gap:10px;padding:3px 14px;}
.mm-benchRow + .mm-benchRow{border-top:1px dashed var(--line);}
.mm-benchTps{font-size:12px;color:var(--text);white-space:nowrap;}
.mm-benchTps b{font-size:15px;font-weight:700;color:var(--accent);}
.mm-benchEmpty{padding:6px 14px;font-size:11.5px;}
.mm-root .mm-btn.mm-btn--danger-solid{background:var(--danger);border-color:var(--danger);color:#fff;}
/* ===== 追加:模型优先三层树(模型 → 量化 → 框架/版本,mockup-v5 定稿)+ 卡 tab + 测速对比 ===== */
.mm-root .mm-cardTabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;}
.mm-root .mm-ctab{border:1px solid var(--line);background:var(--bg);border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer;user-select:none;}
.mm-root .mm-ctab:hover{background:var(--layer2);}
.mm-root .mm-ctab--active{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}
.mm-root .mm-ctab--active:hover{background:var(--accent);}
.mm-root .mm-mrow{cursor:pointer;padding:5px 6px;border-radius:6px;display:flex;align-items:center;gap:5px;font-weight:600;min-width:0;}
.mm-root .mm-mrow:hover{background:var(--layer2);}
.mm-root .mm-mrow--sel{background:#eaf3ff;}
.mm-root .mm-arrow{color:var(--faint);font-size:11px;width:12px;flex:none;transition:transform .12s;}
.mm-root .mm-mrow.open > .mm-arrow,.mm-root .mm-qrow.open > .mm-arrow{transform:rotate(90deg);}
.mm-root .mm-msub{margin-left:14px;display:none;}
.mm-root .mm-mrow.open + .mm-msub{display:block;}
.mm-root .mm-mrow .mm-mp{font-family:var(--code);font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}
.mm-root .mm-qrow{cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:5px;color:var(--muted);margin:1px 0;min-width:0;}
.mm-root .mm-qrow:hover{background:var(--layer2);}
.mm-root .mm-qtag{font-weight:600;color:var(--text);}
.mm-root .mm-qcard{color:var(--faint);font-weight:400;font-size:11.5px;white-space:nowrap;}
.mm-root .mm-qstat{margin-left:auto;font-size:11px;white-space:nowrap;}
.mm-root .mm-qstat--run{color:var(--success);font-weight:600;}
.mm-root .mm-qstat--bench{color:var(--accent);font-weight:600;}
.mm-root .mm-qstat--no{color:var(--faint);}
.mm-root .mm-vsub2{margin:1px 0 6px 16px;display:none;border-left:2px solid var(--line);padding-left:6px;}
.mm-root .mm-qrow.open + .mm-vsub2{display:block;}
.mm-root .mm-vrow{cursor:pointer;display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:5px;color:var(--muted);min-width:0;}
.mm-root .mm-vrow:hover{background:var(--layer2);}
.mm-root .mm-vrow--sel{background:#eaf3ff;}
.mm-root .mm-vrow--run .mm-qcard{color:var(--success);}
.mm-root .mm-vstat{margin-left:auto;font-size:11px;white-space:nowrap;}
.mm-root .mm-vstat--run{color:var(--success);font-weight:600;}
.mm-root .mm-vstat--bench{color:var(--accent);font-weight:600;}
.mm-root .mm-vstat--fail{color:var(--danger);}
.mm-root .mm-vstat--no{color:var(--faint);}
.mm-root .mm-mright{margin-left:auto;display:flex;gap:6px;align-items:center;flex:none;}
.mm-root .mm-mcard{font-size:10px;padding:0 6px;border-radius:999px;background:var(--layer);border:1px solid var(--line);color:var(--muted);font-weight:600;white-space:nowrap;}
.mm-root .mm-mcount{color:var(--faint);font-size:11px;font-weight:400;white-space:nowrap;}
.mm-root .mm-vSub{color:var(--faint);font-size:12px;font-weight:400;white-space:nowrap;}
.mm-root .mm-vActions{display:flex;gap:8px;margin:10px 0 2px;flex-wrap:wrap;align-items:center;}
.mm-root .mm-cmp{border:1px solid var(--line);border-radius:8px;margin-top:14px;overflow:hidden;}
.mm-root .mm-cmpHead{background:var(--layer);border-bottom:1px solid var(--line);padding:7px 12px;font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:10px;}
.mm-root .mm-cmpHead .mm-meta{font-weight:400;}
.mm-root .mm-cmpBody{padding:4px 12px 8px;}
.mm-root .mm-brow{display:grid;grid-template-columns:110px minmax(0,1fr) 90px 70px 120px;gap:10px;padding:6px 2px;border-top:1px dashed var(--line);align-items:baseline;font-size:12px;}
.mm-root .mm-brow:first-child{border-top:none;}
.mm-root .mm-brow--head{color:var(--faint);font-weight:600;font-size:11.5px;}
.mm-root .mm-brow--me{background:#f0f6ff;}
.mm-root .mm-bnum{color:var(--text);white-space:nowrap;}
.mm-root .mm-bnum b{font-size:15px;font-weight:700;color:var(--accent);}
.mm-root .mm-bmeta{color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* ===== 追加:侧栏收起 / 日志自动滚动 / 顶部测速 pill ===== */
.mm-root .mm-body.mm-body--collapsed{grid-template-columns:0 1fr;}
.mm-root .mm-body--collapsed .mm-paneL{padding:0;border-right:0;background:none;}
.mm-kickerRow{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
.mm-autoScroll{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);cursor:pointer;user-select:none;}
.mm-autoScroll input{margin:0;cursor:pointer;}
/* ===== v7 §15:模型名首位两行制 / splitter / 参数 9 组 + 未设行 / ⋯菜单 / 折叠块 ===== */
.mm-root .mm-mcol{display:flex;flex-direction:column;flex:1;min-width:0;gap:2px;}
.mm-root .mm-mline1{display:flex;align-items:baseline;gap:7px;min-width:0;}
.mm-root .mm-mline2{display:flex;align-items:center;gap:6px;min-width:0;}
.mm-root .mm-mname{font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.mm-root .mm-mrun{font-size:10px;font-weight:700;color:var(--success);white-space:nowrap;flex:none;}
.mm-root .mm-mrow{align-items:flex-start;padding:6px 6px 5px;}
.mm-root .mm-mrow > .mm-arrow{margin-top:2px;}
.mm-root .mm-qtag{font-size:11.5px;}
.mm-root .mm-vtag{font-size:10.5px;font-weight:600;color:var(--text);background:var(--layer2);border:1px solid var(--line);border-radius:5px;padding:0 5px;line-height:15px;white-space:nowrap;flex:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;}
.mm-root .mm-splitter{cursor:col-resize;background:transparent;position:relative;flex:none;}
.mm-root .mm-splitter::after{content:"";position:absolute;inset:0 -3px;z-index:5;}
.mm-root .mm-splitter:hover,.mm-root .mm-splitter:active{background:color-mix(in srgb,var(--accent) 35%,transparent);}
.mm-root .mm-body--collapsed .mm-splitter{display:none;}
.mm-root .mm-pGroup{display:flex;align-items:center;gap:8px;padding:5px 10px 4px;background:color-mix(in srgb,var(--layer) 65%,transparent);border-bottom:1px solid var(--line);font-size:10.5px;font-weight:700;letter-spacing:.08em;color:var(--muted);}
.mm-root .mm-pRow--unset{opacity:.62;background:repeating-linear-gradient(135deg,transparent,transparent 9px,color-mix(in srgb,var(--layer) 45%,transparent) 9px,color-mix(in srgb,var(--layer) 45%,transparent) 10px);}
.mm-root .mm-pRow--unset:hover{opacity:.92;}
.mm-root .mm-pRow--unset .mm-pDel{color:var(--accent);}
.mm-root .mm-unsetTag{font-size:11px;color:var(--faint);padding:3px 7px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;}
.mm-root .mm-sibHint{font-size:10px;color:var(--accent);font-family:var(--code);opacity:.85;}
.mm-root .mm-moreWrap{position:relative;}
.mm-root .mm-moreMenu{position:absolute;right:0;top:calc(100% + 4px);z-index:40;min-width:180px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 28px rgba(31,35,40,.22);padding:4px;display:flex;flex-direction:column;gap:2px;}
.mm-root .mm-moreMenu button{border:0;background:none;text-align:left;padding:6px 10px;border-radius:6px;font-size:12px;color:var(--text);cursor:pointer;white-space:nowrap;}
.mm-root .mm-moreMenu button:hover{background:var(--hover);}
.mm-root .mm-moreMenu button:disabled{opacity:.5;cursor:default;}
.mm-root .mm-menuSel{width:100%;margin:2px 0;}
.mm-root .mm-fold{border:1px solid var(--line);border-radius:8px;margin-top:10px;overflow:hidden;background:var(--bg);}
.mm-root .mm-foldSum{cursor:pointer;padding:7px 12px;font-size:11.5px;font-weight:600;color:var(--muted);background:var(--layer);user-select:none;display:flex;align-items:center;gap:8px;list-style:none;}
.mm-root .mm-foldSum::before{content:"▸";color:var(--faint);font-size:10px;}
.mm-root .mm-fold[open] > .mm-foldSum::before{content:"▾";}
.mm-root summary::-webkit-details-marker{display:none;}
.mm-root details > summary{list-style:none;}
.mm-root .mm-foldFlag{font-weight:400;font-size:11px;}
.mm-root .mm-foldFlag--ok{color:var(--success);}
.mm-root .mm-foldFlag--warn{color:var(--warn);}
.mm-root .mm-foldFlag--bad{color:var(--danger);font-weight:600;}
.mm-root .mm-tailFold > .mm-pTable{border:0;border-radius:0;border-bottom:1px solid var(--line);}
.mm-root .mm-vFoot{padding:6px 10px 8px;}
.mm-root .mm-logBox{margin:0 10px 10px;}
.mm-root .mm-benchBar{display:flex;align-items:center;gap:8px;padding:7px 12px 3px;}
.mm-root .mm-cmp{margin-top:10px;}
.mm-root .mm-cmpHead{cursor:pointer;list-style:none;}
.mm-root .mm-svcToggle{display:inline-flex;align-items:center;gap:10px;cursor:pointer;user-select:none;color:var(--muted);font-size:12px;min-width:0;flex-wrap:nowrap;max-width:52ch;overflow:hidden;}
`;

    /* ================= 官方参数目录 + 中文说明(自 mockup-v3 注入:
       CAT_LLAMA / CAT_SGLANG / CATS / ALIAS / ZH / ZH_OVERRIDES / zhFor /
       GROUP_ZH / norm / catItem / sortedParams / recFor / isOn / recMismatch) ================= */
    /* ================= 框架官方参数目录(实机 --help / argparse ground truth) ================= */
const CAT_LLAMA=[
{"f":"-t","t":"int","d":"-1","s":"number of CPU threads to use during generation (default: -1)","z":"生成时使用的 CPU 线程数(默认 -1,自动)","g":"perf"},
{"f":"-tb","t":"int","d":"same as --threads","s":"number of threads to use during batch and prompt processing (default: same as --threads)","z":"批处理与提示词处理的线程数(默认同 -t)","g":"perf"},
{"f":"-c","t":"int","d":"0","s":"size of the prompt context (default: 0, 0 = loaded from model)","z":"提示词上下文大小;0=从模型元数据读取(= -np 个 slot 共享此总预算)","g":"context"},
{"f":"-n","t":"int","d":"-1","s":"number of tokens to predict (default: -1, -1 = infinity)","z":"预测 token 数;-1=不限(默认)","g":"context"},
{"f":"-b","t":"int","d":"2048","s":"logical maximum batch size","z":"逻辑最大批大小","g":"context"},
{"f":"--swa-full","t":"bool","d":"","s":"use full-size SWA cache (default: false)","z":"使用全尺寸 SWA(滑动窗口注意力)缓存(默认关)","g":"kv"},
{"f":"-fa","t":"enum","d":"on,off,auto","s":"set Flash Attention use ('on', 'off', or 'auto', default: 'auto')","z":"Flash Attention 开关('on'/'off'/'auto',默认 auto)","g":"perf"},
{"f":"--rope-scaling","t":"enum","d":"none,linear,yarn","s":"RoPE frequency scaling method, defaults to linear unless specified by the model","z":"RoPE 频率缩放方式,模型未指定时默认 linear","g":"context"},
{"f":"-kvo","t":"bool","d":"","s":"whether to enable KV cache offloading (default: enabled)","z":"是否开启 KV 缓存卸载到 CPU(默认开)","g":"kv"},
{"f":"-ctk","t":"enum","d":"f32,f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1","s":"KV cache data type for K (default: f16)","z":"K 缓存数据类型(默认 f16)","g":"kv"},
{"f":"-ctv","t":"enum","d":"f32,f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1","s":"KV cache data type for V (default: f16)","z":"V 缓存数据类型(默认 f16)","g":"kv"},
{"f":"-lm","t":"enum","d":"auto,none,mmap,mlock,mmap+mlock,dio","s":"model loading mode (default: auto)","z":"模型加载方式(默认 auto)","g":"model"},
{"f":"--device","t":"str","d":"","s":"comma-separated list of devices to use for offloading (none = don't offload)","z":"参与卸载的设备列表,逗号分隔(none=不卸载)","g":"model"},
{"f":"-ncmoe","t":"int","d":"","s":"keep the Mixture of Experts (MoE) weights of the first N layers in the CPU","z":"MoE 前 N 层专家权重保留在 CPU","g":"model"},
{"f":"-ngl","t":"str","d":"auto","s":"max. number of layers to store in VRAM, either an exact number, 'auto', or 'all'","z":"上 GPU 的最大层数;精确数字、'auto' 或 'all'(默认 auto=全量)","g":"model"},
{"f":"-sm","t":"enum","d":"none,layer,row,tensor","s":"how to split the model across multiple GPUs (default: layer)","z":"多 GPU 间切分模型的方式(默认 layer)","g":"model"},
{"f":"-mg","t":"int","d":"0","s":"the GPU to use for the model (with split-mode = none), or for intermediate results","z":"split-mode=none 时模型所用 GPU,或中间结果所用 GPU","g":"model"},
{"f":"--fit","t":"enum","d":"on,off","s":"whether to adjust unset arguments to fit in device memory (default: 'on')","z":"是否自动调整未设参数以塞进显存(默认 on)","g":"model"},
{"f":"-m","t":"str","d":"","s":"model path to load","z":"要加载的模型文件路径(插件托管,勿手填)","g":"model"},
{"f":"-hf","t":"str","d":"","s":"Hugging Face model repository; quant is optional, case-insensitive, default to Q4_K_M","z":"Hugging Face 模型仓库,量化可选(大小写不敏感,默认 Q4_K_M)","g":"model"},
{"f":"-v","t":"bool","d":"","s":"Set verbosity level to infinity (i.e. log all messages, useful for debugging)","z":"日志级别设为无穷(输出全部消息,调试用)","g":"misc"},
{"f":"--offline","t":"bool","d":"","s":"Offline mode: forces use of cache, prevents network access","z":"离线模式:强制走缓存,禁止联网","g":"misc"},
{"f":"-lv","t":"int","d":"3","s":"Set the verbosity threshold. Messages with a higher verbosity will be ignored.","z":"日志详细度阈值,高于该级别的消息被忽略(默认 3)","g":"misc"},
{"f":"--spec-draft-type-k","t":"enum","d":"f32,f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1","s":"KV cache data type for K for the draft model (default: f16)","z":"草稿模型 K 缓存数据类型(默认 f16)","g":"spec"},
{"f":"-s","t":"int","d":"-1","s":"RNG seed (default: -1, use random seed for -1)","z":"随机种子;-1=随机(默认)","g":"sampling"},
{"f":"--temp","t":"float","d":"0.80","s":"temperature","z":"采样温度(默认 0.80)","g":"sampling"},
{"f":"--top-k","t":"int","d":"40","s":"top-k sampling (default: 40, 0 = disabled)","z":"top-k 采样;0=禁用(默认 40)","g":"sampling"},
{"f":"--top-p","t":"float","d":"0.95","s":"top-p sampling (default: 0.95, 1.0 = disabled)","z":"top-p 采样;1.0=禁用(默认 0.95)","g":"sampling"},
{"f":"--min-p","t":"float","d":"0.05","s":"min-p sampling (default: 0.05, 0.0 = disabled)","z":"min-p 采样;0.0=禁用(默认 0.05)","g":"sampling"},
{"f":"--repeat-penalty","t":"float","d":"1.00","s":"penalize repeat sequence of tokens (default: 1.00, 1.0 = disabled)","z":"重复序列惩罚;1.0=禁用(默认 1.00)","g":"sampling"},
{"f":"-j","t":"str","d":"","s":"JSON schema to constrain generations (https://json-schema.org/), e.g. {}","z":"用 JSON Schema 约束生成结果,如 {}","g":"sampling"},
{"f":"--spec-draft-hf","t":"str","d":"","s":"Same as --hf-repo, but for the draft model (default: unused)","z":"草稿模型的 HF 仓库(同 --hf,默认不用)","g":"spec"},
{"f":"--spec-draft-n-max","t":"int","d":"3","s":"number of tokens to draft for speculative decoding","z":"投机解码每次起草的 token 数(默认 3)","g":"spec"},
{"f":"--spec-draft-n-min","t":"int","d":"0","s":"minimum number of draft tokens to use for speculative decoding","z":"投机解码最少起草 token 数(默认 0)","g":"spec"},
{"f":"--spec-draft-ngl","t":"str","d":"auto","s":"max. number of draft model layers to store in VRAM, either an exact number, 'auto'","z":"草稿模型上 GPU 的最大层数(默认 auto)","g":"spec"},
{"f":"--spec-draft-model","t":"str","d":"","s":"draft model for speculative decoding (default: unused)","z":"投机解码的草稿模型路径(默认不用)","g":"spec"},
{"f":"--spec-type","t":"enum","d":"none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache","s":"comma-separated list of types of speculative decoding to use (default: none)","z":"启用的投机解码类型,逗号分隔(默认 none)","g":"spec"},
{"f":"-ctxcp","t":"int","d":"32","s":"max number of context checkpoints to create per slot","z":"每个 slot 最多创建的上下文检查点数(默认 32)","g":"context"},
{"f":"-cram","t":"int","d":"8192","s":"set the maximum cache size in MiB (default: 8192, -1 - no limit, 0 - disable)","z":"KV 缓存大小上限 MiB;0=禁用,-1=不限(默认 8192)","g":"kv"},
{"f":"-kvu","t":"bool","d":"","s":"use single unified KV buffer shared across all sequences (default: enabled if auto)","z":"所有序列共用单个统一 KV 缓冲(默认 auto 时开启)","g":"kv"},
{"f":"-np","t":"int","d":"-1","s":"number of server slots (default: -1, -1 = auto)","z":"server 的 slot 数(并行会话数);-1=自动(默认)","g":"context"},
{"f":"-cb","t":"bool","d":"","s":"whether to enable continuous batching (a.k.a dynamic batching)","z":"启用连续批处理(动态批处理)","g":"context"},
{"f":"-mm","t":"str","d":"","s":"path to a multimodal projector file. see tools/mtmd/README.md","z":"多模态投影器文件路径(视觉模型)","g":"model"},
{"f":"--mmproj-auto","t":"bool","d":"","s":"whether to use multimodal projector file (if available), useful when using -hf","z":"自动使用可用的 mmproj 文件(配 -hf 时有用)","g":"model"},
{"f":"--image-min-tokens","t":"int","d":"read from model","s":"minimum number of tokens each image can take, only used by vision models with dynamic","z":"每张图最少占用的 token 数(视觉模型)","g":"model"},
{"f":"--image-max-tokens","t":"int","d":"read from model","s":"maximum number of tokens each image can take, only used by vision models with dynamic","z":"每张图最多占用的 token 数(视觉模型)","g":"model"},
{"f":"-a","t":"str","d":"","s":"set model name aliases, comma-separated (to be used by API)","z":"模型名别名,逗号分隔(API 调用时使用)","g":"server"},
{"f":"--host","t":"str","d":"127.0.0.1","s":"ip address to listen, or bind to an UNIX socket if the address ends with .sock","z":"监听地址;以 .sock 结尾则绑定 UNIX socket(默认 127.0.0.1)","g":"server"},
{"f":"--port","t":"int","d":"8080","s":"port to listen","z":"监听端口(默认 8080;插件托管,勿手填)","g":"server"},
{"f":"--ui","t":"bool","d":"","s":"whether to enable the Web UI (default: enabled)","z":"是否开启 Web UI(默认开)","g":"server"},
{"f":"--api-key","t":"str","d":"","s":"API key to use for authentication, multiple keys can be provided as a comma-separated","z":"API 鉴权密钥,多个用逗号分隔","g":"server"},
{"f":"-to","t":"int","d":"3600","s":"server read/write timeout in seconds (default: 3600)","z":"server 读写超时秒数(默认 3600)","g":"server"},
{"f":"--threads-http","t":"int","d":"-1","s":"number of threads used to process HTTP requests","z":"处理 HTTP 请求的线程数(默认 -1=自动)","g":"perf"},
{"f":"--cache-prompt","t":"bool","d":"","s":"whether to enable prompt caching (default: enabled)","z":"启用提示词缓存(默认开)","g":"kv"},
{"f":"--cache-reuse","t":"int","d":"0","s":"min chunk size to attempt reusing from the cache via KV shifting (default: 0)","z":"经 KV shifting 尝试复用的最小缓存块大小(默认 0)","g":"kv"},
{"f":"--metrics","t":"bool","d":"","s":"enable prometheus compatible metrics endpoint","z":"开启 Prometheus 兼容的指标端点","g":"server"},
{"f":"--slots","t":"bool","d":"","s":"expose slots monitoring endpoint (default: enabled)","z":"暴露 slot 监控端点(默认开)","g":"server"},
{"f":"--jinja","t":"bool","d":"","s":"whether to use jinja template engine for chat (default: enabled)","z":"用 jinja 模板引擎处理 chat(默认开)","g":"misc"},
{"f":"--reasoning-format","t":"enum","d":"none,deepseek,deepseek-legacy,auto","s":"controls whether thought tags are allowed and/or extracted from the response, and in","z":"思考标签是否允许/提取及格式","g":"misc"},
{"f":"--reasoning-budget","t":"int","d":"-1","s":"token budget for thinking: -1 for unrestricted, 0 for immediate end, N>0 for budget","z":"思考 token 预算:-1 不限,0 立即结束,N>0 为预算(默认 -1)","g":"misc"},
{"f":"--reasoning-preserve","t":"bool","d":"","s":"preserve reasoning trace in the full history, not just the last assistant message","z":"在完整历史中保留推理轨迹,而非仅最后一条助手消息","g":"misc"},
{"f":"--chat-template-file","t":"str","d":"","s":"set custom jinja chat template file (default: template taken from model's metadata)","z":"自定义 jinja chat 模板文件(默认取模型元数据)","g":"misc"},
{"f":"-sps","t":"float","d":"0.10","s":"how much the prompt of a request must match the prompt of a slot in order to use that slot","z":"请求提示词需与 slot 提示词匹配多高才能复用该 slot(默认 0.10)","g":"context"},
{"f":"--spec-default","t":"bool","d":"","s":"enable default speculative decoding config","z":"启用默认投机解码配置","g":"spec"}
];
const CAT_SGLANG=[
{"f":"--model-path","t":"str","d":"required","s":"The path of the model weights. This can be a local folder or a Hugging Face repo ID.","z":"模型权重路径;本地目录或 HF 仓库 ID(插件托管,勿手填)","g":"model"},
{"f":"--tokenizer-path","t":"str","d":"null","s":"The path of the tokenizer.","z":"tokenizer 路径","g":"model"},
{"f":"--load-format","t":"enum","d":"[\"auto\",\"pt\",\"safetensors\",\"npcache\",\"dummy\",\"sharded_state\",\"presharded\",\"gguf\",\"bitsandbytes\",\"mistral\",\"layered\",\"flash_rl\",\"remote\",\"remote_instance\",\"fastsafetensors\",\"private\",\"runai_streamer\"]","s":"The format of the model weights to load. \"auto\" will try to load the weights in the safetensors format.","z":"权重加载格式;'auto' 优先试 safetensors(默认)","g":"model"},
{"f":"--trust-remote-code","t":"bool","d":"false","s":"Whether or not to allow for custom models defined on the Hub in their own modeling files.","z":"允许 Hub 上模型自带的自定义 modeling 代码","g":"model"},
{"f":"--context-length","t":"int","d":"null(=model max)","s":"The model's maximum context length. Defaults to None (will use the value from the model's config).","z":"模型最大上下文长度;null=用模型配置值(默认)","g":"memory"},
{"f":"--enable-multimodal","t":"bool","d":"null(=auto)","s":"Enable the multimodal functionality for the served model.","z":"启用多模态能力","g":"parser"},
{"f":"--revision","t":"str","d":"null","s":"The specific model version to use. It can be a branch name, a tag name, or a commit id.","z":"指定模型版本:分支/标签/commit","g":"model"},
{"f":"--dtype","t":"enum","d":"[\"auto\",\"half\",\"float16\",\"bfloat16\",\"float\",\"float32\"]","s":"Data type for model weights and activations. \"auto\" will use FP16 precision for FP32 and FP16 models.","z":"权重与激活精度;'auto' 对 FP32/FP16 模型用 FP16","g":"model"},
{"f":"--quantization","t":"enum","d":"[\"awq\",\"fp8\",\"mxfp8\",\"gptq\",\"marlin\",\"gptq_marlin\",\"awq_marlin\",\"bitsandbytes\",\"gguf\",\"modelopt\",\"modelopt_fp8\",\"modelopt_fp4\",\"nvfp4_online\",\"auto\",\"compressed-tensors\",\"unquant\"]","s":"The quantization method.","z":"量化方法","g":"model"},
{"f":"--kv-cache-dtype","t":"enum","d":"[\"auto\",\"fp8_e5m2\",\"fp8_e4m3\",\"mxfp8\",\"bf16\",\"bfloat16\",\"nvfp4\",\"fp4_mx_block16\",\"fp4_e2m1\"]","s":"Data type for kv cache storage. \"auto\" will use model data type.","z":"KV 缓存存储类型;'auto'=跟随模型精度","g":"memory"},
{"f":"--mem-fraction-static","t":"float","d":"null","s":"The fraction of the memory used for static allocation (model weights and KV cache memory pool).","z":"静态分配显存占比(权重+KV 池);null=自动(48G≈0.92,96G≈0.75)","g":"memory"},
{"f":"--max-running-requests","t":"int","d":"null","s":"The maximum number of running requests.","z":"最大并发请求数","g":"perf"},
{"f":"--max-queued-requests","t":"int","d":"null","s":"The maximum number of queued requests. Ignored when using disaggregation-mode.","z":"最大排队请求数","g":"memory"},
{"f":"--max-total-tokens","t":"int","d":"null","s":"The maximum number of tokens in the memory pool. If not specified, it will be automatically determined.","z":"内存池中 token 上限;不设=自动决定","g":"memory"},
{"f":"--chunked-prefill-size","t":"int","d":"null","s":"The maximum number of tokens in a chunk for the chunked prefill. -1 means no chunked prefill.","z":"分块预填充每块最大 token 数;-1=不分块","g":"memory"},
{"f":"--max-prefill-tokens","t":"int","d":"16384","s":"The maximum number of tokens in a prefill batch. The real bound will be the maximum of this value.","z":"预填充批最大 token 数(默认 16384)","g":"memory"},
{"f":"--schedule-policy","t":"enum","d":"[\"lpm\",\"random\",\"fcfs\",\"dfs-weight\",\"lof\",\"priority\",\"routing-key\"]","s":"The scheduling policy of the requests.","z":"请求调度策略","g":"perf"},
{"f":"--radix-eviction-policy","t":"enum","d":"[\"lru\",\"lfu\",\"slru\",\"priority\"]","s":"The eviction policy of radix trees. 'lru' = Least Recently Used, 'lfu' = Least Frequently Used.","z":"radix 树驱逐策略;lfu=最少使用","g":"cache"},
{"f":"--disable-radix-cache","t":"bool","d":"false","s":"Disable RadixAttention for prefix caching.","z":"关闭 RadixAttention 前缀缓存","g":"cache"},
{"f":"--disable-overlap-schedule","t":"bool","d":"false","s":"Disable the overlap scheduler, which overlaps the CPU scheduler with GPU model worker.","z":"关闭 CPU 调度与 GPU 执行的重叠","g":"perf"},
{"f":"--num-continuous-decode-steps","t":"int","d":"1","s":"Run multiple continuous decoding steps to reduce scheduling overhead.","z":"连续解码步数,减少调度开销(默认 1)","g":"perf"},
{"f":"--enable-mixed-chunk","t":"bool","d":"false","s":"Enabling mixing prefill and decode in a batch when using chunked prefill.","z":"分块预填充时允许 prefill/decode 混批","g":"perf"},
{"f":"--nnodes","t":"int","d":"1","s":"The number of nodes.","z":"节点数(默认 1)","g":"parallelism"},
{"f":"--node-rank","t":"int","d":"0","s":"The node rank.","z":"本节点序号(默认 0)","g":"parallelism"},
{"f":"--tp-size","t":"int","d":"1","s":"The tensor parallelism size. (旧版别名 --tp / --tensor-parallel-size)","z":"张量并行度(旧别名 --tp/--tensor-parallel-size,默认 1)","g":"parallelism"},
{"f":"--pp-size","t":"int","d":"1","s":"The pipeline parallelism size.","z":"流水线并行度(默认 1)","g":"parallelism"},
{"f":"--dp-size","t":"int","d":"1","s":"The data parallelism size.","z":"数据并行度(默认 1)","g":"parallelism"},
{"f":"--enable-dp-attention","t":"bool","d":"false","s":"Enabling data parallelism for attention and tensor parallelism for FFN.","z":"attention 用数据并行、FFN 用张量并行","g":"parallelism"},
{"f":"--device","t":"str","d":"null","s":"The device to use ('cuda', 'xpu', 'hpu', 'npu', 'cpu', 'musa'). Defaults to auto-detection.","z":"设备(cuda/xpu/hpu/npu/cpu/musa),默认自动检测","g":"misc"},
{"f":"--base-gpu-id","t":"int","d":"0","s":"The base GPU ID to start allocating GPUs from. Useful when running multiple instances on the same node.","z":"GPU 分配起始 ID;同机多实例时有用(默认 0)","g":"misc"},
{"f":"--watchdog-timeout","t":"float","d":"300","s":"Set watchdog timeout in seconds. If a forward batch takes longer than this, the server will be restarted.","z":"看门狗超时秒数,前向批超时会重启(默认 300)","g":"misc"},
{"f":"--host","t":"str","d":"127.0.0.1","s":"The host of the HTTP server.","z":"HTTP 服务地址(默认 127.0.0.1)","g":"server"},
{"f":"--port","t":"int","d":"30000","s":"The port of the HTTP server.","z":"HTTP 服务端口(默认 30000;插件托管,勿手填)","g":"server"},
{"f":"--api-key","t":"str","d":"null","s":"Set API key of the server. It is also used in the OpenAI API compatible server.","z":"API 密钥,OpenAI 兼容端点同样生效","g":"server"},
{"f":"--served-model-name","t":"str","d":"null","s":"Override the model name returned by the v1/models endpoint in OpenAI API server.","z":"覆盖 /v1/models 返回的模型名","g":"server"},
{"f":"--chat-template","t":"str","d":"null","s":"The builtin chat template name or the path of the chat template file.","z":"内置 chat 模板名或模板文件路径","g":"parser"},
{"f":"--completion-template","t":"str","d":"null","s":"The builtin completion template name or the path of the completion template file.","z":"内置 completion 模板名或模板文件路径","g":"parser"},
{"f":"--enable-cache-report","t":"bool","d":"false","s":"Return number of cached tokens in usage.prompt_tokens_details for each openai request.","z":"在 usage.prompt_tokens_details 回报缓存命中 token 数(DSH 缓存命中率显示依赖此开关!)","g":"cache"},
{"f":"--default-chat-template-kwargs","t":"str","d":"null","s":"Default chat template kwargs applied to every request when not overridden per-request.","z":"默认 chat 模板参数,可被请求级覆盖","g":"parser"},
{"f":"--log-level","t":"str","d":"info","s":"The logging level of all loggers. (CRITICAL / ERROR / WARNING / INFO / DEBUG)","z":"日志级别(CRITICAL/ERROR/WARNING/INFO/DEBUG,默认 info)","g":"server"},
{"f":"--enable-metrics","t":"bool","d":"false","s":"Enable log prometheus metrics.","z":"输出 Prometheus 指标","g":"server"},
{"f":"--grammar-backend","t":"enum","d":"[\"xgrammar\",\"outlines\",\"llguidance\",\"none\"]","s":"Choose the backend for grammar-guided decoding.","z":"语法引导解码后端","g":"parser"},
{"f":"--mamba-backend","t":"enum","d":"[\"triton\",\"flashinfer\"]","s":"Choose the kernel backend for Mamba SSM operations. Default is 'triton'.","z":"Mamba SSM 内核后端(默认 triton)","g":"mamba"},
{"f":"--cuda-graph-max-bs-decode","t":"int","d":"null","s":"Maximum batch size captured for the decode cuda graph.","z":"decode CUDA 图捕获的最大批大小","g":"perf"},
{"f":"--cuda-graph-max-bs-prefill","t":"int","d":"null","s":"Maximum batch size captured for the prefill cuda graph.","z":"prefill CUDA 图捕获的最大批大小","g":"perf"},
{"f":"--speculative-algorithm","t":"str","d":"null","s":"Speculative algorithm. Builtins: EAGLE, EAGLE3, NEXTN, STANDALONE, NGRAM, DFLASH, DSPARK.","z":"投机解码算法: EAGLE/EAGLE3/NEXTN/STANDALONE/NGRAM/DFLASH/DSPARK","g":"speculative"},
{"f":"--speculative-draft-model-path","t":"str","d":"null","s":"The path of the draft model weights. This can be a local folder or a Hugging Face repo ID.","z":"草稿模型权重路径;本地目录或 HF 仓库","g":"speculative"},
{"f":"--speculative-num-steps","t":"int","d":"null","s":"The number of steps sampled from draft model in Speculative Decoding.","z":"投机解码中草稿模型采样步数","g":"speculative"},
{"f":"--speculative-eagle-topk","t":"int","d":"null","s":"The number of tokens sampled from the draft model in eagle2 each step.","z":"eagle2 每步从草稿模型采样的 token 数","g":"speculative"},
{"f":"--speculative-num-draft-tokens","t":"int","d":"null","s":"The number of tokens sampled from the draft model in Speculative Decoding.","z":"投机解码起草 token 数;DFLASH 时须等于草稿 block_size","g":"speculative"},
{"f":"--speculative-attention-mode","t":"enum","d":"[\"prefill\",\"decode\"]","s":"Attention backend for speculative decoding operations (both target verify and draft extend).","z":"投机解码注意力后端(target verify 与 draft extend 共用)","g":"speculative"},
{"f":"--ep-size","t":"int","d":"1","s":"The expert parallelism size.","z":"专家并行度(默认 1)","g":"parallelism"},
{"f":"--max-mamba-cache-size","t":"int","d":"null","s":"The maximum size of the mamba cache.","z":"mamba 缓存最大容量","g":"mamba"},
{"f":"--mamba-ssm-dtype","t":"enum","d":"[\"float32\",\"bfloat16\",\"float16\"]","s":"The data type of the SSM states in mamba cache. If not set, will be read from model config.","z":"mamba 缓存中 SSM 状态精度;不设=读模型配置","g":"mamba"},
{"f":"--mamba-max-states-per-path","t":"int","d":"-1","s":"Maximum number of cached Mamba states retained per root-to-tail path (-1 means unlimited).","z":"每条根到尾路径最多保留的 Mamba 状态数;-1 不限(默认)","g":"mamba"},
{"f":"--mamba-full-memory-ratio","t":"float","d":"0.9","s":"The ratio of mamba state memory to full kv cache memory.","z":"mamba 状态显存占 KV 总显存的比例(默认 0.9)","g":"mamba"},
{"f":"--mamba-radix-cache-strategy","t":"enum","d":"[\"auto\",\"no_buffer\",\"extra_buffer\",\"extra_buffer_lazy\"]","s":"The strategy to use for mamba radix cache.","z":"mamba radix 缓存策略","g":"mamba"},
{"f":"--mamba-track-interval","t":"int","d":"256","s":"The interval to track the mamba state during decode.","z":"解码时追踪 mamba 状态的间隔(默认 256)","g":"mamba"},
{"f":"--linear-attn-backend","t":"enum","d":"[\"triton\",\"cutedsl\",\"flashinfer\",\"flashkda\",\"nvidia_kda\",\"ptx_kda\",\"helion\"]","s":"The default kernel backend for linear attention (GDN/KDA).","z":"线性注意力(GDN/KDA)默认内核后端","g":"mamba"},
{"f":"--enable-hierarchical-cache","t":"bool","d":"false","s":"Enable hierarchical cache","z":"启用分层(主机内存)缓存","g":"cache"},
{"f":"--hicache-ratio","t":"float","d":"null","s":"The ratio of the size of host KV cache memory pool to the size of device pool.","z":"主机 KV 池与设备池的大小比","g":"cache"},
{"f":"--hicache-write-policy","t":"enum","d":"[\"write_back\",\"write_through\",\"write_through_selective\"]","s":"The write policy of hierarchical cache.","z":"分层缓存写入策略","g":"cache"},
{"f":"--hicache-io-backend","t":"enum","d":"[\"direct\",\"kernel\",\"kernel_ascend\"]","s":"The IO backend for KV cache transfer between CPU and GPU.","z":"CPU↔GPU KV 传输 IO 后端","g":"cache"},
{"f":"--enable-lora","t":"bool","d":"null(=auto)","s":"Enable LoRA support for the model. Automatically True if lora paths are given.","z":"启用 LoRA;给了 LoRA 路径时自动开","g":"misc"},
{"f":"--disaggregation-mode","t":"enum","d":"[\"null\",\"prefill\",\"decode\"]","s":"Only used for PD disaggregation. \"null\" = normal mode.","z":"PD 分离模式;'null'=常规","g":"misc"},
{"f":"--download-dir","t":"str","d":"null","s":"Model download directory for huggingface.","z":"HF 模型下载目录","g":"misc"},
{"f":"--reasoning-parser","t":"enum","d":"[\"auto\",\"deepseek-r1\",\"deepseek-v3\",\"deepseek-v4\",\"glm45\",\"kimi\",\"muse\",\"qwen3\",\"qwen3-thinking\",\"mistral\",\"gemma4\",\"inkling\"]","s":"Specify the parser for reasoning models. Use 'auto' to detect from chat template.","z":"推理模型解析器;'auto' 从 chat 模板自动检测","g":"parser"},
{"f":"--tool-call-parser","t":"enum","d":"[\"auto\",\"deepseekv3\",\"deepseekv4\",\"glm45\",\"kimi_k2\",\"kimi_k3\",\"qwen\",\"qwen25\",\"qwen3_coder\",\"muse\",\"minimax-m3\",\"inkling\",\"hermes\"]","s":"Specify the parser for handling tool-call interactions. Use 'auto' to detect from chat template.","z":"工具调用解析器;'auto' 从 chat 模板自动检测","g":"parser"},
{"f":"--disable-cuda-graph","t":"bool","d":"false","s":"Deprecated. Use --cuda-graph-backend-{decode,prefill}=disabled instead.","z":"已弃用,改用 --cuda-graph-backend-{decode,prefill}=disabled","g":"perf"}
];
const CATS={"llama.cpp":CAT_LLAMA,"SGLang":CAT_SGLANG};
/* 长/短别名归一(llama.cpp help 用短形) */
const ALIAS={"--model":"-m","--mmproj":"-mm","--cache-type-k":"-ctk","--cache-type-v":"-ctv","--flash-attn":"-fa","-md":"--spec-draft-model"};
/* 中文说明(官方 help 原文译注,悬停 title 仍保留英文) */
const ZH={
"-t":"生成时使用的 CPU 线程数(默认 -1,自动)",
"-tb":"批处理与提示词处理的线程数(默认同 -t)",
"-c":"提示词上下文大小;0=从模型元数据读取(= -np 个 slot 共享此总预算)",
"-n":"预测 token 数;-1=不限(默认)",
"-b":"逻辑最大批大小",
"--swa-full":"使用全尺寸 SWA(滑动窗口注意力)缓存(默认关)",
"-fa":"Flash Attention 开关('on'/'off'/'auto',默认 auto)",
"--rope-scaling":"RoPE 频率缩放方式,模型未指定时默认 linear",
"-kvo":"是否开启 KV 缓存卸载到 CPU(默认开)",
"-ctk":"K 缓存数据类型(默认 f16)",
"-ctv":"V 缓存数据类型(默认 f16)",
"-lm":"模型加载方式(默认 auto)",
"--device":"参与卸载的设备列表,逗号分隔(none=不卸载)",
"-ncmoe":"MoE 前 N 层专家权重保留在 CPU",
"-ngl":"上 GPU 的最大层数;精确数字、'auto' 或 'all'(默认 auto=全量)",
"-sm":"多 GPU 间切分模型的方式(默认 layer)",
"-mg":"split-mode=none 时模型所用 GPU,或中间结果所用 GPU",
"--fit":"是否自动调整未设参数以塞进显存(默认 on)",
"-m":"要加载的模型文件路径(插件托管,勿手填)",
"-hf":"Hugging Face 模型仓库,量化可选(大小写不敏感,默认 Q4_K_M)",
"-v":"日志级别设为无穷(输出全部消息,调试用)",
"--offline":"离线模式:强制走缓存,禁止联网",
"-lv":"日志详细度阈值,高于该级别的消息被忽略(默认 3)",
"--spec-draft-type-k":"草稿模型 K 缓存数据类型(默认 f16)",
"-s":"随机种子;-1=随机(默认)",
"--temp":"采样温度(默认 0.80)",
"--top-k":"top-k 采样;0=禁用(默认 40)",
"--top-p":"top-p 采样;1.0=禁用(默认 0.95)",
"--min-p":"min-p 采样;0.0=禁用(默认 0.05)",
"--repeat-penalty":"重复序列惩罚;1.0=禁用(默认 1.00)",
"-j":"用 JSON Schema 约束生成结果,如 {}",
"--spec-draft-hf":"草稿模型的 HF 仓库(同 --hf,默认不用)",
"--spec-draft-n-max":"投机解码每次起草的 token 数(默认 3)",
"--spec-draft-n-min":"投机解码最少起草 token 数(默认 0)",
"--spec-draft-ngl":"草稿模型上 GPU 的最大层数(默认 auto)",
"--spec-draft-model":"投机解码的草稿模型路径(默认不用)",
"--spec-type":"启用的投机解码类型,逗号分隔(默认 none)",
"-ctxcp":"每个 slot 最多创建的上下文检查点数(默认 32)",
"-cram":"KV 缓存大小上限 MiB;0=禁用,-1=不限(默认 8192)",
"-kvu":"所有序列共用单个统一 KV 缓冲(默认 auto 时开启)",
"-np":"server 的 slot 数(并行会话数);-1=自动(默认)",
"-cb":"启用连续批处理(动态批处理)",
"-mm":"多模态投影器文件路径(视觉模型)",
"--mmproj-auto":"自动使用可用的 mmproj 文件(配 -hf 时有用)",
"--image-min-tokens":"每张图最少占用的 token 数(视觉模型)",
"--image-max-tokens":"每张图最多占用的 token 数(视觉模型)",
"-a":"模型名别名,逗号分隔(API 调用时使用)",
"--host":"监听地址;以 .sock 结尾则绑定 UNIX socket(默认 127.0.0.1)",
"--port":"监听端口(默认 8080;插件托管,勿手填)",
"--ui":"是否开启 Web UI(默认开)",
"--api-key":"API 鉴权密钥,多个用逗号分隔",
"-to":"server 读写超时秒数(默认 3600)",
"--threads-http":"处理 HTTP 请求的线程数(默认 -1=自动)",
"--cache-prompt":"启用提示词缓存(默认开)",
"--cache-reuse":"经 KV shifting 尝试复用的最小缓存块大小(默认 0)",
"--metrics":"开启 Prometheus 兼容的指标端点",
"--slots":"暴露 slot 监控端点(默认开)",
"--jinja":"用 jinja 模板引擎处理 chat(默认开)",
"--reasoning-format":"思考标签是否允许/提取及格式",
"--reasoning-budget":"思考 token 预算:-1 不限,0 立即结束,N>0 为预算(默认 -1)",
"--reasoning-preserve":"在完整历史中保留推理轨迹,而非仅最后一条助手消息",
"--chat-template-file":"自定义 jinja chat 模板文件(默认取模型元数据)",
"-sps":"请求提示词需与 slot 提示词匹配多高才能复用该 slot(默认 0.10)",
"--spec-default":"启用默认投机解码配置",
"--model-path":"模型权重路径;本地目录或 HF 仓库 ID(插件托管,勿手填)",
"--tokenizer-path":"tokenizer 路径",
"--load-format":"权重加载格式;'auto' 优先试 safetensors(默认)",
"--trust-remote-code":"允许 Hub 上模型自带的自定义 modeling 代码",
"--context-length":"模型最大上下文长度;null=用模型配置值(默认)",
"--enable-multimodal":"启用多模态能力",
"--revision":"指定模型版本:分支/标签/commit",
"--dtype":"权重与激活精度;'auto' 对 FP32/FP16 模型用 FP16",
"--quantization":"量化方法",
"--kv-cache-dtype":"KV 缓存存储类型;'auto'=跟随模型精度",
"--mem-fraction-static":"静态分配显存占比(权重+KV 池);null=自动(48G≈0.92,96G≈0.75)",
"--max-running-requests":"最大并发请求数",
"--max-queued-requests":"最大排队请求数",
"--max-total-tokens":"内存池中 token 上限;不设=自动决定",
"--chunked-prefill-size":"分块预填充每块最大 token 数;-1=不分块",
"--max-prefill-tokens":"预填充批最大 token 数(默认 16384)",
"--schedule-policy":"请求调度策略",
"--radix-eviction-policy":"radix 树驱逐策略;lfu=最少使用",
"--disable-radix-cache":"关闭 RadixAttention 前缀缓存",
"--disable-overlap-schedule":"关闭 CPU 调度与 GPU 执行的重叠",
"--num-continuous-decode-steps":"连续解码步数,减少调度开销(默认 1)",
"--enable-mixed-chunk":"分块预填充时允许 prefill/decode 混批",
"--nnodes":"节点数(默认 1)",
"--node-rank":"本节点序号(默认 0)",
"--tp-size":"张量并行度(旧别名 --tp/--tensor-parallel-size,默认 1)",
"--pp-size":"流水线并行度(默认 1)",
"--dp-size":"数据并行度(默认 1)",
"--enable-dp-attention":"attention 用数据并行、FFN 用张量并行",
"--base-gpu-id":"GPU 分配起始 ID;同机多实例时有用(默认 0)",
"--watchdog-timeout":"看门狗超时秒数,前向批超时会重启(默认 300)",
"--served-model-name":"覆盖 /v1/models 返回的模型名",
"--chat-template":"内置 chat 模板名或模板文件路径",
"--completion-template":"内置 completion 模板名或模板文件路径",
"--enable-cache-report":"在 usage.prompt_tokens_details 回报缓存命中 token 数(DSH 缓存命中率显示依赖此开关!)",
"--default-chat-template-kwargs":"默认 chat 模板参数,可被请求级覆盖",
"--log-level":"日志级别(CRITICAL/ERROR/WARNING/INFO/DEBUG,默认 info)",
"--enable-metrics":"输出 Prometheus 指标",
"--grammar-backend":"语法引导解码后端",
"--mamba-backend":"Mamba SSM 内核后端(默认 triton)",
"--cuda-graph-max-bs-decode":"decode CUDA 图捕获的最大批大小",
"--cuda-graph-max-bs-prefill":"prefill CUDA 图捕获的最大批大小",
"--speculative-algorithm":"投机解码算法: EAGLE/EAGLE3/NEXTN/STANDALONE/NGRAM/DFLASH/DSPARK",
"--speculative-draft-model-path":"草稿模型权重路径;本地目录或 HF 仓库",
"--speculative-num-steps":"投机解码中草稿模型采样步数",
"--speculative-eagle-topk":"eagle2 每步从草稿模型采样的 token 数",
"--speculative-num-draft-tokens":"投机解码起草 token 数;DFLASH 时须等于草稿 block_size",
"--speculative-attention-mode":"投机解码注意力后端(target verify 与 draft extend 共用)",
"--ep-size":"专家并行度(默认 1)",
"--max-mamba-cache-size":"mamba 缓存最大容量",
"--mamba-ssm-dtype":"mamba 缓存中 SSM 状态精度;不设=读模型配置",
"--mamba-max-states-per-path":"每条根到尾路径最多保留的 Mamba 状态数;-1 不限(默认)",
"--mamba-full-memory-ratio":"mamba 状态显存占 KV 总显存的比例(默认 0.9)",
"--mamba-radix-cache-strategy":"mamba radix 缓存策略",
"--mamba-track-interval":"解码时追踪 mamba 状态的间隔(默认 256)",
"--linear-attn-backend":"线性注意力(GDN/KDA)默认内核后端",
"--enable-hierarchical-cache":"启用分层(主机内存)缓存",
"--hicache-ratio":"主机 KV 池与设备池的大小比",
"--hicache-write-policy":"分层缓存写入策略",
"--hicache-io-backend":"CPU↔GPU KV 传输 IO 后端",
"--enable-lora":"启用 LoRA;给了 LoRA 路径时自动开",
"--disaggregation-mode":"PD 分离模式;'null'=常规",
"--download-dir":"HF 模型下载目录",
"--reasoning-parser":"推理模型解析器;'auto' 从 chat 模板自动检测",
"--tool-call-parser":"工具调用解析器;'auto' 从 chat 模板自动检测",
"--disable-cuda-graph":"已弃用,改用 --cuda-graph-backend-{decode,prefill}=disabled"
};
/* 跨框架同名参数按框架覆盖(避免全局字典串义) */
const ZH_OVERRIDES={"SGLang":{
"--device":"使用设备('cuda'/'xpu'/'hpu'/'npu'/'cpu'/'musa'),默认自动检测",
"--host":"HTTP 服务监听地址(默认 127.0.0.1)",
"--port":"HTTP 服务端口(默认 30000;插件托管,勿手填)",
"--api-key":"服务端 API 密钥,OpenAI 兼容端点同样生效"
}};
function zhFor(fw,f){const o=ZH_OVERRIDES[fw];return (o&&o[f])||ZH[f]||null;}
const GROUP_ZH={model:"模型",server:"服务",context:"上下文",sampling:"采样",spec:"投机解码",speculative:"投机解码",kv:"KV 缓存",perf:"性能",cache:"缓存",parallelism:"并行",mamba:"Mamba",memory:"显存",parser:"解析/模板",misc:"其他"};
function norm(f){return ALIAS[f]||f;}
function catItem(fw,f){const c=CATS[fw];if(!c)return null;return c.find(x=>x.f===norm(f))||null;}
/* v7 §15 排序 A:9 组固定序(模型→上下文→KV→投机→采样→性能→并行→服务→其他)。
   cache/memory/parser/mamba 并入「服务」;组内保持官方目录序;目录外参数进「其他」。
   同模型+同框架不同量化:行集取并集(见 paramsTableHtml),共有参数行位对齐。 */
const G9_ORDER = ["model", "context", "kv", "spec", "sampling", "perf", "parallelism", "server", "misc"];
const G9_ZH = { model: "模型", context: "上下文", kv: "KV 缓存", spec: "投机解码", sampling: "采样", perf: "性能", parallelism: "并行", server: "服务", misc: "其他" };
function g9Of(fw, f) {
  const cat = catItem(fw, f);
  let g = cat ? cat.g : null;
  if (g === "speculative") g = "spec";
  if (g === "cache" || g === "memory" || g === "parser" || g === "mamba") g = "server";
  const i = G9_ORDER.indexOf(g);
  return i === -1 ? "misc" : g;
}
function sortedParams(fw, params) {
  return params.map((p, i) => ({ p, i, gi: G9_ORDER.indexOf(g9Of(fw, p[0])), ci: catItem(fw, p[0]) ? CATS[fw].findIndex((x) => x.f === norm(p[0])) : 1e9 }))
    .sort((a, b) => (a.gi - b.gi) || (a.ci - b.ci) || (a.i - b.i)).map((x) => x.p);
}
function isOn(val){return !(val==="false"||val==="off");}
function recMismatch(cat,cur,rec){if(rec==null)return false;if(cat&&cat.t==="bool")return isOn(cur)!==isOn(rec);return cur!==rec;}

    /* v7 推荐值三级溯源链(用户:「推荐参数要合理,主要参考官方或者最佳社区实践,参考硬件一样的,不要随便想」):
       L1 同量化:该组「激活版本」launchCommand 实跑值 → 来源「同量化」
       L2 同模型:同框架兄弟量化实跑值(显存不同标「同模型·显存差异」,值不自动换算) → 来源「同模型」
       L3 官方:内置最佳实践表 bpFor(仅收录有据条目) → 来源「官方」
       三级皆无 → null(留空不猜)。返回 { rec, src }。 */
    function cardMemGb(gpu) {
      if (isDual(gpu)) { const a = detectedCard(0), b = detectedCard(1); return (a && a.memGb ? a.memGb : 48) + (b && b.memGb ? b.memGb : 48); }
      const c = detectedCard(gpu);
      return c && c.memGb ? c.memGb : ((((builtinGpus()[gpu]) || {}).memGb));
    }
    /* 官方/最佳社区实践表(可溯源,禁止臆造):
       llama.cpp: -fa on(git-master 官方建议长上下文开 FA,本机实跑稳定)
       SGLang: --enable-cache-report(DSH 命中率依赖,官方参数);--kv-cache-dtype fp8_e4m3(FP8 KV 官方支持,48G+ 省显存);
               --mem-fraction-static 单卡独占经验值:≈48G→0.92,≥80G(96G)→0.75(大显存留 KV/激活余量,社区单卡长上下文实践) */
    function bpFor(fwLabel, f, v) {
      if (fwLabel === "llama.cpp") {
        if (f === "-fa") return "on";
        return null;
      }
      if (fwLabel === "SGLang") {
        if (f === "--enable-cache-report") return "";
        if (f === "--kv-cache-dtype") return "fp8_e4m3";
        if (f === "--mem-fraction-static") {
          const gb = v ? cardMemGb(v.gpu) : 0;
          if (gb >= 80) return "0.75";
          if (gb >= 40) return "0.92";
          return null;
        }
        if (f === "--context-length") return v && v.contextWindow ? String(v.contextWindow) : null;
      }
      return null;
    }
    function recChain(g, f, v, siblings) {
      const pick = (ver) => { for (const p of parseLaunchCommand((ver && ver.launchCommand) || "")) if (norm(p[0]) === norm(f)) return p[1]; return null; };
      const vs = (g && g.versions) || [];
      const a = vs.find((x) => x.active) || vs[0];
      if (a) { const r = pick(a); if (r != null) return { rec: r, src: "同量化" }; }
      const sib = (siblings || []).slice().sort((x, y) => (y.active ? 1 : 0) - (x.active ? 1 : 0));
      for (const s of sib) {
        const r = pick(s);
        if (r != null) {
          const sameMem = !v || cardMemGb(s.gpu) === cardMemGb(v.gpu);
          return { rec: r, src: sameMem ? "同模型" : "同模型·显存差异" };
        }
      }
      const b = bpFor(g && g.fwLabel, f, v);
      if (b != null) return { rec: b, src: "官方" };
      return null;
    }
    /* 版本行短标签:profile 名剥掉 base + 量化 + 框架 + 卡后剩余修饰词(如 MTP/副本2);空则不显示 */
    function versionTag(v) {
      let s = String((v && v.name) || "");
      if (v.__base) s = s.split(v.__base).join("");
      if (v.__qname) s = s.split(v.__qname).join("");
      s = s.split("llama.cpp").join("").split("SGLang").join("").split("vLLM").join("");
      s = s.replace(/\b(llama|sglang|vllm)\b/gi, "");
      s = s.replace(/双卡|\(1,0\)|\(0,1\)|[Gg][Pp][Uu]\s?\d|卡\s?\d/g, "");
      return s.replace(/[ ·]+/g, " ").replace(/^[-–—·\s]+|[-–—·\s]+$/g, "").trim();
    }
    /* 服务模型名参数(缺失校验用):各框架下「对外展示的模型名」flag */
    const MODEL_NAME_FLAG = { llama: "-a", sglang: "--served-model-name", vllm: "--served-model-name" };

    /* 已知不可用条目(树徽章 + 详情红字;按完整 profile 名索引)。
       仓库默认空;个人调机记录请写在本机,不要提交。 */
    const KNOWN_DEAD = {};

    /* ---------- 工具 ---------- */
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
    function fmtK(n) { n = Number(n) || 0; if (n >= 1000000) return Math.round(n / 1000000) + "M"; if (n >= 1000) return Math.floor(n / 1000) + "K"; return String(n); }
    /* profile 名约定(版本号已废弃):"<模型> · <框架> · <卡>"——首段=模型,卡段=命名用 */
    function modelOf(name) { const s = String(name || ""); const i = s.indexOf(" · "); return i > 0 ? s.slice(0, i) : s; }
    /* 双卡判定(格式统一):null(旧表达)或逗号串 "1,0"(新表达)均算双卡 */
    function isDual(g) { return g === null || g === undefined || (typeof g === "string" && g.indexOf(",") !== -1); }
    /* 卡占用匹配:双卡互相视为同卡占用(任一双卡在跑即冲突);单卡按编号精确匹配 */
    function cardBusy(s, g) { return isDual(g) ? isDual(s.gpu) : s.gpu === g; }
    /* 卡名:检测短名优先(gpus.json,短名已去 NVIDIA/GeForce/RTX/架构词),未检测回退服务端内置表 */
    function gpuName(g) {
      if (isDual(g)) return "双卡";
      const c = detectedCard(g);
      const bn = ((builtinGpus()[g]) || {}).name;
      return c ? c.shortName : (bn || ("GPU" + g));
    }
    function shortPath(p) { const pre = "/models/"; const i = String(p || "").lastIndexOf(pre); return i >= 0 ? String(p).slice(i + pre.length) : String(p || ""); }
    function gpuLabel(g) {
      if (isDual(g)) return "双卡(1,0)";
      const c = detectedCard(g);
      return c ? c.shortName : (((builtinGpus()[g]) || {}).name || ("GPU " + g));
    }
    function defaultPort(gpu) { return gpu === 0 ? 11436 : 11437; }
    /* 同卡双开端口池:按卡分池(偶端口=卡0/4090,奇端口=卡1/6000,贴合 11436=4090、11437=6000 心智),
       默认端口在前,跳过注册表已占端口;本卡 3 口全占则返回 null */
    function nextFreePort(gpu, servers) {
      const used = new Set((servers || []).map((s) => s.port));
      const pref = gpu === 0 ? [11436, 11440, 11442] : [11437, 11439, 11441];
      for (const p of pref) if (!used.has(p)) return p;
      return null;
    }

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
            if (isDual(s.gpu) || s.gpu !== act.gpu) continue;
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
          const cap = !isDual(p.gpu) ? (detectedCard(p.gpu) ? detectedCard(p.gpu).memGb : (((builtinGpus()[p.gpu]) || {}).memGb)) : undefined;
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
      /* v7 §14.4:服务模型名缺失 → 请求方(含 DSH)传的 model 名将落到框架默认,提示显式设置 */
      const mnf = MODEL_NAME_FLAG[p.framework];
      if (mnf && val(mnf) == null) out.push({ tone: "warn", msg: "缺 " + mnf + "(未设服务模型名,客户端按名请求会落到框架默认值)" });
      return out;
    }

    function doctorFindings(servers, groups) {
      const f = [];
      for (const s of servers) {
        if (PROTECTED_PORTS.indexOf(s.port) !== -1) f.push({ tone: "warn", where: String(s.port), msg: "health " + (s.health || "-") + " · " + (s.model || "") + " · DSH 在用:面板可两次点击确认停止(停止将中断当前会话)" });
        else f.push({ tone: s.status === "running" ? "ok" : "bad", where: String(s.port), msg: s.status === "running" ? "health " + (s.health || "") + " · " + (s.model || "") : "离线" });
      }
      gpuCardList().forEach((c) => {
        const occ = servers.find((s) => s.status === "running" && (isDual(s.gpu) || s.gpu === c.index));
        if (!occ) f.push({ tone: "ok", where: c.shortName, msg: "空闲 · " + defaultPort(c.index) + " 可启动托管版本" });
      });
      const total = groups.reduce((n, cg) => n + cg.fwGroups.reduce((m, sg) => m + sg.versions.length, 0), 0);
      let ok = 0;
      for (const cg of groups) for (const sg of cg.fwGroups) for (const p of sg.versions) {
        const issues = validateLocal(p);
        if (p.modelMissing) issues.unshift({ tone: "bad", msg: "模型文件缺失(盘面上不存在): " + p.modelPath });
        if (issues.length) { for (const it of issues) f.push({ tone: it.tone, where: modelOf(p.name) + " · " + gpuName(p.gpu), msg: it.msg }); }
        else ok++;
      }
      f.push({ tone: ok > 0 ? "ok" : "warn", where: "版本", msg: ok + " / " + total + " 通过校验(上下文约定 / 托管参数 / 缓存回报)" });
      return f;
    }

    /* ---------- 模型优先三层树(模型 → 量化 → 框架/版本;mockup-v5 定稿) ---------- */
    /* 从显示名拆 base 模型名 + 量化标签。量化标记(连字符/空格分隔,取末尾):
       UD-Qx_x / UD-IQx_x GGUF 量化名(Q8_K_XL、IQ4_XS…)、FP8/FP16/BF16/NVFP4/FP4、APEX-MTP、GGUF;
       Uncensored=变体(并入标签);尾部空格修饰词 MTP/DFLASH/dspark 并入量化标签。
       拆不出量化标记时回退 model 字段再拆(如显示名 Qwen3.8-Flash-Next → 字段 …-UD-IQ4_XS)。 */
    function splitQuant(display, fallback) {
      let s = String(display || "").trim();
      if (!s) s = String(fallback || "").trim();
      if (!s) return { base: "未知", q: null };
      // 末尾量化标记:UD-Qx/IQx 系 GGUF 量化名、FP8/FP16/BF16/NVFP4/FP4、APEX-MTP、GGUF
      const QUANT = /[\s_-]((?:UD-)?(?:Q\d+|IQ\d+)(?:[_-][A-Za-z0-9]+)*|BF16|FP16|FP8|NVFP4|FP4|APEX-MTP|GGUF)$/i;
      const mods = [];
      for (;;) {
        const mm = s.match(/\s+((?:MTP|DFLASH|dspark)[\w-]*)$/);
        if (!mm) break;
        mods.unshift(mm[1]);
        s = s.slice(0, mm.index).trim();
      }
      let q = null;
      const mq = s.match(QUANT);
      if (mq) { q = mq[1]; s = s.slice(0, mq.index).trim(); }
      let unc = false;
      const mu = s.match(/[_-]Uncensored$/i);
      if (mu) { unc = true; s = s.slice(0, mu.index).trim(); }
      if (!q) {
        // 显示名无量化标记 → 回退 model 字段取量化标记(base 仍用显示名)
        const fb = String(fallback || "").trim();
        if (fb) {
          const mf = fb.match(QUANT);
          if (mf) q = mf[1];
        }
      }
      if (!s) s = "未知";
      let label = q ? (unc ? q + " (Uncensored)" : q) : (unc ? "Uncensored" : null);
      if (mods.length) label = (label ? label + " " : "") + mods.join(" ");
      return { base: s, q: label || null };
    }
    /* 模型优先树:buildGroups 输出 → 模型节点(base 名,同名模型跨量化目录/卡合并)
       → 量化组(名称含 MTP/DFLASH/Uncensored 变体)→ 版本(profile)。
       副作用:给每个 profile 挂 __base/__qname(对象来自本次 fetch,可安全改写)。 */
    function buildModelTree(groups) {
      const mMap = new Map();
      for (const cg of groups) {
        for (const sg of cg.fwGroups) {
          for (const v of sg.versions) {
            const sq = splitQuant(modelOf(v.name), v.model);
            v.__base = sq.base;
            v.__qname = sq.q || "默认";
            let m = mMap.get(sq.base);
            if (!m) { m = { base: sq.base, paths: [], cards: [], qs: new Map() }; mMap.set(sq.base, m); }
            if (v.modelPath && m.paths.indexOf(v.modelPath) === -1) m.paths.push(v.modelPath);
            const cardKey = isDual(v.gpu) ? "dual" : String(v.gpu);
            if (m.cards.indexOf(cardKey) === -1) m.cards.push(cardKey);
            if (!m.qs.has(v.__qname)) m.qs.set(v.__qname, { name: v.__qname, versions: [] });
            m.qs.get(v.__qname).versions.push(v);
          }
        }
      }
      const gkey = (p) => (p.gpu === 0 ? 0 : p.gpu === 1 ? 1 : 2);
      const list = [...mMap.values()];
      for (const m of list) {
        for (const qq of m.qs.values()) {
          qq.versions.sort((a, b) => (gkey(a) - gkey(b)) || String(a.framework).localeCompare(String(b.framework)) || String(a.name).localeCompare(String(b.name)));
        }
        m.qs = [...m.qs.values()]; // 按首次出现顺序
      }
      list.sort((a, b) => a.base.localeCompare(b.base));
      return list;
    }
    /* 卡过滤:"all" | "dual"(双卡 gpu==null 或 "1,0") | 卡索引字符串 */
    function cardMatch(v, cardFilter) {
      if (!cardFilter || cardFilter === "all") return true;
      if (cardFilter === "dual") return isDual(v.gpu);
      return v.gpu === Number(cardFilter);
    }

    /* ---------- HTML 片段(字符串;事件走 data-act 委托) ---------- */
    function treeHtml(modelsIn, selId, runMap, q, cardFilter, openSet, benchMap) {
      if (!modelsIn.length) return '<div class="mm-loading">暂无参数版本<br>保存的 profile 会出现在这里</div>';
      const qL = (q || "").toLowerCase();
      const cardLabel = (k) => (k === "dual" ? gpuName(null) : gpuName(Number(k)));
      /* v7 §15:标注各模型运行中服务(● :port)并把含运行版本的模型置顶(稳定排序保原序) */
      const models = modelsIn.map((m) => {
        let r = null;
        for (const o of m.qs) for (const vv of o.versions) { const rr = runMap.get(vv.id); if (rr) r = rr; }
        return Object.assign({}, m, { __run: r });
      });
      models.sort((a, b) => (b.__run ? 1 : 0) - (a.__run ? 1 : 0));
      let h = "";
      let shownM = 0, shownV = 0;
      for (const m of models) {
        // 卡是版本属性不是模型层级:按该模型全部版本覆盖的卡做过滤
        if (cardFilter && cardFilter !== "all" && m.cards.indexOf(cardFilter) === -1) continue;
        const modelHit = !qL || m.base.toLowerCase().indexOf(qL) !== -1 ||
          m.paths.some((p) => shortPath(p).toLowerCase().indexOf(qL) !== -1) ||
          m.cards.some((k) => cardLabel(k).toLowerCase().indexOf(qL) !== -1);
        const qShow = m.qs.filter((o) => {
          if (cardFilter && cardFilter !== "all" && !o.versions.some((v) => cardMatch(v, cardFilter))) return false;
          if (!qL || modelHit) return true;
          if (o.name.toLowerCase().indexOf(qL) !== -1) return true;
          for (const v of o.versions) {
            if (v.framework.toLowerCase().indexOf(qL) !== -1) return true;
            if (String(v.name || "").toLowerCase().indexOf(qL) !== -1) return true;
          }
          return false;
        });
        if (!modelHit && !qShow.length) continue;
        shownM++;
        const mkey = m.base;
        // 展开态只由 openSet 决定;选中不强制展开,否则带选中版本时无法折叠
        const mOpen = openSet.has(mkey);
        const selInModel = selId != null && m.qs.some((o) => o.versions.some((v) => v.id === selId));
        const chips = m.cards.map((k) => '<span class="mm-mcard">' + esc(cardLabel(k)) + "</span>").join("");
        const nvShow = qShow.reduce((n, o) => n + o.versions.filter((v) => cardMatch(v, cardFilter)).length, 0);
        const runFlag = m.__run ? '<span class="mm-mrun" title="运行中服务">● :' + m.__run.port + "</span>" : "";
        h += '<div class="mm-mrow' + (mOpen ? " open" : "") + (selInModel ? " mm-mrow--sel" : "") + '" data-act="tg-model" data-key="' + esc(mkey) + '">';
        h += '<span class="mm-arrow">▶</span><span class="mm-mcol">';
        h += '<span class="mm-mline1"><span class="mm-mname" title="' + esc(m.paths.map(shortPath).join("\n")) + '">' + esc(m.base) + "</span>" + runFlag + "</span>";
        h += '<span class="mm-mline2">' + chips + '<span class="mm-mcount">' + qShow.length + " 量化 · " + nvShow + " 版</span></span>";
        h += "</span></div>";
        h += '<div class="mm-msub">';
        for (const o of qShow) {
          const vShow = o.versions.filter((v) => cardMatch(v, cardFilter));
          if (!vShow.length) continue;
          shownV += vShow.length;
          const qkey = mkey + "::" + o.name;
          const qOpen = openSet.has(qkey);
          let runInQ = 0, benched = 0;
          for (const v of vShow) {
            if (runMap.get(v.id)) runInQ++;
            const b = benchMap.get(v.name);
            if (b && b.tps != null) benched++;
          }
          const qstat = runInQ ? '<span class="mm-qstat mm-qstat--run">●' + runInQ + "</span>"
            : benched ? '<span class="mm-qstat mm-qstat--bench">测' + benched + "</span>"
            : '<span class="mm-qstat mm-qstat--no">' + vShow.length + "版</span>";
          const qCards = [];
          for (const v of vShow) { const k = isDual(v.gpu) ? "dual" : String(v.gpu); if (qCards.indexOf(k) === -1) qCards.push(k); }
          h += '<div class="mm-qrow' + (qOpen ? " open" : "") + '" data-act="tg-q" data-key="' + esc(qkey) + '">';
          h += '<span class="mm-arrow">▶</span>';
          h += '<span class="mm-qtag">' + esc(o.name) + '</span><span class="mm-qcard">· ' + esc(qCards.map(cardLabel).join("+")) + "</span>";
          h += qstat + '</div><div class="mm-vsub2">';
          for (const v of vShow) {
            const isSel = v.id === selId;
            const run = runMap.get(v.id);
            const dead = v.modelMissing ? "模型文件缺失(盘面上不存在)" : KNOWN_DEAD[modelOf(v.name)];
            const b = benchMap.get(v.name);
            const vstat = run
              ? '<span class="mm-vstat mm-vstat--run">● 运行 @' + run.port + (run.ext ? " · 外" : "") + "</span>"
              : dead
                ? '<span class="mm-vstat mm-vstat--fail">' + (v.modelMissing ? "✗ 缺失" : (v.framework === "vllm" ? "⚠ vLLM" : "✗ 不可行")) + "</span>"
                : b && b.tps != null
                  ? '<span class="mm-vstat mm-vstat--bench" title="TTFB ' + (b.ttfbMs != null ? b.ttfbMs + " ms" : "-") + " · KV " + (b.ctxAllocated != null ? fmtK(b.ctxAllocated) : "-") + '">' + b.tps + " tok/s" + (b.fullCtx ? "" : " · 未满") + "</span>"
                  : '<span class="mm-vstat mm-vstat--no">未测</span>';
            h += '<div class="mm-vrow' + (isSel ? " mm-vrow--sel" : "") + (run ? " mm-vrow--run" : "") + '" data-act="select" data-id="' + esc(v.id) + '">';
            h += '<span class="mm-fw mm-fw--' + esc(v.framework) + '">' + esc(FRAMEWORKS[v.framework] || v.framework) + "</span>";
            const vtag = versionTag(v);
            if (vtag) h += '<span class="mm-vtag" title="' + esc(v.name) + '">' + esc(vtag) + "</span>";
            h += '<span class="mm-qcard">· ' + esc(gpuName(v.gpu)) + (v.active ? " ▶" : "") + "</span>";
            h += vstat + "</div>";
          }
          h += "</div></div>";
        }
        h += "</div>";
      }
      if (qL && !shownM) h = '<div class="mm-loading">无匹配「' + esc(q) + "」</div>";
      return h;
    }
    /* 测速对比:同 base 模型全部版本(跨量化/框架/卡),取各 profile 最新一次测速;选中行高亮 */
    function compareTableHtml(v, models, benchMap) {
      const m = models.find((x) => x.base === v.__base) || null;
      const rows = [];
      if (m) for (const o of m.qs) for (const vv of o.versions) rows.push(Object.assign({}, vv, { qname: o.name }));
      let h = '<details class="mm-cmp mm-fold"><summary class="mm-cmpHead">测速对比 · 该模型全部版本<span class="mm-meta">默认收起 · 点击展开 · 取各版本最新一次测速</span></summary><div class="mm-cmpBody">';
      h += '<div class="mm-brow mm-brow--head"><span>框架</span><span>量化 · 卡</span><span class="mm-bnum">tok/s</span><span class="mm-bnum">TTFB</span><span class="mm-bnum">KV 全上下文</span></div>';
      for (const vv of rows) {
        const b = benchMap.get(vv.name);
        const me = vv.id === v.id ? " mm-brow--me" : "";
        h += '<div class="mm-brow' + me + '"><span><span class="mm-fw mm-fw--' + esc(vv.framework) + '">' + esc(FRAMEWORKS[vv.framework] || vv.framework) + '</span></span><span class="mm-bmeta" title="' + esc(vv.name) + '">' + esc(vv.qname) + " · " + esc(gpuName(vv.gpu)) + "</span>";
        if (b && b.tps != null) {
          const full = b.fullCtx === true || (b.ctxAllocated != null && b.ctxTarget != null && b.ctxAllocated >= b.ctxTarget);
          h += '<span class="mm-bnum"><b>' + b.tps + "</b></span>";
          h += '<span class="mm-bmeta">' + (b.ttfbMs != null ? b.ttfbMs + " ms" : "—") + "</span>";
          h += '<span class="mm-bmeta">' + (b.ctxAllocated != null ? fmtK(b.ctxAllocated) + (full ? " ✓" : "") : "—") + "</span>";
        } else {
          h += '<span class="mm-bnum">—</span><span class="mm-bmeta">—</span><span class="mm-bmeta">未测</span>';
        }
        h += "</div>";
      }
      h += "</div></details>";
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
      const cap = !isDual(v.gpu) ? (detectedCard(v.gpu) ? detectedCard(v.gpu).memGb : (((builtinGpus()[v.gpu]) || {}).memGb)) : undefined;
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

    function paramsTableHtml(g, v, draft, siblings) {
      const enums = [...new Set((CATS[g.fwLabel] || []).filter((x) => x.t === "enum").flatMap((x) => (x.d || "").replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim()).filter(Boolean)))];
      /* v7 §15 行位对齐:行集 = 本版本草稿 ∪ 同模型同框架兄弟量化参数并集(兄弟按名排序 → 并集顺序只由
         (base, fw) 决定,不同量化打开参数表行位一致);草稿没有的显示灰行「未设 + 兄弟量化值」,可一键补加。 */
      const draftSet = new Set();
      for (const [f] of draft) draftSet.add(norm(f));
      const seen = new Set();
      const allFlags = [];
      for (const [f] of draft) { const k = norm(f); if (!seen.has(k)) { seen.add(k); allFlags.push(f); } }
      const sibVal = new Map();
      const sibs = (siblings || []).slice().sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const s of sibs) {
        for (const [f, val0] of parseLaunchCommand(s.launchCommand || "")) {
          const k = norm(f);
          if (!seen.has(k)) { seen.add(k); allFlags.push(f); }
          if (!sibVal.has(k)) sibVal.set(k, []);
          const arr = sibVal.get(k);
          const tag = s.__qname || "默认";
          if (!arr.some((x) => x.indexOf(tag + "=") === 0)) arr.push(tag + "=" + (val0 === "" ? "开" : val0));
        }
      }
      let h = '<div class="mm-secLabel">启动参数(' + draft.length + ')<span class="mm-meta">9 组固定序 · 兄弟量化 ' + sibs.length + " 项行位对齐</span></div>";
      if (enums.length) h += '<datalist id="mmDl">' + enums.map((x) => '<option value="' + esc(x) + '"></option>').join("") + "</datalist>";
      h += '<div class="mm-pTable"><div class="mm-pHead"><span>参数</span><span>值</span><span>说明(中文 · 悬停=英文原文)</span></div>';
      const rows = sortedParams(g.fwLabel, allFlags.map((f) => [f, ""]));
      let lastG9 = null;
      for (const row of rows) {
        const f = row[0];
        const g9 = g9Of(g.fwLabel, f);
        if (g9 !== lastG9) { h += '<div class="mm-pGroup">' + (G9_ZH[g9] || g9) + "</div>"; lastG9 = g9; }
        const cat = catItem(g.fwLabel, f);
        const rc = recChain(g, f, v, siblings);
        const rec = rc ? rc.rec : null;
        const i = draft.findIndex((x) => norm(x[0]) === norm(f));
        if (i < 0) {
          /* 兄弟量化已设,本版本未设:灰行 + 兄弟值 + 「＋」补加(走 pickParam 带推荐/默认) */
          const sibTxt = (sibVal.get(norm(f)) || []).join(" · ");
          const zh = cat ? (zhFor(g.fwLabel, cat.f) || cat.z || "") : "(自定义参数)";
          h += '<div class="mm-pRow mm-pRow--unset"><span class="mm-pFlag" title="兄弟量化已设,本版本未设">' + esc(f) + '</span><span class="mm-pVal"><span class="mm-unsetTag">未设' + (sibTxt ? '<span class="mm-sibHint">其他量化:' + esc(sibTxt) + "</span>" : "") + '</span></span><span class="mm-pDesc">' + esc(zh) + '</span><span class="mm-pDel" title="加到本版本" data-act="addflag" data-f="' + esc(f) + '">＋</span></div>';
          continue;
        }
        const val0 = draft[i][1];
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
          if (rec != null) { const rd = cat.t === "bool" ? (isOn(rec) ? "开" : "关") : rec; if (rd !== "") recHtml = ' <span class="mm-recChip" title="推荐值来源">推荐 ' + esc(rd) + (rc && rc.src ? " · " + esc(rc.src) : "") + "</span>"; }
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

    function pickerHtml(g, v, draft, q, siblings) {
      const cat = CATS[g.fwLabel] || [];
      const have = new Set(draft.map((x) => norm(x[0])));
      const qL = (q || "").toLowerCase();
      const items = cat.filter((x) => !have.has(x.f) && (!q || x.f.toLowerCase().indexOf(qL) !== -1 || (x.s || "").toLowerCase().indexOf(qL) !== -1 || (zhFor(g.fwLabel, x.f) || "").indexOf(q) !== -1));
      let h = ""; let lastG = null;
      for (const x of items) {
        if (x.g !== lastG) { h += '<div class="mm-pkGroup">' + (GROUP_ZH[x.g] || x.g) + "</div>"; lastG = x.g; }
        const dflt = x.d && x.d !== "" ? x.d : "(开/关)";
        const rec = recChain(g, x.f, v, siblings);
        let recHtml = "";
        if (rec && rec.rec != null) { const rd = x.t === "bool" ? (rec.rec === "" ? "开" : "关") : rec.rec; if (rd !== "") recHtml = '<span class="mm-recChip" title="推荐值来源">' + esc(rd) + " · " + esc(rec.src) + "</span>"; }
        const zh = zhFor(g.fwLabel, x.f) || x.z || x.s;
        h += '<div class="mm-pkItem" data-act="pickparam" data-param="' + esc(x.f) + '"><span class="mm-f">' + esc(x.f) + '</span><span class="mm-d">' + esc(dflt) + '</span><span class="mm-s" title="' + esc(x.s) + '">' + esc(zh) + "</span>" + recHtml + "</div>";
      }
      if (!items.length) h += '<div class="mm-pkGroup">(无匹配)</div>';
      return h;
    }

    function benchBoxHtml(v, run, benchmarks) {
      const mine = (benchmarks || []).filter((b) => b.profile === v.name || (run && b.port === run.port));
      if (!mine.length && !run) return "";
      const last = mine[mine.length - 1];
      /* v7:测速记录默认折叠,summary 显示最新 tok/s(不必展开就能看头条数);按钮在内容区(summary 内不放交互件) */
      let h = '<details class="mm-benchBox mm-fold"><summary class="mm-foldSum">测速记录';
      if (last && last.tps != null) h += ' <span class="mm-benchTps">最新 <b>' + last.tps + "</b> tok/s" + (last.fullCtx ? " · 满ctx" : "") + "</span>";
      h += "</summary>";
      h += '<div class="mm-benchBar">';
      if (run) {
        h += '<button class="mm-btn mm-btn--sm" data-act="bench" data-port="' + run.port + '">重新测速</button>';
        h += '<button class="mm-btn mm-btn--sm" data-act="benchFullCtx" data-port="' + run.port + '" title="校验满上下文 + 流式 warmup/测量,单并发">满上下文热测速</button>';
      } else {
        h += '<span class="mm-meta mm-benchEmpty">启动后可『一键测速』</span>';
      }
      h += "</div>";
      if (mine.length) {
        h += '<div class="mm-benchList">';
        for (const b of mine.slice(-3).reverse()) {
          const d = new Date(b.at);
          const ts = (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
          if (b.scheme === "full-ctx-warm-v2") {
            const ctxTag = b.fullCtx ? "满ctx " + (b.ctxAllocated || "?") : "ctx未验证";
            h += '<div class="mm-benchRow"><span class="mm-benchTps"><b>' + (b.tps != null ? b.tps : "-") + '</b> tok/s</span><span class="mm-meta">热测速 · TTFB ' + (b.ttfbMs != null ? b.ttfbMs : "-") + "ms · prefill " + (b.prefillTps != null ? b.prefillTps : "-") + " tok/s · " + ctxTag + " · @" + b.port + " · " + ts + "</span></div>";
          } else {
            h += '<div class="mm-benchRow"><span class="mm-benchTps"><b>' + (b.tps != null ? b.tps : "-") + '</b> tok/s</span><span class="mm-meta">' + b.tokens + " tokens · " + (b.ms / 1000).toFixed(1) + "s · @" + b.port + " · " + ts + "</span></div>";
          }
        }
        h += "</div>";
      } else {
        h += '<div class="mm-meta mm-benchEmpty">暂无测速记录</div>';
      }
      h += "</details>";
      return h;
    }

    function tailHtml(g, v, run, logState, dead, draft, benchmarks, autoScroll) {
      const issues = validateLocal({ ...v, launchCommand: buildLaunchCommand(draft) });
      const badCount = issues.filter((it) => it.tone === "bad").length + (dead ? 1 : 0);
      const warnCount = issues.filter((it) => it.tone === "warn").length;
      /* v7:次要块折叠(托管参数/校验/日志);有故障默认展开,summary 直接报数 */
      let h = "";
      h += '<details class="mm-fold mm-tailFold"' + (badCount ? " open" : "") + '><summary class="mm-foldSum">托管参数(只读)· 校验 · 启动日志 ';
      if (badCount) h += '<span class="mm-foldFlag mm-foldFlag--bad">✗ ' + badCount + " 故障</span>";
      else if (warnCount) h += '<span class="mm-foldFlag mm-foldFlag--warn">⚠ ' + warnCount + " 待确认</span>";
      else h += '<span class="mm-foldFlag mm-foldFlag--ok">✓ 校验通过</span>';
      h += "</summary>";
      h += '<div class="mm-pTable">';
      const mflag = g.fw === "llama" ? "-m" : (g.fw === "sglang" ? "--model-path" : "--model");
      h += '<div class="mm-pRow mm-pRow--locked"><span class="mm-pFlag">' + mflag + '</span><span class="mm-pVal"><span class="mm-txt">' + esc(v.modelPath) + '</span></span><span class="mm-pDesc">插件托管</span></div>';
      if (v.exePath) h += '<div class="mm-pRow mm-pRow--locked"><span class="mm-pFlag">exe</span><span class="mm-pVal"><span class="mm-txt">' + esc(v.exePath) + '</span></span><span class="mm-pDesc">覆盖全局框架路径</span></div>';
      const portHint = run ? ("@" + run.port) : (v.gpu === 0 ? "11436(卡0 推断)" : (isDual(v.gpu) ? "11437(双卡推断)" : "11437(卡1 推断)"));
      h += '<div class="mm-pRow mm-pRow--locked"><span class="mm-pFlag">--port</span><span class="mm-pVal"><span class="mm-txt">' + esc(portHint) + '</span></span><span class="mm-pDesc">插件托管</span></div>';
      h += "</div>";
      h += '<div class="mm-vFoot">';
      if (g.fw === "llama") {
        const c = Number(flagVal(draft, "-c")) || 0;
        const np = flagVal(draft, "-np") == null ? 1 : Number(flagVal(draft, "-np"));
        if (c > 0 && np >= 1 && c % np === 0) h += '<div class="mm-okLine">✓ -c ' + c + " ÷ -np " + np + " = " + fmtK(c / np) + "(per-slot)</div>";
      }
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
      h += "</details>";
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
      const [openSet, setOpenSet] = React.useState(() => new Set()); // 树展开态唯一来源(模型/量化 key);选中只补开,折叠不受选中影响
      const [cardFilter, setCardFilter] = React.useState("all"); // 卡过滤 tab:all | dual | 卡索引
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
      const [moreOpen, setMoreOpen] = React.useState(false); // v7 三级动作「⋯」菜单(另存/对比/删除)
      const [svcOpen, setSvcOpen] = React.useState(false); // 服务注册表 chips(默认折叠,省一行高度)
      const [paneW, setPaneW] = React.useState(() => { try { return Math.min(560, Math.max(220, Number(localStorage.getItem("mm.paneW")) || 320)); } catch (err) { return 320; } }); // 左栏宽:拖拽可调,localStorage 持久化
      const bodyRef = React.useRef(null);
      const dragRef = React.useRef(null);
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
      /* v7:P3 统一端点常驻横幅 → 挂载时一次性提示(自动消失,不再永久占一行) */
      React.useEffect(() => {
        flash("ok", "P3 规划 · 统一端点 http://127.0.0.1:11435/v1:一个端口跑所有模型,按 body.model 路由,切模型自动接管卡(常驻横幅已收进本提示)");
      }, []);

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
      /* 模型优先树 + 测速索引 + 卡 tab(数据驱动:检测卡列表 + 双卡) */
      const models = React.useMemo(() => buildModelTree(groups), [groups]);
      /* v7 兄弟量化版本:与选中版本同 base + 同框架的全部版本(除自身)。
         参数表并集行集(行位对齐)+ 推荐链 L2 数据源;排序在 paramsTableHtml 内按名稳定化。 */
      const sibVersions = React.useMemo(() => {
        const cur = profiles.find((p) => p.id === selId) || null;
        if (!cur) return [];
        const m = models.find((x) => x.base === cur.__base);
        if (!m) return [];
        const arr = [];
        for (const o of m.qs) for (const vv of o.versions) if (vv.framework === cur.framework && vv.id !== cur.id) arr.push(vv);
        return arr;
      }, [models, selId, profiles]);
      const benchMap = React.useMemo(() => {
        const m = new Map();
        for (const b of benchmarks) if (b && b.profile != null) m.set(b.profile, b); // 后写覆盖=最新一次
        return m;
      }, [benchmarks]);
      const cardTabs = React.useMemo(() => {
        const tabs = [];
        for (const c of gpuCardList() || []) tabs.push({ val: String(c.index), label: c.shortName || ("GPU" + c.index) });
        if (profiles.some((p) => isDual(p.gpu))) tabs.push({ val: "dual", label: "双卡" });
        return tabs;
      }, [profiles, gpuInfo]);

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

      /* 选中变化 → 补开其模型/量化节点(仅新增 key;折叠不受选中影响,与 mockup 语义一致)。
         依赖只取 selId:30s 刷新会换新 profiles→新 models 对象,带上 models 依赖会把用户手动折叠的节点每 30s 重新打开。 */
      React.useEffect(() => {
        const v = profilesRef.current.find((p) => p.id === selId);
        if (!v || !v.__base) return;
        const base = v.__base, qkey = v.__base + "::" + (v.__qname || "默认");
        setOpenSet((s) => (s.has(base) && s.has(qkey) ? s : new Set(s).add(base).add(qkey)));
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
        const rc = recChain(g, flags[i][0], v, sibVersions);
        const el = rootRef.current && rootRef.current.querySelector('input[data-i="' + i + '"]');
        if (el) el.classList.toggle("mm-rec-diff", !!(rc && recMismatch(cat, val, rc.rec)));
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
        const rc = recChain(g, f, v, sibVersions);
        const rec = rc ? rc.rec : null;
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
      function doStart(port) {
        const v = curVer(); if (!v) return;
        const p = port || defaultPort(v.gpu);
        /* 非默认端口=同卡双开:占用者已在同卡,显存需装两份,确认一次 */
        const occ2 = running.find((s) => cardBusy(s, v.gpu));
        if (p !== defaultPort(v.gpu) && occ2 && !window.confirm("同卡双开 @" + p + ":" + (occ2.model || "") + " 已在 @" + occ2.port + " 运行,两实例同卡共享显存。继续?")) return;
        setBusy("start");
        apiPost("/api/mm/start", { profile: v.name, port: p, gpu: isDual(v.gpu) ? "1,0" : v.gpu }).then(async (r) => {
          flash("ok", "已托管启动 @" + r.entry.port + "(pid " + r.entry.pid + ")· 盯 readyRe 锚点,失败即存日志");
          await load();
        }).catch((err) => flash("err", "启动失败:" + err.message)).then(() => setBusy(""));
      }
      function doTakeover() {
        const v = curVer(); if (!v) return;
        const occ = running.find((s) => cardBusy(s, v.gpu));
        if (!occ) return;
        const port = occ.port;
        const occWarn = PROTECTED_PORTS.indexOf(port) !== -1 ? "(⚠ DSH 在用服务,停止将中断当前会话)" : "";
        if (!window.confirm("卡互斥:先停止在跑的 " + (occ.model || "") + "(@" + port + occWarn + "),再在 " + port + " 启动 " + modelOf(v.name) + "?")) return;
        setBusy("takeover");
        (async () => {
          try {
            await apiPost("/api/mm/stop", { port, force: !occ.managed });
            const r = await apiPost("/api/mm/start", { profile: v.name, port, gpu: isDual(v.gpu) ? "1,0" : v.gpu });
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
      /* 满上下文热测速:校验满上下文 + 流式 warmup/测量(单并发),落盘 benchmarks.json(scheme=full-ctx-warm-v2) */
      function doBenchFullCtx(port) {
        const v = curVer();
        setBusy("benchfc:" + port);
        apiPost("/api/mm/bench/fullctx", { port, profile: v ? v.name : null }).then(async (r) => {
          const res = (r && r.result) || r;
          flash("ok", "满上下文热测速 @" + res.port + ":decode " + res.tps + " tok/s · TTFB " + res.ttfbMs + "ms · prefill " + (res.prefillTps != null ? res.prefillTps + " tok/s" : "-") + " · ctx " + res.ctxAllocated + "/" + res.ctxTarget);
          try { const b = await apiGet("/api/mm/benchmarks"); _lastBench = Array.isArray(b) ? b : []; setBenchmarks(_lastBench); } catch {}
        }).catch((err) => flash("err", /404|route/i.test(String(err.message)) ? "满上下文测速端点未生效——你手动重启一次 dsh 后自动可用" : "满上下文测速失败:" + err.message)).then(() => setBusy(""));
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
        /* v7:点「⋯」菜单区域之外才关菜单(菜单内空白/select 不误关) */
        const inMenu = (ev.target && ev.target.closest && ev.target.closest(".mm-moreMenu")) || (t && t.dataset.act === "more");
        if (moreOpen && !inMenu) setMoreOpen(false);
        if (!t) return;
        const act = t.dataset.act;
        if (act === "select") setSelId(t.dataset.id);
        else if (act === "tg-model" || act === "tg-q") {
          const key = t.dataset.key;
          setOpenSet((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
        }
        else if (act === "cardtab") setCardFilter(t.dataset.card || "all");
        else if (act === "save") doSave();
        else if (act === "saveas") { setMoreOpen(false); doSaveAs(); }
        else if (act === "delete") { setMoreOpen(false); doDelete(); }
        else if (act === "start") doStart(t.dataset.port ? +t.dataset.port : undefined);
        else if (act === "takeover") doTakeover();
        else if (act === "stop" || act === "stopsrv") requestStop(Number(t.dataset.port), t.dataset.managed === "true");
        else if (act === "drawer") setDrawer((d) => !d);
        else if (act === "delparam") delParam(t.dataset.f);
        else if (act === "openpicker") { setPickerQ(""); setPickerOpen(true); }
        else if (act === "pickparam") pickParam(t.dataset.param);
        else if (act === "addflag") pickParam(t.dataset.f);
        else if (act === "more") setMoreOpen((s) => !s);
        else if (act === "svc-toggle") setSvcOpen((s) => !s);
        else if (act === "copylog") copyLog();
        else if (act === "autoscroll") setAutoScroll((s) => !s);
        else if (act === "tree-collapse") setTreeCollapsed(true);
        else if (act === "tree-expand") setTreeCollapsed(false);
        else if (act === "refresh") load();
        else if (act === "gpu-detect") doGpuDetect();
        else if (act === "bench") doBench(Number(t.dataset.port));
        else if (act === "benchFullCtx") doBenchFullCtx(Number(t.dataset.port));
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
      }

      const v = profiles.find((p) => p.id === selId) || null;
      const g = v ? groupForVersion(v) || null : null;
      const run = v ? runMap.get(v.id) : undefined;
      const dead = v ? (v.modelMissing ? "模型文件缺失(盘面上不存在)" : KNOWN_DEAD[modelOf(v.name)]) : undefined;
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
        if (v.modelMissing) {
          startBtn = e("button", { className: "mm-btn mm-btn--sm", disabled: true, title: "模型文件缺失(盘面上不存在,无法启动)" }, "文件缺失");
        } else if (run) {
          const prot = PROTECTED_PORTS.indexOf(run.port) !== -1;
          startBtn = stopBtn(run.port, !!(run.server && run.server.managed), "stop", "停止 @" + run.port + ((run.server && !run.server.managed) ? "(fuser)" : "") + (prot ? " · DSH 在用" : ""));
        } else if (isDual(v.gpu)) {
          const occ = running.find((s) => cardBusy(s, v.gpu));
          if (occ) {
            startBtn = e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "takeover", title: "先停 " + (occ.model || "") + " @" + occ.port + ",再同端口启动本版本" }, "启动 · 接管 " + occ.port);
          } else {
            startBtn = e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "start", title: "双卡 CUDA_VISIBLE_DEVICES=1,0 托管启动" }, "双卡启动 (1,0)");
          }
        } else {
          const occ = running.find((s) => s.gpu === v.gpu);
          if (occ) {
            /* 卡被占:同模型(同量化)→ 可第二端口双开;异模型 → 维持卡互斥只给接管 */
            const sameModel = !!occ.model && !!v.model && occ.model === v.model;
            const fp = sameModel ? nextFreePort(v.gpu, servers) : null;
            if (fp) {
              startBtn = e(React.Fragment, null,
                e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "start", "data-port": String(fp), title: "同卡双开:显存需装两份 " + (occ.model || "") }, "启动 · 双开 @" + fp),
                e("button", { className: "mm-btn mm-btn--sm", disabled: anyBusy, "data-act": "takeover", title: "先停 " + (occ.model || "") + " @" + occ.port + ",再同端口启动本版本" }, "接管 @" + occ.port),
              );
            } else {
              startBtn = e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "takeover" }, "启动 · 接管 " + occ.port);
            }
          } else {
            startBtn = e("button", { className: "mm-btn mm-btn--sm mm-btn--primary", disabled: anyBusy, "data-act": "start" }, "启动 (" + defaultPort(v.gpu) + ")");
          }
        }
      }

      /* 一键测速(运行中才显示;结果落 benchmarks.json 并回显详情) */
      let benchBtn = null;
      if (v && run) {
        benchBtn = e(React.Fragment, null,
          e("button", { className: "mm-btn mm-btn--sm", disabled: busy === "bench:" + run.port, "data-act": "bench", "data-port": String(run.port) }, busy === "bench:" + run.port ? "测速中…" : "一键测速"),
          e("button", { className: "mm-btn mm-btn--sm", disabled: busy === "benchfc:" + run.port, "data-act": "benchFullCtx", "data-port": String(run.port) }, busy === "benchfc:" + run.port ? "热测速中…" : "满上下文热测速"),
        );
      }

      /* v7 splitter:拖拽调左栏宽(clamp 220..min(560, 主体宽 60%)),双击复位 320,持久化 localStorage(mm.paneW) */
      function onSplitDown(ev) {
        if (treeCollapsed) return;
        dragRef.current = { x0: ev.clientX, w0: paneW };
        if (ev.currentTarget.setPointerCapture) { try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) {} }
        ev.preventDefault();
      }
      function onSplitMove(ev) {
        const d = dragRef.current; if (!d || !bodyRef.current) return;
        const rect = bodyRef.current.getBoundingClientRect();
        const maxW = Math.min(560, Math.floor(rect.width * 0.6));
        const w = Math.max(220, Math.min(maxW, Math.round(d.w0 + (ev.clientX - d.x0))));
        setPaneW(w);
        try { localStorage.setItem("mm.paneW", String(w)); } catch (err) {}
      }
      function onSplitUp() { dragRef.current = null; }
      function resetPaneW() { setPaneW(320); try { localStorage.setItem("mm.paneW", "320"); } catch (err) {} }

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
            e("span", { className: "mm-pill" }, e("b", null, models.length), " 模型 · ", e("b", null, profiles.length), " 参数版本"),
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
          e("div", { className: "mm-meta" }, "30s 自动刷新 · 卡互斥(一张卡一个模型,同模型可双开另一端口)· 参数 9 组固定序(兄弟量化行位对齐)· 说明=中文(悬停看英文)· 推荐值=同量化→同模型→官方最佳实践" + gpuMetaLine(gpuInfo)),
        ),
        flashMsg ? e("div", { className: "mm-flash" + (flashMsg.kind === "err" ? " mm-flash--err" : "") }, flashMsg.text) : null,
        /* 服务注册表(v7:默认折叠成一行摘要,▸ 展开 chips;toggle 按钮恒在右端) */
        e("div", { className: "mm-extStrip" },
          e("span", { className: "mm-kicker" }, "服务注册表"),
          e("span", { className: "mm-svcToggle", "data-act": "svc-toggle", title: svcOpen ? "折叠服务列表" : "展开全部服务" }, svcOpen ? "▾" : "▸"),
          svcOpen
            ? (servers.length ? servers.map(serverChip) : e("span", { className: "mm-meta" }, "暂无已登记服务"))
            : e("span", { className: "mm-meta" }, running.length ? running.map((s) => (s.model || "未署名") + " @" + s.port).join("  ·  ") : (servers.length ? "已登记 " + servers.length + " 项(当前全部离线)" : "暂无已登记服务")),
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
        /* 主体:左树 · splitter(可拖宽)· 右详情(折叠态不写内联 grid,让 .mm-body--collapsed 生效) */
        e("div", { ref: bodyRef, className: "mm-body" + (treeCollapsed ? " mm-body--collapsed" : ""), style: treeCollapsed ? null : { gridTemplateColumns: paneW + "px 5px 1fr" } },
          e("div", { className: "mm-paneL" },
            treeCollapsed
              ? null
              : (
                e("div", { className: "mm-paneLInner" },
                  e("div", { className: "mm-kickerRow" },
                    e("span", { className: "mm-kicker" }, "模型 · 量化 · 版本"),
                    e("div", { className: "mm-spacer" }),
                    e("button", { className: "mm-btn mm-btn--sm", "data-act": "tree-collapse", title: "收起侧栏" }, "⟨")),
                  cardTabs.length ? e("div", { className: "mm-cardTabs" },
                    e("span", { className: "mm-ctab" + (cardFilter === "all" ? " mm-ctab--active" : ""), "data-act": "cardtab", "data-card": "all" }, "全部"),
                    cardTabs.map((c) => e("span", { key: c.val, className: "mm-ctab" + (cardFilter === c.val ? " mm-ctab--active" : ""), "data-act": "cardtab", "data-card": c.val }, c.label))) : null,
                  e("input", { className: "mm-search", type: "text", placeholder: "搜索(模型 / 量化 / 框架 / 卡)…", value: treeQ, onChange: (ev) => setTreeQ(ev.target.value) }),
                  e("div", { dangerouslySetInnerHTML: { __html: treeHtml(models, selId, runMap, treeQ, cardFilter, openSet, benchMap) } }))),
          ),
          treeCollapsed ? null : e("div", { className: "mm-splitter", title: "拖动调整侧栏宽度 · 双击复位 320", onPointerDown: onSplitDown, onPointerMove: onSplitMove, onPointerUp: onSplitUp, onPointerCancel: onSplitUp, onDoubleClick: resetPaneW }, null),
          e("div", { className: "mm-paneR" },
            !v || !g
              ? e("div", { className: "mm-loading" },
                treeCollapsed ? e("button", { className: "mm-btn mm-btn--sm", "data-act": "tree-expand", title: "展开「模型 · 参数版本」列表" }, "≡ 版本") : null,
                "在左侧选择一个参数版本…")
              : e("div", { key: v.id + ":" + tick },
                e("div", { className: "mm-vHead" },
                  treeCollapsed ? e("button", { className: "mm-btn mm-btn--sm", "data-act": "tree-expand", title: "展开「模型 · 量化 · 版本」列表" }, "≡ 版本") : null,
                  e("span", { className: "mm-vTitle" }, v.__base || modelOf(v.name)),
                  e("span", { className: "mm-vSub" }, "· " + (g ? g.fwLabel : v.framework) + " · " + (v.__qname || "默认") + " · " + gpuLabel(v.gpu)),
                  v.active ? e("span", { className: "mm-pill mm-mini" }, "激活") : null,
                  run ? e("span", { className: "mm-pill mm-pill--ok mm-mini" }, "● 运行中 @" + run.port + (run.ext ? " · 外部" : "")) : null,
                  dead ? e("span", { className: "mm-pill mm-pill--fail mm-mini" }, v.modelMissing ? "✗ 文件缺失" : g.fw === "vllm" ? "⚠ vLLM 不可用" : "✗ 不可行") : null,
                  e("span", { id: "mmDirtyPill", className: "mm-pill mm-pill--warn mm-mini", style: { display: dirtyRef.current ? "inline-flex" : "none" } }, "● 未保存"),
                  e("div", { className: "mm-spacer" }),
                  e("span", { className: "mm-meta" }, shortPath(v.modelPath || "")),
                ),
                /* v7:meta 行上收进 vHead(紧贴标题),不再是独立中部条 */
                e("div", { className: "mm-metaStrip", dangerouslySetInnerHTML: { __html: metaStripHtml(g, v, benchmarks, run) } }),
                /* v7 三级动作:一级 启动/停止(startBtn) · 二级 测速×2(benchBtn) · 三级 保存/另存/对比/删除 收进「⋯」 */
                e("div", { className: "mm-vActions" },
                  startBtn,
                  benchBtn,
                  e("div", { className: "mm-moreWrap" },
                    e("button", { className: "mm-btn mm-btn--sm", "data-act": "more", "aria-expanded": moreOpen ? "true" : "false", disabled: anyBusy, title: "保存 / 另存为 / 对比基线 / 删除" }, "⋯ 更多"),
                    moreOpen ? e("div", { className: "mm-moreMenu", role: "menu" },
                      e("button", { role: "menuitem", id: "mmBtnSave", className: "mm-btn mm-btn--sm", disabled: !dirtyRef.current || anyBusy, "data-act": "save" }, dirtyRef.current ? "● 保存" : "保存"),
                      e("button", { role: "menuitem", className: "mm-btn mm-btn--sm", disabled: anyBusy, "data-act": "saveas" }, "另存为版本"),
                      g.versions.length > 1 ? e("select", { className: "mm-sel mm-menuSel", value: diffBase || "", onChange: (ev) => { setDiffBase(ev.target.value || null); setMoreOpen(false); } },
                        e("option", { value: "" }, "对比基线…"),
                        g.versions.filter((o) => o.id !== v.id).map((o) => e("option", { key: o.id, value: o.id }, "对比 " + modelOf(o.name) + "(基线)"))) : null,
                      e("button", { role: "menuitem", className: "mm-btn mm-btn--sm mm-btn--danger", disabled: anyBusy, "data-act": "delete" }, "删除版本"),
                    ) : null,
                  ),
                ),
                baseV
                  ? e("div", { dangerouslySetInnerHTML: { __html: diffHtml(g, v, baseV, draft) } })
                  : e("div", { dangerouslySetInnerHTML: { __html: paramsTableHtml(g, v, draft, sibVersions) } }),
                pickerOpen
                  ? e("div", { className: "mm-picker" },
                    e("input", { type: "text", placeholder: "搜索参数(中文/英文,如 speculative / cache / top-k)…", value: pickerQ, onChange: (ev) => setPickerQ(ev.target.value) }),
                    e("div", { dangerouslySetInnerHTML: { __html: pickerHtml(g, v, draft, pickerQ, sibVersions) } }))
                  : e("div", { className: "mm-pAdd", "data-act": "openpicker" }, "＋ 从官方目录添加参数(按 9 组固定序插入,带候选/默认/推荐)"),
                e("div", { dangerouslySetInnerHTML: { __html: compareTableHtml(v, models, benchMap) } }),
                e("div", { dangerouslySetInnerHTML: { __html: tailHtml(g, v, run, logState, dead, draft, benchmarks, autoScroll) } }),
              ),
          ),
        ),
        /* v7:P3 统一端点横幅已移除 → 挂载一次性 flash(见 flash 定义处) */
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
