import { useEffect, useMemo, useState } from "react";
import { CLUSTER } from "../config";

const KEY = `balnex:lifecycle-lock:v1:${CLUSTER}`;
const HISTORY_KEY = `balnex:lifecycle-history:v1:${CLUSTER}`;
const EVENT = "balnex:lifecycle-lock-changed";

let operationInFlight = false;

const ACTIVE_STATES = new Set([
  "TOKEN_RESERVED",
  "TOKEN_CREATED",
  "POOL_PENDING",
  "POOL_RUNNING",
  "ADD_LIQUIDITY_PENDING",
  "REMOVAL_PENDING",
  "RECOVERY_REQUIRED",
]);

const LEGACY_STATUS = (state) =>
  ["TOKEN_RESERVED", "TOKEN_CREATED", "POOL_PENDING"].includes(state)
    ? "launch_pending"
    : ACTIVE_STATES.has(state)
      ? "liquidity_created"
      : "completed";

function emit() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

function safeRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function persist(lock) {
  try {
    if (lock) localStorage.setItem(KEY, JSON.stringify(lock));
    else localStorage.removeItem(KEY);
  } catch (error) {
    throw new Error("BALNEX could not persist the global liquidity lock. Enable browser storage before continuing.");
  }
  emit();
}

function corruptedLock(reason) {
  return {
    id: "storage-recovery-required",
    cluster: CLUSTER,
    wallet: null,
    mint: "",
    name: "Unknown token",
    symbol: "",
    status: "RECOVERY_REQUIRED",
    operation: { type: "storage", state: "unknown", updatedAt: Date.now() },
    transactions: {},
    poolId: null,
    recovery: { reason, at: Date.now(), signature: null },
    lastVerification: null,
  };
}

export function getLifecycleLock() {
  let lock = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      try { lock = JSON.parse(raw); }
      catch { return corruptedLock("The saved lifecycle lock is unreadable. BALNEX blocked new token creation to avoid losing the active reservation."); }
      if (!lock || typeof lock !== "object" || !lock.id || !ACTIVE_STATES.has(lock.status)) {
        return corruptedLock("The saved lifecycle lock is incomplete or has an unknown status. Manual on-chain recovery is required.");
      }
    }
  } catch {
    return corruptedLock("Browser storage is unavailable. BALNEX cannot safely determine whether another token lifecycle is active.");
  }
  if (!lock) {
    // One-time migration from the previous wallet-scoped launch store. Active records
    // become the single global lock; completed/abandoned history never unlocks another lock.
    const legacy = safeRead(`balnex:launches:v1:${CLUSTER}`, []);
    const active = Array.isArray(legacy)
      ? legacy.filter((item) => item && ["launch_pending", "liquidity_created"].includes(item.status))
          .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0]
      : null;
    if (active) {
      const status = active.status === "liquidity_created" ? "POOL_RUNNING" : "TOKEN_CREATED";
      lock = {
        id: `migrated-${active.mint}`, cluster: CLUSTER, wallet: active.wallet,
        mint: active.mint, name: active.name || "", symbol: active.symbol || "",
        decimals: active.decimals ?? null, supply: active.supply ?? null,
        status, poolId: active.poolId || null,
        transactions: { tokenCreation: active.signature || null, poolCreation: active.creationSignature || null, addLiquidity: null, removeLiquidity: active.removalSignature || null },
        operation: { type: "migration", state: "confirmed", updatedAt: Date.now() },
        createdAt: active.createdAt || Date.now(), updatedAt: Date.now(),
        transitions: [{ status, at: Date.now(), source: "legacy_migration" }],
        recovery: null, lastVerification: null,
      };
      persist(lock);
    }
  }
  return lock && lock.id && lock.status && ACTIVE_STATES.has(lock.status) ? lock : null;
}

