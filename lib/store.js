// 持久化:~/.dsh/model-manager/ 下的 JSON/JSONL 原子读写
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync,
  openSync, writeSync, closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/** 插件数据目录(惰性读 DSH_HOME;测试里通过 env 指向临时目录)。 */
export function mmHome() {
  const root = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(root, "model-manager");
}

/**
 * 文件存储。相对路径相对 home 解析。
 * - loadJSON: ENOENT → fallback;JSON 损坏 → 抛错(不静默吞数据)。
 * - saveJSON: tmp + rename 原子写,无 .tmp 残留。
 * - readJSONL: 文件不存在 → [];跳过空行。
 */
export function createStore(home = mmHome()) {
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "servers"), { recursive: true });

  return {
    home: () => home,

    loadJSON(file, fallback) {
      const p = join(home, file);
      if (!existsSync(p)) return fallback;
      const raw = readFileSync(p, "utf8");
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(`corrupt JSON at ${p}: ${err.message}`);
      }
    },

    saveJSON(file, value) {
      const p = join(home, file);
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
      renameSync(tmp, p);
    },

    appendJSONL(file, obj) {
      const p = join(home, file);
      mkdirSync(dirname(p), { recursive: true });
      const fd = openSync(p, "a");
      try {
        writeSync(fd, JSON.stringify(obj) + "\n");
      } finally {
        closeSync(fd);
      }
    },

    readJSONL(file) {
      const p = join(home, file);
      if (!existsSync(p)) return [];
      return readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    },
  };
}
