import { useConnection } from "@solana/wallet-adapter-react";
import { fetchHolders, fetchPoolReserves } from "../lib/analytics";
import { useMetric } from "../lib/useMetric";
import { fromRawUnits } from "../lib/utils";

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
