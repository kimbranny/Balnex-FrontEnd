import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { friendlyError, loadLocalTokens } from "./utils";

// Loads every SPL token account owned by the connected wallet, plus the
// mint / freeze authority of each mint, so the UI can manage and revoke them.
export function useWalletTokens() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setTokens([]);
      setError("");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      const balances = new Map();
      for (const { account } of accounts.value) {
        const info = account.data.parsed.info;
        const existing = balances.get(info.mint);
        const raw = BigInt(info.tokenAmount.amount);
        balances.set(info.mint, {
          mint: info.mint,
          decimals: info.tokenAmount.decimals,
          raw: (existing?.raw ?? 0n) + raw,
        });
      }

      const mints = [...balances.keys()];
      const mintAccounts = mints.length
        ? await connection.getMultipleParsedAccounts(mints.map((m) => new PublicKey(m)))
        : { value: [] };

      const local = loadLocalTokens();

      const result = mints.map((mint, index) => {
        const parsed = mintAccounts.value[index]?.data?.parsed?.info;
        const balance = balances.get(mint);
        return {
          mint,
          decimals: balance.decimals,
          raw: balance.raw,
          uiAmount: Number(balance.raw) / 10 ** balance.decimals,
          supply: parsed?.supply ?? null,
          mintAuthority: parsed?.mintAuthority ?? null,
          freezeAuthority: parsed?.freezeAuthority ?? null,
          name: local[mint]?.name || "",
          symbol: local[mint]?.symbol || "",
        };
      });

      setTokens(result);
    } catch (err) {
      console.error("Failed to load wallet tokens:", err);
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tokens, loading, error, refresh };
}
