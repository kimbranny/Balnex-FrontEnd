// Liquidity history reconstructed from on-chain transactions that touched a pool.
// Read-only. Pure classification (testable) + a paginated RPC fetcher.
//
// CURRENT reserves (what the vaults hold now) are NOT cumulative liquidity. Cumulative
// added/removed are sums over individual confirmed transactions, classified by how each one
// changed the pool's two vault balances:
//   both vaults up   -> liquidity added   (or pool created + initial liquidity if the vaults didn't exist before)
//   both vaults down -> liquidity removed
//   one up, one down -> swap (NOT liquidity; reported separately)
// Totals are in raw native units (token units and lamports). No USD conversion is applied
// because no reliable historical price source is available on Devnet.
// Failed transactions are skipped; each signature is counted once.

const keyOf = (k) => (typeof k === "string" ? k : k?.pubkey?.toString?.() ?? k?.toString?.());

function vaultDelta(tx, vault) {
  const keys = (tx?.transaction?.message?.accountKeys || []).map(keyOf);
  const index = keys.indexOf(vault);
  if (index < 0) return null; // this tx doesn't touch the vault
  const find = (list) => (list || []).find((b) => b.accountIndex === index);
  const pre = find(tx.meta?.preTokenBalances);
  const post = find(tx.meta?.postTokenBalances);
  return {
    delta: BigInt(post?.uiTokenAmount?.amount ?? "0") - BigInt(pre?.uiTokenAmount?.amount ?? "0"),
    existedBefore: !!pre,
  };
}

// pool = { tokenVault, solVault }. Returns an event or null (not related / failed / no change).
export function classifyTransaction(signature, tx, pool) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const t = vaultDelta(tx, pool.tokenVault);
  const s = vaultDelta(tx, pool.solVault);
  if (!t || !s) return null;
  const base = { signature, slot: tx.slot ?? null, blockTime: tx.blockTime ?? null, status: "confirmed" };

  if (t.delta === 0n && s.delta === 0n) return null;
  if (t.delta > 0n && s.delta > 0n) {
    const created = !t.existedBefore && !s.existedBefore;
    return { ...base, type: created ? "pool_created" : "liquidity_added", tokenRaw: t.delta, solRaw: s.delta, initial: created };
  }
  if (t.delta < 0n && s.delta < 0n) {
    return { ...base, type: "liquidity_removed", tokenRaw: -t.delta, solRaw: -s.delta };
  }
  if ((t.delta > 0n && s.delta < 0n) || (t.delta < 0n && s.delta > 0n)) {
    return { ...base, type: "swap", tokenRaw: t.delta, solRaw: s.delta, side: t.delta > 0n ? "sell" : "buy" };
  }
  return { ...base, type: "other", tokenRaw: t.delta, solRaw: s.delta };
}

// Sums liquidity events. Each signature counts once even if it appears in several pages.
export function summarizeLiquidity(events) {
  const seen = new Set();
  const out = { addedToken: 0n, addedSol: 0n, removedToken: 0n, removedSol: 0n, additions: 0, removals: 0, swaps: 0 };
  for (const e of events) {
    if (seen.has(e.signature)) continue;
    seen.add(e.signature);
    if (e.type === "pool_created" || e.type === "liquidity_added") {
      out.addedToken += e.tokenRaw;
      out.addedSol += e.solRaw;
      out.additions += 1;
    } else if (e.type === "liquidity_removed") {
      out.removedToken += e.tokenRaw;
      out.removedSol += e.solRaw;
      out.removals += 1;
    } else if (e.type === "swap") {
      out.swaps += 1;
    }
  }
  return { ...out, transactions: seen.size };
}

export function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((e) => (seen.has(e.signature) ? false : seen.add(e.signature)));
}

// One page of history for a pool, newest first. Cursor = last signature of the previous page.
// `connection` needs getSignaturesForAddress + getParsedTransactions.
export async function fetchPoolHistoryPage(connection, { poolId, vaults, before, limit = 25 }) {
  const signatures = await connection.getSignaturesForAddress(
    typeof poolId === "string" ? await toKey(poolId) : poolId,
    { before: before || undefined, limit },
    "confirmed"
  );
  const ok = signatures.filter((s) => !s.err);
  let parsed = [];
  if (ok.length) {
    parsed = await connection.getParsedTransactions(
      ok.map((s) => s.signature),
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    );
  }
  const events = [];
  let missing = 0;
  ok.forEach((s, i) => {
    if (!parsed[i]) {
      missing += 1; // not indexed yet / pruned: reported, never guessed
      return;
    }
    const event = classifyTransaction(s.signature, { ...parsed[i], blockTime: parsed[i].blockTime ?? s.blockTime }, vaults);
    if (event) events.push(event);
  });
  return {
    events,
    scanned: signatures.length,
    missing,
    nextCursor: signatures.length === limit ? signatures[signatures.length - 1].signature : null,
    hasMore: signatures.length === limit,
  };
}

let PublicKeyCtor = null;
async function toKey(address) {
  if (!PublicKeyCtor) PublicKeyCtor = (await import("@solana/web3.js")).PublicKey;
  return new PublicKeyCtor(address);
}

// Loads pages until the end or `maxPages`. `complete` is true ONLY when the oldest page was reached,
// so cumulative totals are never presented as final when history is truncated.
export async function fetchPoolHistory(connection, { poolId, vaults, pageSize = 25, maxPages = 8 }) {
  let before = null;
  let events = [];
  let missing = 0;
  let complete = false;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPoolHistoryPage(connection, { poolId, vaults, before, limit: pageSize });
    events = events.concat(result.events);
    missing += result.missing;
    if (!result.hasMore) {
      complete = true;
      break;
    }
    before = result.nextCursor;
  }
  events = dedupeEvents(events);
  return { events, summary: summarizeLiquidity(events), complete, missing, fetchedAt: Date.now() };
}
