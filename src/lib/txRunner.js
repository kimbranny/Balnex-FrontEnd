// Staged transaction runner.
//
// Splits "build -> simulate -> sign -> submit -> confirm -> verify" into separate
// steps so a failure always says WHICH step failed, and whether anything was sent.
// It never touches private keys; the wallet signs inside the wallet app.
import { PublicKey } from "@solana/web3.js";

export const STAGES = {
  prepare: "Preparing",
  simulation: "Simulation",
  signing: "Wallet signing",
  submission: "Submission",
  confirmation: "Confirmation",
  verification: "Verification",
};

export class StageError extends Error {
  constructor(stage, message, details = {}) {
    super(message);
    this.name = "StageError";
    this.stage = stage;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Solana RPC errors look like { InstructionError: [index, { Custom: 6001 }] } or a string.
export function parseTxError(txError) {
  if (!txError) return {};
  if (typeof txError === "string") return { programError: txError };
  const instruction = txError.InstructionError;
  if (Array.isArray(instruction)) {
    const [index, detail] = instruction;
    return {
      instructionIndex: index,
      programError: typeof detail === "string" ? detail : JSON.stringify(detail),
    };
  }
  return { programError: JSON.stringify(txError) };
}

// Pulls the useful, non-sensitive facts out of any error for the diagnostics panel.
export function describeError(error) {
  const details = error?.details || {};
  const inner = error?.details?.cause || error?.error || error?.cause;
  return {
    stage: error?.stage || "unknown",
    name: error?.name,
    message: error?.message,
    submitted: details.submitted ?? null,
    walletErrorCode: inner?.code ?? null,
    walletErrorMessage: inner?.message ?? null,
    signature: details.signature ?? null,
    instructionIndex: details.instructionIndex ?? null,
    programError: details.programError ?? null,
    confirmationStatus: details.status ?? null,
    rpcResponse: details.rpc ?? null,
    logs: details.logs ?? null,
    stack: error?.stack ?? null,
  };
}

// Short, honest text for the user: what happened and whether SOL could have moved.
export function userMessage(error) {
  const stage = error?.stage || "unknown";
  const d = error?.details || {};

  if (stage === "prepare") {
    return {
      title: "Couldn't prepare the pool",
      outcome: "Nothing was sent. No SOL or tokens moved.",
      body: error.message,
    };
  }
  if (stage === "simulation") {
    return {
      title: "The pool transaction would fail",
      outcome: "Nothing was sent. The check ran before opening your wallet, so no SOL or tokens moved.",
      body: error.message,
    };
  }
  if (stage === "signing") {
    return {
      title: "Wallet signing failed",
      outcome: "Nothing was submitted. No SOL or tokens moved.",
      body: error.message,
    };
  }
  if (stage === "submission") {
    return {
      title: "The network rejected the transaction",
      outcome: "It was not accepted by the network. No SOL or tokens moved.",
      body: error.message,
    };
  }
  if (stage === "confirmation") {
    if (d.landed === "failed") {
      return {
        title: "Submitted, but it failed on-chain",
        outcome: "The transaction was processed and failed, so the pool was not created. Only the network fee is spent.",
        body: error.message,
      };
    }
    return {
      title: "Submitted, still awaiting confirmation",
      outcome: "We couldn't confirm it in time. It may still succeed. Check the transaction link before trying again.",
      body: error.message,
    };
  }
  if (stage === "verification") {
    return {
      title: "Confirmed, but the pool wasn't found",
      outcome: "The transaction went through, but the pool account could not be verified. Check the transaction link.",
      body: error.message,
    };
  }
  return {
    title: "Something went wrong",
    outcome: "We couldn't tell how far it got. Check your wallet activity before retrying.",
    body: error?.message || "Unknown error.",
  };
}

// Simulates the exact transaction (no signature needed) and measures how much SOL it
// would take from the wallet. Fails early, before the wallet opens, with program logs.
export async function simulateWithCost(connection, transaction, owner) {
  const before = await connection.getBalance(owner, "confirmed");

  let response;
  try {
    response = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [owner.toBase58()] },
    });
  } catch (err) {
    throw new StageError("simulation", `The network couldn't simulate the transaction: ${err?.message || err}`, {
      submitted: false,
      cause: err,
    });
  }

  const { err, logs, unitsConsumed, accounts } = response.value;
  if (err) {
    const parsed = parseTxError(err);
    throw new StageError(
      "simulation",
      `Simulation failed${parsed.programError ? ` (${parsed.programError})` : ""}. ${lastLogLine(logs)}`.trim(),
      { submitted: false, logs, rpc: { err }, ...parsed }
    );
  }

  const after = accounts?.[0]?.lamports;
  return {
    before,
    after: typeof after === "number" ? after : null,
    outflow: typeof after === "number" ? before - after : null,
    logs,
    unitsConsumed,
  };
}

