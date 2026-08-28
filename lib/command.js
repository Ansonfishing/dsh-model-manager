// launchCommand 解析/序列化(独立模块,避免 validate <-> adapters 循环依赖)

/**
 * "​-np 1 -c 524288 --cache-type-k q4_0 --flag=value" → [{flag, value}, ...] 保序。
 * 无值 flag → value:"";支持 --flag=value;空串 → []。
 */
export function parseLaunchCommand(str) {
  if (typeof str !== "string") return [];
  const tokens = str.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-")) {
      out.push({ flag: t, value: "" }); // 游离 token,保留位置
      continue;
    }
    const eq = t.indexOf("=");
    if (eq > 0) {
      out.push({ flag: t.slice(0, eq), value: t.slice(eq + 1) });
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      out.push({ flag: t, value: next });
      i++;
    } else {
      out.push({ flag: t, value: "" });
    }
  }
  return out;
}

/** [{flag, value}] → "-c 524288 --slots"(无值 flag 只输出 flag),与 parseLaunchCommand 往返一致。 */
export function buildLaunchCommand(flags) {
  return flags
    .map((f) => (f.value === "" ? f.flag : `${f.flag} ${f.value}`))
    .join(" ");
}

/** launchCommand 展开成 spawn 参数数组(flag + value 原序)。 */
export function launchTokens(str) {
  const args = [];
  for (const f of parseLaunchCommand(str)) {
    args.push(f.flag);
    if (f.value !== "") args.push(f.value);
  }
  return args;
}
