// Dependency-free helpers that protect against double charges and verify fee payments.
// Kept free of Solana imports so they can be unit-tested in plain Node.
import { CLUSTER } from "../config";

const KEY = `balnex:fee-pending:v1:${CLUSTER}`;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // On-chain state still prevents a second charge; see isAlreadyHandled notes in Manage.
  }
}

// Remembered the moment a signed transaction is submitted, BEFORE confirmation, so a refresh
// or a slow confirmation can't lead the user into paying a second time.
export function savePending({ wallet, mint, kinds, signature, blockhash }) {
  write([{ wallet, mint, kinds, signature, blockhash, at: Date.now() }, ...read().filter((r) => r.signature !== signature)]);
}

export function getPending(wallet, mint) {
  return read().filter((r) => r.wallet === wallet && r.mint === mint);
}

export function clearPending(signature) {
  write(read().filter((r) => r.signature !== signature));
}

// Decides what a previously submitted transaction means for a new attempt.
//   status: entry from getSignatureStatuses (or null), blockhashValid: boolean | null
export function evaluatePending(status, blockhashValid) {
  if (status?.err) return "failed"; // landed and failed: nothing was charged
  if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
    return "confirmed"; // it went through: do NOT charge again
  }
  if (status) return "pending"; // processed, not yet confirmed
  if (blockhashValid === false) return "expired"; // can never land now
  return "pending"; // unknown or still valid: it could still land
}

// Finds the SystemProgram transfer of exactly `lamports` from `owner` to `treasury`
// inside a getParsedTransaction result. Works even if the treasury is the owner's own
// wallet (useful for Devnet tests), unlike a balance-delta check.
export function findFeeTransfer(parsedTx, owner, treasury, lamports) {
  const instructions = parsedTx?.transaction?.message?.instructions || [];
  return instructions.some((ix) => {
    const p = ix?.parsed;
    return (
      ix?.program === "system" &&
      p?.type === "transfer" &&
      p.info?.source === owner &&
      p.info?.destination === treasury &&
      String(p.info?.lamports) === String(lamports)
    );
  });
}
