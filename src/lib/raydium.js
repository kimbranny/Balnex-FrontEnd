// Raydium CPMM helpers.
//
// The SDK is loaded lazily so the rest of the app (token creation, management,
// trending) keeps working even if the SDK fails to load in a given browser/build.
//
// NOTE: written against the official CPMM demos (createPool / addLiquidity /
// withdrawLiquidity). Wiring the SDK to a browser wallet (owner + signAllTransactions)
// is not covered by the public docs, so verify it on Devnet before relying on it.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { CLUSTER, WSOL_MINT } from "../config";

let cached = { key: "", promise: null };

export async function loadRaydium({ connection, publicKey, signAllTransactions }) {
  if (!publicKey || !signAllTransactions) {
    throw new Error("Connect a wallet that supports transaction signing first.");
  }

  const key = `${CLUSTER}:${publicKey.toBase58()}`;
  if (cached.key === key && cached.promise) return cached.promise;

  const promise = (async () => {
    const { Raydium } = await import("@raydium-io/raydium-sdk-v2");
    return Raydium.load({
      owner: publicKey,
      connection,
      cluster: CLUSTER,
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

export function tokenInfo(address, decimals) {
  return { address, programId: TOKEN_PROGRAM_ID.toBase58(), decimals };
}

export const wsolInfo = () => tokenInfo(WSOL_MINT, 9);

export async function createCpmmPool(raydium, { mint, mintDecimals, tokenRaw, solRaw }) {
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  const isDevnet = CLUSTER === "devnet";

  const feeConfigs = await raydium.api.getCpmmConfigs();
  if (isDevnet) {
    // Devnet uses its own program, so config account ids must be re-derived.
    feeConfigs.forEach((config) => {
      config.id = sdk
        .getCpmmPdaAmmConfigId(sdk.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, config.index)
        .publicKey.toBase58();
    });
  }

  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: isDevnet
      ? sdk.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM
      : sdk.CREATE_CPMM_POOL_PROGRAM,
    poolFeeAccount: isDevnet
      ? sdk.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC
      : sdk.CREATE_CPMM_POOL_FEE_ACC,
    mintA: tokenInfo(mint, mintDecimals),
    mintB: wsolInfo(),
    mintAAmount: new BN(tokenRaw.toString()),
    mintBAmount: new BN(solRaw.toString()),
    startTime: new BN(0),
    feeConfig: feeConfigs[0],
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: sdk.TxVersion.V0,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  return { txId, poolId: extInfo.address.poolId.toBase58() };
}

export async function fetchPool(raydium, poolId) {
  // Throws a readable error for malformed ids before touching the network.
  new PublicKey(poolId);
  const data = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  if (!data?.poolInfo) throw new Error("Pool not found on this network.");
  return data;
}

export async function addCpmmLiquidity(raydium, { poolInfo, poolKeys, amountRaw, baseIn, slippagePercent }) {
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  const { execute } = await raydium.cpmm.addLiquidity({
    poolInfo,
    poolKeys,
    inputAmount: new BN(amountRaw.toString()),
    baseIn,
    slippage: new sdk.Percent(Math.round(slippagePercent * 100), 10000),
    txVersion: sdk.TxVersion.V0,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  return { txId };
}

export async function removeCpmmLiquidity(raydium, { poolInfo, poolKeys, lpRaw, slippagePercent }) {
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  const { execute } = await raydium.cpmm.withdrawLiquidity({
    poolInfo,
    poolKeys,
    lpAmount: new BN(lpRaw.toString()),
    slippage: new sdk.Percent(Math.round(slippagePercent * 100), 10000),
    txVersion: sdk.TxVersion.V0,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  return { txId };
}