export function reserveTokenLifecycle({ wallet, mint, name, symbol, decimals, supply, creationOptions = {} }) {
  if (operationInFlight) throw new Error("Another BALNEX lifecycle operation is already running.");
  const existing = getLifecycleLock();
  if (existing) {
    throw new Error(`BALNEX is locked to ${existing.name || "the current token"} (${existing.symbol || "token"}). Complete its liquidity lifecycle before creating another token.`);
  }
  const now = Date.now();
  const lock = {
    id: `lifecycle-${mint}-${now}`,
    cluster: CLUSTER,
    wallet,
    mint,
    name,
    symbol,
    decimals: Number(decimals),
    supply: String(supply),
    creationOptions,
    status: "TOKEN_RESERVED",
    operation: { type: "token_create", state: "prepared", startedAt: now, updatedAt: now },
    transactions: { tokenCreation: null, poolCreation: null, addLiquidity: null, removeLiquidity: null },
    poolId: null,
    createdAt: now,
    updatedAt: now,
    transitions: [{ status: "TOKEN_RESERVED", at: now }],
    recovery: null,
    lastVerification: null,
  };
  // Re-read after the synchronous write to detect another same-origin tab that won.
  persist(lock);
  const check = getLifecycleLock();
  if (!check || check.id !== lock.id) throw new Error("Another tab reserved the BALNEX lifecycle first. Refresh before continuing.");
  return lock;
}

export function replaceReservedMint(mint, expectedName, expectedSymbol) {
  const current = getLifecycleLock();
  if (!current || current.status !== "TOKEN_RESERVED" || current.operation?.state !== "failed_no_submission" ||
      current.transactions?.tokenCreation || current.name !== expectedName || current.symbol !== expectedSymbol) {
    throw new Error("This reserved token cannot be replaced safely. Verify the existing lifecycle before retrying.");
  }
  return updateLifecycleLock({ mint, recovery: null, operation: { type: "token_create", state: "prepared", startedAt: Date.now(), updatedAt: Date.now() } }, current.id);
}

export function updateLifecycleLock(patch, expectedId) {
  const current = getLifecycleLock();
  if (!current || (expectedId && current.id !== expectedId)) {
    throw new Error("The global BALNEX lifecycle lock changed. Refresh and verify its status.");
  }
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.status && patch.status !== current.status) {
    next.transitions = [...(current.transitions || []), { status: patch.status, at: Date.now() }];
  }
  persist(next);
  return next;
}

export function transitionLifecycle(status, patch = {}) {
  if (!ACTIVE_STATES.has(status)) throw new Error("Invalid lifecycle transition.");
  return updateLifecycleLock({ ...patch, status });
}

export function beginLifecycleOperation({ mint, type, allowedStates, pendingStatus }) {
  const current = getLifecycleLock();
  if (!current) throw new Error("No active BALNEX token lifecycle exists.");
  if (current.mint !== mint) throw new Error("This token is not the token reserved by the global BALNEX lifecycle lock.");
  if (operationInFlight) throw new Error("Another BALNEX lifecycle operation is already running.");
  if (current.operation?.state === "submitted" || current.operation?.state === "unknown") {
    throw new Error("A previous transaction is unresolved. Verify its signature before retrying.");
  }
  if (!allowedStates.includes(current.status)) {
    throw new Error(`Operation ${type} is not allowed while the lifecycle is ${current.status}.`);
  }
  operationInFlight = true;
  try {
    const now = Date.now();
    updateLifecycleLock({
      status: pendingStatus || current.status,
      operation: { type, state: "prepared", startedAt: now, updatedAt: now },
      recovery: null,
    }, current.id);
  } catch (error) {
    operationInFlight = false;
    throw error;
  }
  let released = false;
  return {
    lock: current,
    update: (state, details = {}) => {
      const latest = getLifecycleLock();
      if (!latest || latest.id !== current.id) throw new Error("The lifecycle lock changed during this operation.");
      const now = Date.now();
      const transactions = { ...(latest.transactions || {}) };
      if (details.signature) {
        const key = type === "token_create" ? "tokenCreation"
          : type === "pool_create" ? "poolCreation"
            : type === "add_liquidity" ? "addLiquidity"
              : type === "remove_liquidity" ? "removeLiquidity" : null;
        if (key) transactions[key] = details.signature;
      }
      const unknown = state === "unknown" || state === "submitted";
      const nextStatus = unknown ? "RECOVERY_REQUIRED"
        : state === "failed_no_submission" && type === "pool_create" ? "TOKEN_CREATED"
          : state === "failed_no_submission" && type === "remove_liquidity" ? "POOL_RUNNING"
          : state === "failed_no_submission" && type === "token_create" ? "TOKEN_RESERVED"
            : state === "failed_submitted" && type === "pool_create" ? "TOKEN_CREATED"
              : state === "failed_submitted" && type === "remove_liquidity" ? "POOL_RUNNING"
              : state === "failed_submitted" && type === "token_create" ? "TOKEN_RESERVED"
                : state === "confirmed" && type === "pool_create" ? "POOL_RUNNING"
                  : state === "confirmed" && type === "remove_liquidity" ? "REMOVAL_PENDING"
                    : latest.status;
      updateLifecycleLock({
        transactions,
        poolId: details.poolId || latest.poolId,
        status: nextStatus,
        operation: { ...(latest.operation || {}), type, state, updatedAt: now, ...details },
        ...(unknown ? { recovery: { reason: details.reason || state, at: now, signature: details.signature || null } } : state === "failed_no_submission" ? { recovery: { reason: details.reason || state, at: now, signature: null } } : { recovery: null }),
      }, current.id);
    },
    release: () => {
      if (!released) {
        released = true;
        operationInFlight = false;
      }
    },
  };
}

