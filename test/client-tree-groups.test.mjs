// client-tree-groups: 左栏「模型 · 量化 · 版本」三层树契约(mockup-v5 定稿;纯 client 半,源级断言)
//   顶层 = 同名模型(base 名,splitQuant 拆量化标记;跨量化目录/跨卡合并为一个节点)
//   → 量化组(标签含 MTP/DFLASH/Uncensored 变体,拆不出=「默认」)
//   → 版本行(profile:框架 chip + 卡 + 状态)。卡 = 版本属性(行内显示 + 顶部卡 tab mm-ctab 过滤)。
//   展开态 = openSet 唯一来源(选中只补开,折叠不受选中影响)。
//   buildGroups/matchRun 卡互斥语义不变(硬门禁)。读 lib/client.js 源做源级断言;
//   splitQuant 为纯函数,vm 抽取做行为断言。
//   改 build/client-template.js 源 + build/build-client.cjs 重建 lib/client.js(F5 生效,无需重启 dsh)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(join(root, "lib/client.js"), "utf8");

test("node --check lib/client.js", () => {
  const r = spawnSync(process.execPath, ["--check", join(root, "lib/client.js")], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr}`);
});

/* ---------- splitQuant 行为断言(vm 抽取纯函数) ---------- */
function extractFn(name) {
  const i = src.indexOf("function " + name + "(");
  assert.ok(i >= 0, "找不到 function " + name);
  const j = src.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  assert.fail(name + " 花括号未配对");
}
const splitQuant = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(extractFn("splitQuant"), ctx);
  return ctx.splitQuant;
})();

test("splitQuant:真实 profile 显示名 → base + 量化标签", () => {
  const cases = [
    // [display, fallback, wantBase, wantQ]
    ["Qwen3.8-27B Q8_K_XL MTP", null, "Qwen3.8-27B", "Q8_K_XL MTP"],
    ["Qwen3.8-27B-FP8 MTP", null, "Qwen3.8-27B", "FP8 MTP"],
    ["Qwen3.8-27B-FP8 DFLASH", null, "Qwen3.8-27B", "FP8 DFLASH"],
    ["Qwen3.8-27B-FP16 DFLASH", null, "Qwen3.8-27B", "FP16 DFLASH"],
    ["Qwen3.8-27B-Uncensored-FP8", null, "Qwen3.8-27B", "FP8 (Uncensored)"],
    ["Ornith-1.5-35B-A3B-APEX-MTP", null, "Ornith-1.5-35B-A3B", "APEX-MTP"],
    ["Ornith-1.5-35B-A3B-FP16", null, "Ornith-1.5-35B-A3B", "FP16"],
    ["Qwen3.6-35B-A3B-FP8", null, "Qwen3.6-35B-A3B", "FP8"],
    ["Qwen3-VL-4B-Instruct", null, "Qwen3-VL-4B-Instruct", null],
    ["Ornith-1.5-35B-A3B", null, "Ornith-1.5-35B-A3B", null],
    ["DeepSeek-V4-Flash dspark", null, "DeepSeek-V4-Flash", "dspark"],
    ["Qwen3.8-27B", null, "Qwen3.8-27B", null],
  ];
  for (const [display, fallback, wantBase, wantQ] of cases) {
    const r = splitQuant(display, fallback);
    assert.equal(r.base, wantBase, `base(${display})`);
    assert.equal(r.q, wantQ, `q(${display})`);
  }
  // 显示名无量化标记 → 回退 model 字段再拆(如显示名 Qwen3.8-Flash-Next → 字段 …-UD-IQ4_XS;UD- 前缀属量化名)
  // 注:vm 跨 realm 对象原型不同,逐字段断言不用 deepEqual
  const r = splitQuant("Qwen3.8-Flash-Next", "Qwen3.8-Flash-Next-UD-IQ4_XS");
  assert.equal(r.base, "Qwen3.8-Flash-Next");
  assert.equal(r.q, "UD-IQ4_XS");
});

/* ---------- buildGroups / 三层树派生 ---------- */
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
  // 子组 id 同时编码 modelPath 与 framework(两键合并为 modelPath::framework)
  assert.match(bg, /p\.modelPath\s*\+\s*"::"\s*\+\s*p\.framework/);
  // 子组有 activeV(激活版本推导,语义同旧组)
  assert.match(bg, /activeV\s*=/);
});

test("buildModelTree:同名模型合并(base 节点),量化组 + 版本行,profile 挂 __base/__qname", () => {
  const bm = src.slice(src.indexOf("function buildModelTree("), src.indexOf("/* 卡过滤:"));
  assert.ok(bm, "找不到 buildModelTree");
  // base/量化 来自显示名(回退 model 字段)
  assert.match(bm, /splitQuant\(modelOf\(v\.name\), v\.model\)/);
  assert.match(bm, /v\.__base = sq\.base/);
  assert.match(bm, /v\.__qname = sq\.q \|\| "默认"/);
  // 卡 key:单卡索引 / dual(双卡 gpu==null 或 "1,0" 逗号串,isDual 统一判定)
  assert.match(bm, /cardKey = isDual\(v\.gpu\) \? "dual" : String\(v\.gpu\)/);
  assert.match(src, /function isDual\(g\) \{ return g === null \|\| g === undefined \|\| \(typeof g === "string" && g\.indexOf\(","\) !== -1\)/);
});

test("treeHtml:三层树(模型/量化/版本行 + 卡 chip + openSet 展开态 + 卡过滤 + 测速状态),无旧框架下拉", () => {
  const th = src.slice(src.indexOf("function treeHtml("), src.indexOf("/* 测速对比:"));
  assert.ok(th, "找不到 treeHtml");
  // 三层 data-act:模型行切换 tg-model / 量化行切换 tg-q / 版本行 select
  assert.match(th, /data-act="tg-model"/);
  assert.match(th, /data-act="tg-q"/);
  assert.match(th, /data-act="select"/);
  // 模型行:base 名 + 卡 chip + N 量化
  assert.match(th, /mm-mcard/);
  assert.match(th, /mm-mcount/);
  // 量化行:qtag + qstat(运行 ●N / 测N / N版)
  assert.match(th, /mm-qstat/);
  // 展开态 = openSet 唯一来源(选中不强制展开)
  assert.match(th, /openSet\.has\(mkey\)/);
  assert.match(th, /openSet\.has\(qkey\)/);
  // 卡过滤走 cardMatch(卡 = 版本属性,不是模型层级)
  assert.match(th, /cardMatch\(v, cardFilter\)/);
  // 版本行:框架 chip + 运行/测速状态(最新一次测速)
  assert.match(th, /mm-fw mm-fw--/);
  assert.match(th, /benchMap\.get\(v\.name\)/);
  // 旧的框架下拉(sel-fw)不再存在
  assert.doesNotMatch(th, /sel-fw/);
  assert.doesNotMatch(src, /selectedFw/);
});

test("卡 tab:mm-ctab + cardFilter 状态 + cardtab 分发 + 数据驱动 tab 列表(检测卡 + 双卡)", () => {
  assert.match(src, /const \[cardFilter, setCardFilter\] = React\.useState\("all"\);/);
  assert.match(src, /mm-cardTabs/);
  assert.match(src, /mm-ctab/);
  assert.match(src, /act === "cardtab"/);
  assert.match(src, /setCardFilter\(t\.dataset\.card \|\| "all"\)/);
  assert.match(src, /cardTabs = React\.useMemo/);
  assert.match(src, /val: "dual", label: "双卡"/);
});

test("openSet 展开态:useState Set + tg 切换 + 选中只补开(幂等,不强制展开)", () => {
  assert.match(src, /const \[openSet, setOpenSet\] = React\.useState\(\(\) => new Set\(\)\);/);
  assert.match(src, /act === "tg-model" \|\| act === "tg-q"/);
  // 选中补开:模型 key + 量化 key(__base/__qname);已展开则原样返回(不触发重渲染)
  assert.match(src, /v\.__base \+ "::" \+ \(v\.__qname \|\| "默认"\)/);
  assert.match(src, /s\.has\(base\) && s\.has\(qkey\) \? s : new Set\(s\)\.add\(base\)\.add\(qkey\)/);
});

test("测速对比表:同 base 模型全部版本(跨量化/框架/卡),取最新测速,选中行高亮", () => {
  const ct = src.slice(src.indexOf("function compareTableHtml("), src.indexOf("function metaStripHtml("));
  assert.ok(ct, "找不到 compareTableHtml");
  assert.match(ct, /models\.find\(\(x\) => x\.base === v\.__base\)/);
  assert.match(ct, /mm-brow--me/);
  assert.match(ct, /mm-bnum/);
});

test("右栏两行头:标题=base 名 + 副题(框架·量化·卡),操作行独立;对比表在参数表与 tail 之间", () => {
  assert.match(src, /className: "mm-vTitle" \}, v\.__base \|\| modelOf\(v\.name\)/);
  assert.match(src, /className: "mm-vSub"/);
  assert.match(src, /className: "mm-vActions"/);
  const iCmp = src.indexOf("compareTableHtml(v, models, benchMap)");
  const iTail = src.indexOf("tailHtml(g, v, run, logState, dead, draft, benchmarks, autoScroll)");
  assert.ok(iCmp > -1, "未渲染测速对比表");
  assert.ok(iTail > -1, "未渲染 tailHtml");
  assert.ok(iCmp < iTail, "对比表须在参数表与 tailHtml(日志/托管参数)之间");
});

test("渲染/编辑用 g 定位到选中版本所在的 framework 子组(按 modelPath 找顶层,再按 framework 找子组)", () => {
  // 存在按 modelPath 定位顶层分组的定位器
  assert.match(src, /v\.modelPath/);
  // 旧「顶层组 = framework::modelPath 单组」的渲染查找不应再用于定位 g
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

/* ---------- 同卡双开(nextFreePort 行为 + 按钮逻辑) ---------- */
const nextFreePort = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(extractFn("nextFreePort"), ctx);
  return ctx.nextFreePort;
})();

test("nextFreePort:按卡分池(偶=卡0/4090,奇=卡1/6000),跳过已占端口,本卡全占返回 null", () => {
  // 默认端口优先
  assert.equal(nextFreePort(0, []), 11436);
  assert.equal(nextFreePort(1, []), 11437);
  // 卡0 池 = 11436/11440/11442(偶),卡1 池 = 11437/11439/11441(奇)
  assert.equal(nextFreePort(0, [{ port: 11436 }]), 11440);
  assert.equal(nextFreePort(0, [{ port: 11436 }, { port: 11440 }]), 11442);
  assert.equal(nextFreePort(1, [{ port: 11437 }]), 11439);
  assert.equal(nextFreePort(1, [{ port: 11437 }, { port: 11436 }]), 11439); // 卡0 端口不占卡1 池
  // 无关端口不占池
  assert.equal(nextFreePort(0, [{ port: 2244 }]), 11436);
  // 本卡 3 口全占 → null
  assert.equal(nextFreePort(0, [{ port: 11436 }, { port: 11440 }, { port: 11442 }]), null);
  assert.equal(nextFreePort(1, [{ port: 11437 }, { port: 11439 }, { port: 11441 }]), null);
});

test("启动按钮:卡被占+同模型→双开(第二空闲端口)+接管;doStart 收端口参数", () => {
  assert.match(src, /启动 · 双开 @/);
  assert.match(src, /occ\.model === v\.model/);
  assert.match(src, /nextFreePort\(v\.gpu, servers\)/);
  assert.match(src, /"data-port": String\(fp\)/);
  assert.match(src, /function doStart\(port\)/);
  assert.match(src, /port: p, gpu:/);
  assert.match(src, /doStart\(t\.dataset\.port \? \+t\.dataset\.port : undefined\)/);
  assert.match(src, /同卡双开 @/); // 确认弹窗
  // 卡空时仍是默认端口单按钮(无双开)
  assert.match(src, /启动 \(" \+ defaultPort\(v\.gpu\) \+ "\)/);
});

/* ---------- 盘面对应:node 标注 modelMissing,client 消费 ---------- */
test("client 模板消费 modelMissing:树徽标/头部 pill/启动禁用", () => {
  // 树版本行:模型文件缺失 → 「✗ 缺失」
  assert.match(src, /v\.modelMissing \? "✗ 缺失"/);
  // 头部 pill:缺失 → 「✗ 文件缺失」
  assert.match(src, /v\.modelMissing \? "✗ 文件缺失"/);
  // 头部 dead 计算优先 modelMissing,回落 KNOWN_DEAD
  assert.match(src, /const dead = v \? \(v\.modelMissing \? "模型文件缺失\(盘面上不存在\)" : KNOWN_DEAD\[modelOf\(v\.name\)\]\) : undefined;/);
  // 启动按钮:缺失时禁用,不进入启动/接管分支
  assert.match(src, /if \(v\.modelMissing\) \{/);
  assert.match(src, /文件缺失/);
  assert.match(src, /else if \(run\) \{/);
});

test("node 半 profiles 路由标注 modelMissing(existsSync 校验 modelPath)", async () => {
  const idxSrc = readFileSync(join(root, "index.js"), "utf8");
  assert.match(idxSrc, /path: "\/api\/mm\/profiles"/);
  assert.match(idxSrc, /modelMissing: typeof p\.modelPath === "string" && p\.modelPath \? !existsSync\(p\.modelPath\) : false/);
  // existsSync 已在 index.js 顶部导入
  assert.match(idxSrc, /import \{[^}]*existsSync[^}]*\} from "node:fs"/);
});
