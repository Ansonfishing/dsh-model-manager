// GPU 检测集成(lifecycle):首次启动自动获取一次 / 之后全手动 / NVML 降级不落映射 /
// 手动重取覆盖 / 损坏文件不崩且可修复 / validateProfile gpuCap 用检测值
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManager } from "../lib/lifecycle.js";
import { validateProfile } from "../lib/validate.js";

const DETECT = {
  source: "cuda",
  cards: [
    { index: 0, name: "NVIDIA GeForce RTX 4090", shortName: "4090", memGb: 48 },
    { index: 1, name: "NVIDIA RTX PRO 6000 Blackwell", shortName: "PRO 6000", memGb: 96 },
  ],
};
const DETECT_3CARDS = {
  source: "cuda",
  cards: [
    { index: 0, name: "NVIDIA GeForce RTX 4090", shortName: "4090", memGb: 48 },
    { index: 1, name: "NVIDIA RTX PRO 6000 Blackwell", shortName: "PRO 6000", memGb: 96 },
    { index: 2, name: "NVIDIA L40S", shortName: "L40S", memGb: 48 },
  ],
};
const DETECT_NVML = { source: "nvml", cards: null, count: 2, names: ["PRO 6000", "4090"] };

// detectRef 是 getter:测试可在 createManager 之后重赋局部 detect(模拟"修好驱动"),
// 值传递会捕获旧绑定导致手动重取仍抛旧 Error。
function baseDeps(home, calls, detectRef) {
  return {
    home,
    fetchFn: async () => ({ ok: true, status: 200 }),
    execFn: async (argv) => {},
    spawnFn: () => ({ pid: 7001, unref() {} }),
    pidAlive: () => false,
    detectFn: () => {
      calls.push(1);
      const d = detectRef();
      if (d instanceof Error) throw d;
      return d ?? DETECT;
    },
  };
}

function makeManager(detect = DETECT) {
  const home = mkdtempSync(join(tmpdir(), "mm-gpu-"));
  const calls = [];
  const m = createManager(baseDeps(home, calls, () => detect));
  return { m, home, calls, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("首次启动(gpus.json 缺失)→ 自动检测恰好一次并落盘", (t) => {
  const { m, home, calls, cleanup } = makeManager();
  t.after(cleanup);
  assert.equal(calls.length, 1, "createManager 时自动检测一次");
  const info = m.gpus();
  assert.equal(info.gpus.source, "cuda");
  assert.equal(info.gpus.cards[0].shortName, "4090");
  assert.equal(info.gpus.cards[1].shortName, "PRO 6000");
  assert.equal(info.lastError, null);
  assert.ok(info.builtin, "暴露内置回退表供 UI");
  assert.ok(existsSync(join(home, "gpus.json")), "gpus.json 已落盘");
});

test("gpus.json 已存在 → 再次启动不再自动检测(之后全手动)", (t) => {
  const { m, home, calls, cleanup } = makeManager();
  t.after(cleanup);
  assert.equal(calls.length, 1);
  const m2 = createManager(baseDeps(home, calls, () => DETECT));
  assert.equal(calls.length, 1, "第二次启动:已落盘 → 不调用 detectFn");
  void m2;
});

test("NVML 降级 → 落盘 cards=null(不写编号映射)+ count/names", (t) => {
  const { m, home, cleanup } = makeManager(DETECT_NVML);
  t.after(cleanup);
  const info = m.gpus();
  assert.equal(info.gpus.source, "nvml");
  assert.equal(info.gpus.cards, null, "NVML 序绝不写编号→卡名/显存映射");
  assert.equal(info.gpus.count, 2);
  assert.deepEqual(info.gpus.names, ["PRO 6000", "4090"]);
  const raw = JSON.parse(readFileSync(join(home, "gpus.json"), "utf8"));
  assert.equal(raw.cards, null);
});

test("两源皆败 → 不崩;lastError 记录;手动重取修复", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mm-gpu-"));
  const calls = [];
  let detect = new Error("GPU 获取失败: cuda: cuInit != 0 | nvml: no devices");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const m = createManager(baseDeps(home, calls, () => detect));
  assert.equal(calls.length, 1, "首次启动尝试过一次");
  const info = m.gpus();
  assert.equal(info.gpus, null);
  assert.match(info.lastError, /GPU 获取失败/);
  // 修好驱动后手动重取 → 覆盖落盘,lastError 清除
  detect = DETECT;
  const stored = m.detectGpusNow();
  assert.equal(stored.source, "cuda");
  assert.equal(m.gpus().lastError, null);
  assert.equal(m.gpus().gpus.cards.length, 2);
});

test("手动重取 → 覆盖旧结果(卡数跟随检测结果)", (t) => {
  const { m, cleanup } = makeManager();
  t.after(cleanup);
  assert.equal(m.gpus().gpus.cards.length, 2);
  const detect3 = { source: "cuda", cards: DETECT_3CARDS.cards };
  // 再建一个共享 home 的 manager,detectFn 返回 3 卡
  const calls2 = [];
  const m2 = createManager(baseDeps(m.home, calls2, () => detect3));
  assert.equal(calls2.length, 0, "gpus.json 已存在 → 不再自动检测");
  const stored = m2.detectGpusNow();
  assert.equal(stored.cards.length, 3);
  assert.equal(m2.gpus().gpus.cards.length, 3, "重取后 gpus() 反映 3 卡");
  assert.equal(m.gpus().gpus.cards.length, 3, "同一 home 的两个 manager 共享 gpus.json");
});

test("gpus.json 损坏 → 不崩,按内置约定运行,手动重取修复", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mm-gpu-"));
  const calls = [];
  let detect = new Error("GPU 获取失败: 两源皆败");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "gpus.json"), "{corrupt-json!!", "utf8");
  const m = createManager(baseDeps(home, calls, () => detect));
  const info = m.gpus();
  assert.equal(info.gpus, null, "损坏文件视为未检测");
  assert.match(info.lastError, /损坏|corrupt/);
  // 手动重取成功 → 覆盖损坏文件
  detect = DETECT;
  m.detectGpusNow();
  assert.equal(m.gpus().gpus.source, "cuda");
  assert.equal(m.gpus().lastError, null);
});

test("validateProfile gpuCap:检测值(24G)触发 KV 告警,无 gpuCap 且无内置表不触发", () => {
  const profile = {
    name: "t", modelPath: "/x", framework: "llama", gpu: 0,
    kvBytesPerToken: 6400,
    launchCommand: "-c 4000000 -np 2", // KV ≈ 4000000×6400/1e9 = 25.6G
  };
  const withCap = validateProfile(profile, { gpuCap: { 0: 24 } });
  assert.ok(
    withCap.warnings.some((w) => /超出 GPU 0 的 24G 容量/.test(w)),
    "gpuCap=24G 应触发告警: " + JSON.stringify(withCap.warnings),
  );
  const noCap = validateProfile(profile, {});
  assert.ok(
    !noCap.warnings.some((w) => /KV 估算/.test(w)),
    "无 gpuCap 且无内置表不应触发 KV 告警: " + JSON.stringify(noCap.warnings),
  );
});