export function setLifecycleVerification(result) {
  const current = getLifecycleLock();
  if (!current) return null;
  return updateLifecycleLock({ lastVerification: { ...result, checkedAt: Date.now() } }, current.id);
}

export function markTokenCreated(details = {}) {
  const current = getLifecycleLock();
  if (!current) throw new Error("The token reservation is missing; refusing to continue without a lifecycle lock.");
  return updateLifecycleLock({
    status: "TOKEN_CREATED",
    operation: { type: "token_create", state: "confirmed", updatedAt: Date.now(), signature: details.signature || current.transactions?.tokenCreation || null },
    transactions: { ...current.transactions, ...(details.signature ? { tokenCreation: details.signature } : {}) },
    ...details,
  }, current.id);
}

export function markPoolPending(details = {}) {
  return transitionLifecycle("POOL_PENDING", {
    poolId: details.poolId || null,
    operation: { type: "pool_create", state: "prepared", updatedAt: Date.now() },
  });
}

export function markLiquidityCreated(wallet, mint, details = {}) {
  const current = getLifecycleLock();
  if (!current || current.mint !== mint) throw new Error("Pool creation does not match the globally reserved token.");
  return transitionLifecycle("POOL_RUNNING", {
    poolId: details.poolId || current.poolId,
    transactions: {
      ...current.transactions,
      ...(details.creationSignature ? { poolCreation: details.creationSignature } : {}),
    },
    operation: { type: "pool_create", state: "confirmed", updatedAt: Date.now(), signature: details.creationSignature || null },
    ...details,
  });
}

export function markRemovalVerified(details = {}) {
  const current = getLifecycleLock();
  if (!current || !["REMOVAL_PENDING", "RECOVERY_REQUIRED"].includes(current.status)) {
    throw new Error("No removal operation is awaiting verification.");
  }
  return transitionLifecycle("POOL_RUNNING", {
    operation: { type: "remove_liquidity", state: "confirmed", updatedAt: Date.now(), signature: details.signature || null },
    transactions: { ...current.transactions, ...(details.signature ? { removeLiquidity: details.signature } : {}) },
    lastVerification: { ...details, checkedAt: Date.now() },
  });
}

export function markOperationPending(type, pendingStatus, details = {}) {
  const current = getLifecycleLock();
  if (!current) throw new Error("No active lifecycle lock.");
  const allowed = type === "pool_create" ? ["TOKEN_CREATED", "POOL_PENDING", "RECOVERY_REQUIRED"]
    : type === "add_liquidity" ? ["POOL_RUNNING", "ADD_LIQUIDITY_PENDING", "RECOVERY_REQUIRED"]
      : type === "remove_liquidity" ? ["POOL_RUNNING", "REMOVAL_PENDING", "RECOVERY_REQUIRED"] : [];
  if (!allowed.includes(current.status)) throw new Error(`Operation ${type} is not allowed while lifecycle is ${current.status}.`);
  if (current.operation?.state === "submitted" || current.operation?.state === "unknown") throw new Error("A previous transaction remains unresolved. Verify its status before retrying.");
  return transitionLifecycle(pendingStatus, {
    operation: { type, state: "prepared", updatedAt: Date.now(), ...details },
  });
}

