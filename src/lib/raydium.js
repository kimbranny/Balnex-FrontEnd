// Raydium CPMM helpers.
//
// The SDK is loaded lazily so the rest of the app (token creation, management,
// trending) keeps working even if the SDK fails to load in a given browser/build.
//
// The SDK only BUILDS the transaction here. Signing, sending, confirming and
// verifying are done by ./txRunner so every failure reports the exact stage.
import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { CLUSTER, WSOL_MINT } from "../config";
import { getLifecycleLock } from "./lifecycleLock";
import { StageError } from "./txRunner";

let cached = { key: "", promise: null };

export async function loadRaydium({ connection, publicKey, signAllTransactions }) {
  if (!publicKey) {
    throw new StageError("prepare", "Connect your wallet first.", { submitted: false });
  }

  const key = `${CLUSTER}:${publicKey.toBase58()}`;
  if (cached.key === key && cached.promise) return cached.promise;

  const promise = (async () => {
    const { Raydium } = await import("@raydium-io/raydium-sdk-v2");
    return Raydium.load({
      owner: publicKey,
      connection,
      cluster: CLUSTER,
      // Only used by the SDK's own execute(); BALNEX signs transactions itself.
      signAllTransactions,
      disableLoadToken: true,
      disableFeatureCheck: true,
      blockhashCommitment: "confirmed",
    });
  })();

  cached = { key, promise };
  promise.catch(() => {
    if (cached.promise === promise) cached = { key: "", promise: null };
  });
  return promise;
}

// Reads the mint from the chain: confirms it exists, which token program owns it,
// and its real decimals (never assumed).
export async function readMint(connection, mintAddress) {
  let mint;
  try {
    mint = new PublicKey(mintAddress);
  } catch {
    throw new StageError("prepare", "That token address isn't valid.", { submitted: false });
  }

  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    throw new StageError(
      "prepare",
      `This token's mint account wasn't found on Solana ${CLUSTER}. Make sure your wallet is on the same network the token was created on.`,
      { submitted: false }
    );
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new StageError("prepare", "That address isn't an SPL token mint.", { submitted: false });
  }

  const parsed = await getMint(connection, mint, "confirmed", info.owner);
  return {
    mint: mintAddress,
    decimals: parsed.decimals,
    programId: info.owner.toBase58(),
    supply: parsed.supply,
  };
}

function apiToken({ address, decimals, programId, symbol = "", name = "" }) {
  return {
    chainId: CLUSTER === "devnet" ? 103 : 101,
    address,
    programId,
    decimals,
    symbol,
    name: name || symbol,
    logoURI: "",
    tags: [],
    extensions: {},
  };
}

const wsolToken = () =>
  apiToken({
    address: WSOL_MINT,
    decimals: 9,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    symbol: "WSOL",
    name: "Wrapped SOL",
  });

