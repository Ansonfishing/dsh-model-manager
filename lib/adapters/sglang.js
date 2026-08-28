// SGLang 服务 adapter
import { launchTokens } from "../command.js";

export const sglang = {
  name: "sglang",
  defaultExe: "python3",

  // 就绪锚点:SGLang 启动日志
  readyRe: [
    /The server is fired up and ready to roll/,
    /Uvicorn running on http:/,
  ],

  healthUrl: (port) => `http://127.0.0.1:${port}/health`,
  modelsUrl: (port) => `http://127.0.0.1:${port}/v1/models`,

  buildArgs(profile, { port }) {
    const exe = profile.exePath || this.defaultExe;
    const args = [
      "-m", "sglang.launch_server",
      "--model-path", profile.modelPath,
      "--port", String(port),
    ];
    args.push(...launchTokens(profile.launchCommand));
    return { exe, args };
  },
};
