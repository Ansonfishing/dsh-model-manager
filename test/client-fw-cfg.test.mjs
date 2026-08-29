// client-fw-cfg: 框架路径区默认收起契约(纯 client 半,源级断言)
//   1) showFwCfg state 默认 false(每次面板加载都收起)
//   2) 服务注册表 mm-extStrip 上有 fw-cfg-toggle 按钮(与 register-toggle 同排)
//   3) 按钮文案:收起态「+ 框架路径」,展开态「收起框架路径」
//   4) 框架路径 mm-extStrip 仅在 showFwCfg=true 时渲染(条件渲染包裹)
//   5) node --check 通过
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

test("showFwCfg state 存在且默认收起", () => {
  assert.match(src, /const \[showFwCfg, setShowFwCfg\] = React\.useState\(false\);/);
});

test("服务注册表 strip 内有 fw-cfg-toggle 按钮(在 register-toggle 附近)", () => {
  const reg = src.indexOf('e("span", { className: "mm-kicker" }, "服务注册表")');
  assert.notEqual(reg, -1, "未找到服务注册表 strip");
  const btn = src.indexOf('data-act": "fw-cfg-toggle"', reg);
  assert.notEqual(btn, -1, "服务注册表 strip 内没有 fw-cfg-toggle 按钮");
  const regToggle = src.indexOf('data-act": "register-toggle"', reg);
  assert.ok(Math.abs(btn - regToggle) < 400, "toggle 按钮应与 register-toggle 同排(±400 字符)");
});

test("按钮文案:收起态「+ 框架路径」,展开态「收起框架路径」", () => {
  assert.match(src, /showFwCfg \? "收起框架路径" : "\+ 框架路径"/);
});

test("框架路径 strip 条件渲染:showFwCfg ? e(\"div\"... 包裹「框架路径」kicker", () => {
  const cond = src.indexOf('showFwCfg ? e("div", { className: "mm-extStrip" }');
  assert.notEqual(cond, -1, "缺少 showFwCfg 条件渲染(框架路径 strip 未折叠)");
  const kicker = src.indexOf('e("span", { className: "mm-kicker" }, "框架路径")');
  assert.notEqual(kicker, -1, "未找到框架路径 kicker");
  assert.ok(kicker > cond && kicker - cond < 400, "框架路径 kicker 必须位于条件渲染分支内");
});

test("展开 handler 存在(fw-cfg-toggle → 翻转 showFwCfg)", () => {
  assert.match(src, /act === "fw-cfg-toggle"\) setShowFwCfg\(\(s\) => !s\);/);
});
