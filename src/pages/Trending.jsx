import { useEffect, useRef, useState } from "react";
import { fetchMarket } from "../lib/market";
import { createPoller } from "../lib/marketPoller";
import { TRENDING } from "../lib/trendingConfig";
import { shorten } from "../lib/utils";

// Last good dataset survives leaving and returning to this page (shown at once, then refreshed).
let marketCache = null;

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

function formatAge(createdAt, now) {
  const created = Number(createdAt);
  if (!Number.isFinite(created) || created <= 0) return "—";
  const minutes = Math.max(0, Math.floor((now - created) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

const formatCount = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString() : "—");

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
  const [view, setView] = useState({
    data: marketCache?.data ?? null,
    lastOk: marketCache?.lastOk ?? 0,
    error: "",
    refreshing: true,
  });
  const [, setClock] = useState(0);
  const [selected, setSelected] = useState("");
  const [busyAddress, setBusyAddress] = useState("");
  const pollerRef = useRef(null);

  // One poller per visit: refreshes now, then every TRENDING.refreshMs while the tab is visible.
  // Cleanup stops the timer and aborts any request, so nothing runs after leaving the page.
  useEffect(() => {
    const poller = createPoller({
      fetcher: fetchMarket,
      intervalMs: TRENDING.refreshMs,
      staleAfterMs: TRENDING.staleAfterMs,
      backoffMs: TRENDING.rateLimitBackoffMs,
      isVisible: () => document.visibilityState === "visible",
      initial: marketCache,
      onChange: (state) => {
        if (state.data) marketCache = { data: state.data, lastOk: state.lastOk };
        setView(state);
      },
    });
    pollerRef.current = poller;
    const onVisible = () => poller.onVisible();
    document.addEventListener("visibilitychange", onVisible);
    poller.start();

    // Lightweight clock so "stale" and the update age are re-evaluated between refreshes.
    const clock = setInterval(() => setClock((c) => c + 1), 15000);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(clock);
      poller.stop();
      pollerRef.current = null;
    };
  }, []);

  const now = Date.now();
  const coins = view.data?.coins ?? [];
  const stale = view.data !== null && (Boolean(view.error) || now - view.lastOk > TRENDING.staleAfterMs);
  const refresh = () => pollerRef.current?.refresh({ manual: true });

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
        <button className="secondary-button compact" type="button" onClick={refresh} disabled={view.refreshing}>
          {view.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="trending-status" aria-live="polite">
        {view.lastOk ? (
          <span className={stale ? "badge badge-warn" : "badge badge-ok"}>
            {stale ? "STALE" : "LIVE"} · updated {new Date(view.lastOk).toLocaleTimeString()}
          </span>
        ) : (
          <span className="badge">Not loaded yet</span>
        )}
        {view.refreshing && <span className="spinner" aria-label="Refreshing" />}
        <small className="helper">Auto-refreshes every {Math.round(TRENDING.refreshMs / 1000)}s while this page is open.</small>
      </div>

      <div className="notice">
        <span className="notice-icon">ⓘ</span>
        <div>
          <strong>Ranked by trading activity, on Solana mainnet</strong>
          <p>
            Rank comes from volume, transactions, liquidity, price movement and pool age. Paid boosts only help find
            candidates and never affect rank. Tokens you create on Devnet won't appear here. Not financial advice.
          </p>
        </div>
      </div>

      {view.error && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>{view.data ? "Couldn't refresh. Showing older data." : "Couldn't load trending coins"}</strong>
            <p>
              {view.error}
              {view.data && ` The list below is from ${new Date(view.lastOk).toLocaleTimeString()} and is not live.`}
            </p>
          </div>
          <button className="text-button" type="button" onClick={refresh} disabled={view.refreshing}>
            Try again
          </button>
        </div>
      )}

      {view.data?.partial && !view.error && (
        <p className="helper warning-text">Some market data couldn't be loaded this time, so the list may be incomplete.</p>
      )}

      {view.refreshing && coins.length === 0 && !view.error && (
        <div className="skeleton-list" aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {!view.refreshing && !view.error && view.lastOk > 0 && coins.length === 0 && (
        <div className="empty-state">
          <strong>No tokens qualify right now</strong>
          <p>
            {view.data?.stats?.pairsReceived || 0} pairs were checked, but none met the minimum liquidity ($
            {TRENDING.minLiquidityUsd.toLocaleString()}), 24h volume and activity filters. Try refreshing in a moment.
          </p>
        </div>
      )}

      <div className="trending-list">
        {coins.map((entry) => {
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
                <span className="trending-rank">{entry.rank}</span>
                {pair?.info?.imageUrl ? (
                  <img className="trending-icon" src={pair.info.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="trending-icon trending-icon-fallback">{(pair.baseToken.symbol || "?").slice(0, 1)}</span>
                )}
                <div className="trending-name">
                  <strong>{pair.baseToken.name || shorten(address)}</strong>
                  <small>
                    ${pair.baseToken.symbol || "?"} · Vol {formatUsd(pair?.volume?.h24)} ·{" "}
                    {formatCount(pair?.txns?.h24?.buys)}B/{formatCount(pair?.txns?.h24?.sells)}S
                  </small>
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

                  <dl className="cost-list">
                    <dt>Transactions 24h (buys / sells)</dt>
                    <dd>
                      {formatCount(pair?.txns?.h24?.buys)} / {formatCount(pair?.txns?.h24?.sells)}
                    </dd>
                    <dt>Transactions 1h (buys / sells)</dt>
                    <dd>
                      {formatCount(pair?.txns?.h1?.buys)} / {formatCount(pair?.txns?.h1?.sells)}
                    </dd>
                    <dt>Pool age</dt>
                    <dd>{formatAge(pair?.pairCreatedAt, now)}</dd>
                    <dt>DEX</dt>
                    <dd>{pair?.dexId || "—"}</dd>
                    <dt>Token address</dt>
                    <dd title={address}>{shorten(address, 6, 6)}</dd>
                    <dt>Pool address</dt>
                    <dd title={pair?.pairAddress}>{shorten(pair?.pairAddress, 6, 6)}</dd>
                    <dt>Trending score</dt>
                    <dd>
                      {entry.score.toFixed(1)} / 100
                      {boost && " · boosted (no effect on rank)"}
                    </dd>
                  </dl>
                  <small className="helper">
                    Score parts (0–1): volume {entry.components.volume.toFixed(2)}, transactions{" "}
                    {entry.components.transactions.toFixed(2)}, liquidity {entry.components.liquidity.toFixed(2)},
                    momentum {entry.components.momentum.toFixed(2)}, freshness {entry.components.freshness.toFixed(2)}.
                  </small>

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
