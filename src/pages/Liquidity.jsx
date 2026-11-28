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
import { beginCreatePool, checkAllowed, OP } from "../lib/lifecycleLock";
import { useLifecycleLock, useVerifyLifecycle } from "../lib/useLifecycleLock";
import RemoveLiquidity from "../components/RemoveLiquidity";
import { deletePoolRecord, loadPoolRecords, savePoolRecord, verifyPool } from "../lib/pools";
import { loadRaydium, prepareCreatePool, readMint } from "../lib/raydium";
import {
  StageError,
  describeError,
  inspectTransaction,
  messageOf,
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
  // Chosen by the user after a failure; never switched automatically.
  const [signMethod, setSignMethod] = useState("sign");

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
  const launch = useActiveLaunch(owner);
  const { lock } = useLifecycleLock();
  const { verify: verifyLock } = useVerifyLifecycle();

  // Returning to this page re-checks the lock against the chain (never unlocks without proof).
  useEffect(() => {
    verifyLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // While a lifecycle is locked, ONLY the locked token can be pooled.
  const usable = useMemo(
    () =>
      walletTokens.tokens.filter(
        (token) => token.raw > 0n && token.mint !== WSOL_MINT && (!lock?.mint || token.mint === lock.mint)
      ),
    [walletTokens.tokens, lock?.mint]
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
    // The global lock is released ONLY by this on-chain re-check (confirmed removal + pool state +
    // the lock owner's LP position read back from the chain).
    const verdict = await verifyLock();
    const result = await refreshPool(record);
    if (!(verdict?.ok && verdict.status === "RESOLVED")) {
      notify("Withdrawal confirmed. Your token stays locked until the removal is verified on-chain and no liquidity remains.", "info");
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
    const tx = prepared.built.transaction;
    if (!tx) {
      throw new StageError("prepare", "The Raydium SDK didn't return a transaction to sign.", { submitted: false });
    }

    // Idempotent creation: if this pool address already exists on-chain, never build another
    // initialization. (The address is derived from the token pair + fee config.)
    let existing = null;
    try {
      existing = await connection.getAccountInfo(new PublicKey(prepared.poolId), "confirmed");
    } catch (err) {
      throw new StageError("prepare", `Couldn't check whether this pool already exists (${err?.message || err}). Nothing was sent.`, { submitted: false, cause: err });
    }
    if (existing) {
      throw new StageError("prepare", "A pool for this token already exists on-chain, so BALNEX will not create another.", {
        submitted: false,
        poolExists: true,
        poolId: prepared.poolId,
        extra: { poolId: prepared.poolId },
      });
    }

    const inspection = await inspectTransaction(connection, tx, publicKey, prepared.programId);
    if (inspection.problems.length) {
      throw new StageError("prepare", `Transaction check failed: ${inspection.problems.join(" ")}`, {
        submitted: false,
        inspection,
      });
    }

    let sim;
    try {
      sim = await simulateWithCost(connection, tx, publicKey);
    } catch (err) {
      if (err instanceof StageError) err.details = { ...err.details, inspection };
      throw err;
    }
    let networkFee = 5000;
    try {
      const fee = await connection.getFeeForMessage(tx.message, "confirmed");
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
      prepared,
      mintInfo,
      tokenRaw,
      solRaw,
      cost: { deposit, poolFee, rent, networkFee, total, balance },
      simLogs: sim.logs,
    };
  }

  // User-requested retry: rebuilds the pool transaction from fresh chain state and a fresh
  // blockhash and returns to the cost review. Nothing is signed until the user confirms again.
  async function handleRetryBuild({ legacy = false, method = "sign" } = {}) {
    if (busy) return;
    clearFailure();
    setPlan(null);
    if (!selected) return;
    setSignMethod(method);
    setBusy(true);
    setStage("Rebuilding from fresh on-chain data…");
    try {
      setPlan(await buildCreatePlan(legacy));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  async function handleReviewPool() {
    clearFailure();
    setPlan(null);
    setSignMethod("sign");

    if (!connected || !publicKey) {
      openConnect();
      return;
    }
    if (!selected) {
      setError("Choose a token from your wallet first.");
      return;
    }
    const allowed = checkAllowed(OP.CREATE_POOL, selected.mint);
    if (!allowed.ok && allowed.code !== "NO_LOCK") {
      setError(allowed.message);
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
    }
  }

  // Step 2: user confirmed the cost. Sign, send, confirm, verify.
  async function handleConfirmPool() {
    if (!plan) return;
    clearFailure();

    // Action-level guard (synchronous, before any await): re-reads the global lock, checks the
    // token matches and the state allows pool creation, and takes the in-process guard so a
    // double-click can't start two pool creations. A token that isn't under a lock yet becomes
    // THE locked lifecycle here (only if no other lifecycle is active).
    const begun = beginCreatePool(selected.mint, {
      expectedPoolId: plan.prepared.poolId,
      adopt: { wallet: publicKey.toBase58(), name: selected.name || "", symbol: selected.symbol || "", decimals: plan.mintInfo.decimals },
    });
    if (!begun.ok) {
      setError(begun.message);
      notify(begun.message, "error");
      return;
    }
    const op = begun.handle;
    let confirmedLifecycle = false;
    setBusy(true);

    try {
      let active = plan;
      if (Date.now() - plan.builtAt > PLAN_MAX_AGE_MS) {
        setStage("Refreshing the transaction…");
        active = await buildCreatePlan(plan.legacy);
        if (active.cost.total > plan.cost.total * 1.02 + 10000) {
          setPlan(active);
          op.setExpectedPool(active.prepared.poolId);
          throw new StageError("prepare", "The cost changed while you were reviewing. Check the updated total and confirm again.", {
            submitted: false,
          });
        }
        setPlan(active);
        op.setExpectedPool(active.prepared.poolId);
      }

      if (BigInt(active.cost.balance) < BigInt(Math.ceil(active.cost.total)) + BUFFER_LAMPORTS) {
        const short = BigInt(Math.ceil(active.cost.total)) + BUFFER_LAMPORTS - BigInt(active.cost.balance);
        throw new StageError("prepare", `You need about ${sol(short)} more SOL to cover this pool.`, { submitted: false });
      }

      const labels = {
        signing: "Waiting for your wallet to sign…",
        submitting: "Sending to Solana Devnet…",
        confirming: "Waiting for confirmation…",
      };
      labels["signing-alt"] = "Retrying with Phantom's sign-and-send…";
      const run = (transaction, inspection, transactionFormat, notes) => {
        op.signing(messageOf(transaction).recentBlockhash);
        return signSendConfirm({
          connection,
          transaction,
          signTransaction,
          sendTransaction,
          context: { inspection, transactionFormat, fallbackNotes: notes },
          // The wallet may submit by itself in the sign-and-send fallback.
          onStage: (name) => {
            if (name === "signing-alt") op.markMaybeSubmitted();
            setStage(labels[name] || "");
          },
          // Recorded the moment a signature exists, before waiting for confirmation.
          onSubmitted: (signature, blockhash) => op.submitted({ signature, blockhash }),
          method: signMethod,
        });
      };

      // ONE wallet request. If it fails (including Phantom -32603) nothing is retried automatically;
      // the user chooses a retry, which rebuilds everything from fresh on-chain state.
      const { signature } = await run(active.prepared.built.transaction, active.inspection, active.legacy ? "legacy (no lookup table)" : "v0 + lookup table");

      setStage("Verifying the pool on-chain…");
      await verifyPoolAccount(connection, active.prepared.poolId, active.prepared.programId, signature);

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
      op.confirmed({
        poolId: record.poolId,
        lpMint: record.lpMint,
        signature,
        tokenDeposited: record.tokenDeposited,
        solDeposited: record.solDeposited,
      });
      confirmedLifecycle = true;
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
      if (!confirmedLifecycle) {
        const d = describeError(err);
        // Keeps the lock. submitted === false => safe retry; anything else => verify on-chain first.
        op.failed({ submitted: d.submitted, signature: d.signature, message: d.message, stage: d.stage });
        verifyLock();
      }
    } finally {
      op.end();
      setBusy(false);
      setStage("");
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
            {diag?.extra?.poolId ? (
              <p>
                Existing pool:{" "}
                <a href={`https://explorer.solana.com/address/${diag.extra.poolId}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`} target="_blank" rel="noopener noreferrer">
                  {shorten(diag.extra.poolId, 6, 6)} ↗
                </a>
                . Use VERIFY STATUS in the banner above to restore it if it's yours.
              </p>
            ) : null}
            {diag?.stage === "signing" && (
              <div className="button-row">
                <button type="button" className="secondary-button compact" disabled={busy} onClick={() => handleRetryBuild({})}>
                  Rebuild and retry
                </button>
                {diag?.walletErrorCode === -32603 && (
                  <>
                    <button type="button" className="secondary-button compact" disabled={busy} onClick={() => handleRetryBuild({ method: "signAndSend" })}>
                      Rebuild, then use Phantom sign-and-send
                    </button>
                    <button type="button" className="secondary-button compact" disabled={busy} onClick={() => handleRetryBuild({ legacy: true })}>
                      Rebuild without lookup tables
                    </button>
                  </>
                )}
              </div>
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

          {!managingRecord && !lock && (
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
