import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useConnectSheet } from "../components/WalletSheet";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { useToast } from "../components/Toast";
import { CLUSTER, LAST_POOL_KEY, WSOL_MINT } from "../config";
import Diagnostics from "../components/Diagnostics";
import {
  fetchPool,
  loadRaydium,
  prepareAddLiquidity,
  prepareCreatePool,
  prepareRemoveLiquidity,
  readMint,
} from "../lib/raydium";
import {
  StageError,
  describeError,
  inspectTransaction,
  rebuildWithoutLookupTables,
  signSendConfirm,
  simulateWithCost,
  userMessage,
  verifyPoolAccount,
} from "../lib/txRunner";
import { explorerAddress, explorerTx, fromRawUnits, shorten, toRawUnits } from "../lib/utils";

const PLAN_MAX_AGE_MS = 40000;
const BUFFER_LAMPORTS = 5000000n; // keep 0.005 SOL spare for fees

const sol = (lamports) =>
  (Number(lamports) / 1e9).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const TABS = [
  { id: "create", label: "Create pool" },
  { id: "add", label: "Add" },
  { id: "remove", label: "Remove" },
];

const SLIPPAGE_OPTIONS = [0.5, 1, 3];

function readLastPool() {
  try {
    return localStorage.getItem(LAST_POOL_KEY) || "";
  } catch {
    return "";
  }
}

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

  const [tab, setTab] = useState("create");
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
  const [created, setCreated] = useState(null);

  // Add / remove
  const [poolId, setPoolId] = useState(readLastPool);
  const [pool, setPool] = useState(null);
  const [loadingPool, setLoadingPool] = useState(false);
  const [side, setSide] = useState("A");
  const [addAmount, setAddAmount] = useState("");
  const [removePercent, setRemovePercent] = useState("");
  const [lpRaw, setLpRaw] = useState(0n);
  const [slippage, setSlippage] = useState(1);

  const usable = useMemo(
    () => walletTokens.tokens.filter((token) => token.raw > 0n && token.mint !== WSOL_MINT),
    [walletTokens.tokens]
  );
  const selected = usable.find((token) => token.mint === selectedMint) || null;

  // Pre-select a token when arriving from "My Tokens" or right after creation.
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

  function rememberPool(id) {
    setPoolId(id);
    try {
      localStorage.setItem(LAST_POOL_KEY, id);
    } catch {
      // Optional convenience only.
    }
  }

  async function getRaydium() {
    return loadRaydium({ connection, publicKey, signAllTransactions });
  }

  function clearFailure() {
    setError("");
    setErrInfo(null);
    setDiag(null);
  }

  function fail(err) {
    console.error("[BALNEX] transaction failure", describeError(err), err);
    if (err instanceof StageError) {
      setErrInfo(userMessage(err));
      setDiag(describeError(err));
      setError("");
    } else {
      const wrapped = new StageError("unknown", err?.message || String(err) || "Unknown error.", {
        submitted: null,
        cause: err,
      });
      setErrInfo(userMessage(wrapped));
      setDiag(describeError(wrapped));
    }
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

  async function handleReviewPool() {
    clearFailure();
    setCreated(null);
    setPlan(null);

    if (!connected || !publicKey) {
      openConnect();
      return;
    }
    if (!selected) {
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
    }
  }

  // Step 2: user confirmed the cost. Sign, send, confirm, verify.
  async function handleConfirmPool() {
    if (!plan) return;
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

      const labels = {
        signing: "Waiting for your wallet to sign…",
        submitting: "Sending to Solana Devnet…",
        confirming: "Waiting for confirmation…",
      };
      labels["signing-alt"] = "Retrying with Phantom's sign-and-send…";
      const run = (transaction, inspection, transactionFormat, notes) =>
        signSendConfirm({
          connection,
          transaction,
          signTransaction,
          sendTransaction,
          context: { inspection, transactionFormat, fallbackNotes: notes },
          onStage: (name) => setStage(labels[name] || ""),
        });

      let signature;
      try {
        ({ signature } = await run(active.prepared.built.transaction, active.inspection, "v0 + lookup table"));
      } catch (err) {
        // Nothing was sent when signing fails, so re-formatting the same instructions is safe.
        if (!(err instanceof StageError && err.stage === "signing" && err.details?.phantomInternal)) throw err;
        console.warn("[BALNEX] v0 signing failed with -32603; retrying without lookup tables", describeError(err));
        setStage("Re-formatting without lookup tables…");

        let legacyTx;
        let legacyInspection;
        try {
          legacyTx = await rebuildWithoutLookupTables(connection, active.prepared.built.transaction, publicKey);
          legacyInspection = await inspectTransaction(connection, legacyTx, publicKey, active.prepared.programId);
          if (legacyInspection.problems.length) throw new Error(legacyInspection.problems.join(" "));
          if (legacyInspection.instructions.length !== active.inspection.instructions.length) {
            throw new Error("Re-formatted transaction doesn't match the original instructions.");
          }
          await simulateWithCost(connection, legacyTx, publicKey);
        } catch (fallbackErr) {
          console.warn("[BALNEX] legacy re-format not possible:", fallbackErr);
          err.details = {
            ...err.details,
            fallbackNotes: `Legacy re-format not possible: ${fallbackErr?.message || fallbackErr}`,
            legacyInspection,
          };
          throw err;
        }

        try {
          ({ signature } = await run(legacyTx, legacyInspection, "legacy (no lookup table)", "Retried after v0 -32603"));
        } catch (legacyErr) {
          if (legacyErr instanceof StageError) {
            legacyErr.details = { ...legacyErr.details, v0Attempts: err.details?.attempts, v0Inspection: active.inspection };
          }
          throw legacyErr;
        }
      }

      setStage("Verifying the pool on-chain…");
      await verifyPoolAccount(connection, active.prepared.poolId, active.prepared.programId, signature);

      rememberPool(active.prepared.poolId);
      setCreated({
        action: "created",
        txId: signature,
        poolId: active.prepared.poolId,
        lpMint: active.prepared.lpMint,
        mint: selected.mint,
        solDeposited: active.cost.deposit,
        tokenDeposited: fromRawUnits(active.tokenRaw, active.mintInfo.decimals),
      });
      setPlan(null);
      setPool(null);
      notify("Raydium pool created and verified.", "success");
      walletTokens.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  // Shared path for add / remove liquidity: simulate, sign, send, confirm.
  async function runExisting(built) {
    const tx = built.transaction;
    if (!tx) throw new StageError("prepare", "The Raydium SDK didn't return a transaction to sign.", { submitted: false });
    await simulateWithCost(connection, tx, publicKey);
    const { signature } = await signSendConfirm({
      connection,
      transaction: tx,
      signTransaction,
      sendTransaction,
      onStage: (name) =>
        setStage({ signing: "Waiting for your wallet…", submitting: "Sending…", confirming: "Confirming…" }[name] || ""),
    });
    return signature;
  }

  async function handleLoadPool() {
    setError("");

    try {
      new PublicKey(poolId.trim());
    } catch {
      setError("That doesn't look like a valid pool address.");
      return;
    }
    if (!connected || !publicKey) {
      openConnect();
      return;
    }

    setLoadingPool(true);
    setPool(null);
    try {
      const raydium = await getRaydium();
      const data = await fetchPool(raydium, poolId.trim());

      const lpMint = data.poolInfo.lpMint?.address;
      let lp = 0n;
      if (lpMint) {
        const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
          mint: new PublicKey(lpMint),
        });
        lp = accounts.value.reduce(
          (total, { account }) => total + BigInt(account.data.parsed.info.tokenAmount.amount),
          0n
        );
      }

      setLpRaw(lp);
      setPool(data);
      rememberPool(poolId.trim());
    } catch (err) {
      console.error("Load pool error:", err);
      setError((err?.message || "Couldn't load that pool."));
    } finally {
      setLoadingPool(false);
    }
  }

  async function handleAdd() {
    clearFailure();
    if (!pool) return;

    const side_ = side === "A" ? pool.poolInfo.mintA : pool.poolInfo.mintB;
    let amountRaw;
    try {
      amountRaw = toRawUnits(addAmount, side_.decimals);
    } catch (err) {
      setError(err.message);
      return;
    }
    if (amountRaw <= 0n) {
      setError("Enter an amount greater than zero.");
      return;
    }

    setBusy(true);
    try {
      const raydium = await getRaydium();
      const built = await prepareAddLiquidity(raydium, {
        poolInfo: pool.poolInfo,
        poolKeys: pool.poolKeys,
        amountRaw,
        baseIn: side === "A",
        slippagePercent: slippage,
      });
      const txId = await runExisting(built);
      setCreated({ txId, poolId: poolId.trim(), action: "added" });
      setAddAmount("");
      notify("Liquidity added.", "success");
      walletTokens.refresh();
      handleLoadPool();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  async function handleRemove() {
    clearFailure();
    if (!pool) return;

    const amount = (lpRaw * BigInt(removePercent || 0)) / 100n;
    if (amount <= 0n) {
      setError("Choose how much liquidity to remove.");
      return;
    }

    setBusy(true);
    try {
      const raydium = await getRaydium();
      const built = await prepareRemoveLiquidity(raydium, {
        poolInfo: pool.poolInfo,
        poolKeys: pool.poolKeys,
        lpRaw: amount,
        slippagePercent: slippage,
      });
      const txId = await runExisting(built);
      setCreated({ txId, poolId: poolId.trim(), action: "removed" });
      setRemovePercent("");
      notify("Liquidity removed.", "success");
      walletTokens.refresh();
      handleLoadPool();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  if (!connected) {
    return (
      <section className="panel">
        <span className="eyebrow">RAYDIUM</span>
        <h2>Liquidity</h2>
        <p className="muted">Connect your wallet to create a pool or manage liquidity.</p>
        <button className="primary" type="button" onClick={() => openConnect()}>
          Connect Wallet <span>→</span>
        </button>
      </section>
    );
  }

  const poolSideInfo = pool ? (side === "A" ? pool.poolInfo.mintA : pool.poolInfo.mintB) : null;
  const lpDecimals = pool?.poolInfo?.lpMint?.decimals ?? 0;

  return (
    <section className="panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">RAYDIUM CPMM · {CLUSTER.toUpperCase()}</span>
          <h2>Liquidity</h2>
          <p className="muted">Create a pool for your token, then add or remove liquidity.</p>
        </div>
        <div className="panel-icon">◈</div>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "tab active" : "tab"}
            onClick={() => {
              setTab(item.id);
              setError("");
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {created && (
        <div className="success-banner success-detail">
          <span>✓</span>
          <div>
            <strong>
              {created.action === "added"
                ? "Liquidity added"
                : created.action === "removed"
                  ? "Liquidity removed"
                  : "Pool created and verified on Devnet"}
            </strong>
            {created.action === "created" && (
              <dl className="detail-list">
                <dt>Pool ID</dt>
                <dd>{created.poolId}</dd>
                <dt>Transaction</dt>
                <dd>{created.txId}</dd>
                <dt>Token mint</dt>
                <dd>{created.mint}</dd>
                <dt>SOL deposited</dt>
                <dd>{sol(created.solDeposited)} SOL</dd>
                <dt>Tokens deposited</dt>
                <dd>{created.tokenDeposited}</dd>
                {created.lpMint && (
                  <>
                    <dt>LP mint</dt>
                    <dd>{created.lpMint}</dd>
                  </>
                )}
              </dl>
            )}
            <p>
              <a href={explorerTx(created.txId)} target="_blank" rel="noopener noreferrer">
                View transaction on Solana Explorer ↗
              </a>
              {" · "}
              <a href={explorerAddress(created.poolId)} target="_blank" rel="noopener noreferrer">
                Pool {shorten(created.poolId, 5, 5)} ↗
              </a>
            </p>
          </div>
        </div>
      )}

      {errInfo && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>{errInfo.title}</strong>
            <p>{errInfo.outcome}</p>
            <p>{errInfo.body}</p>
            {diag?.signature && (
              <p>
                <a href={explorerTx(diag.signature)} target="_blank" rel="noopener noreferrer">
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

      {tab === "create" && (
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

      {(tab === "add" || tab === "remove") && (
        <div className="guided-step">
          <div className="field">
            <label htmlFor="pool-id">Pool address</label>
            <div className="inline-field">
              <input
                id="pool-id"
                value={poolId}
                placeholder="Paste a Raydium CPMM pool address"
                disabled={busy || loadingPool}
                onChange={(e) => {
                  setPoolId(e.target.value);
                  setPool(null);
                }}
              />
              <button
                type="button"
                className="secondary-button compact"
                disabled={busy || loadingPool || !poolId.trim()}
                onClick={handleLoadPool}
              >
                {loadingPool ? "Loading…" : "Load"}
              </button>
            </div>
            <small className="helper">Pools you create here are remembered in this browser.</small>
          </div>

          {pool && (
            <>
              <div className="pool-preview">
                <div>
                  <span>Token A</span>
                  <strong>{pool.poolInfo.mintA.symbol || shorten(pool.poolInfo.mintA.address)}</strong>
                </div>
                <div>
                  <span>Token B</span>
                  <strong>{pool.poolInfo.mintB.symbol || shorten(pool.poolInfo.mintB.address)}</strong>
                </div>
                <div>
                  <span>Your LP</span>
                  <strong>{fromRawUnits(lpRaw, lpDecimals)}</strong>
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
            </>
          )}

          {pool && tab === "add" && (
            <>
              <div className="field">
                <label>Deposit side</label>
                <div className="liquidity-percentages" role="group" aria-label="Which token to enter">
                  {[
                    { id: "A", info: pool.poolInfo.mintA },
                    { id: "B", info: pool.poolInfo.mintB },
                  ].map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={side === item.id ? "liquidity-percentage selected" : "liquidity-percentage"}
                      aria-pressed={side === item.id}
                      onClick={() => setSide(item.id)}
                      disabled={busy}
                    >
                      {item.info.symbol || shorten(item.info.address)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label htmlFor="add-amount">Amount</label>
                <input
                  id="add-amount"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={addAmount}
                  disabled={busy}
                  onChange={(e) => setAddAmount(e.target.value)}
                />
                <small className="helper">
                  The matching amount of the other token is calculated for you
                  {poolSideInfo ? ` (${poolSideInfo.decimals} decimals on this side)` : ""}.
                </small>
              </div>

              <button className="primary" type="button" disabled={busy || !addAmount} onClick={handleAdd}>
                {busy ? stage || "Adding liquidity…" : "Add liquidity"}
                {!busy && <span> →</span>}
              </button>
            </>
          )}

          {pool && tab === "remove" && (
            <>
              <div className="field">
                <label>Amount to remove</label>
                <div className="liquidity-percentages" role="group" aria-label="Share of your liquidity">
                  {[25, 50, 75, 100].map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={removePercent === String(value) ? "liquidity-percentage selected" : "liquidity-percentage"}
                      aria-pressed={removePercent === String(value)}
                      onClick={() => setRemovePercent(String(value))}
                      disabled={busy || lpRaw === 0n}
                    >
                      {value}%
                    </button>
                  ))}
                </div>
                {lpRaw === 0n && <small className="helper">This wallet holds no LP tokens for this pool.</small>}
              </div>

              <button
                className="primary"
                type="button"
                disabled={busy || lpRaw === 0n || !removePercent}
                onClick={handleRemove}
              >
                {busy ? stage || "Removing liquidity…" : "Remove liquidity"}
                {!busy && <span> →</span>}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
