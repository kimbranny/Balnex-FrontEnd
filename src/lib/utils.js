import { EXPLORER_SUFFIX, LOCAL_TOKENS_KEY } from "../config";

export function shorten(value, head = 4, tail = 4) {
  if (!value) return "";
  const text = String(value);
  return text.length <= head + tail + 3 ? text : `${text.slice(0, head)}...${text.slice(-tail)}`;
}

export function explorerAddress(address) {
  return `https://explorer.solana.com/address/${address}${EXPLORER_SUFFIX}`;
}

export function explorerTx(signature) {
  return `https://explorer.solana.com/tx/${signature}${EXPLORER_SUFFIX}`;
}

// Turns raw wallet / RPC errors into short, readable messages.
export function friendlyError(error) {
  const raw = String(error?.message || error || "");
  const text = raw.toLowerCase();

  if (text.includes("user rejected") || text.includes("rejected the request") || text.includes("declined")) {
    return "You cancelled the request in your wallet. Nothing was sent.";
  }
  if (text.includes("insufficient") || text.includes("0x1") || text.includes("attempt to debit")) {
    return "Not enough SOL to cover the transaction. Add SOL to your wallet and try again.";
  }
  if (text.includes("blockhash not found") || text.includes("block height exceeded") || text.includes("expired")) {
    return "The transaction expired before it was confirmed. Please try again.";
  }
  if (text.includes("429") || text.includes("too many requests") || text.includes("rate limit")) {
    return "The RPC endpoint is rate-limiting requests. Wait a moment, or set VITE_SOLANA_RPC to a private endpoint.";
  }
  if (text.includes("failed to fetch") || text.includes("network")) {
    return "Network problem while contacting Solana. Check your connection and try again.";
  }
  return raw || "An unexpected error occurred.";
}

// Wallet connection errors (wallet-adapter error names) in plain language.
export function friendlyWalletError(error) {
  const name = error?.name || "";
  const raw = String(error?.message || "");

  if (name === "WalletNotReadyError") {
    return "Phantom isn't ready. Install and unlock Phantom, or open this site inside the Phantom app browser, then try again.";
  }
  if (/reject|declin|cancel|denied/i.test(raw)) {
    return "Connection cancelled. Approve the request in your wallet to connect.";
  }
  if (name === "WalletTimeoutError") {
    return "Your wallet didn't respond in time. Unlock it and try again.";
  }
  if (name === "WalletConnectionError" || name === "WalletWindowClosedError") {
    return raw || "Couldn't connect to your wallet. Unlock it and try again.";
  }
  return friendlyError(error);
}

// Converts a decimal string ("1.25") into raw integer units as a BigInt without float errors.
export function toRawUnits(amount, decimals) {
  const text = String(amount ?? "").trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") {
    throw new Error("Enter a valid amount.");
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`This token supports at most ${decimals} decimal places.`);
  }
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function fromRawUnits(raw, decimals) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Tokens created in this browser, so names/symbols survive a page reload.
// (SPL mints do not store name/symbol on-chain without a metadata program.)
export function loadLocalTokens() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_TOKENS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveLocalToken(token) {
  try {
    const all = loadLocalTokens();
    all[token.mint] = token;
    localStorage.setItem(LOCAL_TOKENS_KEY, JSON.stringify(all));
  } catch {
    // Storage can be unavailable (private mode); the app still works without it.
  }
}
