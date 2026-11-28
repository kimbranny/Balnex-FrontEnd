// Optional social links, saved per token mint in localStorage.
//
// Fully isolated: no wallet, no transactions, no authority/metadata/fee code and nothing
// from the lifecycle lock. Purely local presentation data. Limitation: browser-local only.
import { CLUSTER } from "../config";

const KEY = `balnex:social-links:v1:${CLUSTER}`;
export const FIELDS = [
  { id: "website", label: "Website", placeholder: "https://yourtoken.com" },
  { id: "x", label: "X / Twitter", placeholder: "https://x.com/yourtoken" },
  { id: "telegram", label: "Telegram", placeholder: "https://t.me/yourtoken" },
  { id: "discord", label: "Discord", placeholder: "https://discord.gg/yourtoken" },
  { id: "other", label: "Other (optional)", placeholder: "https://…" },
];
const MAX_LENGTH = 300;

// Returns "" when valid or empty (every field is optional), otherwise a helpful message.
export function validateUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length > MAX_LENGTH) return `Keep links under ${MAX_LENGTH} characters.`;
  if (/\s/.test(text)) return "Links can't contain spaces.";
  if (!/^https?:\/\//i.test(text)) return "Start the link with https:// (or http://).";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "That doesn't look like a valid link.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https links are allowed.";
  if (!url.hostname || !(url.hostname.includes(".") || url.hostname === "localhost")) return "Enter a full web address, like https://example.com.";
  return "";
}

export function validateAll(values) {
  const errors = {};
  for (const { id } of FIELDS) {
    const message = validateUrl(values[id]);
    if (message) errors[id] = message;
  }
  return errors;
}

function readAll() {
  try {
    const data = JSON.parse(globalThis.localStorage?.getItem(KEY) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function loadLinks(mint) {
  if (!mint) return {};
  const entry = Object.prototype.hasOwnProperty.call(readAll(), mint) ? readAll()[mint] : null;
  const out = {};
  for (const { id } of FIELDS) if (entry && typeof entry[id] === "string" && !validateUrl(entry[id])) out[id] = entry[id];
  return out;
}

// Saves only this mint's entry. Returns { ok, errors }. Empty values are dropped (clearing).
export function saveLinks(mint, values) {
  if (!mint) return { ok: false, errors: { _: "No token selected." } };
  const errors = validateAll(values);
  if (Object.keys(errors).length) return { ok: false, errors };
  const clean = {};
  for (const { id } of FIELDS) {
    const v = String(values[id] ?? "").trim();
    if (v) clean[id] = v;
  }
  const all = readAll();
  if (Object.keys(clean).length) all[mint] = { ...clean, updatedAt: Date.now() };
  else delete all[mint];
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    return { ok: false, errors: { _: "Couldn't save in this browser (storage unavailable)." } };
  }
  return { ok: true, errors: {} };
}

export const clearLinks = (mint) => saveLinks(mint, {});
