// Transparent activity-based Trending ranking. Pure functions, no network or browser APIs.
//
// 1. filterPair: drops malformed / inactive / low-liquidity pairs (thresholds from config).
// 2. For each token keep its most liquid qualifying pair.
// 3. score = 100 * weighted sum of five 0..1 components:
//      volume       percentile of 6h trading volume (USD) among qualifying tokens
//      transactions percentile of 6h transaction count (buys + sells)
//      liquidity    percentile of pool liquidity (USD)
//      momentum     percentile of recent price change (6h, else 1h, else 24h), clipped to -50%..+100%
//      freshness    1 - min(pair age, 7 days) / 7 days  (0 if the API gives no pair age)
//    Paid boosts are NOT an input. They only help discover candidates.
// Ranks are recomputed from scratch on every successful refresh.
const DAY_MS = 86400000;

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const txnCount = (t) => (t ? (n(t.buys) || 0) + (n(t.sells) || 0) : 0);

export function filterPair(pair, cfg, now) {
  if (!pair || pair.chainId !== "solana") return "wrong_chain";
  if (!pair.baseToken?.address || !pair.baseToken?.symbol || !pair.pairAddress) return "malformed";
  const price = n(pair.priceUsd);
  if (price === null || price <= 0) return "no_price";
  if ((n(pair.liquidity?.usd) ?? 0) < cfg.minLiquidityUsd) return "low_liquidity";
  if ((n(pair.volume?.h24) ?? 0) < cfg.minVolume24hUsd) return "low_volume";
  if (txnCount(pair.txns?.h24) < cfg.minTxns24h) return "low_activity";
  const created = n(pair.pairCreatedAt);
  if (created !== null && now - created < cfg.minPairAgeMinutes * 60000) return "too_new";
  if (cfg.requireTwoSidedTrading && ((n(pair.txns?.h24?.buys) || 0) < 1 || (n(pair.txns?.h24?.sells) || 0) < 1)) {
    return "one_sided";
  }
  return null;
}

// Share of values strictly below v, plus half of ties (0..1). A single value scores 0.5.
function percentile(values, v) {
  if (values.length <= 1) return 0.5;
  let below = 0;
  let equal = 0;
  for (const x of values) {
    if (x < v) below += 1;
    else if (x === v) equal += 1;
  }
  return (below + (equal - 1) / 2) / (values.length - 1);
}

const momentumValue = (pair) => {
  const c = n(pair.priceChange?.h6) ?? n(pair.priceChange?.h1) ?? n(pair.priceChange?.h24);
  return Math.max(-50, Math.min(100, c ?? -50));
};

export function rankPairs(pairs, sources, cfg, now = Date.now()) {
  const excluded = {};
  const best = new Map();

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const reason = filterPair(pair, cfg, now);
    if (reason) {
      excluded[reason] = (excluded[reason] || 0) + 1;
      continue;
    }
    const address = pair.baseToken.address;
    const current = best.get(address);
    if (!current || (n(pair.liquidity?.usd) ?? 0) > (n(current.liquidity?.usd) ?? 0)) best.set(address, pair);
  }

  const entries = [...best.values()];
  const vols = entries.map((p) => n(p.volume?.h6) ?? 0);
  const txns = entries.map((p) => txnCount(p.txns?.h6));
  const liqs = entries.map((p) => n(p.liquidity?.usd) ?? 0);
  const moms = entries.map(momentumValue);
  const w = cfg.weights;
  const wTotal = Object.values(w).reduce((a, b) => a + b, 0) || 1;

  const ranked = entries.map((pair, i) => {
    const created = n(pair.pairCreatedAt);
    const comp = {
      volume: percentile(vols, vols[i]),
      transactions: percentile(txns, txns[i]),
      liquidity: percentile(liqs, liqs[i]),
      momentum: percentile(moms, moms[i]),
      freshness: created === null ? 0 : 1 - Math.min(Math.max(now - created, 0), 7 * DAY_MS) / (7 * DAY_MS),
    };
    const score =
      (100 *
        (w.volume * comp.volume +
          w.transactions * comp.transactions +
          w.liquidity * comp.liquidity +
          w.momentum * comp.momentum +
          w.freshness * comp.freshness)) /
      wTotal;
    return { pair, boost: sources.get(pair.baseToken.address) || null, score, components: comp };
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (n(b.pair.volume?.h24) ?? 0) - (n(a.pair.volume?.h24) ?? 0) ||
      a.pair.baseToken.address.localeCompare(b.pair.baseToken.address)
  );

  return {
    coins: ranked.slice(0, cfg.maxResults).map((entry, index) => ({ ...entry, rank: index + 1 })),
    stats: { pairsReceived: Array.isArray(pairs) ? pairs.length : 0, qualified: entries.length, excluded },
  };
}
