import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useConnectSheet } from "../components/WalletSheet";
import { PublicKey } from "@solana/web3.js";
import { useToast } from "../components/Toast";
import { CLUSTER, LAST_POOL_KEY, WSOL_MINT } from "../config";
import {
  addCpmmLiquidity,
  createCpmmPool,
  fetchPool,
  loadRaydium,
  removeCpmmLiquidity,
} from "../lib/raydium";
import {
  explorerAddress,
  explorerTx,
  friendlyError,
  fromRawUnits,
  shorten,
  toRawUnits,
} from "../lib/utils";

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
  const { publicKey, connected, signAllTransactions } = useWallet();
  const { open: openConnect } = useConnectSheet();
  const notify = useToast();

  const [tab, setTab] = useState("create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  async function handleCreatePool() {
    setError("");

    if (!connected || !publicKey) {
      openConnect();
      return;
    }
    if (!selected) {
      setError("Choose a token from your wallet first.");
      return;
    }

    let tokenRaw;
    let solRaw;
    try {
      tokenRaw = toRawUnits(tokenAmount, selected.decimals);
      solRaw = toRawUnits(solAmount, 9);
    } catch (err) {
      setError(err.message);
      return;
    }

    if (tokenRaw <= 0n || solRaw <= 0n) {
      setError("Enter a token amount and a SOL amount greater than zero.");
      return;
    }
    if (tokenRaw > selected.raw) {
      setError("You don't hold that many tokens.");
      return;
    }

    setBusy(true);
    try {
      const lamports = BigInt(await connection.getBalance(publicKey));
      if (lamports < solRaw) {
        throw new Error("Your wallet doesn't hold enough SOL for this liquidity amount.");
      }

      const raydium = await getRaydium();
      const result = await createCpmmPool(raydium, {
        mint: selected.mint,
        mintDecimals: selected.decimals,
        tokenRaw,
        solRaw,
      });

      rememberPool(result.poolId);
      setCreated(result);
      setPool(null);
      notify("Raydium pool created.", "success");
      walletTokens.refresh();
    } catch (err) {
      console.error("Create pool error:", err);
      const message = friendlyError(err);
      setError(message);
      notify(message, "error");
    } finally {
      setBusy(false);
    }
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
      setError(friendlyError(err));
    } finally {
      setLoadingPool(false);
    }
  }

  async function handleAdd() {
    setError("");
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
      const { txId } = await addCpmmLiquidity(raydium, {
        poolInfo: pool.poolInfo,
        poolKeys: pool.poolKeys,
        amountRaw,
        baseIn: side === "A",
        slippagePercent: slippage,
      });
      setCreated({ txId, poolId: poolId.trim(), action: "added" });
      setAddAmount("");
      notify("Liquidity added.", "success");
      walletTokens.refresh();
      handleLoadPool();
    } catch (err) {
      console.error("Add liquidity error:", err);
      const message = friendlyError(err);
      setError(message);
      notify(message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setError("");
    if (!pool) return;

    const amount = (lpRaw * BigInt(removePercent || 0)) / 100n;
    if (amount <= 0n) {
      setError("Choose how much liquidity to remove.");
      return;
    }

    setBusy(true);
    try {
      const raydium = await getRaydium();
      const { txId } = await removeCpmmLiquidity(raydium, {
        poolInfo: pool.poolInfo,
        poolKeys: pool.poolKeys,
        lpRaw: amount,
        slippagePercent: slippage,
      });
      setCreated({ txId, poolId: poolId.trim(), action: "removed" });
      setRemovePercent("");
      notify("Liquidity removed.", "success");
      walletTokens.refresh();
      handleLoadPool();
    } catch (err) {
      console.error("Remove liquidity error:", err);
      const message = friendlyError(err);
      setError(message);
      notify(message, "error");
    } finally {
      setBusy(false);
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
        <div className="success-banner">
          <span>✓</span>
          <div>
            <strong>
              {created.action === "added"
                ? "Liquidity added"
                : created.action === "removed"
                  ? "Liquidity removed"
                  : "Pool created"}
            </strong>
            <p>
              <a href={explorerTx(created.txId)} target="_blank" rel="noopener noreferrer">
                View transaction ↗
              </a>
              {" · "}
              <a href={explorerAddress(created.poolId)} target="_blank" rel="noopener noreferrer">
                Pool {shorten(created.poolId, 5, 5)} ↗
              </a>
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>Something went wrong</strong>
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
                      disabled={busy || !selected}
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
                  disabled={busy}
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
                    disabled={busy}
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

              <div className="notice">
                <span className="notice-icon">ⓘ</span>
                <div>
                  <strong>Review in your wallet</strong>
                  <p>
                    Your starting amounts set the initial price. Raydium charges a one-time pool creation fee plus
                    account rent on top of the amounts above — Phantom shows the total before you approve.
                  </p>
                </div>
              </div>

              <button className="primary" type="button" disabled={busy} onClick={handleCreatePool}>
                {busy ? "Creating pool…" : "Create Raydium pool"}
                {!busy && <span> →</span>}
              </button>
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
                {busy ? "Adding liquidity…" : "Add liquidity"}
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
                {busy ? "Removing liquidity…" : "Remove liquidity"}
                {!busy && <span> →</span>}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
