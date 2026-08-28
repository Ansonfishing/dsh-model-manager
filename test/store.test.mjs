// store: JSON/JSONL 原子读写（~/.dsh/model-manager/）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, mmHome } from "../lib/store.js";

const home = mkdtempSync(join(tmpdir(), "mm-store-"));
const store = createStore(home);
test.after(() => rmSync(home, { recursive: true, force: true }));

test("createStore home is the given dir", () => {
  assert.equal(store.home(), home);
});

test("mmHome resolves under DSH_HOME/model-manager (lazy env)", () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = "/tmp/fake-dsh";
  try {
    assert.equal(mmHome(), "/tmp/fake-dsh/model-manager");
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test("loadJSON returns fallback for missing file", () => {
  assert.deepEqual(store.loadJSON("servers.json", []), []);
  assert.deepEqual(store.loadJSON("config.json", {}), {});
});

test("saveJSON writes and roundtrips", () => {
  store.saveJSON("servers.json", [{ port: 11437, model: "x" }]);
  assert.deepEqual(store.loadJSON("servers.json", []), [{ port: 11437, model: "x" }]);
  assert.ok(existsSync(join(home, "servers.json")));
});

test("saveJSON overwrites existing content", () => {
  store.saveJSON("p.json", [1]);
  store.saveJSON("p.json", [2, 3]);
  assert.deepEqual(store.loadJSON("p.json", []), [2, 3]);
});

test("saveJSON is atomic: no .tmp residue after write", () => {
  store.saveJSON("t.json", { a: 1 });
  const residue = readdirSync(home).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});

test("loadJSON throws on corrupt JSON (no silent data loss)", () => {
  writeFileSync(join(home, "corrupt.json"), "{oops");
  assert.throws(() => store.loadJSON("corrupt.json", []), /corrupt/i);
});

test("appendJSONL appends one line per call", () => {
  store.appendJSONL("b.jsonl", { i: 1 });
  store.appendJSONL("b.jsonl", { i: 2 });
  assert.deepEqual(store.readJSONL("b.jsonl"), [{ i: 1 }, { i: 2 }]);
});

test("readJSONL returns [] for missing file", () => {
  assert.deepEqual(store.readJSONL("nope.jsonl"), []);
});

test("readJSONL skips empty lines", () => {
  writeFileSync(join(home, "raw.jsonl"), '{"a":1}\n\n{"b":2}\n');
  assert.deepEqual(store.readJSONL("raw.jsonl"), [{ a: 1 }, { b: 2 }]);
});
