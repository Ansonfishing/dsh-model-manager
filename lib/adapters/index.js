// 框架适配层:llama / vllm / sglang
import { llama } from "./llama.js";
import { vllm } from "./vllm.js";
import { sglang } from "./sglang.js";

export const adapters = { llama, vllm, sglang };

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) {
    throw new Error(`unknown framework (未知): ${name}(支持 llama / vllm / sglang)`);
  }
  return a;
}
