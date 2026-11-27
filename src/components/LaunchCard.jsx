import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createBurnInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CLUSTER } from "../config";
import { abandonLaunch } from "../lib/launch";
import { readMint } from "../lib/raydium";
import { StageError, signSendConfirm, simulateWithCost, toFailure } from "../lib/txRunner";
import { explorerAddress, explorerTx, fromRawUnits, shorten } from "../lib/utils";
import Diagnostics from "./Diagnostics";
import { useToast } from "./Toast";

// Shown while the wallet has an unfinished launch: status, Continue, and Abandon.
export default function LaunchCard({ launch, onContinue }) {
  const [open, setOpen] = useState(false);
  const label = launch.symbol ? `$${launch.symbol}` : shorten(launch.mint, 4, 4);

  return (
    <div className="pool-panel launch-card">
      <div className="pool-head">
        <div>
          <strong>Launch in progress</strong>
          <small className="helper">Finish this launch before creating another token.</small>
        </div>
        <div className="badges">
          <span className="badge">{CLUSTER === "devnet" ? "Devnet" : "Mainnet"}</span>
          <span className="badge badge-warn">Pool not created yet</span>
        </div>
      </div>

      <dl className="pool-grid">
        <div>
          <dt>Token</dt>
          <dd>
            {launch.name || "Unnamed"} {launch.symbol && `(${label})`}
          </dd>
        </div>
        <div>
          <dt>Mint address</dt>
          <dd>
            <a href={explorerAddress(launch.mint)} target="_blank" rel="noopener noreferrer">
              {shorten(launch.mint, 6, 6)} ↗
            </a>
          </dd>
        </div>
        <div>
          <dt>Creation tx</dt>
          <dd>
            <a href={explorerTx(launch.signature)} target="_blank" rel="noopener noreferrer">
              {shorten(launch.signature, 6, 6)} ↗
            </a>
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>Token created · waiting for pool</dd>
        </div>
      </dl>

      {onContinue && (
        <button type="button" className="primary" onClick={onContinue}>
          Continue Current Launch <span>→</span>
        </button>
      )}
      <button type="button" className="text-button danger-text" onClick={() => setOpen(true)}>
        Abandon This Launch
      </button>

      {open && <AbandonDialog launch={launch} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AbandonDialog({ launch, onClose }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const notify = useToast();

  const [balance, setBalance] = useState(null); // { raw, decimals, ata, programId }
  const [loading, setLoading] = useState(true);
  const [burn, setBurn] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [failure, setFailure] = useState(null);

  const symbol = launch.symbol ? `$${launch.symbol}` : "tokens";

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await readMint(connection, launch.mint);
        const ata = getAssociatedTokenAddressSync(
          new PublicKey(launch.mint),
          publicKey,
          false,
          new PublicKey(info.programId)
        );
        let raw = 0n;
        try {
          const res = await connection.getTokenAccountBalance(ata, "confirmed");
          raw = BigInt(res.value.amount);
        } catch {
          raw = 0n; // no token account yet
        }
        if (!cancelled) setBalance({ raw, decimals: info.decimals, ata, programId: info.programId });
      } catch (err) {
        if (!cancelled) setBalance({ raw: 0n, decimals: launch.decimals ?? 0, error: err?.message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, launch.mint, launch.decimals, publicKey]);

  const canBurn = !!balance && !balance.error && balance.raw > 0n;

  function finish(extra) {
    abandonLaunch(launch.wallet, launch.mint, extra);
    notify("Launch abandoned. You can create a new token.", "success");
    onClose();
  }

  async function confirm() {
    setFailure(null);

    if (!burn) {
      finish({});
      return;
    }

    setBusy(true);
    try {
      const mint = new PublicKey(launch.mint);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
        createBurnInstruction(balance.ata, mint, publicKey, balance.raw, [], new PublicKey(balance.programId))
      );

      setStage("Simulating the burn…");
      await simulateWithCost(connection, tx, publicKey);

      const labels = {
        signing: "Waiting for Phantom approval…",
        "signing-alt": "Retrying with Phantom's sign-and-send…",
        submitting: "Sending…",
        confirming: "Waiting for confirmation…",
      };
      const { signature } = await signSendConfirm({
        connection,
        transaction: tx,
        signTransaction,
        sendTransaction,
        onStage: (name) => setStage(labels[name] || ""),
      });

      // Don't claim success until the chain shows the tokens are gone.
      setStage("Verifying the burn…");
      const after = await connection.getTokenAccountBalance(balance.ata, "confirmed");
      if (after.value.amount !== "0") {
        throw new StageError("verification", "The burn transaction confirmed, but tokens still remain in your account.", {
          submitted: true,
          signature,
        });
      }

      abandonLaunch(launch.wallet, launch.mint, {
        burnSignature: signature,
        burnedRaw: String(balance.raw),
      });
      notify("Tokens burned and launch abandoned.", "success");
      onClose();
    } catch (err) {
      setFailure(toFailure(err));
      notify("The burn did not complete, so this launch was NOT abandoned.", "error");
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="abandon-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="abandon-title">Abandon this launch?</h3>
        <ul className="modal-list">
          <li>
            Your token mint <code>{shorten(launch.mint, 6, 6)}</code> already exists on Solana. Abandoning does not delete
            it or its blockchain history.
          </li>
          <li>You'll no longer continue this launch through BALNEX, and you'll be able to create another token.</li>
          <li>The SOL spent on creating the mint and on fees is not refunded.</li>
          <li>Burning your tokens is optional. You can abandon without burning.</li>
        </ul>

        {loading ? (
          <p className="helper">Checking your token balance…</p>
        ) : canBurn ? (
          <label className="check-row">
            <input type="checkbox" checked={burn} disabled={busy} onChange={(e) => { setBurn(e.target.checked); setUnderstood(false); }} />
            <span>
              Also burn my tokens: <strong>{fromRawUnits(balance.raw, balance.decimals)} {symbol}</strong>
            </span>
          </label>
        ) : (
          <p className="helper">
            {balance?.error
              ? "Couldn't read your token balance, so burning isn't offered right now."
              : "You hold no tokens of this mint in your main token account, so there is nothing to burn."}
          </p>
        )}

        {burn && canBurn && (
          <label className="check-row">
            <input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>I understand burning is permanent and can't be undone.</span>
          </label>
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

        <div className="button-row">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Keep this launch
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy || loading || (burn && !understood)}
            onClick={confirm}
          >
            {busy ? stage || "Working…" : burn ? "Burn tokens and abandon" : "Abandon launch"}
          </button>
        </div>
      </div>
    </div>
  );
}
