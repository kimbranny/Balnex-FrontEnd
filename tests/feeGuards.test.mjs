import { loadSrc, makeRunner } from "./load.mjs";
const G = await loadSrc("lib/feeGuards.js");
const t = makeRunner();
t.ok("feeGuards exports intact", ["savePending", "getPending", "clearPending", "evaluatePending", "findFeeTransfer"].every((k) => typeof G[k] === "function"));
const parsed = (to, lamports) => ({ transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: "OWNER", destination: to, lamports } } }] } } });
t.ok("finds exact fee transfer", !!G.findFeeTransfer(parsed("TREAS", 100000000), "OWNER", "TREAS", 100000000n) || !!G.findFeeTransfer(parsed("TREAS", 100000000), "OWNER", "TREAS", 100000000));
t.ok("rejects wrong amount", !G.findFeeTransfer(parsed("TREAS", 5), "OWNER", "TREAS", 100000000));
process.exit(t.done("fee guards (unchanged module)") ? 1 : 0);
