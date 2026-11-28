import { loadSrc, makeRunner } from "./load.mjs";
const U = await loadSrc("lib/utils.js", "const LOCAL_TOKENS_KEY='k';const EXPLORER_SUFFIX='';const PublicKey=class{};");
const t = makeRunner();
t.ok("toRawUnits 9 decimals", U.toRawUnits("1.5", 9) === 1500000000n);
t.ok("toRawUnits 6 decimals", U.toRawUnits("0.000001", 6) === 1n);
t.ok("toRawUnits rejects too many decimals", (() => { try { U.toRawUnits("0.0000001", 6); return false; } catch { return true; } })());
t.ok("toRawUnits rejects garbage", (() => { try { U.toRawUnits("1e3", 6); return false; } catch { return true; } })());
t.ok("fromRawUnits round trip", U.fromRawUnits(U.toRawUnits("123.456", 9), 9) === "123.456" && U.fromRawUnits(5n, 0) === "5");
process.exit(t.done("decimal conversion") ? 1 : 0);
