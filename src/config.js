// Central network configuration.
// Defaults to Solana Devnet, exactly like the original project.
// Override with a .env file:
//   VITE_SOLANA_CLUSTER=devnet | mainnet
//   VITE_SOLANA_RPC=https://your-rpc-endpoint
import { clusterApiUrl } from "@solana/web3.js";

export const CLUSTER =
  import.meta.env.VITE_SOLANA_CLUSTER === "mainnet" ? "mainnet" : "devnet";

export const ENDPOINT =
  import.meta.env.VITE_SOLANA_RPC ||
  clusterApiUrl(CLUSTER === "mainnet" ? "mainnet-beta" : "devnet");

export const EXPLORER_SUFFIX = CLUSTER === "devnet" ? "?cluster=devnet" : "";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const LOCAL_TOKENS_KEY = `balnex:tokens:${CLUSTER}`;
export const LAST_POOL_KEY = `balnex:last-pool:${CLUSTER}`;
