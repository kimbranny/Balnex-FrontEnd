import { loadSrc, makeRunner } from "./load.mjs";
const H = await loadSrc("lib/liquidityHistory.js");
const C = await loadSrc("lib/analyticsCodec.js");
const t = makeRunner();

const VAULTS = { tokenVault: "TV", solVault: "SV" };
// Parsed-transaction mock: pre/post token balances for the two vaults (index 1 = TV, 2 = SV).
const tx = ({ pre, post, err = null, slot = 1, blockTime = 1700000000 }) => ({
  slot, blockTime,
  transaction: { message: { accountKeys: [{ pubkey: "payer" }, { pubkey: "TV" }, { pubkey: "SV" }, { pubkey: "pool" }] } },
  meta: {
    err,
    preTokenBalances: pre ? [{ accountIndex: 1, uiTokenAmount: { amount: String(pre[0]) } }, { accountIndex: 2, uiTokenAmount: { amount: String(pre[1]) } }] : [],
    postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: String(post[0]) } }, { accountIndex: 2, uiTokenAmount: { amount: String(post[1]) } }],
  },
});
const create = tx({ pre: null, post: [1000, 10] });
const add = tx({ pre: [1000, 10], post: [1500, 15] });
const remove = tx({ pre: [1500, 15], post: [750, 7] });
const swapBuy = tx({ pre: [750, 7], post: [700, 8] });
const failed = tx({ pre: [1000, 10], post: [2000, 20], err: { InstructionError: [0, "x"] } });
const unrelated = { slot: 2, transaction: { message: { accountKeys: [{ pubkey: "a" }] } }, meta: { err: null, preTokenBalances: [], postTokenBalances: [] } };

// --- classification ---
let e = H.classifyTransaction("s1", create, VAULTS);
t.ok("pool creation + initial liquidity (vaults didn't exist before)", e.type === "pool_created" && e.initial && e.tokenRaw === 1000n && e.solRaw === 10n);
e = H.classifyTransaction("s2", add, VAULTS);
t.ok("subsequent addition", e.type === "liquidity_added" && e.tokenRaw === 500n && e.solRaw === 5n);
e = H.classifyTransaction("s3", remove, VAULTS);
t.ok("removal amounts are positive magnitudes", e.type === "liquidity_removed" && e.tokenRaw === 750n && e.solRaw === 8n);
e = H.classifyTransaction("s4", swapBuy, VAULTS);
t.ok("swap is NOT liquidity", e.type === "swap" && e.side === "buy");
t.ok("failed tx skipped", H.classifyTransaction("s5", failed, VAULTS) === null);
t.ok("unrelated tx skipped", H.classifyTransaction("s6", unrelated, VAULTS) === null);
t.ok("wrong vault addresses (unrelated pool) match nothing", H.classifyTransaction("s7", add, { tokenVault: "X", solVault: "Y" }) === null);
t.ok("no balance change skipped", H.classifyTransaction("s8", tx({ pre: [5, 5], post: [5, 5] }), VAULTS) === null);

// --- cumulative totals vs current reserves ---
const events = ["s1", "s2", "s3"].map((s, i) => H.classifyTransaction(s, [create, add, remove][i], VAULTS));
const sum = H.summarizeLiquidity([...events, events[1], H.classifyTransaction("s4", swapBuy, VAULTS)]);
t.ok("cumulative added = initial + additions (1500 / 15)", sum.addedToken === 1500n && sum.addedSol === 15n && sum.additions === 2);
t.ok("cumulative removed (750 / 8)", sum.removedToken === 750n && sum.removedSol === 8n && sum.removals === 1);
t.ok("duplicate signature not double-counted", sum.transactions === 4 && sum.additions === 2);
t.ok("cumulative differs from current reserves (700 / 8)", sum.addedToken - sum.removedToken === 750n && sum.swaps === 1);