export function markOperationOutcome(state, details = {}) {
  const current = getLifecycleLock();
  if (!current) throw new Error("No active lifecycle lock.");
  const now = Date.now();
  const transactions = { ...current.transactions };
  const signatureKey = current.operation?.type === "pool_create" ? "poolCreation"
    : current.operation?.type === "add_liquidity" ? "addLiquidity"
      : current.operation?.type === "remove_liquidity" ? "removeLiquidity" : null;
  if (signatureKey && details.signature) transactions[signatureKey] = details.signature;
  const unknown = ["submitted", "unknown"].includes(state);
  const nextStatus = unknown ? "RECOVERY_REQUIRED"
    : ["failed_no_submission", "failed_submitted"].includes(state) && current.operation?.type === "pool_create" ? "TOKEN_CREATED"
      : ["failed_no_submission", "failed_submitted"].includes(state) && current.operation?.type === "remove_liquidity" ? "POOL_RUNNING"
        : state === "failed_no_submission" && current.operation?.type === "token_create" ? "TOKEN_RESERVED"
          : state === "confirmed" && current.operation?.type === "pool_create" ? "POOL_RUNNING"
          : state === "confirmed" && current.operation?.type === "add_liquidity" ? "POOL_RUNNING"
            : state === "confirmed" && current.operation?.type === "remove_liquidity" ? "REMOVAL_PENDING"
              : current.status;
  return updateLifecycleLock({
    transactions,
    status: nextStatus,
    operation: { ...(current.operation || {}), state, updatedAt: now, ...details },
    ...(unknown ? { recovery: { reason: details.reason || state, at: now, signature: details.signature || current.operation?.signature || null } } : state === "failed_no_submission" ? { recovery: { reason: details.reason || state, at: now, signature: null } } : { recovery: null }),
  }, current.id);
}

export function markRemovalPending(details = {}) {
  return transitionLifecycle("REMOVAL_PENDING", {
    operation: { type: "remove_liquidity", state: "prepared", updatedAt: Date.now() },
    ...details,
  });
}

export function markLiquidityRemoved(wallet, mint, removalSignature, extra = {}) {
  const current = getLifecycleLock();
  if (!current || current.mint !== mint) throw new Error("Removal verification does not match the globally reserved token.");
  if (
    !removalSignature ||
    extra.verified !== true ||
    extra.signatureStatus !== "finalized" ||
    String(extra.remainingLpRaw) !== "0" ||
    extra.poolStatus !== "emptied" ||
    Number(extra.reserves?.token) !== 0 ||
    Number(extra.reserves?.sol) !== 0 ||
    current.operation?.state !== "confirmed"
  ) {
    throw new Error("A finalized removal signature and independently verified zero LP balance are required before releasing the global lock.");
  }
  const now = Date.now();
  const history = safeRead(HISTORY_KEY, []);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([
      { ...current, status: "RESOLVED", resolvedAt: now, transactions: { ...current.transactions, ...(removalSignature ? { removeLiquidity: removalSignature } : {}) }, ...extra },
      ...(Array.isArray(history) ? history : []),
    ].slice(0, 50)));
  } catch {
    throw new Error("Could not persist lifecycle history; the global lock remains active.");
  }
  persist(null);
  emit();
  return true;
}

// Legacy reads retained for existing components. The lifecycle lock itself is global,
// not scoped to the currently connected wallet.
export function getActiveLaunch(wallet) {
  const lock = getLifecycleLock();
  if (!lock) return null;
  return { ...lock, status: LEGACY_STATUS(lock.status), lifecycleStatus: lock.status, signature: lock.transactions?.tokenCreation };
}
export function getLaunches(wallet) {
  const active = getActiveLaunch(wallet);
  return active ? [active] : safeRead(HISTORY_KEY, []).filter((item) => !wallet || item.wallet === wallet);
}
export function startLaunch({ wallet, mint, name, symbol, signature, decimals }) {
  const current = getLifecycleLock();
  if (!current || current.mint !== mint) throw new Error("Token creation must reserve the global lifecycle before submitting.");
  markTokenCreated({ wallet, mint, name, symbol, decimals, signature });
  return { ok: true, launch: getActiveLaunch(wallet) };
}
export function abandonLaunch() {
  throw new Error("A BALNEX lifecycle cannot be abandoned or manually unlocked. Verify the on-chain state and complete liquidity removal.");
}

export function useLaunches(wallet) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return useMemo(() => getLaunches(wallet), [wallet, version]);
}

export function useLifecycleLock() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return useMemo(() => getLifecycleLock(), [version]);
}

export function useActiveLaunch(wallet) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return useMemo(() => getActiveLaunch(wallet), [wallet, version]);
}
