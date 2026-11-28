import { useConnection } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { fetchHolders, fetchPoolReserves } from "../lib/analytics";
import { fetchPoolHistory } from "../lib/liquidityHistory";
import { useMetric } from "../lib/useMetric";
import { explorerAddress, explorerTx, fromRawUnits, shorten } from "../lib/utils";

const time = (ms) => (ms ? new Date(ms).toLocaleTimeString() : "never");

function Footer({ m }) {
  return (
    <div className="metric-foot">
      <small>
        {m.lastOk ? `Updated ${time(m.lastOk)}` : "Not loaded yet"}
        {m.stale && " · STALE (last refresh failed)"}
      </small>
      <button type="button" className="text-button" onClick={m.refresh} disabled={m.loading}>
        {m.loading ? "Loading…" : "Refresh"}
      </button>
    </div>
  );
}

// Current vault balances of the pool (read-only). Not the same as initial liquidity.
export function PoolReserves({ record, symbol }) {
  const { connection } = useConnection();
  const m = useMetric(`reserves:${record.poolId}`, () =>
    fetchPoolReserves(connection, { poolId: record.poolId, tokenMint: record.mint })
  );
  const name = symbol || record.symbol || "tokens";

  return (
    <div className="metric-box">
      <strong>Current Pool Reserves</strong>
      {m.data ? (
        <dl className="cost-list">
          <dt>{name}</dt>
          <dd>{fromRawUnits(m.data.token.raw, m.data.token.decimals)}</dd>
          <dt>SOL (wrapped SOL vault)</dt>
          <dd>{fromRawUnits(m.data.sol.raw, m.data.sol.decimals)}</dd>
          {m.data.token.raw > 0n && (
            <>
              <dt>Pool price (from current reserves)</dt>
              <dd>
                {(
                  Number(fromRawUnits(m.data.sol.raw, m.data.sol.decimals)) /
                  Number(fromRawUnits(m.data.token.raw, m.data.token.decimals))
                ).toPrecision(6)}{" "}
                SOL
              </dd>
            </>
          )}
        </dl>
      ) : m.loading ? (
        <div className="skeleton" aria-busy="true" />
      ) : (
        <p className="helper warning-text">Unavailable: {m.error}</p>
      )}
      {m.data && m.error && <p className="helper warning-text">Refresh failed: {m.error}. Showing the last good values.</p>}
      <small className="helper">
        Live token balances of the pool's two vault accounts, verified against the pool's own state. They include any
        trading fees not yet collected by the protocol.
      </small>
      <Footer m={m} />
    </div>
  );
}

// Unique holders with a positive balance + total supply (read-only).
export function TokenStats({ mint, symbol }) {
  const { connection } = useConnection();
  const m = useMetric(`holders:${mint}`, () => fetchHolders(connection, mint));

  return (
    <div className="metric-box">
      <strong>Token Holders</strong>
      {m.data ? (
        <dl className="cost-list">
          <dt>Unique holders</dt>
          <dd>{m.data.holders.toLocaleString()}</dd>
          <dt>Total supply</dt>
          <dd>
            {fromRawUnits(m.data.supplyRaw, m.data.decimals)} {symbol || ""}
          </dd>
        </dl>
      ) : m.loading ? (
        <div className="skeleton" aria-busy="true" />
      ) : (
        <p className="helper warning-text">Holder count unavailable: {m.error}</p>
      )}
      {m.data && m.error && <p className="helper warning-text">Refresh failed: {m.error}. Showing the last good values.</p>}
      {m.data?.top?.length > 0 && (
        <div>
          <strong className="helper">Top holders (by wallet, token accounts summed)</strong>
          <dl className="cost-list">
            {m.data.top.map((h) => (
              <div key={h.owner} className="holder-row">
                <dt>
                  <a href={explorerAddress(h.owner)} target="_blank" rel="noopener noreferrer">
                    {shorten(h.owner, 4, 4)} ↗
                  </a>
                </dt>
                <dd>
                  {fromRawUnits(h.amount, m.data.decimals)}
                  {h.percent !== null && ` · ${h.percent.toFixed(2)}%`}
                </dd>
              </div>
            ))}
          </dl>
          {m.data.programOwnedRaw > 0n && (
            <small className="helper">
              Excluded as non-user accounts: {fromRawUnits(m.data.programOwnedRaw, m.data.decimals)} held by
              program-controlled wallets such as the pool's vault. Percentages are of total supply.
            </small>
          )}
        </div>
      )}
      {m.data && (
        <small className="helper">
          Unique wallet owners with a positive balance, from {m.data.tokenAccounts} token account
          {m.data.tokenAccounts === 1 ? "" : "s"} ({m.data.zeroBalanceAccounts} empty excluded
          {m.data.programOwnedExcluded ? `, ${m.data.programOwnedExcluded} program-controlled excluded` : ""}). Read from
          the RPC at confirmed commitment, so it can lag the latest blocks.
        </small>
      )}
      {!m.data && !m.loading && (
        <small className="helper">
          Counting holders needs an RPC that allows token-account queries. Public RPCs often block this; set
          VITE_SOLANA_RPC to a provider endpoint if needed.
        </small>
      )}
      <Footer m={m} />
    </div>
  );
}

