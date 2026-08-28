// GPU 显卡信息获取(卡编号口径 = CUDA_VISIBLE_DEVICES 值,即 CUDA 设备序)。
//
// 为什么不用 nvidia-smi 当主源:部分机器上 nvidia-smi(NVML)物理序与 CUDA 设备序相反,
// 按 NVML 序号贴卡名会把 0/1 标反。
// 主源 = python3 + ctypes 调驱动 libcuda.so.1(cuDeviceGetName/cuDeviceTotalMem):
//   枚举序 == CUDA_VISIBLE_DEVICES 选择序,与插件 spawn 时 CUDA_VISIBLE_DEVICES=g 的实际落卡一致;
//   只依赖驱动自带的 libcuda(无需 CUDA toolkit / torch),python3 -c 一次调用。
// 降级源 = nvidia-smi(NVML 序):**只取卡数与卡名集合展示,绝不产编号→卡名/显存映射**
//   (result.cards=null),防止 NVML/CUDA 序相反导致编号标反;显存校验继续用内置回退表。
// 两源皆败 → 抛聚合错误;调用方(lifecycle)保留内置约定(BUILTIN_GPUS),不阻塞启动。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoPkill } from "./safety.js";
import { mmHome } from "./store.js";

/**
 * 内置卡回退表(检测不可用时的兜底,口径 = CUDA_VISIBLE_DEVICES 值)。
 * 用户本机约定不入库:写 <mmHome>/builtin-gpus.local.json,如
 *   { "0": { "name": "GPU-A", "memGb": 24 }, "1": { "name": "GPU-B", "memGb": 48 } }
 * 文件不存在/非法/损坏 → {}(显存校验对未知卡跳过,不猜测)。
 */
export function loadBuiltinGpus(home) {
  const p = join(home, "builtin-gpus.local.json");
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    /* 损坏 → 视为无内置表 */
  }
  return {};
}

export const BUILTIN_GPUS = loadBuiltinGpus(mmHome());

/** GPU 显存容量表(GiB),key = CUDA_VISIBLE_DEVICES 值;由内置回退表派生,缺省 {}。 */
export const GPU_CAP_GB = Object.fromEntries(
  Object.entries(BUILTIN_GPUS)
    .map(([k, v]) => [Number(k), Number(v && v.memGb)])
    .filter(([, cap]) => Number.isFinite(cap))
);

/* python3 + ctypes 驱动 API(libcuda.so.1 随驱动安装,无需 toolkit) */
const PYTHON_CUDA_SCRIPT = `
import ctypes, json, sys
def fail(msg):
    print(json.dumps({"ok": False, "error": msg})); sys.exit(0)
try:
    lib = ctypes.CDLL("libcuda.so.1")
except Exception as e:
    fail("libcuda.so.1 加载失败: " + str(e))
if lib.cuInit(0) != 0:
    fail("cuInit != 0 (驱动不可用)")
count = ctypes.c_int()
if lib.cuDeviceGetCount(ctypes.byref(count)) != 0:
    fail("cuDeviceGetCount 失败")
if count.value == 0:
    fail("检测到 0 个 CUDA 设备")
cards = []
for i in range(count.value):
    name = ctypes.create_string_buffer(256)
    lib.cuDeviceGetName(name, 256, ctypes.c_int(i))
    mem = ctypes.c_size_t()
    lib.cuDeviceTotalMem(ctypes.byref(mem), ctypes.c_int(i))
    cards.append({"index": i, "name": name.value.decode("utf-8", "replace"), "memMiB": mem.value // (1024 * 1024)})
print(json.dumps({"ok": True, "cards": cards}))
`;

const NVML_CMD = [
  "nvidia-smi",
  "--query-gpu=index,name,memory.total",
  "--format=csv,noheader,nounits",
];

/** 真实 exec:捕获 stdout;红线 assertNoPkill;超时 20s。 */
export function realGpuExec(argv) {
  assertNoPkill(argv);
  return execFileSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/* ---------- 短名:长显卡名 → 面板显示名(全名留 tooltip) ----------
 * 规则:去 NVIDIA / GeForce / 开头 RTX(留 PRO 等实义前缀)/ 尾部架构营销词(Blackwell 等);
 * 保留型号与容量(80GB/48G);仍超长则按词截断 +「…」。 */
const ARCH_WORDS = [
  "Blackwell", "Ada Lovelace", "Hopper", "Ampere",
  "Turing", "Volta", "Pascal", "Maxwell", "Orin",
];

export function shortGpuName(raw) {
  const orig = String(raw || "").trim();
  if (!orig) return "";
  let s = orig
    .replace(/^NVIDIA\s+/i, "")
    .replace(/Ge\s?Force\s+/i, "")
    .replace(/^RTX\s+/i, "");
  for (const w of ARCH_WORDS) {
    s = s.replace(new RegExp("\\s+" + w + "$", "i"), "");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s) s = orig;
  if (s.length > 24) {
    const head = s.slice(0, 25);
    const sp = head.lastIndexOf(" ");
    const cut = sp > 12 ? head.slice(0, sp) : s.slice(0, 24);
    s = cut + "…";
  }
  return s;
}

/* ---------- 解析(纯函数,可注入测试) ---------- */

function normalizeCudaCard({ index, name, memMiB }) {
  return {
    index: Number(index),
    name: String(name || ""),
    shortName: shortGpuName(name),
    memGb: Math.max(1, Math.round((Number(memMiB) || 0) / 1024)),
  };
}

/** python CUDA 探测输出 → [{index, name, shortName, memGb}](CUDA 序,可信映射)。 */
export function parseCudaOut(text) {
  const line = String(text || "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) {
    throw new Error("python CUDA 探测无 JSON 输出: " + String(text || "").slice(0, 120));
  }
  const d = JSON.parse(line);
  if (!d || d.ok !== true) {
    throw new Error((d && d.error) || "CUDA 探测失败");
  }
  const cards = (Array.isArray(d.cards) ? d.cards : []).map(normalizeCudaCard);
  if (!cards.length) throw new Error("CUDA 探测返回 0 张卡");
  return cards;
}

/** nvidia-smi csv 输出 → {count, names}(只有集合,无编号映射——NVML 序不可信)。 */
export function parseNvmlOut(text) {
  const rows = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.split(",")[1] || "").trim())
    .filter(Boolean);
  if (!rows.length) throw new Error("nvidia-smi 输出无有效卡");
  return { count: rows.length, names: rows.map(shortGpuName) };
}

/**
 * 检测显卡。
 * @param {object} opts { exec: (argv) => stdout string }(测试可注入 fake)
 * @returns {Promise 不需要;同步} {source:"cuda", cards:[...]} | {source:"nvml", cards:null, count, names}
 * @throws 两源皆败时抛聚合错误(消息含两源各自原因)
 */
export function detectGpus({ exec = realGpuExec } = {}) {
  const errors = [];
  try {
    const cards = parseCudaOut(exec(["python3", "-c", PYTHON_CUDA_SCRIPT]));
    return { source: "cuda", cards };
  } catch (err) {
    errors.push("cuda: " + (err && err.message ? err.message : String(err)));
  }
  try {
    const nv = parseNvmlOut(exec(NVML_CMD));
    return { source: "nvml", cards: null, count: nv.count, names: nv.names };
  } catch (err) {
    errors.push("nvml: " + (err && err.message ? err.message : String(err)));
  }
  throw new Error("GPU 获取失败: " + errors.join(" | "));
}
