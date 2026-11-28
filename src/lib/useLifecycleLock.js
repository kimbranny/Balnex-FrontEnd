import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { verifyLifecycle } from "./lifecycleChain";
import { getLock, isStorageCorrupt, LOCK_EVENT } from "./lifecycleLock";

// Reactive view of the global lock. The authority is always storage (read on every render),
// never component state, so it is identical on every page.
export function useLifecycleLock() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(LOCK_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(LOCK_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return { lock: getLock(), corrupt: isStorageCorrupt() };
}

// Re-checks the lock against the chain. Used on startup, on returning to the Liquidity page,
// after any failed/unknown transaction, and by the VERIFY STATUS button.
export function useVerifyLifecycle() {
  const { connection } = useConnection();
  const { signAllTransactions } = useWallet();
  const [checking, setChecking] = useState(false);

  const verify = useCallback(async () => {
    setChecking(true);
    try {
      return await verifyLifecycle({ connection, signAllTransactions });
    } catch (err) {
      console.error("[BALNEX] lifecycle verification failed", err);
      return { ok: false, reason: "verification_error" };
    } finally {
      setChecking(false);
    }
  }, [connection, signAllTransactions]);

  return { verify, checking };
}
