// Trending settings. Every threshold and weight can be overridden from .env (VITE_TRENDING_*),
// so nothing about the filters or ranking is permanently hard-wired.
const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
};
const env = import.meta.env;

export const TRENDING = {
  refreshMs: num(env.VITE_TRENDING_REFRESH_MS, 45000), // auto refresh while the page is visible
  staleAfterMs: num(env.VITE_TRENDING_STALE_MS, 90000), // older than this = labelled stale
  requestTimeoutMs: 10000,
  rateLimitBackoffMs: 120000, // pause polling after an HTTP 429
  maxCandidates: num(env.VITE_TRENDING_MAX_CANDIDATES, 90), // tokens looked up per refresh (30 per request)
  maxResults: num(env.VITE_TRENDING_MAX_RESULTS, 30),

  // Filters: pairs failing any of these are excluded before ranking.
  minLiquidityUsd: num(env.VITE_TRENDING_MIN_LIQUIDITY_USD, 5000),
  minVolume24hUsd: num(env.VITE_TRENDING_MIN_VOLUME_24H_USD, 5000),
  minTxns24h: num(env.VITE_TRENDING_MIN_TXNS_24H, 50),
  minPairAgeMinutes: num(env.VITE_TRENDING_MIN_PAIR_AGE_MIN, 30),
  requireTwoSidedTrading: env.VITE_TRENDING_REQUIRE_TWO_SIDED !== "false", // need buys AND sells in 24h

  // Ranking weights (normalised; paid boosts have NO weight).
  weights: {
    volume: num(env.VITE_TRENDING_W_VOLUME, 0.3),
    transactions: num(env.VITE_TRENDING_W_TXNS, 0.25),
    liquidity: num(env.VITE_TRENDING_W_LIQUIDITY, 0.2),
    momentum: num(env.VITE_TRENDING_W_MOMENTUM, 0.15),
    freshness: num(env.VITE_TRENDING_W_FRESHNESS, 0.1),
  },
};
