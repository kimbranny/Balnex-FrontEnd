import { loadSrc, makeRunner } from "./load.mjs";
const C = await loadSrc("lib/lifecycleChain.js");
const t = makeRunner();
const conn = ({ status = null, valid = true, throws = false, statusAfter }) => {
  let calls = 0;
  return {
    getSignatureStatuses: async () => { if (throws) throw new Error("rpc"); calls++; return { value: [calls > 1 && statusAfter !== undefined ? statusAfter : status] }; },
    isBlockhashValid: async () => ({ value: valid }),
  };
};
const o = (c, sig = "s", bh = "bh") => C.signatureOutcome(c, sig, bh);
t.ok("no signature and no blockhash -> none", (await C.signatureOutcome(conn({}), null, null)) === "none");
t.ok("confirmed", (await o(conn({ status: { confirmationStatus: "confirmed" } }))) === "confirmed");
t.ok("finalized counts as confirmed", (await o(conn({ status: { confirmationStatus: "finalized" } }))) === "confirmed");
t.ok("on-chain error -> failed", (await o(conn({ status: { err: {} } }))) === "failed");
t.ok("processed only -> pending", (await o(conn({ status: { confirmationStatus: "processed" } }))) === "pending");
t.ok("not found + blockhash still valid -> pending (not proven)", (await o(conn({ valid: true }))) === "pending");
t.ok("not found + blockhash expired -> expired_unlanded (proven)", (await o(conn({ valid: false }))) === "expired_unlanded");
t.ok("lands right at expiry -> confirmed, not expired", (await o(conn({ valid: false, statusAfter: { confirmationStatus: "confirmed" } }))) === "confirmed");
t.ok("not found, no blockhash -> pending", (await C.signatureOutcome(conn({}), "s", null)) === "pending");
t.ok("RPC error -> unavailable", (await o(conn({ throws: true }))) === "unavailable");
t.ok("no signature, expired blockhash -> expired_unlanded", (await C.signatureOutcome(conn({ valid: false }), null, "bh")) === "expired_unlanded");
process.exit(t.done("chain outcome classification") ? 1 : 0);
