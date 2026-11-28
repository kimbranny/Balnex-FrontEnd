// GLOBAL single-token lifecycle lock.
//
// BALNEX allows exactly ONE token lifecycle at a time (per network, across every wallet in
// this browser). The lock is acquired synchronously BEFORE a token mint transaction starts and
// is released only by decide() when on-chain facts prove the lifecycle is resolved.
//
// Storage: one localStorage record `balnex:lifecycle-lock:v1:<cluster>` = { lock, history }.
// It is re-read from storage on EVERY check (never from a React variable), so a stale render
// can't bypass it. Limitation: browser-local (no backend), so another browser/profile or
// cleared site data starts unlocked. Unreadable/corrupt storage fails CLOSED (blocks creation).
//
// Two layers guard every operation:
//   1. persistent lock  - survives refresh, navigation, tab close, wallet changes, failures
//   2. in-process guard - synchronous, makes double-clicks and concurrent calls impossible
//
// There is intentionally NO exported "unlock". The only way to RESOLVED is applyVerification().
import { CLUSTER } from "../config";

export const STATE = {
  TOKEN_RESERVED: "TOKEN_RESERVED",
  TOKEN_CREATED: "TOKEN_CREATED",
  POOL_PENDING: "POOL_PENDING",
  POOL_RUNNING: "POOL_RUNNING",
  ADD_LIQUIDITY_PENDING: "ADD_LIQUIDITY_PENDING",
  REMOVAL_PENDING: "REMOVAL_PENDING",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  RESOLVED: "RESOLVED",
};
// UNLOCKED is "no active lock record" (none stored, or the stored one is RESOLVED).
export const UNLOCKED = "UNLOCKED";

export const OP = {
  CREATE_TOKEN: "create_token",
  CREATE_POOL: "create_pool",
  ADD_LIQUIDITY: "add_liquidity",
  REMOVE_LIQUIDITY: "remove_liquidity",
};

// Transaction tracking: prepared -> signing -> submitted -> confirmed | failed | unknown
export const TX = {
  PREPARED: "prepared",
  SIGNING: "signing",
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  UNKNOWN: "unknown",
};

export const STATE_LABEL = {
  TOKEN_RESERVED: "Token reserved",
  TOKEN_CREATED: "Token created · awaiting pool",
  POOL_PENDING: "Pool creation pending",
  POOL_RUNNING: "Pool running",
  ADD_LIQUIDITY_PENDING: "Add liquidity pending",
  REMOVAL_PENDING: "Liquidity removal pending",
  RECOVERY_REQUIRED: "Recovery required · status unknown",
  RESOLVED: "Resolved",
};

const KEY = `balnex:lifecycle-lock:v1:${CLUSTER}`;
const EVENT = "balnex:lifecycle-changed";
const SESSION = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const OP_ACTIVE = new Set([TX.PREPARED, TX.SIGNING, TX.SUBMITTED, TX.UNKNOWN]);

// Which operations each state permits.
const ALLOWED = {
  [OP.CREATE_TOKEN]: [STATE.TOKEN_RESERVED],
  [OP.CREATE_POOL]: [STATE.TOKEN_CREATED, STATE.POOL_PENDING],
  [OP.ADD_LIQUIDITY]: [STATE.POOL_RUNNING],
  [OP.REMOVE_LIQUIDITY]: [STATE.POOL_RUNNING],
};

// ---- storage ---------------------------------------------------------------------------
let memory = null; // used only when localStorage is unavailable (then persistence is lost on reload)
let storageOk = true;

function store() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function load() {
  const ls = store();
  if (!ls) return memory ? JSON.parse(memory) : { lock: null, history: [], corrupt: false };
  let raw;
  try {
    raw = ls.getItem(KEY);
  } catch {
    return { lock: null, history: [], corrupt: true };
  }
  if (!raw) return { lock: null, history: [], corrupt: false };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("shape");
    return { lock: data.lock || null, history: Array.isArray(data.history) ? data.history : [], corrupt: false };
  } catch {
    return { lock: null, history: [], corrupt: true }; // fail closed
  }
}

