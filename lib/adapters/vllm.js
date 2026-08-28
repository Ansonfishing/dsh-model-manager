// vLLM OpenAI 兼容服务 adapter
import { launchTokens } from "../command.js";

export const vllm = {
  name: "vllm",
  defaultExe: "python3",

  // 就绪锚点:vLLM 启动日志
  readyRe: [
    /Starting OpenAI-compatible API server at \d+\.\d+\.\d+\.\d+:\d+/,
    /Application startup complete/,
  ],

  healthUrl: (port) => `http://127.0.0.1:${port}/health`,
  modelsUrl: (port) => `http://127.0.0.1:${port}/v1/models`,

  buildArgs(profile, { port }) {
    const exe = profile.exePath || this.defaultExe;
    const args = [
      "-m", "vllm.entrypoints.openai.api_server",
      "--model", profile.modelPath,
      "--port", String(port),
    ];
    args.push(...launchTokens(profile.launchCommand));
    return { exe, args };
  },
};
