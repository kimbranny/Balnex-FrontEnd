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

// ---------------------------------------------------------------------------
// Service fees (authority revocation only). Change these here, or via .env.
//   VITE_AUTHORITY_FEE_SOL   price per authority revoked, in SOL (default 0.1)
//   VITE_TREASURY_WALLET     BALNEX treasury address that receives fees (no default)
//   VITE_ENABLE_MAINNET_FEES "true" to allow collecting fees on Mainnet (default off)
// There is deliberately NO default treasury address: until one is configured, paid
// revocation is disabled rather than sending funds to an invented address.
// ---------------------------------------------------------------------------
export const AUTHORITY_FEE_SOL = import.meta.env.VITE_AUTHORITY_FEE_SOL || "0.1";
export const TREASURY_WALLET = (import.meta.env.VITE_TREASURY_WALLET || "").trim();
export const MAINNET_FEES_ENABLED = import.meta.env.VITE_ENABLE_MAINNET_FEES === "true";
