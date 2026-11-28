const KEY = "balnex:social-links:v1";

export const SOCIAL_FIELDS = [
  { key: "website", label: "Website", placeholder: "https://example.com" },
  { key: "x", label: "X / Twitter", placeholder: "https://x.com/yourproject" },
  { key: "telegram", label: "Telegram", placeholder: "https://t.me/yourcommunity" },
  { key: "discord", label: "Discord", placeholder: "https://discord.gg/yourinvite" },
  { key: "other", label: "Other community link", placeholder: "https://..." },
];

export function validateSocialUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return "Enter a valid HTTP or HTTPS URL.";
    }
    return "";
  } catch {
    return "Enter a complete URL beginning with https:// or http://.";
  }
}

export function loadSocialLinks(mint) {
  if (!mint) return {};
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}");
    const entry = all?.[mint];
    return entry && typeof entry === "object" ? entry : {};
  } catch {
    return {};
  }
}

export function saveSocialLinks(mint, links) {
  if (!mint) throw new Error("Select a token before saving social links.");
  const next = {};
  for (const field of SOCIAL_FIELDS) {
    const value = String(links?.[field.key] || "").trim();
    const error = validateSocialUrl(value);
    if (error) throw new Error(`${field.label}: ${error}`);
    if (value) next[field.key] = value;
  }
  const all = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
  })();
  all[mint] = next;
  localStorage.setItem(KEY, JSON.stringify(all));
  return next;
}

export function clearSocialLinks(mint) {
  if (!mint) return;
  const all = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
  })();
  delete all[mint];
  localStorage.setItem(KEY, JSON.stringify(all));
}
