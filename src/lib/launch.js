// One unfinished token launch per wallet (per network).
//
// Persistence is client-side (localStorage) because BALNEX has no backend. Limitations:
// the record lives in this browser only, so clearing site data or using another browser
// forgets the lock. The chain is still checked where possible (see useActiveLaunch and
// the pool verification in lib/pools.js); stored state is never treated as proof of a pool.
//
// Statuses: launch_pending -> completed | abandoned
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { CLUSTER } from "../config";

const KEY = `balnex:launches:v1:${CLUSTER}`;
const EVENT = "balnex:launches-changed";
const STALE_MINT_MS = 2 * 60 * 1000;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((r) => r && r.mint && r.wallet && r.cluster === CLUSTER) : [];
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
      .filter((r) => r.wallet === wallet && r.status === "launch_pending")
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

function update(wallet, mint, patch, onlyFrom = "launch_pending") {
  let changed = false;
  const next = read().map((r) => {
    if (r.wallet === wallet && r.mint === mint && r.status === onlyFrom) {
      changed = true;
      return { ...r, ...patch, updatedAt: Date.now() };
    }
    return r;
  });
  if (changed) write(next);
  return changed;
}

// Call only after the pool is verified on-chain with liquidity (lib/pools.js verifyPool).
export function completeLaunch(wallet, mint, poolId) {
  return update(wallet, mint, { status: "completed", poolId, completedAt: Date.now() });
}

export function abandonLaunch(wallet, mint, extra = {}) {
  return update(wallet, mint, { status: "abandoned", abandonedAt: Date.now(), ...extra });
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
    if (!launch) return undefined;
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
