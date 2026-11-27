// One unfinished token launch per wallet (per network).
//
// Persistence is client-side (localStorage) because BALNEX has no backend. Limitations:
// the record lives in this browser only, so clearing site data or using another browser
// forgets the lock. The chain is still checked where possible (see useActiveLaunch and
// the pool verification in lib/pools.js); stored state is never treated as proof of a pool.
//
// Lifecycle (the mint address is the one canonical key for a launch):
//   launch_pending    token created, pool not yet created          (LOCKED)
//   liquidity_created pool + initial liquidity verified on-chain   (LOCKED)
//   completed         liquidity fully removed, confirmed on-chain  (unlocked, kept as history)
//   abandoned         user gave up before creating a pool          (unlocked, kept as history)
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { CLUSTER } from "../config";

const KEY = `balnex:launches:v1:${CLUSTER}`;
const EVENT = "balnex:launches-changed";
const STALE_MINT_MS = 2 * 60 * 1000;

const RANK = { launch_pending: 1, liquidity_created: 2, abandoned: 3, completed: 3 };

// One record per (wallet, mint). Duplicates are merged: the most advanced lifecycle state
// wins, and fields missing from it are filled in from the others.
export function mergeLaunches(list) {
  const byKey = new Map();
  for (const record of list) {
    const key = `${record.wallet}:${record.mint}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, record);
      continue;
    }
    const [best, other] =
      (RANK[record.status] || 0) > (RANK[current.status] || 0) ||
      ((RANK[record.status] || 0) === (RANK[current.status] || 0) && (record.updatedAt || 0) > (current.updatedAt || 0))
        ? [record, current]
        : [current, record];
    const filled = { ...other, ...Object.fromEntries(Object.entries(best).filter(([, v]) => v !== undefined && v !== null)) };
    filled.createdAt = Math.min(record.createdAt || Infinity, current.createdAt || Infinity);
    byKey.set(key, filled);
  }
  return [...byKey.values()];
}

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list)
      ? mergeLaunches(list.filter((r) => r && r.mint && r.wallet && r.cluster === CLUSTER))
      : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Without storage the lock can't persist across refreshes; see limitations above.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function getActiveLaunch(wallet) {
  if (!wallet) return null;
  return (
    read()
      .filter((r) => r.wallet === wallet && (r.status === "launch_pending" || r.status === "liquidity_created"))
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null
  );
}

export function getLaunches(wallet) {
  return read().filter((r) => r.wallet === wallet);
}

// Application-level lock: refuses to record a second pending launch for the wallet.
// Returns { ok, launch }.
export function startLaunch({ wallet, mint, name, symbol, signature, decimals }) {
  const existing = getActiveLaunch(wallet);
  if (existing) return { ok: existing.mint === mint, launch: existing };

  const launch = {
    wallet,
    cluster: CLUSTER,
    mint,
    name,
    symbol,
    signature,
    decimals,
    status: "launch_pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const rest = read().filter((r) => !(r.wallet === wallet && r.mint === mint));
  write([launch, ...rest]);
  return { ok: true, launch };
}

function update(wallet, mint, patch, onlyFrom = ["launch_pending"]) {
  let changed = false;
  const next = read().map((r) => {
    if (r.wallet === wallet && r.mint === mint && onlyFrom.includes(r.status)) {
      changed = true;
      return { ...r, ...patch, updatedAt: Date.now() };
    }
    return r;
  });
  if (changed) write(next);
  return changed;
}

// Pool + initial liquidity verified on-chain. The wallet STAYS locked: the same record is
// updated in place (never a second record) and only liquidity removal unlocks it.
export function markLiquidityCreated(wallet, mint, details = {}) {
  return update(wallet, mint, { status: "liquidity_created", poolType: "Raydium CPMM", ...details, liquidityCreatedAt: Date.now() });
}

// Call ONLY after a removal transaction is confirmed on-chain and the wallet's LP position
// for the pool has been read back as zero (or the pool is verifiably empty).
export function markLiquidityRemoved(wallet, mint, removalSignature, extra = {}) {
  return update(
    wallet,
    mint,
    { status: "completed", removalSignature: removalSignature || null, removalStatus: "confirmed", removedAt: Date.now(), ...extra },
    ["liquidity_created"]
  );
}

// Abandoning is only possible before a pool exists.
export function abandonLaunch(wallet, mint, extra = {}) {
  return update(wallet, mint, { status: "abandoned", abandonedAt: Date.now(), ...extra }, ["launch_pending"]);
}

// All launch records for a wallet (one per mint), reactive to changes.
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
  return useMemo(() => (wallet ? getLaunches(wallet) : []), [wallet, version]);
}

export function useActiveLaunch(wallet) {
  const { connection } = useConnection();
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

  const launch = useMemo(() => getActiveLaunch(wallet), [wallet, version]);

  // Chain check: a pending launch whose mint definitively doesn't exist can't be continued.
  // Only released if the record is old enough to rule out RPC lag; RPC errors keep the lock.
  useEffect(() => {
    if (!launch || launch.status !== "launch_pending") return undefined;
    let cancelled = false;
    (async () => {
      try {
        const info = await connection.getAccountInfo(new PublicKey(launch.mint), "confirmed");
        if (!cancelled && !info && Date.now() - launch.createdAt > STALE_MINT_MS) {
          abandonLaunch(launch.wallet, launch.mint, { reason: "mint_not_found_on_chain" });
        }
      } catch {
        // Keep the lock when the chain can't be reached.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, launch?.mint, launch?.wallet]);

  return launch;
}