// Builds (does not send) the create-pool transaction.
export async function prepareCreatePool(raydium, { mintInfo, tokenRaw, solRaw, legacy = false }) {
  const lock = getLifecycleLock();
  if (!lock || lock.cluster !== CLUSTER || lock.mint !== mintInfo.mint || !["TOKEN_CREATED", "POOL_PENDING", "RECOVERY_REQUIRED"].includes(lock.status)) {
    throw new StageError("prepare", "Pool creation is blocked: this mint is not the token authorized by BALNEX's global lifecycle lock.", { submitted: false, mint: mintInfo.mint, lockStatus: lock?.status || "UNLOCKED" });
  }
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  const isDevnet = CLUSTER === "devnet";

  const programId = isDevnet ? sdk.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : sdk.CREATE_CPMM_POOL_PROGRAM;
  const poolFeeAccount = isDevnet ? sdk.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC : sdk.CREATE_CPMM_POOL_FEE_ACC;

  let feeConfigs;
  try {
    feeConfigs = await raydium.api.getCpmmConfigs();
  } catch (err) {
    throw new StageError(
      "prepare",
      `Couldn't load Raydium's fee configuration (${err?.message || "network error"}). Try again in a moment.`,
      { submitted: false, cause: err }
    );
  }
  if (!Array.isArray(feeConfigs) || feeConfigs.length === 0) {
    throw new StageError("prepare", "Raydium returned no fee configurations for this network.", { submitted: false });
  }

  if (isDevnet) {
    // Devnet uses its own program, so each config account id must be re-derived for it.
    feeConfigs.forEach((config) => {
      config.id = sdk.getCpmmPdaAmmConfigId(programId, config.index).publicKey.toBase58();
    });
  }
  const feeConfig = feeConfigs.find((config) => config.index === 0) || feeConfigs[0];

  let built;
  try {
    built = await raydium.cpmm.createPool({
      programId,
      poolFeeAccount,
      mintA: apiToken({ address: mintInfo.mint, decimals: mintInfo.decimals, programId: mintInfo.programId }),
      mintB: wsolToken(),
      mintAAmount: new BN(tokenRaw.toString()),
      mintBAmount: new BN(solRaw.toString()),
      startTime: new BN(0),
      feeConfig,
      associatedOnly: false,
      ownerInfo: { useSOLBalance: true },
      txVersion: legacy ? sdk.TxVersion.LEGACY : sdk.TxVersion.V0,
    });
  } catch (err) {
    throw new StageError("prepare", `Raydium couldn't build the pool transaction: ${err?.message || err}`, {
      submitted: false,
      cause: err,
    });
  }

  const address = built.extInfo?.address || {};
  return {
    built,
    programId: programId.toBase58(),
    poolId: address.poolId?.toBase58?.() || "",
    lpMint: address.lpMint?.toBase58?.() || "",
    createPoolFeeLamports: Number(feeConfig.createPoolFee ?? 0) || 0,
  };
}

export async function fetchPool(raydium, poolId) {
  // Throws a readable error for malformed ids before touching the network.
  new PublicKey(poolId);
  const data = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  if (!data?.poolInfo) throw new Error("Pool not found on this network.");
  return data;
}

export async function prepareAddLiquidity(raydium, { poolInfo, poolKeys, poolId, mint, amountRaw, baseIn, slippagePercent }) {
  const lock = getLifecycleLock();
  if (!lock || lock.cluster !== CLUSTER || lock.mint !== mint || (lock.poolId && lock.poolId !== poolId) || !["POOL_RUNNING", "ADD_LIQUIDITY_PENDING", "RECOVERY_REQUIRED"].includes(lock.status)) {
    throw new StageError("prepare", "Adding liquidity is blocked because this pool does not match the active global token lifecycle.", { submitted: false, poolId, mint, lockStatus: lock?.status || "UNLOCKED" });
  }
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  try {
    return await raydium.cpmm.addLiquidity({
      poolInfo,
      poolKeys,
      inputAmount: new BN(amountRaw.toString()),
      baseIn,
      slippage: new sdk.Percent(Math.round(slippagePercent * 100), 10000),
      txVersion: sdk.TxVersion.V0,
    });
  } catch (err) {
    throw new StageError("prepare", `Raydium couldn't build the add-liquidity transaction: ${err?.message || err}`, {
      submitted: false,
      cause: err,
    });
  }
}

export async function prepareRemoveLiquidity(raydium, { poolInfo, poolKeys, poolId, mint, lpRaw, slippagePercent }) {
  const lock = getLifecycleLock();
  if (!lock || lock.cluster !== CLUSTER || lock.mint !== mint || (lock.poolId && lock.poolId !== poolId) || !["POOL_RUNNING", "REMOVAL_PENDING", "RECOVERY_REQUIRED"].includes(lock.status)) {
    throw new StageError("prepare", "Liquidity removal is blocked because this pool does not match the active global token lifecycle.", { submitted: false, poolId, mint, lockStatus: lock?.status || "UNLOCKED" });
  }
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  try {
    return await raydium.cpmm.withdrawLiquidity({
      poolInfo,
      poolKeys,
      lpAmount: new BN(lpRaw.toString()),
      slippage: new sdk.Percent(Math.round(slippagePercent * 100), 10000),
      txVersion: sdk.TxVersion.V0,
    });
  } catch (err) {
    throw new StageError("prepare", `Raydium couldn't build the remove-liquidity transaction: ${err?.message || err}`, {
      submitted: false,
      cause: err,
    });
  }
}