function save(data) {
  const payload = JSON.stringify({ lock: data.lock, history: data.history.slice(0, 20) });
  const ls = store();
  try {
    if (!ls) throw new Error("no storage");
    ls.setItem(KEY, payload);
    storageOk = true;
  } catch {
    memory = payload;
    storageOk = false;
  }
  try {
    if (typeof window !== "undefined" && window.dispatchEvent) window.dispatchEvent(new Event(EVENT));
  } catch {
    // non-browser environment
  }
}

export const LOCK_EVENT = EVENT;
export const isPersistent = () => storageOk;

function newId() {
  return `lock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---- reads -----------------------------------------------------------------------------
export function getLockRecord() {
  return load().lock;
}

// The active (unresolved) lock, or null when unlocked.
export function getLock() {
  const { lock } = load();
  return lock && lock.status !== STATE.RESOLVED ? lock : null;
}

export function isLocked() {
  const data = load();
  return data.corrupt || (!!data.lock && data.lock.status !== STATE.RESOLVED);
}

export const isStorageCorrupt = () => load().corrupt;
export const getLockHistory = () => load().history;
export const stateOf = (lock) => (lock && lock.status !== STATE.RESOLVED ? lock.status : UNLOCKED);
export const opIsActive = (lock) => !!lock?.op && OP_ACTIVE.has(lock.op.txState);

// ---- in-process synchronous guard ------------------------------------------------------
// Taken and checked in the same synchronous turn as the lock read, so two clicks in the same
// tick (or two components) can't both proceed.
let guard = null; // { lockId|null, type, at }

export const isOperationRunning = () => !!guard;

function stamp(lock, status, note) {
  const at = Date.now();
  lock.transitions = [...(lock.transitions || []), { status, at, note: note || null }].slice(-100);
  lock.status = status;
  lock.updatedAt = at;
}

function reject(code, message, lock) {
  return { ok: false, code, message, lock: lock || null };
}

const LOCKED_MESSAGE =
  "You must complete or resolve this token's liquidity lifecycle before creating another token.";

// Is a retry of `type` permitted from the lock's current state? Only when nothing is in
// flight and the previous attempt is PROVEN not to have succeeded (safeRetry).
function retryBlocker(lock, type) {
  const op = lock.op;
  if (!op || op.type !== type) return null; // first attempt of this operation
  if (OP_ACTIVE.has(op.txState)) {
    return reject(
      "UNRESOLVED_OPERATION",
      op.txState === TX.UNKNOWN || op.txState === TX.SUBMITTED
        ? "A previous transaction was submitted and its outcome isn't known yet. Verify its status before doing anything else."
        : "Another operation for this token is still in progress or didn't finish cleanly. Verify its status first.",
      lock
    );
  }
  if (op.txState === TX.FAILED && !op.safeRetry) {
    return reject("VERIFY_FIRST", "Verify the on-chain status before retrying.", lock);
  }
  return null;
}

// Common gate for every operation after the token exists. Synchronous.
function begin(type, { mint, meta } = {}) {
  const data = load();
  if (data.corrupt) {
    return reject("STORAGE_UNREADABLE", "BALNEX can't read its saved lifecycle lock, so actions are blocked to stay safe.");
  }
  let lock = data.lock && data.lock.status !== STATE.RESOLVED ? data.lock : null;

  if (guard) return reject("OPERATION_IN_PROGRESS", "Another BALNEX operation is already running. Wait for it to finish.", lock);
  // A token that wasn't created through BALNEX's lock (made before this feature, or elsewhere)
  // can become THE locked lifecycle when the user explicitly starts a pool for it, but only
  // if no other lifecycle is active.
  if (!lock && type === OP.CREATE_POOL && meta?.adopt && mint) {
    lock = adoptToken({ ...meta.adopt, mint }, data);
    data.lock = lock;
  }
  if (!lock) return reject("NO_LOCK", "There is no active token lifecycle for this operation.");

  if (mint && lock.mint && mint !== lock.mint) {
    return reject("TOKEN_MISMATCH", `Only the locked token (${lock.name || lock.mint}) can be used until its liquidity lifecycle is resolved.`, lock);
  }
  if (!ALLOWED[type]?.includes(lock.status)) {
    return reject("NOT_ALLOWED_IN_STATE", `This action isn't allowed while the lifecycle is "${STATE_LABEL[lock.status] || lock.status}".`, lock);
  }
  const blocked = retryBlocker(lock, type);
  if (blocked) return blocked;
  if (opIsActive(lock) && lock.op.sessionId !== SESSION) {
    return reject("UNRESOLVED_OPERATION", "A previous operation didn't finish cleanly. Verify its status first.", lock);
  }

  guard = { lockId: lock.lockId, type, at: Date.now() };

  const next = structuredCloneSafe(lock);
  if (type === OP.CREATE_POOL) stamp(next, STATE.POOL_PENDING, "pool creation started");
  else if (type === OP.ADD_LIQUIDITY) stamp(next, STATE.ADD_LIQUIDITY_PENDING, "add liquidity started");
  else if (type === OP.REMOVE_LIQUIDITY) stamp(next, STATE.REMOVAL_PENDING, "liquidity removal started");
  else next.updatedAt = Date.now();
  next.op = newOp(type, meta);
  next.recovery = null;
  save({ ...data, lock: next });
  return { ok: true, handle: makeHandle(next.lockId, type) };
}

