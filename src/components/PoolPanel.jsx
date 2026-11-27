import { CLUSTER } from "../config";
import { explorerAddress, explorerTx, fromRawUnits, shorten } from "../lib/utils";
import { useToast } from "./Toast";

const fmt = (n, max = 6) => Number(n).toLocaleString(undefined, { maximumFractionDigits: max });

function CopyRow({ label, value, href }) {
  const notify = useToast();
  function copy() {
    navigator.clipboard?.writeText(value).then(
      () => notify(`${label} copied.`, "success"),
      () => notify("Couldn't copy automatically.", "error")
    );
  }
  return (
    <div className="copy-row">
      <span>{label}</span>
      <code title={value}>{shorten(value, 8, 8)}</code>
      <button type="button" className="text-button" onClick={copy}>
        Copy
      </button>
      <a href={href} target="_blank" rel="noopener noreferrer">
        ↗
      </a>
    </div>
  );
}

// Verified pool details. Everything shown here comes from the chain check in lib/pools,
// except the initial deposit amounts, which come from the confirmed creation record.
export default function PoolPanel({ record, verified, onRemove, onForget }) {
  const label = record.symbol ? `$${record.symbol}` : shorten(record.mint, 4, 4);

  if (verified?.status && verified.status !== "verified") {
    return (
      <div className="pool-panel pool-unavailable">
        <div className="pool-head">
          <strong>{label} / SOL</strong>
          <span className="badge badge-warn">Not verified</span>
        </div>
        <p className="helper">{verified.message}</p>
        <p className="helper">Management is locked for this pool until the chain confirms it.</p>
        <button type="button" className="text-button" onClick={onForget}>
          Remove from this list
        </button>
      </div>
    );
  }

  if (!verified) {
    return (
      <div className="pool-panel" aria-busy="true">
        <div className="pool-head">
          <strong>{label} / SOL</strong>
          <span className="badge">Verifying on-chain…</span>
        </div>
        <div className="skeleton" />
      </div>
    );
  }

  const hasLp = verified.lpRaw > 0n;
  const share = verified.lpSupply > 0n ? (Number(verified.lpRaw) / Number(verified.lpSupply)) * 100 : 0;

  return (
    <div className="pool-panel">
      <div className="pool-head">
        <div>
          <strong>
            {record.name ? `${record.name} · ` : ""}
            {label} / SOL
          </strong>
          <small className="helper">Raydium CPMM pool</small>
        </div>
        <div className="badges">
          <span className="badge">{CLUSTER === "devnet" ? "Devnet" : "Mainnet"}</span>
          <span className="badge badge-ok">
            ✓ {verified.txStatus === "unavailable" ? "Pool verified" : `Creation ${verified.txStatus}`}
          </span>
        </div>
      </div>

      <dl className="pool-grid">
        <div>
          <dt>Initial token liquidity</dt>
          <dd>{record.tokenDeposited}</dd>
        </div>
        <div>
          <dt>Initial SOL liquidity</dt>
          <dd>{fromRawUnits(BigInt(record.solDeposited), 9)} SOL</dd>
        </div>
        <div>
          <dt>Pool reserves now</dt>
          <dd>
            {fmt(verified.reserves.token)} {verified.tokenSymbol || "tokens"}
            <br />
            {fmt(verified.reserves.sol)} SOL
          </dd>
        </div>
        <div>
          <dt>Your LP position</dt>
          <dd>
            {fromRawUnits(verified.lpRaw, verified.lpDecimals)}
            <br />
            <small>{hasLp ? `${fmt(share, 4)}% of the pool` : "No LP tokens in this wallet"}</small>
          </dd>
        </div>
      </dl>

      <CopyRow label="Pool address" value={record.poolId} href={explorerAddress(record.poolId)} />
      {record.signature && <CopyRow label="Creation tx" value={record.signature} href={explorerTx(record.signature)} />}

      <button type="button" className="danger-button" onClick={onRemove}>
        <span aria-hidden="true">⊖</span> Remove Liquidity
      </button>
      {!hasLp && <small className="helper">This wallet holds no LP tokens for this pool, so there's nothing to withdraw.</small>}
    </div>
  );
}