// --- pagination, RPC failures, delayed indexing ---
const all = [
  { signature: "s1", err: null }, { signature: "s2", err: null }, { signature: "s3", err: null },
  { signature: "sF", err: { x: 1 } }, { signature: "s4", err: null },
];
const parsedBySig = { s1: create, s2: add, s3: remove, s4: swapBuy, sF: failed };
const mkConn = (o = {}) => ({
  calls: { sigs: 0, txs: 0 },
  async getSignaturesForAddress(_k, { before, limit }) {
    this.calls.sigs++;
    if (o.rpcDown) throw new Error("429 Too Many Requests");
    const start = before ? all.findIndex((x) => x.signature === before) + 1 : 0;
    return all.slice(start, start + limit);
  },
  async getParsedTransactions(sigs) { this.calls.txs++; return sigs.map((s) => (o.missing?.includes(s) ? null : parsedBySig[s])); },
});
const fakeKey = { fake: true };
{ const c = mkConn(); const page = await H.fetchPoolHistoryPage(c, { poolId: fakeKey, vaults: VAULTS, limit: 2 });
  t.ok("page 1 has a cursor and hasMore", page.hasMore && page.nextCursor === "s2" && page.events.length === 2);
  const page2 = await H.fetchPoolHistoryPage(c, { poolId: fakeKey, vaults: VAULTS, limit: 2, before: page.nextCursor });
  t.ok("page 2 continues after the cursor (no overlap)", page2.events[0].signature === "s3");
  const page3 = await H.fetchPoolHistoryPage(c, { poolId: fakeKey, vaults: VAULTS, limit: 2, before: page2.nextCursor });
  t.ok("last page ends pagination", !page3.hasMore && page3.nextCursor === null); }
{ const c = mkConn(); const full = await H.fetchPoolHistory(c, { poolId: fakeKey, vaults: VAULTS, pageSize: 2, maxPages: 10 });
  t.ok("full history complete, totals correct, failed tx ignored", full.complete && full.summary.addedToken === 1500n && full.summary.removedToken === 750n && full.events.length === 4); }
{ const c = mkConn(); const cut = await H.fetchPoolHistory(c, { poolId: fakeKey, vaults: VAULTS, pageSize: 2, maxPages: 1 });
  t.ok("truncated scan is flagged incomplete (never shown as final)", cut.complete === false); }
{ const c = mkConn({ missing: ["s2"] }); const r = await H.fetchPoolHistory(c, { poolId: fakeKey, vaults: VAULTS, pageSize: 10 });
  t.ok("delayed indexing: missing tx reported, not guessed", r.missing === 1 && r.summary.additions === 1); }
{ let thrown; try { await H.fetchPoolHistory(mkConn({ rpcDown: true }), { poolId: fakeKey, vaults: VAULTS }); } catch (x) { thrown = x; }
  t.ok("RPC failure/rate limit surfaces as an error (UI shows 'unavailable', not zero)", /429/.test(thrown?.message || "")); }

// --- holders ---
const A = (owner, amount) => ({ owner, amount });
const accts = [A("w1", 300n), A("w1", 200n), A("w2", 100n), A("poolAuth", 400n), A("w3", 0n), A("mintAuth", 0n)];
const prog = (o) => o === "poolAuth";
const agg = C.aggregateHolders(accts, prog);
t.ok("holders aggregated by owner (w1 counted once), pool authority + empty excluded", agg.holders === 2 && agg.programOwnedExcluded === 1 && agg.zeroBalanceAccounts === 2 && agg.tokenAccounts === 6);
const top = C.topHolders(accts, prog, 1000n, 10);
t.ok("top holders sums token accounts per wallet and sorts", top.top[0].owner === "w1" && top.top[0].amount === 500n && top.top[1].owner === "w2");
t.ok("percent of TOTAL supply", top.top[0].percent === 50 && top.top[1].percent === 10);
t.ok("pool vault holdings excluded from top holders and reported", !top.top.some((h) => h.owner === "poolAuth") && top.programOwnedRaw === 400n);
t.ok("top limit respected", C.topHolders(accts, prog, 1000n, 1).top.length === 1);
t.ok("zero supply gives null percent, not NaN", C.topHolders([A("w", 5n)], () => false, 0n).top[0].percent === null);
process.exit(t.done("analytics (mocked data; not proof of live on-chain behaviour)") ? 1 : 0);
