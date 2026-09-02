// 从 mockup-v3.html 提取 白底 CSS(作用域化 .mm-root)+ 官方参数目录/中文说明 JS 块,
// 注入 client-template.js → lib/client.js(本目录)
const fs = require("fs");

const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "mockup-v3.html"), "utf8");
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const cStart = script.indexOf("/* ================= 框架官方参数目录");
const cEnd = script.indexOf("/* ================= 数据");
if (cStart < 0 || cEnd < 0) throw new Error("catalog markers not found");
const chunk = script.slice(cStart, cEnd);

/* CSS 作用域化:每条规则的选择器前缀 .mm-root;:root/body → .mm-root */
function scopeCss(css) {
  const rules = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { rules.push(css.slice(start, i + 1)); start = i + 1; } }
  }
  if (start < css.length) { const rest = css.slice(start).trim(); if (rest) rules.push(rest); }
  return rules.map((r) => {
    const ob = r.indexOf("{");
    if (ob === -1) return r;
    let sel = r.slice(0, ob);
    let body = r.slice(ob);
    if (sel.trim().indexOf("@media") === 0) {
      body = body.replace(/\*/g, ".mm-root *");
    } else {
      sel = sel.split(",").map((s) => {
        s = s.trim(); if (!s) return s;
        if (s === "*") return ".mm-root *";
        if (s === ":root" || s === "body" || s === ".frame") return ".mm-root";
        // 类名加 mm- 前缀(与模板 markup 一致,避免与宿主应用全局类撞名)
        s = s.replace(/\.([A-Za-z_][\w-]*)/g, (m, c) => ".mm-" + c);
        return ".mm-root " + s;
      }).join(", ");
    }
    return sel + body;
  }).join("\n");
}

const EXTRA = `
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
`;

const css = scopeCss(style) + EXTRA;

let tpl = fs.readFileSync(path.join(__dirname, "client-template.js"), "utf8");
tpl = tpl.replace("/*__CSS__*/", () => css);
tpl = tpl.replace("/*__CATS__*/", () => chunk);
fs.writeFileSync(path.join(ROOT, "lib", "client.js"), tpl);
console.log("client.js written:", tpl.length, "bytes; css:", css.length, "; catalog chunk:", chunk.length);