function lastLogLine(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return "";
  const hit = [...logs].reverse().find((line) => /error|fail|insufficient|exceeded/i.test(line));
  return hit ? `Last program message: ${hit}` : "";
}

async function waitForSignature(connection, signature, blockhash, timeoutMs = 90000) {
  const started = Date.now();
  let lastStatus = null;
  let rpcFailures = 0;

  while (Date.now() - started < timeoutMs) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = value[0];
      lastStatus = status || lastStatus;

      if (status?.err) return { state: "failed", status };
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        return { state: "confirmed", status };
      }

      if (!status && blockhash) {
        const valid = await connection.isBlockhashValid(blockhash, { commitment: "confirmed" }).catch(() => null);
        if (valid && valid.value === false) {
          await sleep(2500);
          const recheck = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          if (!recheck.value[0]) return { state: "expired", status: null };
        }
      }
    } catch (err) {
      rpcFailures += 1;
      if (rpcFailures >= 5) throw err;
    }
    await sleep(1500);
  }

  return { state: "timeout", status: lastStatus };
}

async function fetchFailureDetails(connection, signature) {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return { logs: tx?.meta?.logMessages ?? null, err: tx?.meta?.err ?? null };
  } catch {
    return { logs: null, err: null };
  }
}

// Sign with the wallet, submit with preflight, then wait for a real confirmation.
// Throws StageError for every failure; resolves only when the transaction confirmed.
export async function signSendConfirm({ connection, transaction, signTransaction, onStage }) {
  if (typeof signTransaction !== "function") {
    throw new StageError("signing", "Your wallet can't sign transactions. Reconnect Phantom and try again.", {
      submitted: false,
    });
  }

  const blockhash = transaction?.message?.recentBlockhash || transaction?.recentBlockhash || null;

  onStage?.("signing");
  let signed;
  try {
    signed = await signTransaction(transaction);
  } catch (err) {
    console.error("Wallet signing error:", err);
    const code = err?.error?.code ?? err?.code;
    const raw = err?.error?.message || err?.message || "";
    let message = raw || "The wallet didn't sign the transaction.";
    if (code === 4001 || /reject|declin|cancel/i.test(raw)) {
      message = "You cancelled the request in your wallet.";
    } else if (code === -32603 || /^unexpected error$/i.test(raw.trim())) {
      message =
        "Phantom reported an internal error (-32603 \"Unexpected error\") while signing. Close Phantom, reopen it, make sure this account has enough SOL, then try again.";
    }
    throw new StageError("signing", message, { submitted: false, cause: err });
  }

  onStage?.("submitting");
  let signature;
  try {
    signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5,
    });
  } catch (err) {
    console.error("Submission error:", err);
    let logs = err?.logs ?? null;
    if (!logs && typeof err?.getLogs === "function") {
      logs = await err.getLogs(connection).catch(() => null);
    }
    throw new StageError("submission", `${err?.message || "The network rejected the transaction."} ${lastLogLine(logs)}`.trim(), {
      submitted: false,
      logs,
      cause: err,
    });
  }

  onStage?.("confirming");
  let result;
  try {
    result = await waitForSignature(connection, signature, blockhash);
  } catch (err) {
    console.error("Confirmation error:", err);
    throw new StageError("confirmation", `Couldn't check the transaction status: ${err?.message || err}`, {
      submitted: true,
      signature,
      landed: "unknown",
      cause: err,
    });
  }

  if (result.state === "failed") {
    const extra = await fetchFailureDetails(connection, signature);
    const parsed = parseTxError(result.status.err);
    throw new StageError(
      "confirmation",
      `On-chain failure${parsed.programError ? ` (${parsed.programError})` : ""}. ${lastLogLine(extra.logs)}`.trim(),
      {
        submitted: true,
        signature,
        landed: "failed",
        status: result.status,
        logs: extra.logs,
        rpc: { err: result.status.err },
        ...parsed,
      }
    );
  }

  if (result.state !== "confirmed") {
    throw new StageError(
      "confirmation",
      result.state === "expired"
        ? "The transaction expired before the network confirmed it."
        : "The network hasn't confirmed the transaction yet.",
      { submitted: true, signature, landed: "unknown", status: result.status }
    );
  }

  return { signature, status: result.status };
}

// Confirms the pool account really exists on-chain and belongs to the CPMM program.
export async function verifyPoolAccount(connection, poolId, programId, signature) {
  const account = await connection.getAccountInfo(new PublicKey(poolId), "confirmed");
  if (!account) {
    throw new StageError("verification", "The transaction confirmed, but no pool account exists at the expected address.", {
      submitted: true,
      signature,
    });
  }
  if (programId && !account.owner.equals(new PublicKey(programId))) {
    throw new StageError("verification", "An account exists at the pool address, but it isn't owned by the Raydium CPMM program.", {
      submitted: true,
      signature,
    });
  }
  return true;
}
