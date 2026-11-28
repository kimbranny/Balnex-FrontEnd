import { loadSrc, makeRunner, storage } from "./load.mjs";
const S = await loadSrc("lib/socialLinks.js");
const t = makeRunner();
storage.clear();

t.ok("empty values are valid (optional)", S.validateUrl("") === "" && S.validateUrl("   ") === "");
t.ok("https accepted", S.validateUrl("https://example.com/path?x=1") === "");
t.ok("http accepted", S.validateUrl("http://example.com") === "");
for (const bad of ["example.com", "javascript:alert(1)", "ftp://example.com", "https://", "https://nodot", "https://a b.com", "data:text/html,hi", "https://" + "a".repeat(400) + ".com"]) {
  t.ok(`rejects ${bad.slice(0, 30)}`, S.validateUrl(bad) !== "");
}

const A = "MintAAA", B = "MintBBB";
let r = S.saveLinks(A, { website: "https://a.com", x: "https://x.com/a", telegram: "", discord: "", other: "" });
t.ok("save ok", r.ok);
t.ok("load after refresh (fresh read from storage)", S.loadLinks(A).website === "https://a.com" && S.loadLinks(A).x === "https://x.com/a");
t.ok("empty fields not stored", !("telegram" in S.loadLinks(A)));
t.ok("isolated per token", Object.keys(S.loadLinks(B)).length === 0);
S.saveLinks(B, { website: "https://b.com" });
t.ok("token B has own links, A unchanged", S.loadLinks(B).website === "https://b.com" && S.loadLinks(A).website === "https://a.com");
r = S.saveLinks(A, { website: "not a url" });
t.ok("invalid URL rejected, nothing overwritten", !r.ok && r.errors.website && S.loadLinks(A).website === "https://a.com");
S.saveLinks(A, { website: "https://a2.com" });
t.ok("edit replaces previous values", S.loadLinks(A).website === "https://a2.com" && !S.loadLinks(A).x);
S.clearLinks(A);
t.ok("clear removes only that token's links", Object.keys(S.loadLinks(A)).length === 0 && S.loadLinks(B).website === "https://b.com");
t.ok("prototype keys can't leak", Object.keys(S.loadLinks("__proto__")).length === 0 && Object.keys(S.loadLinks("constructor")).length === 0);
storage.set("balnex:social-links:v1:devnet", "{broken");
t.ok("corrupt storage reads as empty", Object.keys(S.loadLinks(A)).length === 0);
process.exit(t.done("social links") ? 1 : 0);
