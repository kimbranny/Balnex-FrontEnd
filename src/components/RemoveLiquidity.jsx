import { useState } from "react";
import { prepareRemoveLiquidity } from "../lib/raydium";
import { beginRemoveLiquidity, checkAllowed, OP } from "../lib/lifecycleLock";
import { lpForPercent, estimateOutputs, minOutput } from "../lib/liquidityMath";
import { StageError, describeError, inspectTransaction, messageOf, signSendConfirm, simulateWithCost, toFailure } from "../lib/txRunner";
import { useLifecycleLock, useVerifyLifecycle } from "../lib/useLifecycleLock";
import { explorerTx, fromRawUnits, shorten } from "../lib/utils";
import Diagnostics from "./Diagnostics";

const SLIPPAGE_OPTIONS = [0.5, 1, 3];
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });

// Withdraw liquidity from ONE verified pool. The pool address comes from the verified
// record, never from user input.
export default function RemoveLiquidity({
  record,
  verified,
  connection,
  publicKey,
  getRaydium,
  signTransaction,
  sendTransaction,
  notify,
  onBack,
  onChanged,
}) {
  const [percent, setPercent] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);
  // Wallet method is chosen by the user after a failure; it is never switched automatically.
  const [method, setMethod] = useState("sign");
  useLifecycleLock(); // re-render when the lock changes
  const { verify: verifyLock } = useVerifyLifecycle();
  const gate = checkAllowed(OP.REMOVE_LIQUIDITY, record.mint);

  const lpRaw = verified.lpRaw;
  const hasLp = lpRaw > 0n;
  const burn = percent ? lpForPercent(lpRaw, percent) : 0n;
  const { token: estToken, sol: estSol } = estimateOutputs(verified.reserves, burn, verified.lpSupply);
  const symbol = verified.tokenSymbol || record.symbol || "tokens";

  async function handleWithdraw() {
    if (burn <= 0n) return;
    // Action-level guard (synchronous): lock must exist for THIS token, the state must allow
    // removal, and no other operation may be running (double-click safe).
    const begun = beginRemoveLiquidity(record.mint, {});
    if (!begun.ok) {
      notify(begun.message, "error");
      return;
    }
    const op = begun.handle;
    let confirmedOnChain = false;
    setFailure(null);
    setDone(null);
    setBusy(true);
    try {
      setStage("Building the withdrawal…");
      const raydium = await getRaydium();
      const built = await prepareRemoveLiquidity(raydium, {
        poolInfo: verified.poolInfo,
        poolKeys: verified.poolKeys,
        lpRaw: burn,
        slippagePercent: slippage,
      });
      const tx = built.transaction;
      if (!tx) throw new Error("The Raydium SDK didn't return a transaction to sign.");

      // Everything below is public data only (addresses, sizes, amounts); never keys.
      setStage("Inspecting the transaction…");
      const inspection = await inspectTransaction(connection, tx, publicKey, verified.poolInfo?.programId);
      const diagnostics = {
        pool: record.poolId,
        cpmmProgram: verified.poolInfo?.programId || null,
        lpMint: verified.lpMint,
        lpBalanceRaw: String(lpRaw),
        lpToBurnRaw: String(burn),
        selectedPercent: percent,
        slippagePercent: slippage,
        estimatedTokenOut: estToken,
        estimatedSolOut: estSol,
        minTokenOut: minOutput(estToken, slippage),
        minSolOut: minOutput(estSol, slippage),
        walletIsLpOwner: publicKey.toBase58() === record.owner,
        method,
      };
      if (publicKey.toBase58() !== record.owner) {
        throw new StageError("prepare", "The connected wallet isn't the owner of this pool's LP tokens.", { submitted: false, inspection, extra: diagnostics });
      }
      if (inspection.problems.length) {
        throw new StageError("prepare", `Transaction check failed: ${inspection.problems.join(" ")}`, { submitted: false, inspection, extra: diagnostics });
      }

      setStage("Simulating…");
      try {
        await simulateWithCost(connection, tx, publicKey);
      } catch (simErr) {
        if (simErr instanceof StageError) simErr.details = { ...simErr.details, inspection, extra: diagnostics };
        throw simErr;
      }

      const labels = {
        signing: "Waiting for Phantom approval…",
        "signing-alt": "Retrying with Phantom's sign-and-send…",
        submitting: "Sending…",
        confirming: "Waiting for confirmation…",
      };
      op.signing(messageOf(tx).recentBlockhash);
      const { signature } = await signSendConfirm({
        connection,
        transaction: tx,
        signTransaction,
        sendTransaction,
        onStage: (name) => {
          if (name === "signing-alt") op.markMaybeSubmitted();
          setStage(labels[name] || "");
        },
        onSubmitted: (sig, blockhash) => op.submitted({ signature: sig, blockhash }),
        method,
        context: { inspection, transactionFormat: inspection.version, extra: diagnostics },
      });
      op.confirmed({ signature }); // transaction confirmed; the lock stays until verified on-chain
      confirmedOnChain = true;

      setDone({ signature, percent });
      setPercent("");
      notify("Liquidity withdrawn.", "success");
      setStage("Refreshing your position…");
      await onChanged(signature);
    } catch (err) {
      setFailure(toFailure(err));
      notify("Withdrawal did not complete. See details below.", "error");
      // Percentage stays selected so a user-requested retry rebuilds the same withdrawal fresh.
      if (!confirmedOnChain) {
        const d = describeError(err);
        op.failed({ submitted: d.submitted, signature: d.signature, message: d.message, stage: d.stage });
        verifyLock(); // re-check pool + position before any retry is offered
      }
    } finally {
      op.end();
      setBusy(false);
      setStage("");
    }
  }

  return (
    <div className="pool-panel">
      <div className="pool-head">
        <strong>Remove liquidity · {record.symbol ? `$${record.symbol}` : shorten(record.mint, 4, 4)} / SOL</strong>
        <button type="button" className="text-button" onClick={onBack} disabled={busy}>
          ← Pool details
        </button>
      </div>

      <div className="copy-row">
        <span>Pool</span>
        <code title={record.poolId}>{shorten(record.poolId, 8, 8)}</code>
      </div>

      <dl className="pool-grid">
        <div>
          <dt>Your LP balance</dt>
          <dd>{fromRawUnits(lpRaw, verified.lpDecimals)}</dd>
        </div>
        <div>
          <dt>Pool reserves</dt>
          <dd>
            {fmt(verified.reserves.token)} {symbol}
            <br />
            {fmt(verified.reserves.sol)} SOL
          </dd>
        </div>
      </dl>

      {done && (
        <div className="success-banner">
          <span>✓</span>
          <div>
            <strong>Withdrawal confirmed ({done.percent}%)</strong>
            <p>
              <a href={explorerTx(done.signature)} target="_blank" rel="noopener noreferrer">
                View transaction ↗
              </a>
            </p>
          </div>
        </div>
      )}

      {failure && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>{failure.info.title}</strong>
            <p>{failure.info.outcome}</p>
            <p>{failure.info.body}</p>
            {failure.diag?.stage === "signing" && (
              <>
                <p>
                  This is a wallet-signing failure, not a Raydium or on-chain failure. Check that Phantom is set to Solana
                  Devnet (Settings → Developer Settings → Testnet Mode) and unlocked, then retry. Every retry rebuilds the
                  withdrawal from fresh on-chain data and a fresh blockhash.
                </p>
                {failure.diag?.walletErrorCode === -32603 && method === "sign" && (
                  <button type="button" className="text-button" disabled={busy} onClick={() => setMethod("signAndSend")}>
                    Use Phantom's sign-and-send on my next attempt
                  </button>
                )}
              </>
            )}
            <Diagnostics data={failure.diag} />
          </div>
        </div>
      )}

      {!hasLp ? (
        <div className="notice">
          <span className="notice-icon">ⓘ</span>
          <div>
            <strong>Nothing to withdraw</strong>
            <p>
              The connected wallet holds no LP tokens for this pool, so liquidity can't be removed from here. The LP
              tokens may have been withdrawn already or sent to another wallet.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label>Amount to remove</label>
            <div className="liquidity-percentages" role="group" aria-label="Share of your liquidity">
              {[25, 50, 75, 100].map((value) => (
                <button
                  type="button"
                  key={value}
                  className={percent === String(value) ? "liquidity-percentage selected" : "liquidity-percentage"}
                  aria-pressed={percent === String(value)}
                  onClick={() => setPercent(String(value))}
                  disabled={busy}
                >
                  {value}%
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Slippage tolerance</label>
            <div className="liquidity-percentages" role="group" aria-label="Slippage tolerance">
              {SLIPPAGE_OPTIONS.map((value) => (
                <button
                  type="button"
                  key={value}
                  className={slippage === value ? "liquidity-percentage selected" : "liquidity-percentage"}
                  aria-pressed={slippage === value}
                  onClick={() => setSlippage(value)}
                  disabled={busy}
                >
                  {value}%
                </button>
              ))}
            </div>
          </div>

          <div className="pool-preview">
            <div>
              <span>LP to burn</span>
              <strong>{percent ? fromRawUnits(burn, verified.lpDecimals) : "—"}</strong>
            </div>
            <div>
              <span>≈ {symbol} back</span>
              <strong>{percent ? fmt(estToken) : "—"}</strong>
            </div>
            <div>
              <span>≈ SOL back</span>
              <strong>{percent ? fmt(estSol) : "—"}</strong>
            </div>
          </div>
          <small className="helper">
            Estimates use your share of the live pool reserves; the final amounts can differ slightly within your slippage
            tolerance. Wrapped SOL from the pool is returned to you as SOL.
          </small>

          {!gate.ok && (
            <div className="notice" role="status">
              <span className="notice-icon">ⓘ</span>
              <div>
                <strong>Removal not available right now</strong>
                <p>{gate.message} Use VERIFY STATUS in the banner above if the status is unknown.</p>
              </div>
            </div>
          )}
          <button type="button" className="danger-button" disabled={busy || burn <= 0n || !gate.ok} onClick={handleWithdraw}>
            <span aria-hidden="true">⊖</span> {busy ? stage || "Working…" : percent ? `Confirm: remove ${percent}%` : "Choose an amount"}
          </button>
        </>
      )}
    </div>
  );
}