const structuredCloneSafe = (v) => JSON.parse(JSON.stringify(v));

function newOp(type, meta = {}) {
  const now = Date.now();
  return {
    type,
    txState: TX.PREPARED,
    sessionId: SESSION,
    startedAt: now,
    history: [{ txState: TX.PREPARED, at: now }],
    signature: null,
    blockhash: null,
    maybeSubmitted: false,
    safeRetry: false,
    expectedPoolId: meta.expectedPoolId || null,
    error: null,
  };
}

// ---- acquiring the lock for token creation --------------------------------------------
// MUST be called synchronously at the start of the create-token handler, before any await.
export function acquireForCreation({ wallet, name, symbol, decimals, supply }) {
  const data = load();
  if (data.corrupt) {
    return reject("STORAGE_UNREADABLE", "BALNEX can't read its saved lifecycle lock, so token creation is blocked to stay safe.");
  }
  if (guard) return reject("OPERATION_IN_PROGRESS", "A token creation is already in progress.", data.lock);

  const lock = data.lock && data.lock.status !== STATE.RESOLVED ? data.lock : null;
  if (lock) {
    // Only a retry of THIS reservation (same wallet, nothing in flight, proven not created) is allowed.
    const isRetry = lock.status === STATE.TOKEN_RESERVED && lock.wallet === wallet;
    if (!isRetry) return reject("TOKEN_LOCKED", LOCKED_MESSAGE, lock);
    const blocked = retryBlocker(lock, OP.CREATE_TOKEN);
    if (blocked) return blocked;
    if (opIsActive(lock) && lock.op.sessionId !== SESSION) {
      return reject("UNRESOLVED_OPERATION", "A previous token creation didn't finish cleanly. Verify its status first.", lock);
    }
    guard = { lockId: lock.lockId, type: OP.CREATE_TOKEN, at: Date.now() };
    const next = structuredCloneSafe(lock);
    Object.assign(next, { name, symbol, decimals, supply });
    next.op = newOp(OP.CREATE_TOKEN);
    next.pendingMint = null;
    next.recovery = null;
    next.updatedAt = Date.now();
    save({ ...data, lock: next });
    return { ok: true, handle: makeHandle(next.lockId, OP.CREATE_TOKEN), retry: true };
  }

  guard = { lockId: null, type: OP.CREATE_TOKEN, at: Date.now() };
  const now = Date.now();
  const fresh = {
    lockId: newId(),
    cluster: CLUSTER,
    wallet,
    name,
    symbol,
    decimals,
    supply: supply === undefined ? null : String(supply),
    mint: null,
    pendingMint: null,
    status: STATE.TOKEN_RESERVED,
    poolId: null,
    lpMint: null,
    creationSignature: null,
    poolSignature: null,
    addLiquiditySignature: null,
    removeSignature: null,
    op: null,
    transitions: [],
    recovery: null,
    lastVerification: null,
    createdAt: now,
    updatedAt: now,
  };
  stamp(fresh, STATE.TOKEN_RESERVED, "reserved before creation");
  fresh.op = newOp(OP.CREATE_TOKEN);
  guard.lockId = fresh.lockId;
  const history = data.lock ? [data.lock, ...data.history] : data.history;
  save({ lock: fresh, history });
  return { ok: true, handle: makeHandle(fresh.lockId, OP.CREATE_TOKEN), retry: false };
}

