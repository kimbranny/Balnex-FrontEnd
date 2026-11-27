import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { friendlyError } from "./utils";

// Reads the connected wallet's real SOL balance from the configured RPC.
// Updates on account changes (websocket) and re-checks every 30s as a fallback.
export function useSolBalance() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [lamports, setLamports] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setLamports(null);
      setError("");
      return;
    }

    setLoading(true);
    try {
      setLamports(await connection.getBalance(publicKey, "confirmed"));
      setError("");
    } catch (err) {
      console.error("Balance fetch error:", err);
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refresh();
    if (!publicKey) return undefined;

    let subscriptionId;
    try {
      subscriptionId = connection.onAccountChange(
        publicKey,
        (info) => {
          setLamports(info.lamports);
          setError("");
        },
        "confirmed"
      );
    } catch (err) {
      // Some RPC endpoints don't allow websockets; polling below still works.
      console.warn("Balance subscription unavailable:", err);
    }

    const timer = setInterval(refresh, 30000);

    return () => {
      clearInterval(timer);
      if (subscriptionId !== undefined) {
        connection.removeAccountChangeListener(subscriptionId).catch(() => {});
      }
    };
  }, [connection, publicKey, refresh]);

  return {
    sol: lamports === null ? null : lamports / LAMPORTS_PER_SOL,
    loading,
    error,
    refresh,
  };
}
