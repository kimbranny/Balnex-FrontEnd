// Authority revocation fee logic. All amounts are integers in lamports (BigInt).
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AuthorityType, createSetAuthorityInstruction } from "@solana/spl-token";
import { AUTHORITY_FEE_SOL, CLUSTER, MAINNET_FEES_ENABLED, TREASURY_WALLET } from "../config";
import { StageError } from "./txRunner";
import { toRawUnits } from "./utils";

export const AUTHORITIES = {
  mint: {
    id: "mint",
    label: "Mint authority",
    type: AuthorityType.MintTokens,
    field: "mintAuthority",
    explain: "Permanently stops anyone, including you, from minting more of this token.",
    supported: true,
  },
  freeze: {
    id: "freeze",
    label: "Freeze authority",
    type: AuthorityType.FreezeAccount,
    field: "freezeAuthority",
    explain: "Permanently removes the power to freeze holders' token accounts.",
    supported: true,
  },
  update: {
    id: "update",
    label: "Update authority",
    type: null,
    field: null,
    explain: "Controls token metadata. BALNEX tokens don't use on-chain metadata, so there's nothing to revoke here.",
    supported: false,
  },
};

export const FEE_PER_AUTHORITY_LAMPORTS = toRawUnits(AUTHORITY_FEE_SOL, 9);

export function calcFee(kinds, perAuthority = FEE_PER_AUTHORITY_LAMPORTS) {
  // A Set guarantees an authority can never be counted twice.
  const unique = [...new Set(kinds)].filter((k) => AUTHORITIES[k]?.supported);
  return { kinds: unique, count: unique.length, total: perAuthority * BigInt(unique.length) };
}

// Fees can be collected only with a valid treasury, and never on Mainnet unless enabled.
export function feeStatus() {
  if (CLUSTER !== "devnet" && !MAINNET_FEES_ENABLED) {
    return { ok: false, reason: "Paid revocation is disabled on Mainnet until fees are explicitly enabled." };
  }
  if (!TREASURY_WALLET) {
    return {
      ok: false,
      reason: "No treasury wallet is configured. Set VITE_TREASURY_WALLET to enable paid revocation.",
    };
  }
  try {
    return { ok: true, treasury: new PublicKey(TREASURY_WALLET) };
  } catch {
    return { ok: false, reason: "The configured treasury wallet address is not a valid Solana address." };
  }
}

// ONE transaction: the selected setAuthority instructions + the fee transfer.
// If any instruction fails, the whole transaction fails and the fee is not charged.
export function buildRevocationInstructions({ owner, mint, programId, kinds, treasury, feeLamports }) {
  const instructions = kinds.map((kind) =>
    createSetAuthorityInstruction(mint, owner, AUTHORITIES[kind].type, null, [], programId)
  );
  if (feeLamports > 0n) {
    instructions.push(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: treasury, lamports: feeLamports })
    );
  }
  return instructions;
}

// Confirms from the confirmed transaction that the treasury really received the fee.
export async function verifyFeePaid(connection, signature, treasury, feeLamports) {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) {
    throw new StageError("verification", "Couldn't read the confirmed transaction to verify the fee.", {
      submitted: true,
      signature,
    });
  }
  if (tx.meta.err) {
    throw new StageError("verification", "The transaction reported an error, so the fee was not collected.", {
      submitted: true,
      signature,
    });
  }
  const keys = tx.transaction.message.getAccountKeys();
  let index = -1;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys.get(i).equals(treasury)) {
      index = i;
      break;
    }
  }
  const received = index >= 0 ? BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]) : 0n;
  if (received !== feeLamports) {
    throw new StageError("verification", `The treasury received ${received} lamports, expected ${feeLamports}.`, {
      submitted: true,
      signature,
    });
  }
  return received;
}
