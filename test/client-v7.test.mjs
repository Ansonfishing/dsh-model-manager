// client-v7: v7 面板重设计契约(DESIGN.md §14/§15,2026-09-03 落地)
//   1) 参数排序 A:9 组固定序(模型→上下文→KV→投机→采样→性能→并行→服务→其他),目录外进「其他」
//   2) 兄弟量化行位对齐:paramsTableHtml 行集 = 草稿 ∪ 同模型同框架兄弟参数并集;未设灰行 + 兄弟值 + addflag
//   3) 推荐值三级溯源链 recChain(同量化→同模型→官方 bpFor),每格标来源;MODEL_NAME_FLAG 缺失校验
//   4) 左栏:模型名首位(13px/700 两行制 mm-mname)+ 运行中模型置顶(mm-mrun)+ 版本行 mm-vtag
//   5) splitter 拖宽:paneW state + localStorage mm.paneW + clamp(220..min(560,60%)) + 双击复位;折叠态不写内联 grid
//   6) 三级动作:保存/另存为/对比/删除 收进「⋯」菜单(moreOpen/mm-moreMenu);一级启动/二级测速留在动作行
//   7) metaStrip 上收进 vHead(在 vActions 之前);P3 常驻横幅移除(挂载一次性 flash)
//   8) 服务注册表默认折叠(svcOpen),kicker「服务注册表」文案逐字保留
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(join(root, "lib/client.js"), "utf8");

