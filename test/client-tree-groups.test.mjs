// client-tree-groups: 左栏「模型·参数版本」树三层化契约(纯 client 半,源级断言)
//   规格见 doublecheck-spec.md「dsh-model-manager 重构」
//   顶层 = checkpoint(=modelPath,版本1) 分组 → 每 checkpoint 一个框架下拉
//   → 下拉下 = 参数版本树(版本2,现有 versions,通过「另存为版本」copy launchCommand)
//   matchRun 卡互斥语义不变(硬门禁)。读 lib/client.js 源码做源级断言(仓库既有 seam)。
//   改 build/client-template.js 源 + build/build-client.cjs 重建 lib/client.js(F5 生效,无需重启 dsh)。
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

test("存在 selFw 内存态(顶层 checkpoint→框架选择,不持久化)", () => {
  assert.match(src, /const \[selFw, setSelFw\] = React\.useState\(\{\}\);/);
});

test("buildGroups 顶层按 modelPath(版本1=checkpoint)分组,其下 fwGroups[] 子组", () => {
  const bg = src.slice(src.indexOf("function buildGroups(profiles)"), src.indexOf("/* 运行匹配:"));
  assert.ok(bg, "找不到 buildGroups");
  // 顶层 key = modelPath(不再是 framework::modelPath)
  assert.match(bg, /\.set\(p\.modelPath/);
  // 组对象含 fwGroups[] 数组(框架子组容器)
  assert.match(bg, /fwGroups:\s*\[\]/);
  // 子组被压入顶层组的 fwGroups,而非旧的 framework::modelPath 单组
  assert.match(bg, /fwGroups\.push/);
  // 旧顶层 key(framework::modelPath) 不应再作为顶层分组键出现
  assert.doesNotMatch(bg, /p\.framework\s*\+\s*"::"\s*\+\s*p\.modelPath/);
});

test("framework 子组等价于旧顶层组(id 同时编码 modelPath+framework 两键,activeV 不变)", () => {
  const bg = src.slice(src.indexOf("function buildGroups(profiles)"), src.indexOf("/* 运行匹配:"));
  // 子组 id 同时编码 modelPath 与 framework(两键合并为 modelPath::framework;id 可内联或用 key 变量)
  assert.match(bg, /p\.modelPath\s*\+\s*"::"\s*\+\s*p\.framework/);
  // 子组有 activeV(激活版本推导,语义同旧组)
  assert.match(bg, /activeV\s*=/);
});

test("treeHtml 渲染 framework 下拉(mm-sel + data-act=sel-fw),版本行限定在选中子组", () => {
  const th = src.slice(src.indexOf("function treeHtml("), src.indexOf("function metaStripHtml("));
  assert.ok(th, "找不到 treeHtml");
  // 框架下拉:原生 select,带 sel-fw 动作(走 root onChange 委托)
  assert.match(th, /<select[\s\S]*?sel-fw|data-act="sel-fw"[\s\S]*?<select/);
  assert.match(th, /class="mm-sel"/);
  // 参数版本行(mm-ver)仍在每组内渲染(gpuName+modelOf+run/dead 徽章)
  assert.match(th, /class="mm-ver/);
  assert.match(th, /gpuName\(/);
  assert.match(th, /modelOf\(/);
});

test("交互闭环:根onChange委托 sel-fw → setSelFw(cp=value),treeHtml 读 selectedFw(cg,selFw) 选子组", () => {
  // 1) 框架下拉的选中态通过 root 事件委托写入 selFw(内存态),键=checkpoint id
  const afterRoot = src.indexOf("function stopBtn(");
  const onRoot = src.slice(src.indexOf("function onRootChange("), afterRoot);
  assert.match(onRoot, /el\.dataset\.act === "sel-fw"/);
  assert.match(onRoot, /setSelFw\(\(s\) => \(\{\s*\.\.\.s,\s*\[el\.dataset\.cp\]: ev\.target\.value \}\)\)/);
  // 2) treeHtml 按 selFw 当前值选子组(非默认首组),保证切换框架即切可见版本行
  const th = src.slice(src.indexOf("function treeHtml("), src.indexOf("function metaStripHtml("));
  assert.match(th, /selectedFw\(cg, selFw\)/);
  // selectedFw 优先取 selFw[cg.id],否则回退首子组
  const sf = src.slice(src.indexOf("function selectedFw("), src.indexOf("function treeHtml("));
  assert.match(sf, /selFw\[cg\.id\]/);
});

test("渲染/编辑用 g 定位到选中版本所在的 framework 子组(按 modelPath 找顶层,再按 framework 找子组)", () => {
  // 存在按 modelPath 定位顶层分组的定位器
  assert.match(src, /v\.modelPath/);
  // 旧「顶层组 = framework::modelPath 单组」的渲染查找 v.framework + "::" + v.modelPath 不应再用于定位 g
  // (g 应指向框架子组;若仍存在单组查找即错层)
  const gLine = src.match(/const g = v \?[^;]*;/);
  assert.ok(gLine, "未找到渲染层 const g 定位");
  assert.doesNotMatch(gLine[0], /v\.framework\s*\+\s*"::"\s*\+\s*v\.modelPath/);
});

test("matchRun 卡互斥语义不变:托管按 managed:note 认领、外部按 gpu+framework+模型名 认领激活版本、选最高分", () => {
  const mr = src.slice(src.indexOf("function matchRun("), src.indexOf("/* 客户端校验:"));
  assert.ok(mr, "找不到 matchRun");
  // 托管精确认领(managed:note)
  assert.match(mr, /managed:/);
  // 外部认领仍按 gpu + framework + 模型名,最高分(卡 0 一个模型)
  assert.match(mr, /s\.framework\s*!==/);
  assert.match(mr, /s\.gpu\s*!==/);
  assert.match(mr, /bestScore/);
  // 子组迭代:walk over 顶层组的 fwGroups
  assert.match(mr, /fwGroups/);
});

test("doSaveAs 不变:仍 copy launchCommand、保留 modelPath/framework、active:false", () => {
  const sa = src.slice(src.indexOf("function doSaveAs()"), src.indexOf("function doDelete()"));
  assert.ok(sa, "找不到 doSaveAs");
  assert.match(sa, /launchCommand: cmd/);
  assert.match(sa, /active:\s*false/);
  // 未引入按 checkpoint 拆名的新逻辑(仍按 name+副本 去重)
  assert.match(sa, /name = v\.name \+\s*" 副本"/);
});

test("doctorFindings 三层计数:遍历顶层组 fwGroups[].versions(旧 g.versions 会 throw)", () => {
  const df = src.slice(src.indexOf("function doctorFindings("), src.indexOf("/* ---------- HTML 片段"));
  assert.ok(df, "找不到 doctorFindings");
  // 总计数走顶层组的 fwGroups[].versions(三层化后顶层 checkpoint 无 .versions,旧写法会 throw)
  assert.match(df, /cg\.fwGroups\.reduce/);
  assert.match(df, /for \(const cg of groups\) for \(const sg of cg\.fwGroups\) for \(const p of sg\.versions\)/);
  // 旧顶层 g.versions 计数不应再出现
  assert.doesNotMatch(df, /groups\.reduce\(\(n, g\) => n \+ g\.versions\.length/);
});
