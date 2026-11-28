// Pure byte/aggregation logic for read-only analytics (no Solana imports, unit-testable).

// Raydium CPMM PoolState (Anchor account): 8-byte discriminator, then Pubkeys in this order.
export const POOL_STATE = {
  ammConfig: 8,
  poolCreator: 40,
  token0Vault: 72,
  token1Vault: 104,
  lpMint: 136,
  token0Mint: 168,
  token1Mint: 200,
  minLength: 232,
};

export function parsePoolState(bytes, toBase58) {
  if (!bytes || bytes.length < POOL_STATE.minLength) throw new Error("Pool account is too short to be a CPMM pool.");
  const key = (offset) => toBase58(bytes.slice(offset, offset + 32));
  return {
    token0Vault: key(POOL_STATE.token0Vault),
    token1Vault: key(POOL_STATE.token1Vault),
    lpMint: key(POOL_STATE.lpMint),
    token0Mint: key(POOL_STATE.token0Mint),
    token1Mint: key(POOL_STATE.token1Mint),
  };
}

// SPL token account slice (offset 32, length 40): owner (32 bytes) + amount (u64 LE).
export function parseTokenAccountSlice(bytes, toBase58) {
  if (!bytes || bytes.length < 40) throw new Error("Unexpected token account data.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { owner: toBase58(bytes.slice(0, 32)), amount: view.getBigUint64(32, true) };
}

// Counts UNIQUE owners with a positive balance. Program-controlled owners (off-curve PDAs,
// e.g. a pool's vault authority) are excluded from the holder count and reported separately.
export function aggregateHolders(accounts, isProgramOwned) {
  const holders = new Set();
  const programOwned = new Set();
  let zeroBalance = 0;
  for (const { owner, amount } of accounts) {
    if (amount <= 0n) {
      zeroBalance += 1;
      continue;
    }
    if (isProgramOwned(owner)) programOwned.add(owner);
    else holders.add(owner);
  }
  return {
    holders: holders.size,
    programOwnedExcluded: programOwned.size,
    zeroBalanceAccounts: zeroBalance,
    tokenAccounts: accounts.length,
  };
}

// Top holders by OWNER (token accounts of the same wallet are summed). Program-controlled
// owners (e.g. pool vault authorities) are excluded and reported separately. Percentages are of
// TOTAL supply, so they include supply held by excluded accounts in the denominator.
export function topHolders(accounts, isProgramOwned, supplyRaw, limit = 10) {
  const byOwner = new Map();
  let excludedRaw = 0n;
  for (const { owner, amount } of accounts) {
    if (amount <= 0n) continue;
    if (isProgramOwned(owner)) {
      excludedRaw += amount;
      continue;
    }
    byOwner.set(owner, (byOwner.get(owner) || 0n) + amount);
  }
  const supply = BigInt(supplyRaw);
  const list = [...byOwner.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, limit)
    .map(([owner, amount]) => ({
      owner,
      amount,
      percent: supply > 0n ? Number((amount * 1000000n) / supply) / 10000 : null,
    }));
  return { top: list, programOwnedRaw: excludedRaw };
}
