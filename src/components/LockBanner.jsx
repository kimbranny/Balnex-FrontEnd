import { CLUSTER } from "../config";
import { STATE, STATE_LABEL, TX } from "../lib/lifecycleLock";
import { useLifecycleLock, useVerifyLifecycle } from "../lib/useLifecycleLock";
import { explorerAddress, explorerTx, shorten } from "../lib/utils";

// What the person should understand, and what (if anything) is safe to do next.
export function describeRecovery(lock) {
  const op = lock.op;
  const reason = lock.recovery?.reason;
  const result = lock.lastVerification?.result;

  if (reason === "rpc_unavailable") {
    return {
      tone: "warn",
      title: "RPC verification unavailable",
      body: "The network couldn't be reached, so nothing could be checked. Your token stays locked. Try VERIFY STATUS again in a moment.",
      verify: true,
    };
  }
  if (lock.status === STATE.RECOVERY_REQUIRED) {
    const submitted = !!op?.signature;
    return {
      tone: "danger",
      title: submitted ? "Transaction status unknown" : "Recovery required",
      body: submitted
        ? "A transaction was submitted but BALNEX couldn't confirm what happened to it. It will not be retried blindly. Use VERIFY STATUS to check it on-chain."
        : "An operation may have reached the network. Use VERIFY STATUS to check the chain before anything else is attempted.",
      verify: true,
    };
  }
  if (reason === "signing_failed") {
    return {
      tone: "warn",
      title: "Signing failed",
      body: "Your wallet didn't sign, so nothing was submitted and no SOL moved. It is safe to retry for this same token.",
      retry: true,
    };
  }
  if (lock.status === STATE.REMOVAL_PENDING) {
    return op?.txState === TX.FAILED
      ? {
          tone: "warn",
          title: "Liquidity removal failed",
          body: "The pool and your position are re-checked on-chain before a retry is offered. Use VERIFY STATUS.",
          verify: true,
        }
      : {
          tone: "info",
          title: "Liquidity removal pending",
          body: "Your lock stays in place until the removal is confirmed and read back from the chain.",
          verify: true,
        };
  }
  if (lock.status === STATE.ADD_LIQUIDITY_PENDING) {
    return { tone: "info", title: "Add liquidity pending", body: "Waiting for the transaction to be confirmed and verified on-chain.", verify: true };
  }
  if (lock.status === STATE.POOL_PENDING) {
    return op?.txState === TX.SUBMITTED
      ? {
          tone: "warn",
          title: "Pool creation submitted, not confirmed",
          body: "The transaction was sent but isn't confirmed yet. Use VERIFY STATUS; a retry is only offered once it is proven that no pool was created.",
          verify: true,
        }
      : {
          tone: "warn",
          title: "Pool creation failed",
          body: "The token stays locked. A retry is available for this token once it is confirmed that no pool was created.",
          retry: op?.safeRetry,
          verify: true,
        };
  }
  if (result === "pool_found_on_chain") {
    return { tone: "ok", title: "Pool already exists", body: "A confirmed pool for this token was found on-chain, so it was restored as running.", verify: false };
  }
  return null;
}

export default function LockBanner({ onResume }) {
  const { lock, corrupt } = useLifecycleLock();
  const { verify, checking } = useVerifyLifecycle();

  if (corrupt) {
    return (
      <div className="lock-banner lock-banner-danger" role="alert">
        <div className="lock-banner-head">LIQUIDITY WORKFLOW LOCKED</div>
        <p>BALNEX can't read its saved lifecycle state, so token and pool creation are blocked to stay safe.</p>
      </div>
    );
  }
  if (!lock) return null;

  const info = describeRecovery(lock);
  const label = lock.symbol ? `${lock.name || "Unnamed"} (${lock.symbol})` : lock.name || "Unnamed";
  const mint = lock.mint || lock.pendingMint;
  const signature = lock.op?.signature || lock.removeSignature || lock.poolSignature || lock.creationSignature;

  return (
    <div className={`lock-banner ${info?.tone === "danger" ? "lock-banner-danger" : ""}`} role="status">
      <div className="lock-banner-main">
        <div>
          <div className="lock-banner-head">LIQUIDITY WORKFLOW LOCKED</div>
          <div className="lock-banner-line">
            Token: <strong>{label}</strong>
          </div>
          <div className="lock-banner-line">
            Status: <strong>{STATE_LABEL[lock.status] || lock.status}</strong>
          </div>
          <p className="lock-banner-text">
            You must complete or resolve this token's liquidity lifecycle before creating another token.
          </p>
        </div>
        <button type="button" className="primary lock-banner-button" onClick={() => onResume(lock)}>
          RESUME CURRENT TOKEN <span>→</span>
        </button>
      </div>

      {info && (
        <div className={`lock-recovery lock-recovery-${info.tone}`}>
          <strong>{info.title}</strong>
          <p>{info.body}</p>
          {lock.recovery?.message && <p className="lock-detail">Details: {lock.recovery.message}</p>}
          <div className="lock-ids">
            {mint && (
              <span>
                Mint:{" "}
                <a href={explorerAddress(mint)} target="_blank" rel="noopener noreferrer">
                  {shorten(mint, 6, 6)} ↗
                </a>
              </span>
            )}
            {signature && (
              <span>
                Transaction:{" "}
                <a href={explorerTx(signature)} target="_blank" rel="noopener noreferrer">
                  {shorten(signature, 6, 6)} ↗
                </a>
              </span>
            )}
            <span>{CLUSTER === "devnet" ? "Devnet" : "Mainnet"}</span>
          </div>
          {info.verify && (
            <button type="button" className="secondary-button" disabled={checking} onClick={verify}>
              {checking ? "Checking the chain…" : "VERIFY STATUS"}
            </button>
          )}
          {info.retry && <small className="helper">Retry from the Liquidity page. It is the same token and the same step.</small>}
        </div>
      )}
    </div>
  );
}