// ---- other operations ------------------------------------------------------------------
export const beginCreatePool = (mint, meta) => begin(OP.CREATE_POOL, { mint, meta });
export const beginAddLiquidity = (mint, meta) => begin(OP.ADD_LIQUIDITY, { mint, meta });
export const beginRemoveLiquidity = (mint, meta) => begin(OP.REMOVE_LIQUIDITY, { mint, meta });

// Cheap synchronous check for UI/handlers (does not take the guard).
export function checkAllowed(type, mint) {
  const data = load();
  if (data.corrupt) return reject("STORAGE_UNREADABLE", "Saved lifecycle lock is unreadable.");
  const lock = data.lock && data.lock.status !== STATE.RESOLVED ? data.lock : null;
  if (type === OP.CREATE_TOKEN) return lock ? reject("TOKEN_LOCKED", LOCKED_MESSAGE, lock) : { ok: true };
  if (!lock) return reject("NO_LOCK", "There is no active token lifecycle.");
  if (mint && lock.mint && mint !== lock.mint) return reject("TOKEN_MISMATCH", "This isn't the locked token.", lock);
  if (!ALLOWED[type]?.includes(lock.status)) return reject("NOT_ALLOWED_IN_STATE", "Not allowed in the current state.", lock);
  return retryBlocker(lock, type) || { ok: true };
}

// ---- handle: the running operation -----------------------------------------------------
function mutate(lockId, fn) {
  const data = load();
  if (!data.lock || data.lock.lockId !== lockId) return null;
  const next = structuredCloneSafe(data.lock);
  fn(next);
  save({ ...data, lock: next });
  return next;
}

function setTx(lock, txState, extra = {}) {
  const now = Date.now();
  lock.op = { ...lock.op, ...extra, txState, history: [...(lock.op?.history || []), { txState, at: now }].slice(-20) };
  lock.updatedAt = now;
}

function makeHandle(lockId, type) {
  let ended = false;
  const end = () => {
    if (!ended && guard && guard.lockId === lockId) guard = null;
    ended = true;
  };
  return {
    lockId,
    type,
    // Persist pre-submission facts so recovery can look for them on-chain.
    setMint: (mint) => mutate(lockId, (l) => (l.pendingMint = mint)),
    setExpectedPool: (poolId) => mutate(lockId, (l) => (l.op = { ...l.op, expectedPoolId: poolId })),
    signing: (blockhash) => mutate(lockId, (l) => setTx(l, TX.SIGNING, blockhash ? { blockhash } : {})),
    // Wallet may submit by itself (sign-and-send fallback): a missing signature can no longer prove non-submission.
    markMaybeSubmitted: () => mutate(lockId, (l) => (l.op = { ...l.op, maybeSubmitted: true })),
    // Record the signature BEFORE/AS the transaction is sent, never after confirmation.
    // Calling it with no signature (just before sending) still marks the op as possibly on the network.
    submitted: ({ signature, blockhash } = {}) =>
      mutate(lockId, (l) =>
        setTx(l, TX.SUBMITTED, {
          signature: signature || l.op.signature,
          blockhash: blockhash || l.op.blockhash,
          maybeSubmitted: true,
        })
      ),
    // Transaction confirmed on-chain. Applies the transition only for operations that are
    // fully verified at this point (token creation, pool creation). Removal / add liquidity
    // stay pending until applyVerification() has read the chain back.
    confirmed: (patch = {}) => {
      const next = mutate(lockId, (l) => {
        setTx(l, TX.CONFIRMED, { signature: patch.signature || l.op?.signature || null });
        if (type === OP.CREATE_TOKEN) {
          l.mint = patch.mint || l.pendingMint;
          l.creationSignature = patch.signature || l.op.signature;
          if (patch.decimals !== undefined) l.decimals = patch.decimals;
          if (patch.supply !== undefined) l.supply = String(patch.supply);
          l.recovery = null;
          stamp(l, STATE.TOKEN_CREATED, "mint confirmed on-chain");
        } else if (type === OP.CREATE_POOL) {
          Object.assign(l, {
            poolId: patch.poolId || l.op.expectedPoolId,
            lpMint: patch.lpMint || null,
            poolSignature: patch.signature || l.op.signature,
            tokenDeposited: patch.tokenDeposited ?? null,
            solDeposited: patch.solDeposited ?? null,
          });
          l.recovery = null;
          stamp(l, STATE.POOL_RUNNING, "pool confirmed and verified on-chain");
        } else if (type === OP.ADD_LIQUIDITY) {
          l.addLiquiditySignature = patch.signature || l.op.signature;
        } else if (type === OP.REMOVE_LIQUIDITY) {
          l.removeSignature = patch.signature || l.op.signature;
        }
      });
      end();
      return next;
    },
    // Failure. `submitted` false => nothing reached the network (safe to retry the same op for
    // the same token). Anything else is UNRESOLVED and must be verified on-chain first.
    failed: ({ submitted, message, signature, stage } = {}) => {
      const next = mutate(lockId, (l) => {
        const safe = submitted === false && !l.op?.maybeSubmitted;
        if (safe) {
          setTx(l, TX.FAILED, { safeRetry: true, error: { message: message || null, stage: stage || null, at: Date.now() } });
          if (type === OP.CREATE_POOL) stamp(l, STATE.POOL_PENDING, "pool creation failed before submission");
          if (type === OP.CREATE_TOKEN) l.pendingMint = null;
          // Removal/add must be re-checked against the chain before any retry (see applyVerification).
          l.recovery = { reason: signingOrPrep(stage), message: message || null, at: Date.now(), safeRetry: type !== OP.REMOVE_LIQUIDITY && type !== OP.ADD_LIQUIDITY };
          if (type === OP.REMOVE_LIQUIDITY || type === OP.ADD_LIQUIDITY) l.op = { ...l.op, safeRetry: false, needsRecheck: true };
        } else {
          const previous = l.status;
          setTx(l, TX.UNKNOWN, { signature: signature || l.op?.signature || null, error: { message: message || null, stage: stage || null, at: Date.now() } });
          l.recovery = { reason: "status_unknown", message: message || null, previous, at: Date.now() };
          stamp(l, STATE.RECOVERY_REQUIRED, "outcome unknown after submission");
        }
      });
      end();
      return next;
    },
    end,
  };
}

