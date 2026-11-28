import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useConnectSheet } from "../components/WalletSheet";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { useToast } from "../components/Toast";
import { CLUSTER, WSOL_MINT } from "../config";
import Diagnostics from "../components/Diagnostics";
import LaunchCard from "../components/LaunchCard";
import PoolPanel from "../components/PoolPanel";
import { markLiquidityCreated, markLiquidityRemoved, useActiveLaunch } from "../lib/launch";
import RemoveLiquidity from "../components/RemoveLiquidity";
import { deletePoolRecord, loadPoolRecords, savePoolRecord, verifyPool } from "../lib/pools";
import { loadRaydium, prepareCreatePool, readMint } from "../lib/raydium";
import {
  StageError,
  describeError,
  inspectTransaction,
  refreshTransactionBlockhash,
  signSendConfirm,
  simulateWithCost,
  toFailure,
  verifyPoolAccount,
} from "../lib/txRunner";
import { fromRawUnits, shorten, toRawUnits } from "../lib/utils";

const PLAN_MAX_AGE_MS = 40000;
const BUFFER_LAMPORTS = 5000000n; // keep 0.005 SOL spare for fees

const sol = (lamports) =>
  (Number(lamports) / 1e9).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });


function tokenLabel(token) {
  if (!token) return "";
  const name = token.symbol ? `$${token.symbol}` : shorten(token.mint, 4, 4);
  return `${name} · ${token.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

export default function Liquidity({ walletTokens, initialMint, onNavigate }) {
  const { connection } = useConnection();
  const { publicKey, connected, signAllTransactions, signTransaction, sendTransaction } = useWallet();
  const { open: openConnect } = useConnectSheet();
  const notify = useToast();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errInfo, setErrInfo] = useState(null);
  const [diag, setDiag] = useState(null);
  const [stage, setStage] = useState("");
  const [plan, setPlan] = useState(null);

  // Create pool
  const [selectedMint, setSelectedMint] = useState(initialMint || "");
  const [percent, setPercent] = useState("");
  const [tokenAmount, setTokenAmount] = useState("");
  const [solAmount, setSolAmount] = useState("");

  // Launched pools (stored list is only a list of things to re-verify on-chain)
  const owner = publicKey ? publicKey.toBase58() : "";
  const [recordsVersion, setRecordsVersion] = useState(0);
  const records = useMemo(
    () => (owner ? loadPoolRecords().filter((r) => r.owner === owner) : []),
    [owner, recordsVersion]
  );
  const [verifiedMap, setVerifiedMap] = useState({});
  const [managing, setManaging] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const verifyRun = useRef(0);
  const operationLock = useRef(false);
  const pendingCreation = useRef(null);
  const launch = useActiveLaunch(owner);

  // Lifecycle sync from CHAIN-verified pool data. Creating a pool moves the launch to
  // liquidity_created but keeps the wallet locked; a pool that is verifiably drained on-chain
  // completes it. (BALNEX's own removal flow completes it too: see handleWithdrawn.)
  useEffect(() => {
    if (!launch) return;
    const rec = records.find((r) => r.mint === launch.mint);
    const v = rec ? verifiedMap[rec.poolId] : null;
    if (!rec || !v) return;
    if (launch.status === "launch_pending" && v.status === "verified") {
      markLiquidityCreated(launch.wallet, launch.mint, {
        poolId: rec.poolId,
        lpMint: v.lpMint,
        creationSignature: rec.signature,
        tokenDeposited: rec.tokenDeposited,
        solDeposited: rec.solDeposited,
      });
    } else if (launch.status === "liquidity_created" && v.status === "emptied") {
      markLiquidityRemoved(launch.wallet, launch.mint, null, { reason: "pool_emptied_on_chain" });
    }
  }, [launch, records, verifiedMap]);

  const usable = useMemo(
    () => walletTokens.tokens.filter((token) => token.raw > 0n && token.mint !== WSOL_MINT),
    [walletTokens.tokens]
  );
  const selected = usable.find((token) => token.mint === selectedMint) || null;

  useEffect(() => {
    if (initialMint) setSelectedMint(initialMint);
  }, [initialMint]);

  useEffect(() => {
    if (!selectedMint && usable.length > 0) setSelectedMint(usable[0].mint);
  }, [selectedMint, usable]);

  function pickPercent(value) {
    if (!selected) return;
    setPercent(String(value));
    setTokenAmount(fromRawUnits((selected.raw * BigInt(value)) / 100n, selected.decimals));
  }

  async function getRaydium() {
    return loadRaydium({ connection, publicKey, signAllTransactions });
  }

  // Re-verify one record against the chain and the connected wallet.
  const verifyOne = useCallback(
    async (record) => {
      const result = await verifyPool({
        connection,
        owner: publicKey,
        record,
        getRaydium: () => loadRaydium({ connection, publicKey, signAllTransactions }),
      });
      return result;
    },
    [connection, publicKey, signAllTransactions]
  );

  // On connect, wallet switch, refresh, or a new record: re-verify everything for this wallet.
  useEffect(() => {
    const run = ++verifyRun.current;
    setVerifiedMap({});
    setManaging("");
    if (!publicKey) return undefined;

    (async () => {
      for (const record of records) {
        const result = await verifyOne(record);
        if (verifyRun.current !== run) return;
        setVerifiedMap((prev) => ({ ...prev, [record.poolId]: result }));
      }
    })();
    return () => {
      verifyRun.current += 1;
    };
  }, [owner, records, verifyOne]);

  async function refreshPool(record) {
    const result = await verifyOne(record);
    setVerifiedMap((prev) => ({ ...prev, [record.poolId]: result }));
    return result;
  }

  // Called after a withdrawal transaction CONFIRMED. The wallet unlocks only if the chain now
  // shows this wallet holds no LP tokens for the pool (a full removal). Partial removals keep
  // the lock because liquidity is still in the pool.
  async function handleWithdrawn(record, signature) {
    const result = await refreshPool(record);
    const closed = (result.status === "verified" || result.status === "emptied") && result.lpRaw === 0n;
    if (!closed) {
      notify("Withdrawal confirmed. Some liquidity remains, so your launch stays active until all of it is removed.", "info");
      return;
    }
    savePoolRecord({ ...record, removalSignature: signature, removedAt: Date.now() });
    markLiquidityRemoved(record.owner, record.mint, signature, { poolId: record.poolId });
    setRecordsVersion((v) => v + 1);
    notify("All liquidity removed and confirmed on-chain. You can create your next token.", "success");
  }

  function forget(record) {
    deletePoolRecord(record.poolId, record.owner);
    setRecordsVersion((v) => v + 1);
  }

  function clearFailure() {
    setError("");
    setErrInfo(null);
    setDiag(null);
  }

  function fail(err) {
    const { info, diag: d } = toFailure(err);
    setErrInfo(info);
    setDiag(d);
    setError("");
    notify("Transaction did not complete. See details below.", "error");
  }

  // Signs (never sends) a harmless self-transfer to show whether this wallet can sign at all.
  async function handleWalletSelfTest() {
    if (!publicKey || !signTransaction) return;
    const results = [];
    try {
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const legacy = new VersionedTransaction(
        new TransactionMessage({
          payerKey: publicKey,
          recentBlockhash: blockhash,
          instructions: [SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 1 })],
        }).compileToLegacyMessage()
      );
      await signTransaction(legacy);
      results.push("simple legacy transaction: signed OK");
    } catch (err) {
      results.push(`simple legacy transaction: FAILED (${err?.error?.code ?? err?.code ?? "?"} ${err?.error?.message || err?.message})`);
    }
    setDiag((prev) => ({ ...(prev || {}), walletSelfTest: results }));
    notify(results.join(" · "), results.some((r) => r.includes("FAILED")) ? "error" : "success");
  }

  // Step 1: read the mint, build the exact transaction, simulate it and show the full cost.
  async function buildCreatePlan(legacy = false) {
    const mintInfo = await readMint(connection, selected.mint);
    const tokenRaw = toRawUnits(tokenAmount, mintInfo.decimals);
    const solRaw = toRawUnits(solAmount, 9);

    if (tokenRaw <= 0n || solRaw <= 0n) {
      throw new StageError("prepare", "Enter a token amount and a SOL amount greater than zero.", { submitted: false });
    }
    if (tokenRaw > selected.raw) {
      throw new StageError("prepare", "You don't hold that many tokens.", { submitted: false });
    }

    const raydium = await getRaydium();
    const prepared = await prepareCreatePool(raydium, { mintInfo, tokenRaw, solRaw, legacy });
    if (prepared.poolId) {
      const existing = await connection.getAccountInfo(new PublicKey(prepared.poolId), "confirmed");
      if (existing) {
        throw new StageError("prepare", existing.owner.toBase58() === prepared.programId
          ? "A pool already exists for this token pair. BALNEX stopped to prevent duplicate pool initialization."
          : "The derived pool address is already occupied by an unexpected account. Creation was stopped for safety.", {
          submitted: false,
          inspection: { poolId: prepared.poolId, existingAccountOwner: existing.owner.toBase58(), expectedProgramId: prepared.programId },
        });
      }
    }
    const tx = prepared.built.transaction;
    if (!tx) {
      throw new StageError("prepare", "The Raydium SDK didn't return a transaction to sign.", { submitted: false });
    }

    const refreshed = await refreshTransactionBlockhash(connection, tx, publicKey);
    const activeTx = refreshed.transaction;
    const inspection = await inspectTransaction(connection, activeTx, publicKey, prepared.programId);
    if (inspection.problems.length) {
      throw new StageError("prepare", `Transaction check failed: ${inspection.problems.join(" ")}`, {
        submitted: false,
        inspection,
      });
    }

    let sim;
    try {
      sim = await simulateWithCost(connection, activeTx, publicKey);
    } catch (err) {
      if (err instanceof StageError) err.details = { ...err.details, inspection };
      throw err;
    }
    let networkFee = 5000;
    try {
      const fee = await connection.getFeeForMessage(activeTx.message, "confirmed");
      if (typeof fee?.value === "number") networkFee = fee.value;
    } catch {
      // keep the default estimate
    }

    const deposit = Number(solRaw);
    const poolFee = prepared.createPoolFeeLamports;
    const outflow = sim.outflow ?? deposit + poolFee;
    const rent = Math.max(0, outflow - deposit - poolFee);
    const total = deposit + poolFee + rent + networkFee;
    const balance = await connection.getBalance(publicKey, "confirmed");

    return {
      builtAt: Date.now(),
      legacy,
      inspection,
      prepared: { ...prepared, transaction: activeTx },
      mintInfo,
      blockhash: refreshed.blockhash,
      lastValidBlockHeight: refreshed.lastValidBlockHeight,
      tokenRaw,
      solRaw,
      cost: { deposit, poolFee, rent, networkFee, total, balance },
      simLogs: sim.logs,
    };
  }

  async function handleReviewPool() {
    if (operationLock.current) return;
    operationLock.current = true;
    clearFailure();
    setPlan(null);

    if (!connected || !publicKey) {
      operationLock.current = false;
      openConnect();
      return;
    }
    if (!selected) {
      operationLock.current = false;
      setError("Choose a token from your wallet first.");
      return;
    }

    setBusy(true);
    setStage("Checking your token and simulating the pool…");
    try {
      const next = await buildCreatePlan();
      setPlan(next);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setStage("");
      operationLock.current = false;
    }
  }

  // Step 2: user confirmed the cost. Sign, send, confirm, verify.
  async function handleConfirmPool() {
    if (!plan || operationLock.current) return;
    operationLock.current = true;
    clearFailure();
    setBusy(true);

    try {
      let active = plan;
      if (Date.now() - plan.builtAt > PLAN_MAX_AGE_MS) {
        setStage("Refreshing the transaction…");
        active = await buildCreatePlan();
        if (active.cost.total > plan.cost.total * 1.02 + 10000) {
          setPlan(active);
          throw new StageError("prepare", "The cost changed while you were reviewing. Check the updated total and confirm again.", {
            submitted: false,
          });
        }
        setPlan(active);
      }

      if (BigInt(active.cost.balance) < BigInt(Math.ceil(active.cost.total)) + BUFFER_LAMPORTS) {
        const short = BigInt(Math.ceil(active.cost.total)) + BUFFER_LAMPORTS - BigInt(active.cost.balance);
        throw new StageError("prepare", `You need about ${sol(short)} more SOL to cover this pool.`, { submitted: false });
      }

      // A previous submitted transaction must be resolved before any new creation.
      if (pendingCreation.current) {
        const pending = pendingCreation.current;
        const status = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
        const state = status.value[0];
        const poolAccount = await connection.getAccountInfo(new PublicKey(pending.poolId), "confirmed");
        if (poolAccount) {
          throw new StageError("verification", "A pool account now exists for the previous creation attempt. Refresh pool records and verify it before starting another creation.", {
            submitted: true,
            signature: pending.signature,
            inspection: { poolId: pending.poolId, accountOwner: poolAccount.owner.toBase58() },
          });
        }
        if (!state || state.confirmationStatus !== "finalized") {
          throw new StageError("confirmation", "The previous creation transaction is not conclusively finalized. BALNEX has blocked another attempt to avoid a duplicate pool.", {
            submitted: true,
            signature: pending.signature,
            landed: state?.err ? "failed" : "unknown",
            status: state,
          });
        }
        if (!state.err) {
          throw new StageError("verification", "The previous creation transaction finalized, but the expected pool account is not yet verified. Do not retry until this is investigated.", {
            submitted: true,
            signature: pending.signature,
            landed: "confirmed",
          });
        }
        pendingCreation.current = null;
      }

      const activeTx = active.prepared.transaction;
      const freshInspection = await inspectTransaction(connection, activeTx, publicKey, active.prepared.programId);
      if (freshInspection.problems.length) {
        throw new StageError("prepare", `Transaction check failed: ${freshInspection.problems.join(" ")}`, {
          submitted: false,
          inspection: freshInspection,
        });
      }
      const finalSimulation = await simulateWithCost(connection, activeTx, publicKey);
      const blockhashValid = await connection.isBlockhashValid(active.blockhash, { commitment: "confirmed" });
      if (!blockhashValid.value) {
        throw new StageError("prepare", "The creation transaction expired before signing. Review the rebuilt transaction and confirm again.", { submitted: false });
      }

      const { signature } = await signSendConfirm({
        connection,
        transaction: activeTx,
        signTransaction,
        sendTransaction,
        context: {
          inspection: freshInspection,
          transactionFormat: freshInspection.version === "legacy" ? "legacy" : `versioned (${freshInspection.version})`,
          simulation: { unitsConsumed: finalSimulation.unitsConsumed, outflow: finalSimulation.outflow },
          pool: { poolId: active.prepared.poolId, lpMint: active.prepared.lpMint, mint: selected.mint },
        },
        onSubmitted: (submittedSignature) => {
          pendingCreation.current = { signature: submittedSignature, poolId: active.prepared.poolId };
        },
        onStage: (name) => setStage(({ signing: "Waiting for your wallet to sign…", submitting: "Sending to Solana Devnet…", confirming: "Waiting for confirmation…" })[name] || ""),
      });

      setStage("Verifying the pool on-chain…");
      await verifyPoolAccount(connection, active.prepared.poolId, active.prepared.programId, signature);
      pendingCreation.current = null;

      const record = {
        poolId: active.prepared.poolId,
        owner: publicKey.toBase58(),
        cluster: CLUSTER,
        mint: selected.mint,
        symbol: selected.symbol || "",
        name: selected.name || "",
        signature,
        lpMint: active.prepared.lpMint,
        solDeposited: String(active.solRaw),
        tokenDeposited: fromRawUnits(active.tokenRaw, active.mintInfo.decimals),
        createdAt: Date.now(),
      };
      savePoolRecord(record);
      // Update the EXISTING launch record for this mint in place (no second record).
      // The wallet stays locked; only confirmed liquidity removal unlocks it.
      markLiquidityCreated(publicKey.toBase58(), selected.mint, {
        poolId: record.poolId,
        lpMint: record.lpMint,
        creationSignature: signature,
        tokenDeposited: record.tokenDeposited,
        solDeposited: record.solDeposited,
      });
      setPlan(null);
      setShowCreate(false);
      setManaging("");
      setRecordsVersion((v) => v + 1);
      notify("Pool transaction confirmed. Verifying the pool on-chain…", "success");
      walletTokens.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setStage("");
      operationLock.current = false;
    }
  }

  if (!connected) {
    return (
      <section className="panel">
        <span className="eyebrow">RAYDIUM</span>
        <h2>Liquidity</h2>
        <p className="muted">Connect your wallet to launch a pool for your token.</p>
        <button className="primary" type="button" onClick={() => openConnect()}>
          Connect Wallet <span>→</span>
        </button>
      </section>
    );
  }

  const managingRecord = records.find((r) => r.poolId === managing);
  const managingVerified = managingRecord ? verifiedMap[managingRecord.poolId] : null;
  const showForm = records.length === 0 || showCreate;

  return (
    <section className="panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">RAYDIUM CPMM · {CLUSTER.toUpperCase()}</span>
          <h2>{records.length ? "Your pools" : "Launch your pool"}</h2>
          <p className="muted">
            {records.length
              ? "Pool details are re-checked on-chain every time you open this page."
              : "Create a Raydium pool with your first liquidity deposit."}
          </p>
        </div>
        <div className="panel-icon">◈</div>
      </div>

      {launch && <LaunchCard launch={launch} />}

      {errInfo && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>{errInfo.title}</strong>
            <p>{errInfo.outcome}</p>
            <p>{errInfo.body}</p>
            {diag?.signature && (
              <p>
                <a href={`https://explorer.solana.com/tx/${diag.signature}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`} target="_blank" rel="noopener noreferrer">
                  View transaction ↗
                </a>
              </p>
            )}
            <Diagnostics data={diag} />
            {errInfo?.title === "Wallet signing failed" && (
              <button type="button" className="text-button" onClick={handleWalletSelfTest}>
                Test whether my wallet can sign at all (nothing is sent)
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>Check your input</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {records.length > 0 && (
        <div className="guided-step">
          {managingRecord && managingVerified?.status === "verified" ? (
            <RemoveLiquidity
              record={managingRecord}
              verified={managingVerified}
              connection={connection}
              publicKey={publicKey}
              getRaydium={getRaydium}
              signTransaction={signTransaction}
              sendTransaction={sendTransaction}
              notify={notify}
              onBack={() => setManaging("")}
              onChanged={(signature) => handleWithdrawn(managingRecord, signature)}
            />
          ) : (
            records.map((record) => {
              const verified = verifiedMap[record.poolId];
              return (
                <PoolPanel
                  key={record.poolId}
                  record={record}
                  verified={verified}
                  onRemove={() => setManaging(record.poolId)}
                  onForget={() => forget(record)}
                />
              );
            })
          )}

          {!managingRecord && (
            <button type="button" className="secondary-button" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Hide pool creation" : "Launch another pool"}
            </button>
          )}
        </div>
      )}

      {showForm && !managingRecord && (
        <div className="guided-step">
          {walletTokens.loading && usable.length === 0 ? (
            <div className="skeleton-list" aria-busy="true">
              <div className="skeleton" />
            </div>
          ) : usable.length === 0 ? (
            <div className="empty-state">
              <strong>No tokens to pool</strong>
              <p>Create a token first, or switch to a wallet that holds one.</p>
              <button className="primary" type="button" onClick={() => onNavigate("create")}>
                Create a token <span>→</span>
              </button>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="pool-token">Token</label>
                <select
                  id="pool-token"
                  value={selectedMint}
                  onChange={(e) => {
                    setSelectedMint(e.target.value);
                    setPercent("");
                    setTokenAmount("");
                  }}
                  disabled={busy}
                >
                  {usable.map((token) => (
                    <option key={token.mint} value={token.mint}>
                      {tokenLabel(token)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="pool-token-amount">Token amount</label>
                <div className="liquidity-percentages" role="group" aria-label="Percentage of your balance">
                  {[25, 50, 75, 90].map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={percent === String(value) ? "liquidity-percentage selected" : "liquidity-percentage"}
                      aria-pressed={percent === String(value)}
                      onClick={() => pickPercent(value)}
                      disabled={busy || !!plan || !selected}
                    >
                      {value}%
                    </button>
                  ))}
                </div>
                <input
                  id="pool-token-amount"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={tokenAmount}
                  disabled={busy || !!plan}
                  onChange={(e) => {
                    setTokenAmount(e.target.value);
                    setPercent("");
                  }}
                />
                <small className="helper">Percentages apply to your wallet balance of this token.</small>
              </div>

              <div className="field">
                <label htmlFor="pool-sol-amount">SOL amount</label>
                <div className="amount-input">
                  <input
                    id="pool-sol-amount"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={solAmount}
                    disabled={busy || !!plan}
                    onChange={(e) => setSolAmount(e.target.value)}
                  />
                  <span>SOL</span>
                </div>
              </div>

              <div className="pool-preview">
                <div>
                  <span>Pool type</span>
                  <strong>Raydium CPMM</strong>
                </div>
                <div>
                  <span>Token</span>
                  <strong>{tokenAmount || "0"}</strong>
                </div>
                <div>
                  <span>SOL</span>
                  <strong>{solAmount || "0"}</strong>
                </div>
              </div>

              {plan ? (
                <div className="cost-box">
                  <strong>Full cost before you approve</strong>
                  <dl className="cost-list">
                    <dt>Liquidity deposit (goes into the pool)</dt>
                    <dd>{sol(plan.cost.deposit)} SOL</dd>
                    <dt>Raydium pool creation fee</dt>
                    <dd>{sol(plan.cost.poolFee)} SOL</dd>
                    <dt>Account rent (est., refundable only when accounts close)</dt>
                    <dd>{sol(plan.cost.rent)} SOL</dd>
                    <dt>Network fee</dt>
                    <dd>{sol(plan.cost.networkFee)} SOL</dd>
                    <dt className="total">Total leaving your wallet</dt>
                    <dd className="total">≈ {sol(plan.cost.total)} SOL</dd>
                    <dt>Your balance</dt>
                    <dd>{sol(plan.cost.balance)} SOL</dd>
                  </dl>
                  <p className="helper">
                    Tokens deposited: {fromRawUnits(plan.tokenRaw, plan.mintInfo.decimals)} (token has{" "}
                    {plan.mintInfo.decimals} decimals). The simulation succeeded, so nothing has been sent yet.
                  </p>
                  {BigInt(plan.cost.balance) < BigInt(Math.ceil(plan.cost.total)) + BUFFER_LAMPORTS && (
                    <p className="helper">
                      You need about{" "}
                      {sol(BigInt(Math.ceil(plan.cost.total)) + BUFFER_LAMPORTS - BigInt(plan.cost.balance))} more SOL.
                    </p>
                  )}
                  <div className="button-row">
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => setPlan(null)}>
                      Edit
                    </button>
                    <button className="primary" type="button" disabled={busy} onClick={handleConfirmPool}>
                      {busy ? stage || "Working…" : "Confirm and open wallet"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="notice">
                    <span className="notice-icon">ⓘ</span>
                    <div>
                      <strong>You'll see the full cost first</strong>
                      <p>
                        We simulate the pool, then show your liquidity deposit separately from Raydium's creation fee,
                        account rent and the network fee before your wallet opens.
                      </p>
                    </div>
                  </div>

                  <button className="primary" type="button" disabled={busy} onClick={handleReviewPool}>
                    {busy ? stage || "Checking…" : "Review pool cost"}
                    {!busy && <span> →</span>}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
