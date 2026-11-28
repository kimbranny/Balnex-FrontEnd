import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useConnectSheet } from "../components/WalletSheet";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import Diagnostics from "../components/Diagnostics";
import { useToast } from "../components/Toast";
import { CLUSTER, WSOL_MINT } from "../config";
import { TokenStats } from "../components/Analytics";
import { useLaunches, useLifecycleLock } from "../lib/launch";
import SocialLinks from "../components/SocialLinks";
import { loadPoolRecords } from "../lib/pools";
import {
  AUTHORITIES,
  FEE_PER_AUTHORITY_LAMPORTS,
  buildRevocationInstructions,
  calcFee,
  feeStatus,
  verifyFeePaid,
} from "../lib/fees";
import { clearPending, evaluatePending, getPending, savePending } from "../lib/feeGuards";
import { readMetadata } from "../lib/metadata";
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

  // ONE entry per mint. The mint address is the canonical key:
  //  - LP tokens (and wrapped SOL) are pool plumbing, not separate tokens, so they're hidden;
  //  - launches that are no longer held in the wallet stay visible as history;
  //  - anything left is de-duplicated by mint.
  const owner = publicKey ? publicKey.toBase58() : "";
  const launches = useLaunches(owner);
  const lifecycleLock = useLifecycleLock();
  const poolRecords = useMemo(
    () => (owner ? loadPoolRecords().filter((r) => r.owner === owner) : []),
    [owner, launches]
  );
  const displayTokens = useMemo(() => {
    const lpMints = new Set([...poolRecords.map((r) => r.lpMint), ...launches.map((l) => l.lpMint)].filter(Boolean));
    const byMint = new Map();
    for (const token of tokens) {
      if (lpMints.has(token.mint) || token.mint === WSOL_MINT) continue;
      byMint.set(token.mint, token);
    }
    for (const launch of launches) {
      if (byMint.has(launch.mint)) continue;
      byMint.set(launch.mint, {
        mint: launch.mint,
        decimals: launch.decimals ?? 0,
        raw: 0n,
        uiAmount: 0,
        mintAuthority: null,
        freezeAuthority: null,
        name: launch.name || "",
        symbol: launch.symbol || "",
        historical: true,
      });
    }
    return [...byMint.values()];
  }, [tokens, poolRecords, launches]);
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

  // Metaplex metadata (update authority) for each token, read from the chain.
  const [metaMap, setMetaMap] = useState({});
  const [metaVersion, setMetaVersion] = useState(0);
  const [confirmMint, setConfirmMint] = useState("");
  const mintsKey = tokens.map((t) => t.mint).join(",");
  useEffect(() => {
    let cancelled = false;
    setMetaMap({});
    (async () => {
      for (const token of tokens) {
        let meta;
        try {
          meta = await readMetadata(connection, token.mint);
        } catch (err) {
          meta = { status: "error", reason: err?.message || "Couldn't read metadata." };
        }
        if (cancelled) return;
        setMetaMap((prev) => ({ ...prev, [token.mint]: meta }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, mintsKey, metaVersion]);

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

    const liveMeta = selectedKinds(token.mint).includes("update") ? await readMetadata(connection, token.mint) : null;
    const eligible = selectedKinds(token.mint).filter((kind) => {
      if (kind === "update") {
        return liveMeta?.status === "ok" && liveMeta.isMutable && liveMeta.updateAuthority === wallet;
      }
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
      const stillActive = plan.kinds.filter((kind) => kind !== "update" && after[AUTHORITIES[kind].field] !== null);
      if (plan.kinds.includes("update")) {
        const metaAfter = await readMetadata(connection, token.mint);
        if (metaAfter.status !== "ok" || metaAfter.isMutable) stillActive.push("update");
      }
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
      setMetaVersion((v) => v + 1);
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

      {lifecycleLock && (
        <div className="notice">
          <div><strong>LIQUIDITY WORKFLOW LOCKED</strong><p>{lifecycleLock.name} ({lifecycleLock.symbol}) is the only token permitted to continue its liquidity lifecycle.</p></div>
        </div>
      )}

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

      {!loading && !error && displayTokens.length === 0 && (
        <div className="empty-state">
          <strong>No tokens yet</strong>
          <p>This wallet doesn't hold any SPL tokens on this network.</p>
          <button className="primary" type="button" onClick={() => onNavigate("create")}>
            Create a token <span>→</span>
          </button>
        </div>
      )}

      <div className="token-list">
        {displayTokens.map((token) => {
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

              {!token.historical && (
                <>
              {["mint", "freeze", "update"].map((kind) => {
                const def = AUTHORITIES[kind];
                const meta = metaMap[token.mint];
                let holder = def.field ? token[def.field] : null;
                let mine = holder && holder === wallet;
                let revoked = !holder;
                let state;
                let note = "";

                if (kind === "update") {
                  if (!meta) {
                    holder = null;
                    revoked = false;
                    state = "Checking metadata…";
                  } else if (meta.status === "ok") {
                    holder = meta.updateAuthority;
                    revoked = !meta.isMutable;
                    mine = meta.isMutable && holder === wallet;
                    state = revoked
                      ? `Revoked · metadata locked (last authority ${shorten(holder)})`
                      : mine
                        ? `Active · you control it (${shorten(holder)})`
                        : `Active · held by ${shorten(holder)}`;
                  } else if (meta.status === "none") {
                    holder = null;
                    revoked = false;
                    state = "No metadata";
                    note = "This token was created without on-chain metadata, so it has no update authority to revoke.";
                  } else {
                    holder = null;
                    revoked = false;
                    state = "Not supported";
                    note = meta.reason || "Couldn't read this token's metadata.";
                  }
                } else {
                  state = revoked
                    ? "Revoked"
                    : mine
                      ? "Active · you control it"
                      : `Active · held by ${shorten(holder)}`;
                }

                const selectable = def.supported && mine && fee.ok && (kind !== "update" || meta?.status === "ok");
                const checked = Boolean(selection[token.mint]?.[kind]);

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
                      <strong className={revoked ? "status-revoked" : holder ? "status-open" : ""}>{state}</strong>
                      <small className="helper">{note || def.explain}</small>
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
                              <button type="button" className="danger-button" disabled={busy} onClick={() => setConfirmMint(token.mint)}>
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

                </>
              )}

              {(() => {
                const launch = launches.find((l) => l.mint === token.mint);
                if (!launch) return null;
                const labels = {
                  launch_pending: ["Pool not created yet", "badge badge-warn"],
                  liquidity_created: ["Pool live", "badge badge-ok"],
                  completed: ["Launch complete · liquidity removed", "badge"],
                  abandoned: ["Launch abandoned", "badge"],
                };
                const [text, cls] = labels[launch.status] || ["", "badge"];
                return (
                  <div className="cost-box">
                    <div className="pool-head">
                      <strong>Launch</strong>
                      <span className={cls}>{text}</span>
                    </div>
                    {launch.poolId && (
                      <dl className="cost-list">
                        <dt>Pool (Raydium CPMM)</dt>
                        <dd>
                          <a href={explorerAddress(launch.poolId)} target="_blank" rel="noopener noreferrer">
                            {shorten(launch.poolId, 6, 6)} ↗
                          </a>
                        </dd>
                        {launch.tokenDeposited && (
                          <>
                            <dt>Initial token liquidity</dt>
                            <dd>{launch.tokenDeposited}</dd>
                          </>
                        )}
                        {launch.solDeposited && (
                          <>
                            <dt>Initial SOL liquidity</dt>
                            <dd>{fromRawUnits(BigInt(launch.solDeposited), 9)} SOL</dd>
                          </>
                        )}
                        {launch.creationSignature && (
                          <>
                            <dt>Pool creation tx</dt>
                            <dd>
                              <a href={explorerTx(launch.creationSignature)} target="_blank" rel="noopener noreferrer">
                                {shorten(launch.creationSignature, 6, 6)} ↗
                              </a>
                            </dd>
                          </>
                        )}
                        {launch.removalSignature && (
                          <>
                            <dt>Removal tx</dt>
                            <dd>
                              <a href={explorerTx(launch.removalSignature)} target="_blank" rel="noopener noreferrer">
                                {shorten(launch.removalSignature, 6, 6)} ↗
                              </a>
                            </dd>
                          </>
                        )}
                      </dl>
                    )}
                    <TokenStats mint={token.mint} symbol={token.symbol} />
                    {launch.status === "liquidity_created" && (
                      <button type="button" className="secondary-button compact" onClick={() => onNavigate("liquidity")}>
                        Manage pool / Remove Liquidity →
                      </button>
                    )}
                  </div>
                );
              })()}

              <SocialLinks mint={token.mint} />

              {token.historical && <p className="helper">This token is no longer held by this wallet. Kept here as launch history.</p>}

              {!token.historical && !launches.some((l) => l.mint === token.mint && (l.poolId || l.status === "completed")) && (!lifecycleLock || lifecycleLock.mint === token.mint) && (
              <div className="token-actions">
                <button type="button" className="secondary-button compact" disabled={Boolean(lifecycleLock && lifecycleLock.mint !== token.mint)} onClick={() => onUseForLiquidity(token.mint)}>
                  Create pool →
                </button>
              </div>
              )}
            </article>
          );
        })}
      </div>

      {confirmMint && plans[confirmMint] && (
        <div className="modal-backdrop" onClick={() => setConfirmMint("")}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="revoke-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="revoke-title">Permanently revoke authority?</h3>
            <ul className="modal-list">
              {plans[confirmMint].kinds.map((kind) => (
                <li key={kind}>
                  <strong>{AUTHORITIES[kind].label}:</strong> {AUTHORITIES[kind].explain}
                </li>
              ))}
              <li>Revocation is generally irreversible. Nobody, including you, can undo it.</li>
              <li>
                You'll pay {sol(plans[confirmMint].total)} SOL to BALNEX. It's one transaction with the revocation: if
                the revocation fails, you aren't charged.
              </li>
            </ul>
            <div className="button-row">
              <button type="button" className="secondary-button" onClick={() => setConfirmMint("")}>
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const token = tokens.find((t) => t.mint === confirmMint);
                  setConfirmMint("");
                  if (token) handleConfirm(token);
                }}
              >
                Revoke and open Phantom
              </button>
            </div>
          </div>
        </div>
      )}
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
