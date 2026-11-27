import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useConnectSheet } from "../components/WalletSheet";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import Diagnostics from "../components/Diagnostics";
import { useToast } from "../components/Toast";
import { CLUSTER } from "../config";
import {
  AUTHORITIES,
  FEE_PER_AUTHORITY_LAMPORTS,
  buildRevocationInstructions,
  calcFee,
  feeStatus,
  verifyFeePaid,
} from "../lib/fees";
import { clearPending, evaluatePending, getPending, savePending } from "../lib/feeGuards";
import { readMint } from "../lib/raydium";
import { StageError, signSendConfirm, simulateWithCost, toFailure } from "../lib/txRunner";
import { explorerAddress, explorerTx, fromRawUnits, shorten } from "../lib/utils";

const PLAN_MAX_AGE_MS = 40000;
const BUFFER_LAMPORTS = 2000000n;
const sol = (lamports) => fromRawUnits(BigInt(lamports), 9);

export default function Manage({ walletTokens, onNavigate, onUseForLiquidity }) {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction, sendTransaction } = useWallet();
  const { open: openConnect } = useConnectSheet();
  const notify = useToast();
  const { tokens, loading, error, refresh } = walletTokens;

  const fee = feeStatus();
  const lock = useRef(false); // blocks double-clicks / duplicate submissions

  const [selection, setSelection] = useState({}); // { [mint]: { mint: bool, freeze: bool } }
  const [plans, setPlans] = useState({}); // { [mint]: plan }
  const [busyMint, setBusyMint] = useState("");
  const [stage, setStage] = useState("");
  const [failures, setFailures] = useState({});
  const [results, setResults] = useState({});

  // A different wallet must never inherit selections or a built transaction.
  const walletKey = publicKey ? publicKey.toBase58() : "";
  useEffect(() => {
    setSelection({});
    setPlans({});
    setFailures({});
    setResults({});
  }, [walletKey]);

  const selectedKinds = (mint) => Object.keys(selection[mint] || {}).filter((k) => selection[mint][k]);

  function toggle(mint, kind) {
    if (busyMint) return;
    setSelection((prev) => ({ ...prev, [mint]: { ...prev[mint], [kind]: !prev[mint]?.[kind] } }));
    setPlans((prev) => ({ ...prev, [mint]: undefined }));
    setResults((prev) => ({ ...prev, [mint]: undefined }));
  }

  // Reads the mint FRESH from the chain, keeps only authorities that are still active and
  // controlled by this wallet, then builds + simulates the single combined transaction.
  async function buildPlan(token) {
    if (!fee.ok) throw new StageError("prepare", fee.reason, { submitted: false });

    // 1) An earlier submission for this token might still be in flight or may have landed.
    //    Never build a second paid transaction until that is settled.
    for (const entry of getPending(publicKey.toBase58(), token.mint)) {
      const { value } = await connection.getSignatureStatuses([entry.signature], { searchTransactionHistory: true });
      const valid = entry.blockhash
        ? await connection.isBlockhashValid(entry.blockhash, { commitment: "confirmed" }).then((r) => r.value).catch(() => null)
        : null;
      const verdict = evaluatePending(value[0], valid);
      if (verdict === "pending") {
        throw new StageError(
          "confirmation",
          "A previous revocation transaction for this token is still awaiting confirmation. Wait for it to settle before trying again; you won't be charged twice.",
          { submitted: true, signature: entry.signature, landed: "unknown" }
        );
      }
      clearPending(entry.signature);
      if (verdict === "confirmed") {
        await refresh();
        throw new StageError(
          "confirmation",
          "Your previous revocation transaction went through. Your tokens have been refreshed; nothing further was charged.",
          { submitted: true, signature: entry.signature, landed: "confirmed" }
        );
      }
    }

    const mintKey = new PublicKey(token.mint);
    const info = await readMint(connection, token.mint);
    const programId = new PublicKey(info.programId);
    const live = await getMint(connection, mintKey, "confirmed", programId);
    const wallet = publicKey.toBase58();

    const eligible = selectedKinds(token.mint).filter((kind) => {
      const holder = live[AUTHORITIES[kind].field];
      return holder && holder.toBase58() === wallet;
    });
    const dropped = selectedKinds(token.mint).filter((kind) => !eligible.includes(kind));
    if (dropped.length) {
      notify("Some selected authorities are already revoked or not yours; they won't be charged.", "info");
    }

    const { kinds, total } = calcFee(eligible);
    if (kinds.length === 0) {
      throw new StageError("prepare", "None of the selected authorities can be revoked, so nothing will be charged.", {
        submitted: false,
      });
    }

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
      ...buildRevocationInstructions({
        owner: publicKey,
        mint: mintKey,
        programId,
        kinds,
        treasury: fee.treasury,
        feeLamports: total,
      })
    );

    await simulateWithCost(connection, tx, publicKey);

    let networkFee = 5000n;
    try {
      const res = await connection.getFeeForMessage(tx.compileMessage(), "confirmed");
      if (typeof res?.value === "number") networkFee = BigInt(res.value);
    } catch {
      // keep estimate
    }
    const balance = BigInt(await connection.getBalance(publicKey, "confirmed"));

    return { mint: token.mint, kinds, total, networkFee, balance, tx, builtAt: Date.now(), dropped };
  }

  async function handleReview(token) {
    if (lock.current) return;
    lock.current = true;
    setFailures((prev) => ({ ...prev, [token.mint]: undefined }));
    setResults((prev) => ({ ...prev, [token.mint]: undefined }));
    setBusyMint(token.mint);
    setStage("Checking the chain and simulating…");
    try {
      const plan = await buildPlan(token);
      setPlans((prev) => ({ ...prev, [token.mint]: plan }));
    } catch (err) {
      setFailures((prev) => ({ ...prev, [token.mint]: toFailure(err) }));
    } finally {
      lock.current = false;
      setBusyMint("");
      setStage("");
    }
  }

  async function handleConfirm(token) {
    const existing = plans[token.mint];
    if (!existing || lock.current) return;
    lock.current = true;
    setFailures((prev) => ({ ...prev, [token.mint]: undefined }));
    setBusyMint(token.mint);

    try {
      let plan = existing;
      if (Date.now() - plan.builtAt > PLAN_MAX_AGE_MS) {
        setStage("Refreshing the transaction…");
        plan = await buildPlan(token);
        if (plan.total !== existing.total) {
          setPlans((prev) => ({ ...prev, [token.mint]: plan }));
          throw new StageError("prepare", "The fee changed because some authorities are no longer eligible. Review the new total.", {
            submitted: false,
          });
        }
        setPlans((prev) => ({ ...prev, [token.mint]: plan }));
      }

      if (plan.balance < plan.total + plan.networkFee + BUFFER_LAMPORTS) {
        const short = plan.total + plan.networkFee + BUFFER_LAMPORTS - plan.balance;
        throw new StageError("prepare", `You need about ${sol(short)} more SOL to pay this fee.`, { submitted: false });
      }

      const labels = {
        signing: "Waiting for Phantom approval…",
        "signing-alt": "Retrying with Phantom's sign-and-send…",
        submitting: "Sending…",
        confirming: "Waiting for confirmation…",
      };
      const { signature } = await signSendConfirm({
        connection,
        transaction: plan.tx,
        signTransaction,
        sendTransaction,
        onSubmitted: (sig, blockhash) =>
          savePending({ wallet: publicKey.toBase58(), mint: token.mint, kinds: plan.kinds, signature: sig, blockhash }),
        onStage: (name) => setStage(labels[name] || ""),
      });

      // Verify BOTH outcomes on-chain before claiming success.
      setStage("Verifying the revocation and payment…");
      const mintKey = new PublicKey(token.mint);
      const info = await readMint(connection, token.mint);
      const after = await getMint(connection, mintKey, "confirmed", new PublicKey(info.programId));
      const stillActive = plan.kinds.filter((kind) => after[AUTHORITIES[kind].field] !== null);
      if (stillActive.length) {
        throw new StageError("verification", `The transaction confirmed, but ${stillActive.join(" and ")} authority still appears active.`, {
          submitted: true,
          signature,
        });
      }
      await verifyFeePaid(connection, signature, publicKey, fee.treasury, plan.total);
      clearPending(signature);

      setResults((prev) => ({ ...prev, [token.mint]: { signature, kinds: plan.kinds, total: plan.total } }));
      setPlans((prev) => ({ ...prev, [token.mint]: undefined }));
      setSelection((prev) => ({ ...prev, [token.mint]: {} }));
      notify("Authorities revoked and fee paid.", "success");
      await refresh();
    } catch (err) {
      setFailures((prev) => ({ ...prev, [token.mint]: toFailure(err) }));
      notify("Revocation did not complete. See details on the token.", "error");
    } finally {
      lock.current = false;
      setBusyMint("");
      setStage("");
    }
  }

  if (!connected) {
    return (
      <section className="panel">
        <span className="eyebrow">TOKEN MANAGEMENT</span>
        <h2>My Tokens</h2>
        <p className="muted">Connect your wallet to see the tokens it holds and manage their authorities.</p>
        <button className="primary" type="button" onClick={() => openConnect()}>
          Connect Wallet <span>→</span>
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">TOKEN MANAGEMENT</span>
          <h2>My Tokens</h2>
          <p className="muted">SPL tokens in your wallet. Revoke authorities you control (0.1 SOL each), or create a pool.</p>
        </div>
        <button className="secondary-button compact" type="button" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="notice notice-error">
          <div>
            <strong>Couldn't load your tokens</strong>
            <p>{error}</p>
          </div>
          <button className="text-button" type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {loading && tokens.length === 0 && (
        <div className="skeleton-list" aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {!loading && !error && tokens.length === 0 && (
        <div className="empty-state">
          <strong>No tokens yet</strong>
          <p>This wallet doesn't hold any SPL tokens on this network.</p>
          <button className="primary" type="button" onClick={() => onNavigate("create")}>
            Create a token <span>→</span>
          </button>
        </div>
      )}

      <div className="token-list">
        {tokens.map((token) => {
          const wallet = publicKey?.toBase58();
          const canRevokeMint = token.mintAuthority && token.mintAuthority === wallet;
          const canRevokeFreeze = token.freezeAuthority && token.freezeAuthority === wallet;
          const title = token.name ? `${token.name}${token.symbol ? ` ($${token.symbol})` : ""}` : shorten(token.mint, 6, 6);

          return (
            <article className="token-card" key={token.mint}>
              <div className="token-card-head">
                <div className="token-avatar">{(token.symbol || token.name || "T").slice(0, 1).toUpperCase()}</div>
                <div className="token-info">
                  <strong>{title}</strong>
                  <a href={explorerAddress(token.mint)} target="_blank" rel="noopener noreferrer">
                    {shorten(token.mint, 6, 6)} ↗
                  </a>
                </div>
                <div className="token-balance">
                  <strong>{token.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong>
                  <small>balance</small>
                </div>
              </div>

              {["mint", "freeze", "update"].map((kind) => {
                const def = AUTHORITIES[kind];
                const holder = def.field ? token[def.field] : null;
                const mine = holder && holder === wallet;
                const revoked = def.supported && !holder;
                const selectable = def.supported && mine && fee.ok;
                const checked = Boolean(selection[token.mint]?.[kind]);
                const state = !def.supported
                  ? "Not supported"
                  : revoked
                    ? "Revoked"
                    : mine
                      ? "Active · you control it"
                      : `Active · held by ${shorten(holder)}`;

                return (
                  <label
                    className={selectable ? "authority-row authority-pick" : "authority-row authority-pick disabled"}
                    key={kind}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!selectable || Boolean(busyMint)}
                      onChange={() => toggle(token.mint, kind)}
                    />
                    <div className="authority-text">
                      <span>{def.label}</span>
                      <strong className={holder ? "status-open" : "status-revoked"}>{state}</strong>
                      <small className="helper">{def.explain}</small>
                    </div>
                    <span className={selectable ? "fee-chip" : "fee-chip off"}>
                      {selectable ? `+${sol(FEE_PER_AUTHORITY_LAMPORTS)} SOL` : "No fee"}
                    </span>
                  </label>
                );
              })}

              {(() => {
                const kinds = selectedKinds(token.mint);
                const { total, count } = calcFee(kinds);
                const plan = plans[token.mint];
                const failure = failures[token.mint];
                const result = results[token.mint];
                const busy = busyMint === token.mint;

                return (
                  <>
                    {!fee.ok && (canRevokeMint || canRevokeFreeze) && (
                      <p className="helper warning-text">{fee.reason}</p>
                    )}

                    {count > 0 && (
                      <div className="cost-box">
                        <strong>Authority service fee</strong>
                        <dl className="cost-list">
                          {kinds.map((kind) => (
                            <FeeLine key={kind} label={AUTHORITIES[kind].label} value={`${sol(FEE_PER_AUTHORITY_LAMPORTS)} SOL`} />
                          ))}
                          <dt className="total">Total service fee</dt>
                          <dd className="total">{sol(total)} SOL</dd>
                        </dl>
                        <p className="helper">
                          Revoking is permanent. The fee and the revocation are one transaction: if the revocation
                          fails, the fee isn't charged. Only active authorities you control are charged.
                        </p>

                        {plan ? (
                          <>
                            <dl className="cost-list">
                              <dt>Service fee to treasury</dt>
                              <dd>{sol(plan.total)} SOL</dd>
                              <dt>Network fee (est.)</dt>
                              <dd>{sol(plan.networkFee)} SOL</dd>
                              <dt>Treasury wallet</dt>
                              <dd title={String(fee.treasury)}>{shorten(String(fee.treasury), 6, 6)}</dd>
                              <dt>Network</dt>
                              <dd>{CLUSTER}</dd>
                            </dl>
                            <div className="button-row">
                              <button type="button" className="secondary-button" disabled={busy} onClick={() => setPlans((p) => ({ ...p, [token.mint]: undefined }))}>
                                Edit
                              </button>
                              <button type="button" className="danger-button" disabled={busy} onClick={() => handleConfirm(token)}>
                                {busy ? stage || "Working…" : `Pay ${sol(plan.total)} SOL and revoke`}
                              </button>
                            </div>
                          </>
                        ) : (
                          <button type="button" className="primary" disabled={busy || Boolean(busyMint) || !fee.ok} onClick={() => handleReview(token)}>
                            {busy ? stage || "Checking…" : `Review ${sol(total)} SOL fee`}
                          </button>
                        )}
                      </div>
                    )}

                    {result && (
                      <div className="success-banner">
                        <span>✓</span>
                        <div>
                          <strong>
                            Revoked {result.kinds.join(" + ")} · paid {sol(result.total)} SOL
                          </strong>
                          <p>
                            Verified on-chain.{" "}
                            <a href={explorerTx(result.signature)} target="_blank" rel="noopener noreferrer">
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
                          {failure.diag?.signature && (
                            <p>
                              <a href={explorerTx(failure.diag.signature)} target="_blank" rel="noopener noreferrer">
                                View transaction ↗
                              </a>
                            </p>
                          )}
                          <Diagnostics data={failure.diag} />
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              <div className="token-actions">
                <button type="button" className="secondary-button compact" onClick={() => onUseForLiquidity(token.mint)}>
                  Create pool →
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FeeLine({ label, value }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