const signingOrPrep = (stage) => (stage === "signing" ? "signing_failed" : stage === "prepare" ? "prepare_failed" : "failed_before_submission");

// ---- verification: the ONLY path to resolution -----------------------------------------
// `facts` are read from the chain by lifecycleChain.collectFacts(). decide() is pure.
//   facts = { at, rpcAvailable, mintExists: bool|null, sigOutcome: 'none'|'confirmed'|'failed'|
//             'expired_unlanded'|'pending'|'unavailable', poolStatus: 'unchecked'|'verified'|
//             'emptied'|'not_found'|'invalid'|'unavailable', poolId?, lpMint?, lpRaw?: bigint|string,
//             reserves?, message? }
export function decide(lock, facts) {
  const unchanged = { status: lock.status, patch: {}, op: null, reason: "unchanged" };
  const lastVerification = {
    at: facts.at || Date.now(),
    rpcAvailable: !!facts.rpcAvailable,
    mintExists: facts.mintExists ?? null,
    sigOutcome: facts.sigOutcome || "none",
    poolStatus: facts.poolStatus || "unchecked",
    lpRaw: facts.lpRaw !== undefined && facts.lpRaw !== null ? String(facts.lpRaw) : null,
    reserves: facts.reserves || null,
    message: facts.message || null,
  };
  if (!facts.rpcAvailable) {
    return {
      ...unchanged,
      lastVerification: { ...lastVerification, result: "unavailable" },
      recovery: { reason: "rpc_unavailable", message: "The network couldn't be reached, so nothing could be verified. Your token stays locked.", at: Date.now(), previous: lock.recovery?.previous || (lock.status === STATE.RECOVERY_REQUIRED ? null : lock.status) },
    };
  }

  const op = lock.op || null;
  const sig = facts.sigOutcome || "none";
  // Without any signature, nothing can have been submitted unless the wallet may have sent it itself.
  const provenNotSent = sig === "failed" || sig === "expired_unlanded" || (sig === "none" && !op?.maybeSubmitted);
  const phase = lock.status === STATE.RECOVERY_REQUIRED ? lock.recovery?.previous || inferPhase(lock) : lock.status;
  const done = (status, patch = {}, opPatch = null, reason = "") => ({
    status,
    patch,
    op: opPatch,
    reason,
    lastVerification: { ...lastVerification, result: reason || "ok" },
    recovery: null,
  });
  const stuck = (reason, message) => ({
    status: STATE.RECOVERY_REQUIRED,
    patch: {},
    op: null,
    reason,
    lastVerification: { ...lastVerification, result: reason },
    recovery: { reason, message, at: Date.now(), previous: phase === STATE.RECOVERY_REQUIRED ? inferPhase(lock) : phase },
  });
  const lpIsZero = facts.lpRaw !== undefined && facts.lpRaw !== null && BigInt(facts.lpRaw) === 0n;

  switch (phase) {
    case STATE.TOKEN_RESERVED: {
      if (facts.mintExists === true) {
        return done(STATE.TOKEN_CREATED, { mint: lock.pendingMint || lock.mint, creationSignature: op?.signature || lock.creationSignature }, { txState: TX.CONFIRMED }, "mint_found_on_chain");
      }
      if (facts.mintExists === false && provenNotSent) {
        return done(STATE.TOKEN_RESERVED, { pendingMint: null }, { txState: TX.FAILED, safeRetry: true }, "creation_proven_not_landed");
      }
      return stuck("creation_unresolved", "The token creation may still land. Check again shortly; nothing can be retried until it is known.");
    }
    case STATE.TOKEN_CREATED:
    case STATE.POOL_PENDING: {
      // Nothing in flight and no pool address to look at: the state is already correct.
      if ((facts.poolStatus === "unchecked" || facts.poolStatus === "unavailable") && !opIsActive(lock) && lock.status !== STATE.RECOVERY_REQUIRED) {
        return { ...unchanged, lastVerification: { ...lastVerification, result: "nothing_pending" } };
      }
      if (facts.poolStatus === "verified") {
        return done(STATE.POOL_RUNNING, { poolId: facts.poolId || lock.poolId || op?.expectedPoolId, lpMint: facts.lpMint || lock.lpMint, poolSignature: op?.signature || lock.poolSignature }, { txState: TX.CONFIRMED }, "pool_found_on_chain");
      }
      if (facts.poolStatus === "emptied") {
        return done(STATE.RESOLVED, { poolId: facts.poolId || lock.poolId }, { txState: TX.CONFIRMED }, "pool_found_empty");
      }
      if (facts.poolStatus === "not_found" && provenNotSent) {
        return done(STATE.TOKEN_CREATED, {}, { txState: TX.FAILED, safeRetry: true }, "no_pool_exists");
      }
      if (facts.poolStatus === "not_found" && !op) return done(STATE.TOKEN_CREATED, {}, null, "no_pool_exists");
      return stuck(facts.poolStatus === "invalid" ? "pool_invalid" : "pool_unresolved", facts.message || "The pool's outcome couldn't be proven yet.");
    }
    case STATE.POOL_RUNNING: {
      if (facts.poolStatus === "verified") return done(STATE.POOL_RUNNING, { poolId: facts.poolId || lock.poolId }, null, "pool_verified");
      if (facts.poolStatus === "emptied") return done(STATE.RESOLVED, {}, null, "pool_emptied_on_chain");
      if (facts.poolStatus === "unavailable" || facts.poolStatus === "unchecked") return { ...unchanged, lastVerification: { ...lastVerification, result: "pool_unavailable" } };
      return stuck("pool_missing", facts.message || "The recorded pool couldn't be found on-chain.");
    }
    case STATE.REMOVAL_PENDING:
    case STATE.ADD_LIQUIDITY_PENDING: {
      const removing = phase === STATE.REMOVAL_PENDING;
      if (facts.poolStatus === "emptied") {
        return done(STATE.RESOLVED, { removeSignature: removing ? op?.signature || lock.removeSignature : lock.removeSignature }, { txState: TX.CONFIRMED }, "removal_verified_pool_empty");
      }
      if (facts.poolStatus === "verified") {
        if (sig === "confirmed") {
          if (removing && lpIsZero) {
            return done(STATE.RESOLVED, { removeSignature: op?.signature }, { txState: TX.CONFIRMED }, "removal_verified_position_zero");
          }
          return done(STATE.POOL_RUNNING, removing ? { removeSignature: op?.signature } : { addLiquiditySignature: op?.signature }, { txState: TX.CONFIRMED }, removing ? "partial_removal_confirmed" : "add_liquidity_confirmed");
        }
        if (provenNotSent) {
          return done(STATE.POOL_RUNNING, {}, { txState: TX.FAILED, safeRetry: true, needsRecheck: false }, "pool_and_position_intact");
        }
      }
      return stuck("operation_unresolved", facts.message || "The transaction's outcome couldn't be proven yet. Nothing can be retried until it is known.");
    }
    default:
      return unchanged;
  }
}

