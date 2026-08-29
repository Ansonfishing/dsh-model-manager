// safety: 杀进程红线不变量——只 fuser -k <port>/tcp 或 kill 自身 spawn 的 PID,
// 绝不 pkill;未注册拒盲杀;外部需 force。无特殊保护端口(11437 保护已移除)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROTECTED_PORTS, stopPlan, assertNoPkill, realPidAlive } from "../lib/safety.js";

test("DEFAULT_PROTECTED_PORTS 为空(11437 不再特殊对待)", () => {
  assert.deepEqual(DEFAULT_PROTECTED_PORTS, []);
});

test("托管服务 + pid 存活 → kill -TERM <pid>", () => {
  const argv = stopPlan(11436, { managed: true, pid: 4242 }, { pidAlive: () => true });
  assert.deepEqual(argv, ["kill", "-TERM", "4242"]);
});

test("托管服务 + pid 已死 → 回退 fuser -k <port>/tcp", () => {
  const argv = stopPlan(11436, { managed: true, pid: 4242 }, { pidAlive: () => false });
  assert.deepEqual(argv, ["fuser", "-k", "11436/tcp"]);
});

test("外部服务无 force → 拒绝", () => {
  assert.throws(() => stopPlan(11436, { managed: false }, {}), /force/);
});

test("外部服务 force=true → fuser -k <port>/tcp", () => {
  const argv = stopPlan(11436, { managed: false }, { force: true });
  assert.deepEqual(argv, ["fuser", "-k", "11436/tcp"]);
});

test("未注册端口 → 拒绝", () => {
  assert.throws(() => stopPlan(9999, null, { force: true }), /未注册|unregistered/i);
});

test("11437 保护已放开(用户确认):行为等同外部服务", () => {
  // 外部 + 无 force → 仍要求显式确认
  assert.throws(() => stopPlan(11437, { managed: false }, {}), /force/);
  // 外部 + force → fuser -k <port>/tcp
  assert.deepEqual(stopPlan(11437, { managed: false }, { force: true }), ["fuser", "-k", "11437/tcp"]);
  // 托管条目 + 存活 pid → kill 托管 pid(不再被保护清单拦截)
  assert.deepEqual(stopPlan(11437, { managed: true, pid: 1 }, { force: true, pidAlive: () => true }), ["kill", "-TERM", "1"]);
});

test("不变量:stopPlan 所有输出形状都不含 pkill", () => {
  const plans = [
    stopPlan(11436, { managed: true, pid: 1 }, { pidAlive: () => true }),
    stopPlan(11436, { managed: true, pid: 1 }, { pidAlive: () => false }),
    stopPlan(11436, { managed: false }, { force: true }),
  ];
  for (const argv of plans) assertNoPkill(argv);
});

test("assertNoPkill 对 pkill argv 必抛", () => {
  assert.throws(() => assertNoPkill(["pkill", "-f", "llama-server"]), /pkill/);
  assert.throws(() => assertNoPkill(["/usr/bin/pkill", "vllm"]), /pkill/);
});

test("realPidAlive: 自身 pid 存活,超大 pid 不存活", () => {
  assert.equal(realPidAlive(process.pid), true);
  assert.equal(realPidAlive(99999999), false);
});
