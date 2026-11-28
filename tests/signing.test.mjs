import { loadSrc, makeRunner } from "./load.mjs";
const prelude = `const SystemProgram={programId:{toBase58:()=>"11111111111111111111111111111111"}};const PublicKey=class{};const TransactionMessage={};const VersionedTransaction=class{};`;
const R = await loadSrc("lib/txRunner.js", prelude);
const L = await loadSrc("lib/liquidityMath.js");
const t = makeRunner();

const tx = { version: 0, message: { recentBlockhash: "bh" }, serialize: () => new Uint8Array(1) };
const mkConn = (o = {}) => ({
  isBlockhashValid: async () => ({ value: o.valid ?? true }),
  sendRawTransaction: async () => { o.sent = (o.sent || 0) + 1; return "SIG"; },
  getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed" }] }),
});
const err32603 = Object.assign(new Error("Unexpected error"), { code: -32603, name: "WalletSignTransactionError" });

// 1. -32603 -> exactly ONE wallet request, no automatic second method, nothing submitted
{ let signCalls = 0, sendCalls = 0; const o = {}; const c = mkConn(o);
  let thrown; try { await R.signSendConfirm({ connection: c, transaction: tx, signTransaction: async () => { signCalls++; throw err32603; }, sendTransaction: async () => { sendCalls++; return "S"; } }); } catch (e) { thrown = e; }
  t.ok("-32603: one signTransaction request only", signCalls === 1, signCalls);
  t.ok("-32603: no automatic sign-and-send", sendCalls === 0, sendCalls);
  t.ok("-32603: reported as signing stage, submitted=false, nothing sent", thrown?.stage === "signing" && thrown.details.submitted === false && !o.sent);
  t.ok("-32603: flagged phantomInternal", thrown?.details.phantomInternal === true); }
// 2. user reject
{ let thrown; try { await R.signSendConfirm({ connection: mkConn(), transaction: tx, signTransaction: async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } }); } catch (e) { thrown = e; }
  t.ok("user rejection is a signing failure, submitted=false", thrown?.stage === "signing" && thrown.details.submitted === false && /cancelled/.test(thrown.message)); }
// 3. stale blockhash -> wallet never asked
{ let signCalls = 0; let thrown; try { await R.signSendConfirm({ connection: mkConn({ valid: false }), transaction: tx, signTransaction: async () => { signCalls++; return tx; } }); } catch (e) { thrown = e; }
  t.ok("expired blockhash: wallet is not asked to sign", signCalls === 0 && thrown?.stage === "prepare" && thrown.details.staleBlockhash === true); }
// 4. happy path: sign -> submit (records signature) -> confirm
{ const o = {}; const c = mkConn(o); const seen = []; const r = await R.signSendConfirm({ connection: c, transaction: tx, signTransaction: async (x) => x, onSubmitted: (sig) => seen.push(sig), onStage: () => {} });
  t.ok("happy path confirms and records signature via hook", r.signature === "SIG" && seen[0] === "SIG" && o.sent === 1); }
// 5. method signAndSend is used only when explicitly chosen
{ let signCalls = 0, sendCalls = 0; await R.signSendConfirm({ connection: mkConn(), transaction: tx, method: "signAndSend", signTransaction: async () => { signCalls++; return tx; }, sendTransaction: async () => { sendCalls++; return "SIG"; } });
  t.ok("signAndSend: single sendTransaction request, no signTransaction", sendCalls === 1 && signCalls === 0); }
// 6. sign-and-send -32603 also stops
{ let sendCalls = 0; let thrown; try { await R.signSendConfirm({ connection: mkConn(), transaction: tx, method: "signAndSend", sendTransaction: async () => { sendCalls++; throw err32603; } }); } catch (e) { thrown = e; }
  t.ok("signAndSend -32603: one request, stops", sendCalls === 1 && thrown?.stage === "signing"); }
// 7. error classification text
{ const info = R.userMessage(new R.StageError("signing", "x", { submitted: false })); t.ok("signing failure message says nothing submitted", /Nothing was submitted/.test(info.outcome) && info.title === "Wallet signing failed"); }

// ---- withdrawal math ----
t.ok("25/50/75/100% of LP balance", [25, 50, 75, 100].map((p) => String(L.lpForPercent(1000n, p))).join() === "250,500,750,1000");
t.ok("percent rounds down on raw units", L.lpForPercent(999n, 50) === 499n);
t.ok("invalid percent -> 0", L.lpForPercent(1000n, 0) === 0n && L.lpForPercent(1000n, 101) === 0n && L.lpForPercent(1000n, 12.5) === 0n);
t.ok("large LP balance stays exact (BigInt)", L.lpForPercent(123456789012345678901234567890n, 100) === 123456789012345678901234567890n);
{ const e = L.estimateOutputs({ token: 1000, sol: 10 }, 250n, 1000n); t.ok("estimate uses share of reserves", e.token === 250 && e.sol === 2.5 && e.share === 0.25); }
t.ok("zero supply -> zero share, no NaN", L.estimateOutputs({ token: 5, sol: 5 }, 10n, 0n).token === 0);
t.ok("min output with 1% slippage", Math.abs(L.minOutput(100, 1) - 99) < 1e-9);
t.ok("min output rejects nonsense slippage", L.minOutput(100, -1) === 0 && L.minOutput(100, 100) === 0);
process.exit(t.done("signing pipeline + withdrawal math") ? 1 : 0);
