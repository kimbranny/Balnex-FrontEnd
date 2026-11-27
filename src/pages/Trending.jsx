import { useCallback, useEffect, useState } from "react";
import { shorten } from "../lib/utils";

// Public DexScreener API (no key needed). Shows Solana MAINNET market data,
// independent of the network BALNEX creates tokens on.
const BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1";
const TOKENS_URL = "https://api.dexscreener.com/tokens/v1/solana/";

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
  return `$${number.toFixed(2)}`;
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1) return `$${number.toFixed(2)}`;
  if (number >= 0.0001) return `$${number.toFixed(6)}`;
  return `$${number.toExponential(2)}`;
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Market data request failed (${response.status}).`);
  return response.json();
}

export default function Trending() {
  const [coins, setCoins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (signal) => {
    setLoading(true);
    setError("");

    try {
      const boosts = await fetchJson(BOOSTS_URL, signal);
      const addresses = [
        ...new Set(
          (Array.isArray(boosts) ? boosts : [])
            .filter((item) => item?.chainId === "solana" && item?.tokenAddress)
            .map((item) => item.tokenAddress)
        ),
      ].slice(0, 30);

      if (addresses.length === 0) {
        setCoins([]);
        return;
      }

      const pairs = await fetchJson(`${TOKENS_URL}${addresses.join(",")}`, signal);

      // Keep the most liquid pair for each token, in the original trending order.
      const best = new Map();
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        const address = pair?.baseToken?.address;
        if (!address) continue;
        const current = best.get(address);
        if (!current || Number(pair?.liquidity?.usd || 0) > Number(current?.liquidity?.usd || 0)) {
          best.set(address, pair);
        }
      }

      setCoins(addresses.map((address) => best.get(address)).filter(Boolean));
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error("Trending load error:", err);
      setError(err?.message || "Couldn't load trending coins.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <section className="panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">MARKET</span>
          <h2>Trending Coins</h2>
          <p className="muted">Top boosted Solana tokens right now, via DexScreener.</p>
        </div>
        <button className="secondary-button compact" type="button" onClick={() => load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="notice">
        <span className="notice-icon">ⓘ</span>
        <div>
          <strong>Mainnet market data</strong>
          <p>Trending lists tokens traded on Solana mainnet. Tokens you create on Devnet won't appear here. Boosted rankings are paid promotions, not a recommendation.</p>
        </div>
      </div>

      {error && (
        <div className="notice notice-error">
          <div>
            <strong>Couldn't load trending coins</strong>
            <p>{error}</p>
          </div>
          <button className="text-button" type="button" onClick={() => load()}>
            Try again
          </button>
        </div>
      )}

      {loading && coins.length === 0 && (
        <div className="skeleton-list" aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {!loading && !error && coins.length === 0 && (
        <div className="empty-state">
          <strong>Nothing trending right now</strong>
          <p>Try refreshing in a moment.</p>
        </div>
      )}

      <div className="trending-list">
        {coins.map((pair, index) => {
          const change = Number(pair?.priceChange?.h24);
          const hasChange = Number.isFinite(change);
          return (
            <a
              className="trending-row"
              key={pair.baseToken.address}
              href={pair.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="trending-rank">{index + 1}</span>
              {pair?.info?.imageUrl ? (
                <img className="trending-icon" src={pair.info.imageUrl} alt="" loading="lazy" />
              ) : (
                <span className="trending-icon trending-icon-fallback">{(pair.baseToken.symbol || "?").slice(0, 1)}</span>
              )}
              <div className="trending-name">
                <strong>{pair.baseToken.name || shorten(pair.baseToken.address)}</strong>
                <small>${pair.baseToken.symbol || "?"} · Vol {formatUsd(pair?.volume?.h24)}</small>
              </div>
              <div className="trending-price">
                <strong>{formatPrice(pair.priceUsd)}</strong>
                <small className={hasChange ? (change >= 0 ? "up" : "down") : ""}>
                  {hasChange ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}%` : "—"}
                </small>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
