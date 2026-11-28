import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  data = new Map();
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const lifecycle = await import("../src/lib/lifecycleLock.js");
const social = await import("../src/lib/socialLinks.js");

const wallet = "11111111111111111111111111111111";
const mintA = "So11111111111111111111111111111111111111112";
const mintB = "11111111111111111111111111111112";
const pool = "11111111111111111111111111111113";

function reserve() {
  return lifecycle.reserveTokenLifecycle({
    wallet, mint: mintA, name: "Token A", symbol: "A", decimals: 9, supply: "1000000",
  });
}

test("global lifecycle blocks a second token and persists across reads", () => {
  localStorage.clear();
  const lock = reserve();
  assert.equal(lifecycle.getLifecycleLock().mint, mintA);
  assert.throws(() => lifecycle.reserveTokenLifecycle({
    wallet, mint: mintB, name: "Token B", symbol: "B", decimals: 9, supply: "1",
  }), /locked to Token A/i);
  assert.equal(JSON.parse(localStorage.getItem("balnex:lifecycle-lock:v1:devnet")).id, lock.id);
});

test("synchronous operation guard blocks concurrent pool attempts", () => {
  localStorage.clear();
  reserve();
  const first = lifecycle.beginLifecycleOperation({
    mint: mintA, type: "pool_create", allowedStates: ["TOKEN_RESERVED"], pendingStatus: "POOL_PENDING",
  });
  assert.throws(() => lifecycle.beginLifecycleOperation({
    mint: mintA, type: "pool_create", allowedStates: ["POOL_PENDING"], pendingStatus: "POOL_PENDING",
  }), /already running/i);
  first.update("failed_no_submission", { reason: "wallet signing rejected" });
  first.release();
  assert.equal(lifecycle.getLifecycleLock().status, "TOKEN_RESERVED");
});

test("unknown submitted transaction blocks blind retry", () => {
  localStorage.clear();
  reserve();
  const op = lifecycle.beginLifecycleOperation({
    mint: mintA, type: "pool_create", allowedStates: ["TOKEN_RESERVED"], pendingStatus: "POOL_PENDING",
  });
  op.update("submitted", { signature: "test-signature", poolId: pool });
  op.update("unknown", { signature: "test-signature", poolId: pool, reason: "RPC unavailable" });
  op.release();
  assert.equal(lifecycle.getLifecycleLock().status, "RECOVERY_REQUIRED");
  assert.throws(() => lifecycle.beginLifecycleOperation({
    mint: mintA, type: "pool_create", allowedStates: ["RECOVERY_REQUIRED"], pendingStatus: "POOL_PENDING",
  }), /unresolved/i);
});

test("verified finalized removal with zero LP and reserves is the only unlock path", () => {
  localStorage.clear();
  reserve();
  lifecycle.markTokenCreated({ wallet, mint: mintA, name: "Token A", symbol: "A", decimals: 9, supply: "1000000" });
  lifecycle.markLiquidityCreated(wallet, mintA, { poolId: pool, creationSignature: "pool-signature" });
  const op = lifecycle.beginLifecycleOperation({
    mint: mintA, type: "remove_liquidity", allowedStates: ["POOL_RUNNING"], pendingStatus: "REMOVAL_PENDING",
  });
  op.update("submitted", { signature: "remove-signature", poolId: pool });
  op.update("confirmed", { signature: "remove-signature", poolId: pool });
  op.release();
  assert.throws(() => lifecycle.markLiquidityRemoved(wallet, mintA, "remove-signature", {
    verified: true, signatureStatus: "confirmed", remainingLpRaw: "0", poolStatus: "emptied",
    reserves: { token: 0, sol: 0 },
  }), /finalized/i);
  lifecycle.markLiquidityRemoved(wallet, mintA, "remove-signature", {
    verified: true, signatureStatus: "finalized", remainingLpRaw: "0", poolStatus: "emptied",
    reserves: { token: 0, sol: 0 },
  });
  assert.equal(lifecycle.getLifecycleLock(), null);
});

test("social links validate, persist by mint, isolate, and clear", () => {
  localStorage.clear();
  assert.equal(social.validateSocialUrl("javascript:alert(1)"), "Enter a valid HTTP or HTTPS URL.");
  assert.equal(social.validateSocialUrl("https://example.com"), "");
  social.saveSocialLinks(mintA, { website: "https://a.example", telegram: "https://t.me/a" });
  social.saveSocialLinks(mintB, { website: "https://b.example" });
  assert.equal(social.loadSocialLinks(mintA).website, "https://a.example");
  assert.equal(social.loadSocialLinks(mintB).website, "https://b.example");
  assert.throws(() => social.saveSocialLinks(mintA, { website: "javascript:alert(1)" }), /Website/);
  social.clearSocialLinks(mintA);
  assert.deepEqual(social.loadSocialLinks(mintA), {});
  assert.equal(social.loadSocialLinks(mintB).website, "https://b.example");
});
