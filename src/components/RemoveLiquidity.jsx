import { useRef, useState } from "react";
import { fetchPool, prepareRemoveLiquidity } from "../lib/raydium";
import { verifyPool } from "../lib/pools";
import { inspectTransaction, refreshTransactionBlockhash, signSendConfirm, simulateWithCost, toFailure } from "../lib/txRunner";
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
  const inFlight = useRef(false);

  const lpRaw = verified.lpRaw;
  const hasLp = lpRaw > 0n;
  const burn = percent ? (lpRaw * BigInt(percent)) / 100n : 0n;
  const share = verified.lpSupply > 0n ? Number(burn) / Number(verified.lpSupply) : 0;
  const estToken = verified.reserves.token * share;
  const estSol = verified.reserves.sol * share;
  const symbol = verified.tokenSymbol || record.symbol || "tokens";

  async function handleWithdraw() {
    if (inFlight.current || burn <= 0n) return;
    inFlight.current = true;
    const selectedPercent = percent;
    setFailure(null);
    setDone(null);
    setBusy(true);
    try {
      setStage("Refreshing pool and LP position…");
      const raydium = await getRaydium();
      const current = await verifyPool({
        connection,
        owner: publicKey,
        record,
        getRaydium: async () => raydium,
      });
      if (current.status !== "verified" || current.lpRaw <= 0n) {
        throw new Error(current.message || "The pool or your LP position could not be verified. Refresh and try again.");
      }
      const freshBurn = (current.lpRaw * BigInt(selectedPercent)) / 100n;
      if (freshBurn <= 0n || freshBurn > current.lpRaw) {
        throw new Error("The selected withdrawal amount is no longer valid for your current LP balance.");
      }

      setStage("Building the withdrawal…");
      const built = await prepareRemoveLiquidity(raydium, {
        poolInfo: current.poolInfo,
        poolKeys: current.poolKeys,
        lpRaw: freshBurn,
        slippagePercent: slippage,
      });
      const tx = built.transaction;
      if (!tx) throw new Error("The Raydium SDK didn't return a transaction to sign.");

      // Refresh the actual transaction, not only the simulation copy. Then inspect and
      // simulate that same message before asking Phantom to sign it.
      const refreshed = await refreshTransactionBlockhash(connection, tx, publicKey);
      const inspection = await inspectTransaction(connection, refreshed.transaction, publicKey);
      if (inspection.problems.length) {
        throw new Error(`Withdrawal transaction validation failed: ${inspection.problems.join(" ")}`);
      }

      setStage("Simulating withdrawal…");
      const simulation = await simulateWithCost(connection, refreshed.transaction, publicKey);
      const blockhashCheck = await connection.isBlockhashValid(refreshed.blockhash, { commitment: "confirmed" });
      if (!blockhashCheck.value) {
        throw new Error("The withdrawal transaction blockhash expired during simulation. Please retry to rebuild it.");
      }

      const { signature } = await signSendConfirm({
        connection,
        transaction: refreshed.transaction,
        signTransaction,
        sendTransaction,
        context: {
          inspection,
          transactionFormat: inspection.version === "legacy" ? "legacy" : `versioned (${inspection.version})`,
          simulation: { unitsConsumed: simulation.unitsConsumed, outflow: simulation.outflow },
          withdrawal: {
            poolId: record.poolId,
            lpMint: current.lpMint,
            lpTokenBalance: current.lpRaw.toString(),
            requestedLpAmount: freshBurn.toString(),
            percent: selectedPercent,
            slippagePercent: slippage,
            reserves: current.reserves,
            lpDecimals: current.lpDecimals,
          },
        },
        onStage: (name) => setStage(({ signing: "Waiting for Phantom approval…", submitting: "Sending…", confirming: "Waiting for confirmation…" })[name] || ""),
      });

      setStage("Verifying withdrawal on-chain…");
      const after = await verifyPool({
        connection,
        owner: publicKey,
        record,
        getRaydium: async () => raydium,
      });
      if (after.status !== "verified" && after.status !== "emptied") {
        throw new Error("The withdrawal confirmed, but BALNEX could not verify the updated pool and LP position. Check the transaction before retrying.");
      }
      if (after.lpRaw >= current.lpRaw) {
        throw new Error("The transaction confirmed, but the wallet's LP balance did not decrease as expected. Check the transaction before retrying.");
      }

      setDone({ signature, percent: selectedPercent });
      setPercent("");
      notify("Liquidity withdrawn and verified on-chain.", "success");
      setStage("Refreshing your position…");
      await onChanged(signature);
    } catch (err) {
      setFailure(toFailure(err));
      notify("Withdrawal did not complete. See details below.", "error");
    } finally {
      inFlight.current = false;
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

          <button type="button" className="danger-button" disabled={busy || burn <= 0n} onClick={handleWithdraw}>
            <span aria-hidden="true">⊖</span> {busy ? stage || "Working…" : percent ? `Confirm: remove ${percent}%` : "Choose an amount"}
          </button>
        </>
      )}
    </div>
  );
}
