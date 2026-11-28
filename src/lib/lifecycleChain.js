// Reads the facts lifecycleLock.decide() needs from Solana. Nothing here signs or sends.
// Stored lock data is only a list of things to check; the chain is the source of truth.
import { PublicKey } from "@solana/web3.js";
import { applyVerification, getLock, isOperationRunning, opIsActive } from "./lifecycleLock";
import { loadRaydium } from "./raydium";
import { verifyPool } from "./pools";

// 'none' | 'confirmed' | 'failed' | 'expired_unlanded' | 'pending' | 'unavailable'
// 'expired_unlanded' = the signature isn't on-chain AND its blockhash is no longer valid, so
// the transaction can never land. Only then is it PROVEN that it did not succeed.
export async function signatureOutcome(connection, signature, blockhash) {
  if (!signature && !blockhash) return "none";
  try {
    const read = async () =>
      signature ? (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] : null;
    const status = await read();
    if (status) {
      if (status.err) return "failed";
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return "confirmed";
      return "pending";
    }
    if (!blockhash) return "pending"; // can't prove expiry without the blockhash
    const valid = await connection.isBlockhashValid(blockhash, { commitment: "confirmed" });
    if (valid?.value !== false) return "pending";
    const again = await read(); // re-check after expiry: it could have landed just before
    if (again) return again.err ? "failed" : again.confirmationStatus ? "confirmed" : "pending";
    return "expired_unlanded";
  } catch {
    return "unavailable";
  }
}

export async function collectFacts({ connection, lock, owner, getRaydium }) {
  const facts = { at: Date.now(), rpcAvailable: false, mintExists: null, sigOutcome: "none", poolStatus: "unchecked" };
  try {
    await connection.getSlot("confirmed");
    facts.rpcAvailable = true;
  } catch {
    return facts;
  }

  const op = lock.op || null;
  const mint = lock.mint || lock.pendingMint;
  if (mint) {
    try {
      const info = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
      facts.mintExists = !!info;
    } catch {
      facts.mintExists = null;
    }
  }

  // The signature that matters is the one of the operation that may still be unresolved.
  // With no signature recorded but the op possibly sent, only the blockhash's expiry can prove it never landed.
  const sig = op?.signature || null;
  const unsettled = op && op.txState !== "confirmed" && op.txState !== "failed";
  const pendingLiquidity = lock.status === "REMOVAL_PENDING" || lock.status === "ADD_LIQUIDITY_PENDING";
  if (sig && (unsettled || pendingLiquidity)) {
    facts.sigOutcome = await signatureOutcome(connection, sig, op.blockhash);
  } else if (!sig && unsettled && op.maybeSubmitted && op.blockhash) {
    facts.sigOutcome = await signatureOutcome(connection, null, op.blockhash);
  }

  const poolId = lock.poolId || op?.expectedPoolId;
  if (poolId) {
    const result = await verifyPool({
      connection,
      owner: owner ? new PublicKey(owner) : new PublicKey(lock.wallet),
      record: { poolId, mint: lock.mint, owner: lock.wallet, signature: null },
      getRaydium,
    });
    facts.poolId = poolId;
    facts.message = result.message;
    if (result.status === "verified" || result.status === "emptied") {
      facts.poolStatus = result.status;
      facts.lpMint = result.lpMint;
      facts.lpRaw = result.lpRaw;
      facts.reserves = result.reserves;
    } else if (result.status === "not_found" || result.status === "invalid") {
      facts.poolStatus = result.status;
    } else {
      facts.poolStatus = "unavailable";
    }
  }
  return facts;
}

// Re-check the lock against the chain and apply the outcome. Safe to call repeatedly; it
// does nothing while an operation is running in this page. Never unlocks without proof.
// The LP position is always read for the wallet that owns the lock (not whichever wallet is
// connected now), so switching wallets can never fake an empty position.
export async function verifyLifecycle({ connection, signAllTransactions }) {
  const lock = getLock();
  if (!lock) return { ok: true, status: "UNLOCKED" };
  if (isOperationRunning() && opIsActive(lock)) return { ok: false, reason: "operation_in_progress", lock };

  const wallet = lock.wallet;
  const facts = await collectFacts({
    connection,
    lock,
    owner: wallet,
    getRaydium: () => loadRaydium({ connection, publicKey: new PublicKey(wallet), signAllTransactions }),
  });
  return applyVerification(facts);
}
