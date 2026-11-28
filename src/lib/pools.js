// Pool records + on-chain verification.
//
// Records in localStorage are only a *list of things to check*. They are never trusted:
// every record is re-verified against the chain (pool account, program owner, creation
// transaction, reserves, and the connected wallet's LP balance) before the UI unlocks
// anything for it.
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, WSOL_MINT } from "../config";
import { fetchPool } from "./raydium";

const KEY = `balnex:pools:v1:${CLUSTER}`;

// One pool record per (owner, mint). If duplicates exist (older data, retries), they are merged
// into a single record, preferring the one that carries the successful pool data
// (creation signature + LP mint), then the newest.
export function mergePoolRecords(list) {
  const score = (r) => (r.signature ? 2 : 0) + (r.lpMint ? 1 : 0);
  const byKey = new Map();
  for (const record of list) {
    const key = `${record.owner}:${record.mint || record.poolId}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, record);
      continue;
    }
    const [best, other] =
      score(record) > score(current) || (score(record) === score(current) && (record.createdAt || 0) > (current.createdAt || 0))
        ? [record, current]
        : [current, record];
    byKey.set(key, { ...other, ...Object.fromEntries(Object.entries(best).filter(([, v]) => v !== undefined && v !== null)) });
  }
  return [...byKey.values()];
}

export function loadPoolRecords() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list)
      ? mergePoolRecords(list.filter((r) => r && r.poolId && r.owner && r.cluster === CLUSTER))
      : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Persistence is a convenience; the chain remains the source of truth.
  }
}

export function savePoolRecord(record) {
  // The mint is the canonical key: saving a pool for a mint updates that mint's record.
  write(mergePoolRecords([record, ...loadPoolRecords()]));
}

export function deletePoolRecord(poolId, owner) {
  write(loadPoolRecords().filter((r) => !(r.poolId === poolId && r.owner === owner)));
}

// status: verified | not_found | invalid | error
export async function verifyPool({ connection, getRaydium, record, owner }) {
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  const programId =
    CLUSTER === "devnet" ? sdk.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : sdk.CREATE_CPMM_POOL_PROGRAM;

  let poolKey;
  try {
    poolKey = new PublicKey(record.poolId);
  } catch {
    return { status: "invalid", message: "The stored pool address isn't a valid address." };
  }

  try {
    const account = await connection.getAccountInfo(poolKey, "confirmed");
    if (!account) {
      return { status: "not_found", message: `No pool account exists at this address on Solana ${CLUSTER}.` };
    }
    if (!account.owner.equals(programId)) {
      return { status: "invalid", message: "This address exists but isn't a Raydium CPMM pool on this network." };
    }

    let txStatus = "unavailable";
    if (record.signature) {
      const { value } = await connection.getSignatureStatuses([record.signature], { searchTransactionHistory: true });
      const st = value[0];
      if (st?.err) return { status: "invalid", message: "The recorded creation transaction failed on-chain." };
      if (st?.confirmationStatus) txStatus = st.confirmationStatus;
    }

    const raydium = await getRaydium();
    const data = await fetchPool(raydium, record.poolId);
    const { poolInfo } = data;

    const addresses = [poolInfo.mintA.address, poolInfo.mintB.address];
    if (!addresses.includes(WSOL_MINT) || (record.mint && !addresses.includes(record.mint))) {
      return { status: "invalid", message: "This pool isn't the Token/SOL pair recorded for it." };
    }

    const solIsA = poolInfo.mintA.address === WSOL_MINT;
    const reserves = {
      token: Number(solIsA ? poolInfo.mintAmountB : poolInfo.mintAmountA),
      sol: Number(solIsA ? poolInfo.mintAmountA : poolInfo.mintAmountB),
    };
    const lpMint = poolInfo.lpMint.address;
    const [accounts, supply] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(lpMint) }),
      connection.getTokenSupply(new PublicKey(lpMint), "confirmed"),
    ]);
    const lpRaw = accounts.value.reduce(
      (total, { account: a }) => total + BigInt(a.data.parsed.info.tokenAmount.amount),
      0n
    );

    const base = {
      txStatus,
      poolInfo,
      poolKeys: data.poolKeys,
      lpMint,
      lpDecimals: poolInfo.lpMint.decimals,
      lpRaw,
      lpSupply: BigInt(supply.value.amount),
      lpTokenAccounts: accounts.value.map(({ pubkey, account }) => ({
        address: pubkey.toBase58(),
        tokenProgramId: account.owner.toBase58(),
        rawAmount: account.data.parsed.info.tokenAmount.amount,
        decimals: account.data.parsed.info.tokenAmount.decimals,
      })),
      reserves,
      tokenSymbol: (solIsA ? poolInfo.mintB : poolInfo.mintA).symbol || "",
      checkedAt: Date.now(),
    };

    // A pool with no reserves has been fully drained (e.g. after all liquidity was removed).
    if (!(reserves.token > 0 && reserves.sol > 0)) {
      return { status: "emptied", message: "All liquidity has been removed from this pool.", ...base };
    }
    return { status: "verified", ...base };
  } catch (err) {
    console.error("[BALNEX] pool verification error", err);
    return { status: "error", message: `Couldn't verify this pool right now: ${err?.message || err}` };
  }
}
