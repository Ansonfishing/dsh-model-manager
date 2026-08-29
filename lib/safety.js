// 红线不变量:只 fuser -k <port>/tcp 或 kill 本插件 spawn 的 PID;
// 绝不 pkill -f 框架名(会杀掉当前会话模型);未注册端口拒盲杀;外部服务需 force。

/** 受保护端口(仅作 UI 标记,不阻断停止)。当前为空——所有端口一视同仁。 */
export const DEFAULT_PROTECTED_PORTS = [];

/** 真实 pid 存活检查:kill(pid, 0) 探测;EPERM=存活(无权限),ESRCH=不存在。 */
export function realPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === "EPERM");
  }
}

/** 不变量守卫:任何含 pkill 的 argv 一律拒绝执行。 */
export function assertNoPkill(argv) {
  if (Array.isArray(argv) && argv.some((a) => {
    if (typeof a !== "string") return false;
    return a.split("/").pop() === "pkill";
  })) {
    throw new Error(`refusing to run pkill (red line): ${argv.join(" ")}`);
  }
}

/**
 * 停止某端口的执行计划(只产出 argv,不执行)。检查顺序:注册 → 托管/外部。
 * - 未注册:拒绝盲杀。
 * - 托管 + pid 存活:kill -TERM <pid>(精确杀自己 spawn 的进程)。
 * - 托管 + pid 已死 / 外部 + force:fuser -k <port>/tcp。
 * - 外部 + 无 force:拒绝(要求显式确认)。
 * 注意:11437 不再拒绝停止(保护已降级为 UI 提示),
 * 停止它 = 停当前会话在用的服务,面板侧用二次确认做护栏。
 */
export function stopPlan(port, entry, opts = {}) {
  const {
    force = false,
    pidAlive = realPidAlive,
  } = opts;

  if (!entry) {
    throw new Error(`port ${port} 未注册 (unregistered),拒绝盲杀——请先 mm_server_register`);
  }
  if (entry.managed) {
    if (entry.pid && pidAlive(entry.pid)) {
      return ["kill", "-TERM", String(entry.pid)];
    }
    return ["fuser", "-k", `${port}/tcp`];
  }
  if (!force) {
    throw new Error(`port ${port} 是外部服务(非本插件启动),需 force=true 确认后用 fuser -k 停止`);
  }
  return ["fuser", "-k", `${port}/tcp`];
}
