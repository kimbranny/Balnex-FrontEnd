import { CLUSTER } from "../config";
import { explorerAddress, explorerTx, shorten } from "../lib/utils";

export default function LaunchCard({ launch, onContinue }) {
  if (!launch) return null;
  const lifecycle = launch.lifecycleStatus || (launch.status === "liquidity_created" ? "POOL_RUNNING" : "TOKEN_CREATED");
  const label = launch.symbol ? `$${launch.symbol}` : shorten(launch.mint, 4, 4);
  const safeSigningRetry = lifecycle === "TOKEN_RESERVED" && launch.operation?.state === "failed_no_submission";
  const recovery = lifecycle === "RECOVERY_REQUIRED" || ["unknown", "submitted", "failed_submitted"].includes(launch.operation?.state) || Boolean(launch.recovery) || safeSigningRetry;

  return (
    <div className="pool-panel launch-card">
      <div className="pool-head">
        <div>
          <strong>LIQUIDITY WORKFLOW LOCKED</strong>
          <small className="helper">Complete or resolve this token's liquidity lifecycle before creating another token.</small>
        </div>
        <div className="badges">
          <span className="badge">{CLUSTER === "devnet" ? "Devnet" : "Mainnet"}</span>
          <span className={recovery ? "badge badge-warn" : lifecycle === "POOL_RUNNING" ? "badge badge-ok" : "badge badge-warn"}>
            {lifecycle.replaceAll("_", " ")}
          </span>
        </div>
      </div>
      <dl className="pool-grid">
        <div><dt>Token</dt><dd>{launch.name || "Unnamed"} ({label})</dd></div>
        <div><dt>Mint address</dt><dd><a href={explorerAddress(launch.mint)} target="_blank" rel="noopener noreferrer">{shorten(launch.mint, 6, 6)} ↗</a></dd></div>
        <div><dt>Token creation tx</dt><dd>{(launch.signature || launch.transactions?.tokenCreation) ? <a href={explorerTx(launch.signature || launch.transactions.tokenCreation)} target="_blank" rel="noopener noreferrer">{shorten(launch.signature || launch.transactions.tokenCreation, 6, 6)} ↗</a> : "Not submitted / not recorded"}</dd></div>
        {launch.poolId && <div><dt>Pool address</dt><dd><a href={explorerAddress(launch.poolId)} target="_blank" rel="noopener noreferrer">{shorten(launch.poolId, 6, 6)} ↗</a></dd></div>}
        {launch.operation?.signature && <div><dt>Latest transaction</dt><dd><a href={explorerTx(launch.operation.signature)} target="_blank" rel="noopener noreferrer">{shorten(launch.operation.signature, 6, 6)} ↗</a></dd></div>}
        <div><dt>Operation</dt><dd>{launch.operation?.type || "Token lifecycle"} · {launch.operation?.state || "awaiting action"}</dd></div>
      </dl>
      {recovery && <div className="notice notice-error"><div>
        <strong>{safeSigningRetry ? "Wallet signing failed — nothing was submitted" : "Recovery required"}</strong>
        <p>{safeSigningRetry ? "The reserved token is retained. You can safely rebuild and retry token creation for this reservation." : "Transaction status must be verified on Devnet before another attempt. The global lock remains active."}</p>
      </div></div>}
      {onContinue && <button type="button" className="primary" onClick={onContinue}>{safeSigningRetry ? "RETRY TOKEN CREATION" : "RESUME CURRENT TOKEN"} <span>→</span></button>}
    </div>
  );
}
