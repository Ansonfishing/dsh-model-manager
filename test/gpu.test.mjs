// gpu: 卡名短化 / CUDA & NVML 解析 / 检测回退链 / 短名规则(全 fake exec,不碰真实 GPU)
// 卡编号口径 = CUDA_VISIBLE_DEVICES 值(CUDA 设备序),不是 nvidia-smi(NVML)物理序。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试用独立 DSH_HOME,避免读到本机 ~/.dsh/model-manager 的 builtin-gpus.local.json
// (必须在 import gpu.js 前设置:BUILTIN_GPUS 在模块加载时求值)。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "mm-gpu-test-"));

const {
  shortGpuName,
  parseCudaOut,
  parseNvmlOut,
  detectGpus,
  BUILTIN_GPUS,
  loadBuiltinGpus,
} = await import("../lib/gpu.js");

test("shortGpuName: 去品牌/营销词,留型号+容量", () => {
  assert.equal(shortGpuName("NVIDIA GeForce RTX 4090"), "4090");
  assert.equal(shortGpuName("NVIDIA RTX PRO 6000 Blackwell"), "PRO 6000");
  assert.equal(shortGpuName("NVIDIA H100 80GB HBM3"), "H100 80GB HBM3");
  assert.equal(shortGpuName("NVIDIA A100-PCIE-80GB"), "A100-PCIE-80GB");
  assert.equal(shortGpuName("NVIDIA L40S"), "L40S");
  assert.equal(shortGpuName("NVIDIA DGX A100"), "DGX A100");
  assert.equal(shortGpuName(""), "");
  assert.equal(shortGpuName("   "), "");
});

test("shortGpuName: 超长名截断带省略号,结果非空", () => {
  const long = "NVIDIA Some Very Long GPU Family Name That Exceeds The Panel Limit 80GB";
  const s = shortGpuName(long);
  assert.ok(s.length > 0);
  assert.ok(s.endsWith("…"));
  assert.ok(s.length <= 26);
});

test("parseCudaOut: python JSON → 规范化卡(memMiB→memGb, 附 shortName)", () => {
  const out = JSON.stringify({
    ok: true,
    cards: [
      { index: 0, name: "NVIDIA GeForce RTX 4090", memMiB: 49140 },
      { index: 1, name: "NVIDIA RTX PRO 6000 Blackwell", memMiB: 98304 },
    ],
  });
  const cards = parseCudaOut("some stray line\n" + out + "\n");
  assert.deepEqual(cards, [
    { index: 0, name: "NVIDIA GeForce RTX 4090", shortName: "4090", memGb: 48 },
    { index: 1, name: "NVIDIA RTX PRO 6000 Blackwell", shortName: "PRO 6000", memGb: 96 },
  ]);
});

test("parseCudaOut: ok=false / 无 JSON → 抛错", () => {
  assert.throws(
    () => parseCudaOut(JSON.stringify({ ok: false, error: "cuInit != 0 (驱动不可用)" })),
    /cuInit != 0/,
  );
  assert.throws(() => parseCudaOut("no json here"), /无 JSON 输出/);
  assert.throws(() => parseCudaOut(JSON.stringify({ ok: true, cards: [] })), /0 张卡|没有/);
});

test("parseNvmlOut: csv 行 → {count, names}(只取集合,不产编号映射);空输入抛错", () => {
  const r = parseNvmlOut(
    "0, NVIDIA RTX PRO 6000 Blackwell, 98304\n1, NVIDIA GeForce RTX 4090, 49140\n",
  );
  assert.equal(r.count, 2);
  assert.deepEqual(r.names, ["PRO 6000", "4090"]);
  assert.throws(() => parseNvmlOut("  \n"), /无有效卡/);
});

test("detectGpus: 主源 = CUDA 驱动序(与 CUDA_VISIBLE_DEVICES 选择序一致)", () => {
  const calls = [];
  const exec = (argv) => {
    calls.push(argv[0]);
    if (argv[0] === "python3") {
      return JSON.stringify({
        ok: true,
        cards: [
          { index: 0, name: "NVIDIA GeForce RTX 4090", memMiB: 49140 },
          { index: 1, name: "NVIDIA RTX PRO 6000 Blackwell", memMiB: 98304 },
        ],
      });
    }
    throw new Error("不应走到 nvidia-smi");
  };
  const r = detectGpus({ exec });
  assert.equal(r.source, "cuda");
  assert.deepEqual(calls, ["python3"]);
  assert.equal(r.cards[0].shortName, "4090");
  assert.equal(r.cards[1].shortName, "PRO 6000");
});

test("detectGpus: CUDA 失败 → 回退 nvidia-smi(source=nvml,只取 count+names,不产编号映射)", () => {
  const exec = (argv) => {
    if (argv[0] === "python3") throw new Error("libcuda.so.1 加载失败");
    return "0, NVIDIA RTX PRO 6000 Blackwell, 98304\n1, NVIDIA GeForce RTX 4090, 49140\n";
  };
  const r = detectGpus({ exec });
  assert.equal(r.source, "nvml");
  assert.equal(r.cards, null); // NVML 序与 CUDA 序本机相反 → 绝不写编号→卡名映射
  assert.equal(r.count, 2);
  assert.deepEqual(r.names, ["PRO 6000", "4090"]);
});

test("detectGpus: 两源皆败 → 抛聚合错误", () => {
  const exec = () => {
    throw new Error("boom");
  };
  assert.throws(() => detectGpus({ exec }), /GPU 获取失败/);
});

test("BUILTIN_GPUS: 仓库默认无内置表({}),本机约定走本地文件", () => {
  assert.equal(Object.keys(BUILTIN_GPUS).length, 0);
});

test("loadBuiltinGpus: 读 <home>/builtin-gpus.local.json;缺失/损坏/非对象 → {}", () => {
  const home = mkdtempSync(join(tmpdir(), "mm-builtin-"));
  try {
    assert.deepEqual(loadBuiltinGpus(home), {}, "文件不存在 → {}");
    writeFileSync(join(home, "builtin-gpus.local.json"), JSON.stringify({ 0: { name: "GPU-A", memGb: 24 } }));
    assert.deepEqual(loadBuiltinGpus(home), { 0: { name: "GPU-A", memGb: 24 } }, "正常文件");
    writeFileSync(join(home, "builtin-gpus.local.json"), "{not json");
    assert.deepEqual(loadBuiltinGpus(home), {}, "损坏 → {}");
    writeFileSync(join(home, "builtin-gpus.local.json"), "[1,2]");
    assert.deepEqual(loadBuiltinGpus(home), {}, "非对象 → {}");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
