// profile 保存前校验:errors 阻断,warnings 提示不阻断
import { parseLaunchCommand } from "./command.js";
export { parseLaunchCommand, buildLaunchCommand } from "./command.js";
import { adapters } from "./adapters/index.js";
import { GPU_CAP_GB } from "./gpu.js";

/** llama 的托管参数:由插件拼装进命令,禁止写进 launchCommand。 */
const MANAGED_LLAMA_FLAGS = new Set(["-m", "--model", "--port", "--host"]);

/**
 * 校验参数 profile。约定:
 * llama per-slot 上下文 = 模型原生最大上下文,-c 必须 = 原生 × -np(整除硬校验,
 * per-slot < 原生为 warning——per-slot 低于 DSH 默认 262K 会让 ACP/compaction 80% 阈值算错)。
 */
/**
 * @param {object} opts
 * @param {Array<{port:number}>} [opts.registry] 注册表端口(占用校验)
 * @param {Record<number, number>} [opts.gpuCap] 检测到的卡显存(GiB,编号=CUDA 序);
 *   缺省时回退内置表 GPU_CAP_GB。NVML 降级(无编号映射)时调用方不传此参数。
 */
export function validateProfile(profile, { registry = [], gpuCap } = {}) {
  const errors = [];
  const warnings = [];

  if (!profile || typeof profile !== "object") {
    return { ok: false, errors: ["profile 必须是对象"], warnings };
  }

  if (!profile.name) errors.push("缺 name");
  if (!profile.modelPath) errors.push("缺 modelPath(模型文件/目录路径)");
  if (!adapters[profile.framework]) {
    errors.push(`未知 framework: ${profile.framework}(支持 llama / vllm / sglang)`);
  }

  if (profile.port !== undefined) {
    const p = profile.port;
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      errors.push(`port 非法: ${p}(必须是 1–65535 的整数)`);
    } else if (registry.some((r) => r.port === p)) {
      errors.push(`port ${p} 已被注册表占用 (in use)`);
    }
  }

  const flags = parseLaunchCommand(profile.launchCommand);
  const val = (f) => {
    const x = flags.find((y) => y.flag === f);
    return x ? x.value : null; // null=缺省, ""=存在但无值
  };

  if (profile.framework === "llama") {
    if (flags.some((f) => MANAGED_LLAMA_FLAGS.has(f.flag))) {
      errors.push("llama 的 -m/--model/--port/--host 由插件托管,不要写进 launchCommand");
    }
    const c = Number(val("-c"));
    const npRaw = val("-np");
    const np = npRaw === null ? 1 : Number(npRaw);
    if (Number.isFinite(c) && c > 0) {
      if (!Number.isInteger(np) || np < 1) {
        errors.push(`-np 非法: ${npRaw ?? ""}`);
      } else if (c % np !== 0) {
        errors.push(`-c ${c} 不能被 -np ${np} 整除 (not divisible):per-slot 上下文必须为整数`);
      } else if (profile.contextWindow && c / np < profile.contextWindow) {
        warnings.push(
          `per-slot 上下文 ${c / np} 低于原生 ${profile.contextWindow}:` +
          `llama 约定 -c = 原生 × -np,当前值会让 DSH compaction 80% 阈值提前触发`
        );
      }
    }
  }

  // KV 显存粗估:llama 用 -c 总预算,其他框架用 contextWindow(单请求预算)
  const ctxTokens = profile.framework === "llama"
    ? Number(val("-c")) || 0
    : Number(profile.contextWindow) || 0;
  const kvBytesPerToken = Number(profile.kvBytesPerToken) || 65536; // 缺省按 bf16 上限估
  // 显存容量:优先检测值(gpuCap,编号=CUDA 序),缺省回退内置表
  // 双卡:gpu 为字符串(如 "1,0")或 null 时不单卡估(多卡合计容量不适用单卡公式),跳过单卡 warning
  const singleGpu = Number.isInteger(profile.gpu) ? profile.gpu : null;
  const cap = singleGpu !== null
    ? (gpuCap && Number.isFinite(gpuCap[singleGpu]) ? gpuCap[singleGpu] : GPU_CAP_GB[singleGpu])
    : undefined;
  if (ctxTokens > 0 && cap) {
    const kvGb = (ctxTokens * kvBytesPerToken) / 1e9;
    if (kvGb > cap - 1) {
      warnings.push(
        `KV 估算 ~${kvGb.toFixed(0)}G,超出 GPU ${singleGpu} 的 ${cap}G 容量(KV 单独估算,` +
        `未计权重,实际 OOM 风险更高)——例:262K bf16 KV ≈ 49G,超出 48G 卡容量必崩`
      );
    }
  }

  if (profile.framework === "sglang") {
    if (val("--speculative-num-draft-tokens") !== null) {
      warnings.push(
        "--speculative-num-draft-tokens 必须等于草稿模型 block_size (must equal draft block_size)," +
        "不等会启动即崩 (ValueError: For DFLASH they must match)"
      );
    }
    if (val("--enable-cache-report") === null) {
      warnings.push("缺 --enable-cache-report:不加则 SGLang 不回报缓存命中,DSH 底部命中率恒 0%");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
