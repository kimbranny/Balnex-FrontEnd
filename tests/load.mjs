// Loads a src module in plain Node (no bundler): the config import is replaced with constants
// and a fake localStorage is installed. Pure-logic modules only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
export const storage = store;

let n = 0;
export async function loadSrc(file) {
  const src = fs.readFileSync(path.resolve("src", file), "utf8");
  const code = src
    .replace(/import\s*\{[^}]*\}\s*from\s*"\.\.\/config";?/g, 'const CLUSTER = "devnet";')
    .replace(/^import .*$/gm, "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "balnex-test-"));
  const out = path.join(dir, `m${n++}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

export function makeRunner() {
  let pass = 0;
  let fail = 0;
  return {
    ok(name, cond, extra = "") {
      if (cond) pass++;
      else fail++;
      console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + extra}`);
    },
    done(label) {
      console.log(`\n${label}: ${pass} passed, ${fail} failed`);
      return fail;
    },
  };
}
