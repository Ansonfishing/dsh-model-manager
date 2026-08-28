// client-collapse: 模型管理 tab 侧栏零宽折叠契约(纯 client 半,源级断言)
//   1) 折叠态 grid 左列 0px,且 mm-paneL 的 padding/border/background 被清零(不留窄条)
//   2) 旧 36px 窄条竖排展开按钮(mm-treeExpand)彻底移除
//   3) 展开入口:选中版本时 vHead 最左侧有 data-act=tree-expand 按钮(在标题之前)
//   4) 展开入口:未选版本时空态(mm-loading)里也有该按钮(防锁死)
//   5) 收起入口(tree-collapse)保留;node --check 通过
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

test("折叠态:左列 0px,选择器特异性必须赢过 .mm-root .mm-body(0,2,0),无 36px 残留", () => {
  // 特异性陷阱:折叠规则若只用单类 .mm-body--collapsed(0,1,0),
  // 会被 .mm-root .mm-body{grid-template-columns:320px 1fr}(0,2,0) 覆盖,
  // 折叠后仍是 320px 空列(用户实测:折叠完留一大片白)。
  const m = src.match(/([^{]*\.mm-body--collapsed)\{grid-template-columns:0 1fr;\}/);
  assert.ok(m, "缺少 0 1fr 折叠规则");
  const classCount = (m[1].match(/\.mm-[A-Za-z0-9_-]+/g) || []).length;
  assert.ok(classCount >= 2, `折叠规则选择器「${m[1].trim()}」特异性不足:需 ≥2 个类,实际 ${classCount}`);
  const base = src.indexOf(".mm-root .mm-body{");
  assert.ok(base >= 0, "基准 .mm-root .mm-body 规则缺失?");
  assert.ok(m.index > base, "折叠规则必须声明在 .mm-root .mm-body 之后(特异性打平时靠顺序)");

  const pm = src.match(/([^{]*\.mm-body--collapsed[^{]*)\.mm-paneL\{([^}]*)\}/);
  assert.ok(pm, "缺少折叠态 .mm-paneL 覆盖");
  const pc = (pm[1].match(/\.mm-[A-Za-z0-9_-]+/g) || []).length;
  assert.ok(pc >= 2, `paneL 折叠覆盖选择器「${pm[0].slice(0, pm[0].indexOf("{"))}」特异性不足:需 ≥2 个类,实际 ${pc}`);
  assert.match(pm[2], /padding:0/);
  assert.match(pm[2], /border-right:0/);
  assert.match(pm[2], /background:none/);
  assert.doesNotMatch(src, /grid-template-columns:36px 1fr/, "旧 36px 窄条残留");
});

test("旧竖排窄条按钮 mm-treeExpand 已移除", () => {
  assert.doesNotMatch(src, /mm-treeExpand/);
});

test("展开入口:选中版本时 vHead 最左侧(标题之前)有 tree-expand 按钮", () => {
  const i = src.indexOf('className: "mm-vHead"');
  assert.notEqual(i, -1, "未找到 mm-vHead 渲染");
  const j = src.indexOf('data-act": "tree-expand"', i);
  const k = src.indexOf('className: "mm-vTitle"', i);
  assert.notEqual(j, -1, "vHead 内没有 tree-expand 按钮");
  assert.ok(j < k, "展开按钮必须位于标题(mm-vTitle)之前");
});

test("展开入口:未选版本时空态 mm-loading 里有 tree-expand 按钮(防锁死)", () => {
  const i = src.indexOf('className: "mm-loading"');
  assert.notEqual(i, -1, "未找到空态 mm-loading 渲染");
  const j = src.indexOf('data-act": "tree-expand"', i);
  const end = src.indexOf('e("div", { key: v.id', i);
  assert.notEqual(j, -1, "空态里没有 tree-expand 按钮");
  assert.ok(j < end, "tree-expand 按钮不在空态分支内");
});

test("收起入口 tree-collapse 保留", () => {
  assert.match(src, /data-act": "tree-collapse"/);
});