function inferPhase(lock) {
  if (!lock.mint) return STATE.TOKEN_RESERVED;
  if (!lock.poolId && !lock.op?.expectedPoolId) return STATE.TOKEN_CREATED;
  if (lock.op?.type === OP.REMOVE_LIQUIDITY) return STATE.REMOVAL_PENDING;
  if (lock.op?.type === OP.ADD_LIQUIDITY) return STATE.ADD_LIQUIDITY_PENDING;
  if (lock.poolId) return STATE.POOL_RUNNING;
  return STATE.POOL_PENDING;
}

// Applies a verification result. Refuses while a live operation holds the guard for this lock.
export function applyVerification(facts) {
  const data = load();
  const lock = data.lock;
  if (!lock || lock.status === STATE.RESOLVED) return { ok: false, reason: "no_active_lock" };
  if (guard && guard.lockId === lock.lockId) return { ok: false, reason: "operation_in_progress" };

  const decision = decide(lock, facts);
  const next = structuredCloneSafe(lock);
  next.lastVerification = decision.lastVerification;
  next.recovery = decision.recovery;
  Object.assign(next, decision.patch);
  if (decision.op) next.op = { ...next.op, ...decision.op, history: [...(next.op?.history || []), { txState: decision.op.txState || next.op?.txState, at: Date.now() }].slice(-20) };
  if (decision.status !== lock.status) stamp(next, decision.status, decision.reason);
  else next.updatedAt = Date.now();
  if (decision.status === STATE.RESOLVED) {
    next.resolvedAt = Date.now();
    next.op = next.op ? { ...next.op, txState: next.op.txState === TX.UNKNOWN ? TX.CONFIRMED : next.op.txState } : null;
  }
  save({ ...data, lock: next });
  return { ok: true, status: next.status, reason: decision.reason, lock: next };
}

