// llama.cpp llama-server adapter
import { launchTokens } from "../command.js";

export const llama = {
  name: "llama",
  defaultExe: "llama-server",

  // 就绪锚点:tools/server/server-context.cpp:1177
  // "llama_context: initializing, n_slots = %d, n_ctx_slot = %d"
  readyRe: [/initializing, n_slots = \d+, n_ctx_slot = \d+/],

  healthUrl: (port) => `http://127.0.0.1:${port}/health`,
  modelsUrl: (port) => `http://127.0.0.1:${port}/v1/models`,

  /**
   * 拼装启动命令。-m/--port 由插件托管;launchCommand 原序展开追加。
   * profile.exePath 可覆盖可执行文件路径(自定义构建)。
   */
  buildArgs(profile, { port }) {
    const exe = profile.exePath || this.defaultExe;
    const args = ["-m", profile.modelPath, "--port", String(port)];
    args.push(...launchTokens(profile.launchCommand));
    return { exe, args };
  },
};
