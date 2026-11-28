// Pure helpers for withdrawal amounts. Everything is BigInt on raw units (no float rounding
// on balances); floats are used only for display estimates.

// LP amount for a percentage of the user's verified on-chain LP balance (rounds down).
export function lpForPercent(lpRaw, percent) {
  const p = Number(percent);
  if (!Number.isInteger(p) || p <= 0 || p > 100) return 0n;
  return (BigInt(lpRaw) * BigInt(p)) / 100n;
}

// Share of the pool represented by `burn` LP tokens. 0 when supply is unknown/zero.
export function poolShare(burn, lpSupply) {
  const supply = BigInt(lpSupply);
  return supply > 0n ? Number(burn) / Number(supply) : 0;
}

// Estimated outputs from live reserves (UI units) for `burn` LP tokens.
export function estimateOutputs(reserves, burn, lpSupply) {
  const share = poolShare(burn, lpSupply);
  return { token: reserves.token * share, sol: reserves.sol * share, share };
}

// Minimum acceptable output after slippage (UI units): amount * (1 - slippage%).
export function minOutput(amount, slippagePercent) {
  const s = Number(slippagePercent);
  if (!(s >= 0 && s < 100)) return 0;
  return amount * (1 - s / 100);
}