function adoptToken({ wallet, mint, name, symbol, decimals }, data) {
  const now = Date.now();
  const lock = {
    lockId: newId(), cluster: CLUSTER, wallet, name, symbol, decimals: decimals ?? null, supply: null,
    mint, pendingMint: null, status: STATE.TOKEN_CREATED, poolId: null, lpMint: null,
    creationSignature: null, poolSignature: null, addLiquiditySignature: null, removeSignature: null,
    op: null, transitions: [], recovery: null, lastVerification: null, createdAt: now, updatedAt: now,
  };
  stamp(lock, STATE.TOKEN_CREATED, "existing token adopted for pool creation");
  data.history = data.lock ? [data.lock, ...data.history] : data.history;
  return lock;
}

// Adopt an unfinished launch saved by an earlier BALNEX version (per-wallet record) as the
// global lock, so upgrading can't leave a token outside the lock. No-op if a lock exists.
export function adoptLegacyLaunch(launch) {
  const data = load();
  if (data.corrupt || (data.lock && data.lock.status !== STATE.RESOLVED) || !launch?.mint) return null;
  const now = Date.now();
  const lock = {
    lockId: newId(),
    cluster: CLUSTER,
    wallet: launch.wallet,
    name: launch.name,
    symbol: launch.symbol,
    decimals: launch.decimals ?? null,
    supply: null,
    mint: launch.mint,
    pendingMint: null,
    status: launch.status === "liquidity_created" ? STATE.POOL_RUNNING : STATE.TOKEN_CREATED,
    poolId: launch.poolId || null,
    lpMint: launch.lpMint || null,
    creationSignature: launch.signature || null,
    poolSignature: launch.creationSignature || null,
    addLiquiditySignature: null,
    removeSignature: null,
    op: null,
    transitions: [],
    recovery: null,
    lastVerification: null,
    createdAt: launch.createdAt || now,
    updatedAt: now,
  };
  stamp(lock, lock.status, "adopted from earlier launch record");
  save({ ...data, lock });
  return lock;
}

// Test helper: simulate a page reload (guard and session are per page-load).
export function __resetGuardForTests() {
  guard = null;
  memory = null;
}