const EVENT_LABEL = {
  pool_created: "Pool created + initial liquidity",
  liquidity_added: "Liquidity added",
  liquidity_removed: "Liquidity removed",
  swap: "Swap",
  other: "Other",
};

// Liquidity history for one pool: current vs cumulative added vs cumulative removed, plus
// paginated events. Read-only; counts come from individual confirmed transactions.
export function PoolActivity({ record, symbol }) {
  const { connection } = useConnection();
  const [shown, setShown] = useState(10);
  const [showSwaps, setShowSwaps] = useState(false);
  const m = useMetric(`history:${record.poolId}`, async () => {
    const reserves = await fetchPoolReserves(connection, { poolId: record.poolId, tokenMint: record.mint });
    const history = await fetchPoolHistory(connection, {
      poolId: record.poolId,
      vaults: { tokenVault: reserves.token.vault, solVault: reserves.sol.vault },
    });
    return { reserves, ...history };
  });
  const name = symbol || record.symbol || "tokens";
  const d = m.data;
  const rows = d ? d.events.filter((e) => showSwaps || e.type !== "swap") : [];
  const tok = (raw) => fromRawUnits(raw < 0n ? -raw : raw, d.reserves.token.decimals);
  const solAmt = (raw) => fromRawUnits(raw < 0n ? -raw : raw, d.reserves.sol.decimals);

  return (
    <div className="metric-box">
      <strong>Liquidity History</strong>
      {d ? (
        <>
          <dl className="cost-list">
            <dt>Current liquidity (in the pool now)</dt>
            <dd>
              {tok(d.reserves.token.raw)} {name} · {solAmt(d.reserves.sol.raw)} SOL
            </dd>
            <dt>Cumulative added ({d.summary.additions} tx)</dt>
            <dd>
              {tok(d.summary.addedToken)} {name} · {solAmt(d.summary.addedSol)} SOL
            </dd>
            <dt>Cumulative removed ({d.summary.removals} tx)</dt>
            <dd>
              {tok(d.summary.removedToken)} {name} · {solAmt(d.summary.removedSol)} SOL
            </dd>
          </dl>
          {!d.complete && (
            <p className="helper warning-text">
              Only the most recent transactions were scanned, so cumulative totals may be incomplete.
            </p>
          )}
          {d.missing > 0 && (
            <p className="helper warning-text">
              {d.missing} transaction{d.missing === 1 ? "" : "s"} couldn't be read from the RPC yet (delayed indexing or
              pruned history) and are not counted.
            </p>
          )}
          <label className="helper">
            <input type="checkbox" checked={showSwaps} onChange={(e) => setShowSwaps(e.target.checked)} /> Show swaps
            ({d.summary.swaps}), which are not liquidity
          </label>
          {rows.length === 0 ? (
            <p className="helper">No liquidity events found in the scanned history.</p>
          ) : (
            <ul className="event-list">
              {rows.slice(0, shown).map((e) => (
                <li key={e.signature}>
                  <strong>{EVENT_LABEL[e.type]}</strong>
                  <span>{e.blockTime ? new Date(e.blockTime * 1000).toLocaleString() : "time unavailable"}</span>
                  <span>
                    {tok(e.tokenRaw)} {name} · {solAmt(e.solRaw)} SOL
                  </span>
                  <a href={explorerTx(e.signature)} target="_blank" rel="noopener noreferrer">
                    {shorten(e.signature, 6, 6)} ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
          {rows.length > shown && (
            <button type="button" className="text-button" onClick={() => setShown((n) => n + 10)}>
              Show more ({rows.length - shown} older)
            </button>
          )}
          <small className="helper">
            Reconstructed from confirmed on-chain transactions that changed the pool's vault balances, in native token and
            SOL units (no USD conversion). Current liquidity is not the same as cumulative liquidity added.
          </small>
        </>
      ) : m.loading ? (
        <div className="skeleton" aria-busy="true" />
      ) : (
        <p className="helper warning-text">History unavailable: {m.error}. This is not the same as zero activity.</p>
      )}
      {d && m.error && <p className="helper warning-text">Refresh failed: {m.error}. Showing the last good data.</p>}
      <Footer m={m} />
    </div>
  );
}
