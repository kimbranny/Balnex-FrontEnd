// Staged transaction runner.
//
// Splits "build -> simulate -> sign -> submit -> confirm -> verify" into separate
// steps so a failure always says WHICH step failed, and whether anything was sent.
// It never touches private keys; the wallet signs inside the wallet app.
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const KNOWN_PROGRAMS = {
  [SystemProgram.programId.toBase58()]: "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPSuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};

const MAX_TX_BYTES = 1232;

const isVersioned = (tx) => !!tx && typeof tx.version !== "undefined" && !!tx.message;
export const messageOf = (tx) => (isVersioned(tx) ? tx.message : tx.compileMessage());

// Legacy transactions need wrapping because simulateTransaction's options form
// only exists for VersionedTransaction.
export const toSimulatable = (tx) => (isVersioned(tx) ? tx : new VersionedTransaction(tx.compileMessage()));

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
    inspection: details.inspection ?? null,
    transactionFormat: details.transactionFormat ?? null,
    fallbackNotes: details.fallbackNotes ?? null,
    signingAttempts: details.attempts ?? null,
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
      outcome: "Nothing was submitted. No SOL or tokens moved. (The transaction passed simulation on the network before your wallet opened.)",
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

// Re-compiles the SAME instructions without Address Lookup Tables (as a legacy message),
// with a fresh blockhash. No instruction is added, removed or reordered; the caller
// re-inspects and re-simulates the result before the wallet sees it.
export async function rebuildWithoutLookupTables(connection, tx, feePayer) {
  const message = messageOf(tx);
  const lookups = message.addressTableLookups || [];
  const alts = (
    await Promise.all(lookups.map((l) => connection.getAddressLookupTable(l.accountKey).catch(() => null)))
  )
    .map((r) => r?.value)
    .filter(Boolean);
  if (alts.length !== lookups.length) {
    throw new StageError("prepare", "Couldn't load the lookup table needed to rebuild the transaction.", { submitted: false });
  }

  const decompiled = TransactionMessage.decompile(message, { addressLookupTableAccounts: alts });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  decompiled.recentBlockhash = blockhash;
  decompiled.payerKey = feePayer;
  return new VersionedTransaction(decompiled.compileToLegacyMessage());
}

// Looks inside the transaction BEFORE the wallet sees it. Contains only public data
// (addresses, sizes, instruction programs); never keys.
export async function inspectTransaction(connection, tx, owner, expectedProgramId) {
  const message = messageOf(tx);
  const version = isVersioned(tx) ? tx.version : "legacy";
  const lookups = message.addressTableLookups || [];

  let altAccounts = [];
  if (lookups.length) {
    const results = await Promise.all(lookups.map((l) => connection.getAddressLookupTable(l.accountKey).catch(() => null)));
    altAccounts = results.map((r) => r?.value).filter(Boolean);
  }
  const keys = message.getAccountKeys({ addressLookupTableAccounts: altAccounts });

  const instructions = message.compiledInstructions.map((ix, index) => {
    const programId = keys.get(ix.programIdIndex).toBase58();
    return {
      index,
      programId,
      program: KNOWN_PROGRAMS[programId] || "other",
      accounts: ix.accountKeyIndexes.length,
      dataBytes: ix.data.length,
    };
  });

  const required = message.header.numRequiredSignatures;
  const signerKeys = [];
  for (let i = 0; i < required; i += 1) signerKeys.push(keys.get(i).toBase58());
  const present = [];
  if (isVersioned(tx)) {
    tx.signatures.forEach((sig, i) => {
      if (sig.some((b) => b !== 0)) present.push(signerKeys[i]);
    });
  } else {
    tx.signatures.forEach((entry) => {
      if (entry.signature) present.push(entry.publicKey.toBase58());
    });
  }

  let sizeBytes = null;
  let sizeError = null;
  try {
    sizeBytes = isVersioned(tx) ? tx.serialize().length : tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch (err) {
    sizeError = err?.message || String(err);
  }

  const blockhash = message.recentBlockhash;
  const blockhashValid = await connection
    .isBlockhashValid(blockhash, { commitment: "confirmed" })
    .then((r) => r.value)
    .catch(() => null);

  const programIds = [...new Set(instructions.map((i) => i.programId))];
  const programInfos = await connection.getMultipleAccountsInfo(programIds.map((p) => new PublicKey(p)), "confirmed").catch(() => []);
  const programs = programIds.map((id, i) => ({
    programId: id,
    name: KNOWN_PROGRAMS[id] || "other",
    exists: programInfos[i] ? true : programInfos.length ? false : null,
    executable: programInfos[i]?.executable ?? null,
  }));

  const ownerKey = owner.toBase58();
  const balance = await connection.getBalance(owner, "confirmed").catch(() => null);

  const inspection = {
    version,
    feePayer: keys.get(0).toBase58(),
    feePayerIsWallet: keys.get(0).toBase58() === ownerKey,
    recentBlockhash: blockhash,
    blockhashValid,
    usesAddressLookupTables: lookups.length > 0,
    lookupTables: lookups.map((l) => l.accountKey.toBase58()),
    instructionCount: instructions.length,
    instructions,
    requiredSigners: signerKeys,
    alreadySignedBy: present,
    walletStillNeedsToSign: signerKeys.includes(ownerKey) && !present.includes(ownerKey),
    otherSignersMissing: signerKeys.filter((k) => k !== ownerKey && !present.includes(k)),
    sizeBytes,
    sizeLimitBytes: MAX_TX_BYTES,
    sizeError,
    programs,
    expectedProgramInvoked: expectedProgramId ? programIds.includes(expectedProgramId) : null,
    walletBalanceLamports: balance,
  };

  const problems = [];
  if (!inspection.feePayerIsWallet) problems.push("The fee payer isn't your connected wallet.");
  if (!inspection.walletStillNeedsToSign) problems.push("Your wallet isn't a required signer of this transaction.");
  if (inspection.otherSignersMissing.length) problems.push("A required non-wallet signature is missing.");
  if (sizeError || (sizeBytes && sizeBytes > MAX_TX_BYTES)) problems.push(`The transaction is too large to send (${sizeBytes ?? sizeError}).`);
  if (blockhashValid === false) problems.push("The transaction's blockhash has already expired.");
  if (programs.some((p) => p.exists === false)) problems.push("An instruction targets a program that doesn't exist on this network.");
  if (expectedProgramId && !inspection.expectedProgramInvoked) problems.push("The transaction doesn't call the expected Raydium CPMM program.");
  inspection.problems = problems;

  console.log("[BALNEX] pre-sign transaction inspection", inspection);
  return inspection;
}

// Simulates the exact transaction (no signature needed) and measures how much SOL it
// would take from the wallet. Fails early, before the wallet opens, with program logs.
export async function simulateWithCost(connection, rawTransaction, owner) {
  const transaction = toSimulatable(rawTransaction);
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
export async function signSendConfirm({ connection, transaction, signTransaction, sendTransaction, onStage, context = {} }) {
  try {
    return await signSendConfirmInner({ connection, transaction, signTransaction, sendTransaction, onStage });
  } catch (err) {
    if (err instanceof StageError) err.details = { ...context, ...err.details };
    throw err;
  }
}

const isPhantomInternal = (err) => {
  const code = err?.error?.code ?? err?.code;
  const raw = err?.error?.message || err?.message || "";
  return code === -32603 || /^unexpected error$/i.test(raw.trim());
};
const isUserReject = (err) => {
  const code = err?.error?.code ?? err?.code;
  return code === 4001 || /reject|declin|cancel/i.test(err?.error?.message || err?.message || "");
};
const attemptRecord = (method, err) => ({
  method,
  code: err?.error?.code ?? err?.code ?? null,
  name: err?.name ?? null,
  message: err?.error?.message || err?.message || null,
});

async function signSendConfirmInner({ connection, transaction, signTransaction, sendTransaction, onStage }) {
  if (typeof signTransaction !== "function" && typeof sendTransaction !== "function") {
    throw new StageError("signing", "Your wallet can't sign transactions. Reconnect Phantom and try again.", {
      submitted: false,
    });
  }

  const blockhash = messageOf(transaction).recentBlockhash;
  const attempts = [];
  let signature = null;

  // Attempt 1: sign only, then BALNEX submits.
  onStage?.("signing");
  let signed = null;
  if (typeof signTransaction === "function") {
    try {
      signed = await signTransaction(transaction);
    } catch (err) {
      console.error("Wallet signTransaction error:", err);
      attempts.push(attemptRecord("signTransaction", err));
      if (isUserReject(err)) {
        throw new StageError("signing", "You cancelled the request in your wallet.", { submitted: false, attempts, cause: err });
      }
      if (!isPhantomInternal(err) || typeof sendTransaction !== "function") {
        throw new StageError("signing", attempts[0].message || "The wallet didn't sign the transaction.", {
          submitted: false,
          attempts,
          cause: err,
        });
      }
    }
  }

  // Attempt 2 (only after Phantom's -32603 on attempt 1, so nothing was sent yet):
  // Phantom's own sign-and-send path, which some Phantom versions handle better.
  if (!signed) {
    onStage?.("signing-alt");
    try {
      signature = await sendTransaction(transaction, connection, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 5,
      });
    } catch (err) {
      console.error("Wallet sendTransaction error:", err);
      attempts.push(attemptRecord("signAndSendTransaction", err));
      if (isUserReject(err)) {
        throw new StageError("signing", "You cancelled the request in your wallet.", { submitted: false, attempts, cause: err });
      }
      const inner = err?.error || err;
      const code = inner?.code ?? null;
      throw new StageError(
        "signing",
        isPhantomInternal(err)
          ? "Phantom returned its internal error (-32603) on both signing methods. See Technical details."
          : `The wallet couldn't sign and send: ${inner?.message || err}`,
        { submitted: false, attempts, phantomInternal: isPhantomInternal(err), cause: err, walletCode: code }
      );
    }
  } else {
    onStage?.("submitting");
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
        attempts,
        cause: err,
      });
    }
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
      attempts,
      cause: err,
    });
  }

  if (result.state === "failed") {
    const extra = await fetchFailureDetails(connection, signature);
    const parsed = parseTxError(result.status.err);
    throw new StageError(
      "confirmation",
      `On-chain failure${parsed.programError ? ` (${parsed.programError})` : ""}. ${lastLogLine(extra.logs)}`.trim(),
      { submitted: true, signature, landed: "failed", status: result.status, logs: extra.logs, rpc: { err: result.status.err }, attempts, ...parsed }
    );
  }

  if (result.state !== "confirmed") {
    throw new StageError(
      "confirmation",
      result.state === "expired"
        ? "The transaction expired before the network confirmed it."
        : "The network hasn't confirmed the transaction yet.",
      { submitted: true, signature, landed: "unknown", status: result.status, attempts }
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

// Turns any thrown value into the user message + diagnostics pair used by the UI.
export function toFailure(err) {
  const stageError =
    err instanceof StageError
      ? err
      : new StageError("unknown", err?.message || String(err) || "Unknown error.", { submitted: null, cause: err });
  console.error("[BALNEX] transaction failure", describeError(stageError), err);
  return { info: userMessage(stageError), diag: describeError(stageError) };
}