test("node --check lib/client.js", () => {
  const r = spawnSync(process.execPath, ["--check", join(root, "lib/client.js")], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr}`);
});

test("排序 A:9 组固定序常量 + g9Of 归并(speculative→spec;cache/memory/parser/mamba→server)", () => {
  assert.match(src, /const G9_ORDER = \["model", "context", "kv", "spec", "sampling", "perf", "parallelism", "server", "misc"\];/);
  assert.match(src, /if \(g === "speculative"\) g = "spec";/);
  assert.match(src, /if \(g === "cache" \|\| g === "memory" \|\| g === "parser" \|\| g === "mamba"\) g = "server";/);
  // sortedParams:组序 gi 优先 → 目录序 ci → 原序 i(目录外 ci=1e9 组内垫底)
  assert.match(src, /\.sort\(\(a, b\) => \(a\.gi - b\.gi\) \|\| \(a\.ci - b\.ci\) \|\| \(a\.i - b\.i\)\)/);
});

test("兄弟量化行位对齐:paramsTableHtml 收 siblings 并集 + 未设灰行 + 兄弟值 + addflag 补加", () => {
  assert.match(src, /function paramsTableHtml\(g, v, draft, siblings\) \{/);
  // 兄弟按名排序 → 并集行序只由 (base, fw) 决定,不同量化打开行位一致
  assert.match(src, /const sibs = \(siblings \|\| \[\]\)\.slice\(\)\.sort\(\(a, b\) => \(a\.name < b\.name \? -1 : 1\)\);/);
  assert.match(src, /mm-pRow--unset/);
  assert.match(src, /mm-sibHint/);
  assert.match(src, /data-act="addflag"/);
  assert.match(src, /act === "addflag"\) pickParam\(t\.dataset\.f\);/);
  // 渲染层:sibVersions memo(同 base+同框架,除自身)并传入参数表/picker
  assert.match(src, /const sibVersions = React\.useMemo\(/);
  assert.match(src, /vv\.framework === cur\.framework && vv\.id !== cur\.id/);
  assert.match(src, /paramsTableHtml\(g, v, draft, sibVersions\)/);
  assert.match(src, /pickerHtml\(g, v, draft, pickerQ, sibVersions\)/);
});

test("推荐三级链:recChain(同量化→同模型→官方)+ 来源标注 + bpFor 可溯源表 + 三级皆无不猜", () => {
  assert.match(src, /function recChain\(g, f, v, siblings\) \{/);
  assert.match(src, /src: "同量化"/);
  assert.match(src, /同模型·显存差异/);
  assert.match(src, /src: "官方"/);
  assert.match(src, /function bpFor\(fwLabel, f, v\) \{/);
  // 官方表仅收录有据条目:llama -fa on;sglang cache-report/kv fp8/mem-fraction(48G≈0.92 / ≥80G≈0.75)/context-length=原生
  assert.match(src, /if \(f === "-fa"\) return "on";/);
  assert.match(src, /if \(f === "--mem-fraction-static"\)/);
  assert.match(src, /return "0\.75";/);
  assert.match(src, /return "0\.92";/);
  // 每格标来源(推荐 值 · 来源)
  assert.match(src, /推荐 ' \+ esc\(rd\) \+ \(rc && rc\.src \? " · " \+ esc\(rc\.src\) : ""\)/);
});

test("模型名缺失校验:MODEL_NAME_FLAG(llama -a / sglang+vllm --served-model-name)进 validateLocal", () => {
  assert.match(src, /const MODEL_NAME_FLAG = \{ llama: "-a", sglang: "--served-model-name", vllm: "--served-model-name" \};/);
  assert.match(src, /const mnf = MODEL_NAME_FLAG\[p\.framework\];/);
  assert.match(src, /缺 " \+ mnf \+ "\(未设服务模型名/);
});

test("左栏模型名首位:两行制 mm-mname(13px/700)+ 运行中置顶 mm-mrun + 版本行 mm-vtag", () => {
  assert.match(src, /\.mm-root \.mm-mname\{font-size:13px;font-weight:700/);
  assert.match(src, /<span class="mm-mname"/);
  assert.match(src, /<span class="mm-mrun"/);
  // 运行版本所在模型整组置顶(稳定排序:有 __run 的排前)
  assert.match(src, /models\.sort\(\(a, b\) => \(b\.__run \? 1 : 0\) - \(a\.__run \? 1 : 0\)\);/);
  assert.match(src, /const vtag = versionTag\(v\);/);
  assert.match(src, /<span class="mm-vtag"/);
  // 字号层级:模型 13 > 量化 11.5(不再倒挂)
  assert.match(src, /\.mm-root \.mm-qtag\{font-size:11\.5px;\}/);
});

test("splitter 拖宽:mm-splitter + paneW state(localStorage mm.paneW 默认 320)+ clamp(220,min(560,60%)) + 双击复位", () => {
  assert.match(src, /const \[paneW, setPaneW\] = React\.useState\(\(\) => \{ try \{ return Math\.min\(560, Math\.max\(220, Number\(localStorage\.getItem\("mm\.paneW"\)\) \|\| 320\)\); \} catch \(err\) \{ return 320; \} \}\);/);
  assert.match(src, /className: "mm-splitter"/);
  assert.match(src, /Math\.min\(560, Math\.floor\(rect\.width \* 0\.6\)\)/);
  assert.match(src, /Math\.max\(220, Math\.min\(maxW, Math\.round\(d\.w0 \+ \(ev\.clientX - d\.x0\)\)\)\)/);
  assert.match(src, /onDoubleClick: resetPaneW/);
  assert.match(src, /localStorage\.setItem\("mm\.paneW", "320"\)/);
  // 折叠兼容:collapsed 时不写内联 gridTemplateColumns(让 0 1fr 类规则生效),splitter 隐藏
  assert.match(src, /style: treeCollapsed \? null : \{ gridTemplateColumns: paneW \+ "px 5px 1fr" \}/);
  assert.match(src, /\.mm-root \.mm-body--collapsed \.mm-splitter\{display:none;\}/);
});

test("三级动作:⋯ 菜单(moreOpen)收纳 保存/另存为/对比/删除;一级启动 + 二级测速留动作行", () => {
  assert.match(src, /const \[moreOpen, setMoreOpen\] = React\.useState\(false\);/);
  assert.match(src, /"data-act": "more"/);
  assert.match(src, /act === "more"\) setMoreOpen\(\(s\) => !s\);/);
  assert.match(src, /className: "mm-moreMenu"/);
  // 菜单外点击关闭(菜单内 select/空白不误关)
  assert.match(src, /closest\("\.mm-moreMenu"\)\) \|\| \(t && t\.dataset\.act === "more"\)/);
  // 菜单项动作执行后关菜单
  assert.match(src, /act === "saveas"\) \{ setMoreOpen\(false\); doSaveAs\(\); \}/);
  assert.match(src, /act === "delete"\) \{ setMoreOpen\(false\); doDelete\(\); \}/);
});

test("metaStrip 上收 vHead(metaStripHtml 调用在 mm-vActions 渲染之前)+ P3 常驻横幅已移除", () => {
  const iStrip = src.indexOf("metaStripHtml(g, v, benchmarks, run)");
  const iActs = src.indexOf('className: "mm-vActions"');
  assert.ok(iStrip > -1 && iActs > -1);
  assert.ok(iStrip < iActs, "meta 行须上收进 vHead(在动作行之前)");
  assert.doesNotMatch(src, /className: "mm-unified"/, "P3 常驻横幅应移除(改挂载一次性 flash)");
  assert.match(src, /P3 规划 · 统一端点/);
});

test("服务注册表默认折叠:svcOpen=false + svc-toggle;kicker「服务注册表」逐字保留", () => {
  assert.match(src, /const \[svcOpen, setSvcOpen\] = React\.useState\(false\);/);
  assert.match(src, /act === "svc-toggle"\) setSvcOpen\(\(s\) => !s\);/);
  assert.ok(src.includes('e("span", { className: "mm-kicker" }, "服务注册表")'), "kicker 文案必须逐字保留");
});

test("次要块折叠:托管参数/日志/测速/对比 → details.mm-fold(故障时 tailFold 自动 open)", () => {
  assert.match(src, /<details class="mm-fold mm-tailFold"' \+ \(badCount \? " open" : ""\)/);
  assert.match(src, /<details class="mm-benchBox mm-fold">/);
  assert.match(src, /<details class="mm-cmp mm-fold">/);
  assert.match(src, /\.mm-root details > summary\{list-style:none;\}/);
});

test("菜单层级补丁:save 点击后关菜单(与 saveas/delete 一致)+ Escape 关菜单 + markDirty 更新菜单保存文案", () => {
  // 实测 bug:harness 点「保存」菜单不关(原分支只 doSave())
  assert.match(src, /act === "save"\) \{ setMoreOpen\(false\); doSave\(\); \}/);
  // 键盘可关:root onKeyDown → Escape 收起 ⋯ 菜单
  assert.match(src, /onKeyDown: onRootKey/);
  assert.match(src, /ev\.key === "Escape" && moreOpen\) setMoreOpen\(false\)/);
  // 菜单开着时编辑参数:markDirty 除解禁按钮外同步「● 保存」文案(文本只在 render 更新会滞后)
  assert.match(src, /btn\.textContent = "● 保存";/);
});
