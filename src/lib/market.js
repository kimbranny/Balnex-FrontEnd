// DexScreener public API access for Trending (no API key). Solana mainnet market data.
//
// Discovery (which tokens to look at; paid boosts are NOT a ranking input):
//   GET /token-boosts/top/v1          GET /token-boosts/latest/v1        GET /token-profiles/latest/v1
// Market data (real metrics for those tokens, up to 30 addresses per call):
//   GET /tokens/v1/solana/{addr,addr,...}
// A refresh makes 3 discovery calls + ceil(candidates / 30) market calls (6 with the default 90).
import { TRENDING } from "./trendingConfig";
import { rankPairs } from "./marketRank";

const BASE = "https://api.dexscreener.com";
const DISCOVERY = ["/token-boosts/top/v1", "/token-boosts/latest/v1", "/token-profiles/latest/v1"];

export class MarketError extends Error {
  constructor(message, { status = 0, rateLimited = false } = {}) {
    super(message);
    this.name = "MarketError";
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

async function fetchJson(path, signal) {
  // Own timeout, combined with the caller's abort signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRENDING.requestTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal });
    if (response.status === 429) throw new MarketError("DexScreener is rate-limiting requests.", { status: 429, rateLimited: true });
    if (!response.ok) throw new MarketError(`Market data request failed (${response.status}).`, { status: response.status });
    try {
      return await response.json();
    } catch {
      throw new MarketError("Market data response was malformed.");
    }
  } catch (err) {
    if (err instanceof MarketError) throw err;
    if (signal?.aborted) throw err; // caller cancelled
    if (err?.name === "AbortError") throw new MarketError("Market data request timed out.");
    throw new MarketError("Couldn't reach DexScreener. Check your connection.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchMarket(signal) {
  const results = await Promise.allSettled(DISCOVERY.map((path) => fetchJson(path, signal)));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const ok = results.filter((r) => r.status === "fulfilled");
  if (ok.length === 0) {
    const first = results.find((r) => r.status === "rejected")?.reason;
    throw first instanceof Error ? first : new MarketError("Couldn't load trending coins.");
  }
  const limited = results.find((r) => r.status === "rejected" && r.reason?.rateLimited);
  if (limited && ok.length === 0) throw limited.reason;

  // Candidate tokens: Solana only, first entry per token (keeps description/icon for "Create similar").
  const sources = new Map();
  for (const result of ok) {
    for (const item of Array.isArray(result.value) ? result.value : []) {
      if (item?.chainId === "solana" && item?.tokenAddress && !sources.has(item.tokenAddress)) {
        sources.set(item.tokenAddress, item);
      }
    }
  }
  const addresses = [...sources.keys()].slice(0, TRENDING.maxCandidates);
  if (addresses.length === 0) {
    return { coins: [], stats: { pairsReceived: 0, qualified: 0, excluded: {} }, candidates: 0, fetchedAt: Date.now() };
  }

  const chunks = [];
  for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30));
  const chunkResults = await Promise.allSettled(chunks.map((c) => fetchJson(`/tokens/v1/solana/${c.join(",")}`, signal)));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const pairs = chunkResults.flatMap((r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []));
  if (pairs.length === 0) {
    const failed = chunkResults.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  const ranked = rankPairs(pairs, sources, TRENDING, Date.now());
  return {
    ...ranked,
    candidates: addresses.length,
    partial: chunkResults.some((r) => r.status === "rejected") || ok.length < DISCOVERY.length,
    fetchedAt: Date.now(),
  };
}
