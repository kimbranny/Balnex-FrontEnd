import { useCallback, useEffect, useState } from "react";
import { shorten } from "../lib/utils";

// Public DexScreener API (no key needed). Shows Solana MAINNET market data,
// independent of the network BALNEX creates tokens on.
const BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1";
const TOKENS_URL = "https://api.dexscreener.com/tokens/v1/solana/";

const ALLOWED_IMAGES = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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

function cleanText(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Market data request failed (${response.status}).`);
  return response.json();
}

// Tries to copy the token logo into the browser as a data URL so it can be
// reused in the creation form. Returns null when the image host blocks
// cross-origin reads (CORS), or the file is the wrong type or too large.
async function imageToDataUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!ALLOWED_IMAGES.includes(blob.type) || blob.size > MAX_IMAGE_BYTES) return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default function Trending({ onCreateSimilar }) {
  const [coins, setCoins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [busyAddress, setBusyAddress] = useState("");

  const load = useCallback(async (signal) => {
    setLoading(true);
    setError("");

    try {
      const boosts = await fetchJson(BOOSTS_URL, signal);

      // Keep the first (top-ranked) boost entry per Solana token; it also carries the description.
      const boostByAddress = new Map();
      for (const item of Array.isArray(boosts) ? boosts : []) {
        if (item?.chainId === "solana" && item?.tokenAddress && !boostByAddress.has(item.tokenAddress)) {
          boostByAddress.set(item.tokenAddress, item);
        }
      }
      const addresses = [...boostByAddress.keys()].slice(0, 30);

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

      setCoins(
        addresses
          .map((address) => ({ pair: best.get(address), boost: boostByAddress.get(address) }))
          .filter((entry) => entry.pair)
      );
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

  async function handleCreateSimilar({ pair, boost }) {
    const address = pair.baseToken.address;
    setBusyAddress(address);

    const imageUrl = pair?.info?.imageUrl || boost?.icon || "";
    const image = imageUrl ? await imageToDataUrl(imageUrl) : null;

    const url = typeof pair.url === "string" && pair.url.startsWith("https://") ? pair.url : "";

    // Only name, symbol, description and logo are passed on. The original mint
    // address is deliberately not copied, so the new token is fully independent.
    setBusyAddress("");
    onCreateSimilar({
      name: cleanText(pair.baseToken.name, 32),
      symbol: cleanText(pair.baseToken.symbol, 10).replace(/[$\s]/g, "").toUpperCase(),
      description: cleanText(boost?.description, 500),
      image,
      imageRequested: Boolean(imageUrl),
      source: { url },
    });
  }

  return (
    <section className="panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">MARKET</span>
          <h2>Trending Coins</h2>
          <p className="muted">Pick a trending token as inspiration, then launch your own version.</p>
        </div>
        <button className="secondary-button compact" type="button" onClick={() => load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="notice">
        <span className="notice-icon">ⓘ</span>
        <div>
          <strong>Mainnet market data</strong>
          <p>
            Trending lists tokens traded on Solana mainnet. Tokens you create on Devnet won't appear here. Boosted
            rankings are paid promotions, not a recommendation.
          </p>
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
        {coins.map((entry, index) => {
          const { pair, boost } = entry;
          const address = pair.baseToken.address;
          const open = selected === address;
          const change = Number(pair?.priceChange?.h24);
          const hasChange = Number.isFinite(change);
          const description = cleanText(boost?.description, 500);

          return (
            <div className="trending-item" key={address}>
              <button
                type="button"
                className="trending-row"
                aria-expanded={open}
                onClick={() => setSelected(open ? "" : address)}
              >
                <span className="trending-rank">{index + 1}</span>
                {pair?.info?.imageUrl ? (
                  <img className="trending-icon" src={pair.info.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="trending-icon trending-icon-fallback">{(pair.baseToken.symbol || "?").slice(0, 1)}</span>
                )}
                <div className="trending-name">
                  <strong>{pair.baseToken.name || shorten(address)}</strong>
                  <small>${pair.baseToken.symbol || "?"} · Vol {formatUsd(pair?.volume?.h24)}</small>
                </div>
                <div className="trending-price">
                  <strong>{formatPrice(pair.priceUsd)}</strong>
                  <small className={hasChange ? (change >= 0 ? "up" : "down") : ""}>
                    {hasChange ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}%` : "—"}
                  </small>
                </div>
              </button>

              {open && (
                <div className="trending-detail">
                  <div className="pool-preview">
                    <div>
                      <span>Liquidity</span>
                      <strong>{formatUsd(pair?.liquidity?.usd)}</strong>
                    </div>
                    <div>
                      <span>Market cap</span>
                      <strong>{formatUsd(pair?.marketCap || pair?.fdv)}</strong>
                    </div>
                    <div>
                      <span>Volume 24h</span>
                      <strong>{formatUsd(pair?.volume?.h24)}</strong>
                    </div>
                  </div>

                  {description && <p className="trending-description">{description}</p>}

                  <div className="notice">
                    <span className="notice-icon">✦</span>
                    <div>
                      <strong>Your own token, not a copy</strong>
                      <p>
                        We'll pre-fill the name, symbol, description and logo as a starting point. Your token gets its
                        own mint address and none of {pair.baseToken.name || "this token"}'s price, holders or
                        liquidity. You can change everything before launching.
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="primary"
                    disabled={Boolean(busyAddress)}
                    onClick={() => handleCreateSimilar(entry)}
                  >
                    {busyAddress === address ? (
                      <>
                        <span className="spinner" aria-hidden="true" /> Copying details…
                      </>
                    ) : (
                      <>
                        Create similar token <span>→</span>
                      </>
                    )}
                  </button>

                  {pair.url && typeof pair.url === "string" && pair.url.startsWith("https://") && (
                    <a className="text-button" href={pair.url} target="_blank" rel="noopener noreferrer">
                      View on DexScreener ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
