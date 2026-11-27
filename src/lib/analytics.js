// Read-only on-chain analytics: live pool vault balances and unique token holders.
// Nothing here builds a transaction, asks the wallet to sign, or changes any state.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CLUSTER, WSOL_MINT } from "../config";
import { aggregateHolders, parsePoolState, parseTokenAccountSlice } from "./analyticsCodec";

const b58 = (bytes) => new PublicKey(bytes).toBase58();

export async function getCpmmProgramId() {
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  return CLUSTER === "devnet" ? sdk.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : sdk.CREATE_CPMM_POOL_PROGRAM;
}

// Reads the CURRENT balances of the two vault token accounts that belong to this pool.
// Each vault is cross-checked against the pool's own on-chain state before being trusted.
export async function fetchPoolReserves(connection, { poolId, tokenMint }) {
  const programId = await getCpmmProgramId();
  const poolKey = new PublicKey(poolId);

  const poolAccount = await connection.getAccountInfo(poolKey, "confirmed");
  if (!poolAccount) throw new Error("The pool account was not found on this network.");
  if (!poolAccount.owner.equals(programId)) throw new Error("This address is not a Raydium CPMM pool on this network.");

  const state = parsePoolState(poolAccount.data, b58);
  const [authority] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault_and_lp_mint_auth_seed")], programId);

  const sides = [
    { vault: state.token0Vault, mint: state.token0Mint },
    { vault: state.token1Vault, mint: state.token1Mint },
  ];
  const mints = sides.map((s) => s.mint);
  if (!mints.includes(WSOL_MINT) || !mints.includes(tokenMint)) {
    throw new Error("The pool's mints don't match this token and SOL, so reserves can't be shown safely.");
  }

  const vaults = await connection.getMultipleParsedAccounts(sides.map((s) => new PublicKey(s.vault)), {
    commitment: "confirmed",
  });

  const out = {};
  sides.forEach((side, i) => {
    const parsed = vaults.value[i]?.data?.parsed?.info;
    if (!parsed) throw new Error("A pool vault account couldn't be read.");
    if (parsed.mint !== side.mint) throw new Error("A vault holds a different token than the pool state says.");
    if (parsed.owner !== authority.toBase58()) throw new Error("A vault isn't controlled by this pool's authority.");
    const entry = {
      vault: side.vault,
      raw: BigInt(parsed.tokenAmount.amount),
      decimals: parsed.tokenAmount.decimals,
    };
    if (side.mint === WSOL_MINT) out.sol = entry;
    else out.token = entry;
  });

  if (!out.token || !out.sol) throw new Error("Couldn't match both pool vaults.");
  return { ...out, lpMint: state.lpMint, fetchedAt: Date.now() };
}

// Unique holders with a positive balance, counted by OWNER (not token account), across both
// token programs. Uses the connected RPC's getProgramAccounts; many public RPCs refuse this
// for large tokens, in which case the caller shows "unavailable" rather than a guess.
export async function fetchHolders(connection, mint) {
  const mintKey = new PublicKey(mint);
  const info = await connection.getAccountInfo(mintKey, "confirmed");
  if (!info) throw new Error("The mint account was not found on this network.");

  let programId;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) programId = TOKEN_PROGRAM_ID;
  else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) programId = TOKEN_2022_PROGRAM_ID;
  else throw new Error("This address isn't an SPL token mint.");

  const filters = [{ memcmp: { offset: 0, bytes: mint } }];
  if (programId.equals(TOKEN_PROGRAM_ID)) filters.unshift({ dataSize: 165 });

  const [accounts, supply] = await Promise.all([
    connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters,
      dataSlice: { offset: 32, length: 40 },
    }),
    connection.getTokenSupply(mintKey, "confirmed"),
  ]);

  const parsed = accounts.map(({ account }) => parseTokenAccountSlice(account.data, b58));
  // Owners that are off the ed25519 curve are program-derived (e.g. pool vault authorities).
  const summary = aggregateHolders(parsed, (owner) => !PublicKey.isOnCurve(new PublicKey(owner).toBytes()));

  return {
    ...summary,
    supplyRaw: BigInt(supply.value.amount),
    decimals: supply.value.decimals,
    tokenProgram: programId.toBase58(),
    fetchedAt: Date.now(),
  };
}
