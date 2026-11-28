import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useConnectSheet } from "./components/WalletSheet";
import WalletMenu from "./components/WalletMenu";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  getMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { useToast } from "./components/Toast";
import { CLUSTER } from "./config";
import { explorerAddress, explorerTx, friendlyError, saveLocalToken, shorten } from "./lib/utils";
import { useWalletTokens } from "./lib/useWalletTokens";
import Liquidity from "./pages/Liquidity";
import LaunchCard from "./components/LaunchCard";
import { beginLifecycleOperation, getLifecycleLock, markTokenCreated, replaceReservedMint, reserveTokenLifecycle, useActiveLaunch, useLifecycleLock } from "./lib/launch";
import { createMetadataInstruction } from "./lib/metadata";
import { MAX_NAME_BYTES, MAX_SYMBOL_BYTES } from "./lib/metadataCodec";
import { signatureFromSignedTransaction } from "./lib/txRunner";
import Manage from "./pages/Manage";
import Trending from "./pages/Trending";

const MAX_U64 = 18446744073709551615n;

const NAVIGATION = [
  { id: "create", label: "Create Token", icon: "＋" },
  { id: "tokens", label: "My Tokens", icon: "◉" },
  { id: "liquidity", label: "Liquidity", icon: "◈" },
  { id: "trending", label: "Trending", icon: "↗" },
  { id: "help", label: "Help", icon: "?" },
];

const STEPS = ["Details", "Authorities", "Review"];

const FAQS = [
  {
    question: "What is BALNEX?",
    answer:
      "BALNEX is a Solana token launcher. You can create an SPL token, control its authorities, create a Raydium liquidity pool and manage liquidity from one place.",
  },
  {
    question: "Do I need a wallet?",
    answer: "Yes. A Solana wallet such as Phantom is required to approve every transaction. BALNEX never sees your recovery phrase.",
  },
  {
    question: "What are mint and freeze authorities?",
    answer:
      "Mint authority controls whether more tokens can ever be created. Freeze authority controls whether token accounts can be frozen. Revoking them is permanent and signals to buyers that the supply and balances can't be changed.",
  },
  {
    question: "What is token supply and decimals?",
    answer: "Supply is how many tokens are created at launch. Decimals set how finely a token can be divided; 9 is the Solana standard.",
  },
  {
    question: "Which network am I on?",
    answer:
      "BALNEX runs on Solana Devnet by default, where tokens have no real value. Mainnet can be enabled by the site owner with an environment setting.",
  },
  {
    question: "Why doesn't my token name show in Phantom or explorers?",
    answer:
      "New tokens get on-chain metadata with your name and symbol, so wallets and explorers can display them. Your logo and description are shown inside BALNEX only, because BALNEX has no image hosting yet. Tokens created before this update have no metadata.",
  },
  {
    question: "What is Raydium liquidity?",
    answer:
      "A liquidity pool lets people swap your token for SOL. You deposit both sides to create it, and can manage or withdraw it from the Liquidity page once the pool is confirmed on-chain.",
  },
];

const GUIDE = [
  ["Connect your wallet", "Use the button in the top right to connect Phantom."],
  ["Enter token details", "Choose a name, symbol, supply and optional logo."],
  ["Set authorities", "Decide whether to keep or revoke mint and freeze authority."],
  ["Create the token", "Review, then approve the transaction in your wallet."],
  ["Create a pool", "Pair part of your supply with SOL on Raydium."],
  ["Manage liquidity", "Once your pool is confirmed on-chain, manage and withdraw liquidity from the Liquidity page."],
];

export default function App() {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();
  const { open: openConnect } = useConnectSheet();
  const notify = useToast();
  const walletTokens = useWalletTokens();

  // One application-wide lifecycle lock per network. See lib/lifecycleLock.js.
  const launch = useActiveLaunch();
  const lifecycleLock = useLifecycleLock();
  const creatingRef = useRef(false);
  const prevLaunch = useRef(null);

  // When a launch ends (completed or abandoned), drop the old "token created" screen so
  // Create Token is available again.
  useEffect(() => {
    if (prevLaunch.current && !launch) setCreatedToken(null);
    prevLaunch.current = launch;
  }, [launch]);

  const [page, setPage] = useState("create");
  const [menuOpen, setMenuOpen] = useState(false);
  const [liquidityMint, setLiquidityMint] = useState("");

  // Create-token form
  const [createStep, setCreateStep] = useState(1);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [supply, setSupply] = useState("1000000000");
  const [decimals, setDecimals] = useState("9");
  const [mintAuthority, setMintAuthority] = useState("revoke");
  const [freezeAuthority, setFreezeAuthority] = useState("revoke");
  // Update authority controls on-chain metadata. Defaults to RETAIN (never revoked silently).
  const [updateAuthority, setUpdateAuthority] = useState("retain");
  const [image, setImage] = useState(null);

  // Set when the form was pre-filled from a trending token ("Create Similar Token").
  const [inspiration, setInspiration] = useState(null);

  // Creation result
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdToken, setCreatedToken] = useState(null);

  const [faqOpen, setFaqOpen] = useState(null);

  // Restore the exact token form choices for a reservation whose wallet signing
  // definitively failed before submission. A new mint keypair is generated on retry.
  useEffect(() => {
    if (!lifecycleLock || lifecycleLock.status !== "TOKEN_RESERVED") return;
    setName(lifecycleLock.name || "");
    setSymbol(lifecycleLock.symbol || "");
    setSupply(lifecycleLock.supply || "1000000000");
    if (lifecycleLock.decimals !== null && lifecycleLock.decimals !== undefined) setDecimals(String(lifecycleLock.decimals));
    if (lifecycleLock.creationOptions) {
      setMintAuthority(lifecycleLock.creationOptions.mintAuthority || "revoke");
      setFreezeAuthority(lifecycleLock.creationOptions.freezeAuthority || "revoke");
      setUpdateAuthority(lifecycleLock.creationOptions.updateAuthority || "retain");
      setDescription(lifecycleLock.creationOptions.description || "");
    }
  }, [lifecycleLock?.id, lifecycleLock?.status]);

  // Close the menu with Escape and stop the page scrolling behind it.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => event.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  function navigate(destination) {
    setPage(destination);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      notify("Please upload a PNG, JPG or WEBP image.", "error");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      notify("Please choose an image smaller than 2MB.", "error");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImage(reader.result);
    reader.readAsDataURL(file);
  }

  // Returns an error message, or "" when the details are valid.
  function validateDetails() {
    if (!name.trim() || !symbol.trim() || !supply || Number(supply) <= 0) {
      return "Enter a token name, symbol and a supply greater than zero.";
    }
    if (
      inspiration &&
      name.trim().toLowerCase() === inspiration.name.toLowerCase() &&
      symbol.trim().toLowerCase() === inspiration.symbol.toLowerCase()
    ) {
      return `Change the name or symbol. Your token can't use exactly the same name and symbol as ${inspiration.name}, or it could be mistaken for it.`;
    }
    if (new TextEncoder().encode(name.trim()).length > MAX_NAME_BYTES) {
      return `Token name can be at most ${MAX_NAME_BYTES} bytes (about ${MAX_NAME_BYTES} letters) so it fits on-chain metadata.`;
    }
    if (new TextEncoder().encode(symbol).length > MAX_SYMBOL_BYTES) {
      return `Token symbol can be at most ${MAX_SYMBOL_BYTES} characters.`;
    }
    if (!/^\d+$/.test(supply) || !Number.isSafeInteger(Number(supply))) {
      return "Please enter a whole-number token supply within the supported limit.";
    }
    if (BigInt(supply) * 10n ** BigInt(decimals) > MAX_U64) {
      return "That supply is too large for the chosen decimals. Lower the supply or the decimals.";
    }
    return "";
  }

  function goToStep(step) {
    setCreateStep(step);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function continueFromDetails() {
    const problem = validateDetails();
    if (problem) {
      notify(problem, "error");
      return;
    }
    goToStep(2);
  }

  async function createToken() {
    const problem = validateDetails();
    if (problem) {
      notify(problem, "error");
      goToStep(1);
      return;
    }

    if (!connected || !publicKey) {
      notify("Please connect your Phantom wallet first.", "error");
      openConnect();
      return;
    }

    if (!signTransaction) {
      notify("Your wallet can't sign transactions. Please reconnect Phantom.", "error");
      return;
    }

    if (createdToken) {
      notify("This token has already been created.", "info");
      return;
    }

    // Synchronous global guard and persistent reservation happen before the first RPC await.
    if (creatingRef.current) return;
    creatingRef.current = true;

    setIsCreating(true);
    setCreateError("");

    let lifecycleOperation = null;
    let mintKeypair = null;
    let walletSigned = false;
    let submittedSignature = null;
    let signedSignature = null;
    try {
      const wallet = publicKey.toBase58();
      const existing = getLifecycleLock();
      if (existing) {
        if (
          existing.status !== "TOKEN_RESERVED" ||
          existing.operation?.state !== "failed_no_submission" ||
          existing.wallet !== wallet ||
          existing.name !== name.trim() ||
          existing.symbol !== symbol
        ) {
          throw new Error(`BALNEX is locked to ${existing.name || "the current token"} (${existing.symbol || "token"}). Resume that lifecycle instead of creating another token.`);
        }
        // The prior attempt was proven not submitted. A new mint keypair is safe only
        // after the old reservation's operation record explicitly says no submission.
        mintKeypair = Keypair.generate();
        replaceReservedMint(mintKeypair.publicKey.toBase58(), name.trim(), symbol);
      } else {
        mintKeypair = Keypair.generate();
        reserveTokenLifecycle({
          wallet,
          mint: mintKeypair.publicKey.toBase58(),
          name: name.trim(),
          symbol,
          decimals: Number(decimals),
          supply,
          creationOptions: { mintAuthority, freezeAuthority, updateAuthority, description },
        });
      }
      lifecycleOperation = beginLifecycleOperation({
        mint: mintKeypair.publicKey.toBase58(),
        type: "token_create",
        allowedStates: ["TOKEN_RESERVED"],
        pendingStatus: "TOKEN_RESERVED",
      });

      // Convert the whole-number supply into the smallest token units.
      const tokenDecimals = Number(decimals);
      const baseUnits = BigInt(supply) * 10n ** BigInt(tokenDecimals);

      // Derive the associated token account owned by the connected wallet.
      const associatedTokenAccount = getAssociatedTokenAddressSync(
        mintKeypair.publicKey,
        publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Calculate the rent needed to create the mint account.
      const mintRent = await getMinimumBalanceForRentExemptMint(connection);

      // Get a recent blockhash for the transaction.
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");

      // Build the token creation transaction.
      const transaction = new Transaction();
      transaction.feePayer = publicKey;
      transaction.recentBlockhash = latestBlockhash.blockhash;

      // 1. Create the mint account.
      transaction.add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        })
      );

      // 2. Initialize the mint and apply the selected freeze authority.
      transaction.add(
        createInitializeMintInstruction(
          mintKeypair.publicKey,
          tokenDecimals,
          publicKey,
          freezeAuthority === "retain" ? publicKey : null,
          TOKEN_PROGRAM_ID
        )
      );

      // 3. Create the wallet's associated token account.
      transaction.add(
        createAssociatedTokenAccountInstruction(
          publicKey,
          associatedTokenAccount,
          publicKey,
          mintKeypair.publicKey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

      // 4. Mint the complete initial supply to the connected wallet.
      transaction.add(
        createMintToCheckedInstruction(
          mintKeypair.publicKey,
          associatedTokenAccount,
          publicKey,
          baseUnits,
          tokenDecimals,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      // 4b. Attach on-chain Metaplex metadata (name + symbol) and apply the Update Authority
      // choice. Placed BEFORE the mint-authority revoke because creating metadata needs the
      // mint authority to sign. If the network can't simulate it, we drop just this
      // instruction below so token creation itself never breaks.
      let metadataInstruction = null;
      try {
        metadataInstruction = createMetadataInstruction({
          mint: mintKeypair.publicKey,
          owner: publicKey,
          name: name.trim(),
          symbol,
          uri: "",
          isMutable: updateAuthority !== "revoke",
        });
        transaction.add(metadataInstruction);
      } catch (metaErr) {
        console.warn("Metadata instruction not built:", metaErr);
        metadataInstruction = null;
      }

      // 5. Revoke mint authority if the user selected that option.
      if (mintAuthority === "revoke") {
        transaction.add(
          createSetAuthorityInstruction(
            mintKeypair.publicKey,
            publicKey,
            AuthorityType.MintTokens,
            null,
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }

      // Check the full transaction on the network before asking Phantom to sign.
      let metadataAttached = Boolean(metadataInstruction);
      if (metadataInstruction) {
        try {
          const sim = await connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: "confirmed",
          });
          if (sim.value.err) {
            console.warn("Simulation with metadata failed; creating without metadata.", sim.value.err, sim.value.logs);
            transaction.instructions = transaction.instructions.filter((ix) => ix !== metadataInstruction);
            metadataAttached = false;
            notify("On-chain metadata couldn't be attached on this network, so the token is created without it.", "info");
          }
        } catch (simErr) {
          console.warn("Simulation unavailable; keeping metadata instruction.", simErr);
        }
      }

      // Sign the new mint account with its generated keypair.
      transaction.partialSign(mintKeypair);

      const blockhashCheck = await connection.isBlockhashValid(latestBlockhash.blockhash, { commitment: "confirmed" });
      if (!blockhashCheck.value) {
        throw new Error("The token creation blockhash expired before signing. Retry to rebuild the transaction with a fresh blockhash.");
      }

      // Ask Phantom to approve and sign the transaction.
      lifecycleOperation.update("signing", {
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
      const signedTransaction = await signTransaction(transaction);
      walletSigned = true;
      signedSignature = signatureFromSignedTransaction(signedTransaction);
      lifecycleOperation.update("signed", { signature: signedSignature || null });

      // Persist submission intent BEFORE the RPC call. If the tab closes while the RPC
      // response is in flight, startup recovery must not offer a blind retry.
      lifecycleOperation.update("submitted", {
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        ...(signedSignature ? { signature: signedSignature } : {}),
        reason: "Token transaction submission is in progress; signature not returned yet.",
      });
      const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      submittedSignature = signature;
      lifecycleOperation.update("submitted", { signature });

      // Wait for finalized blockchain confirmation.
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "finalized"
      );

      if (confirmation.value.err) {
        throw new Error("The Solana transaction failed. No successful token creation was confirmed.");
      }

      // Independently verify the finalized SPL mint and its issued supply before advancing
      // the lifecycle or enabling the liquidity workflow.
      const confirmedMint = await getMint(connection, mintKeypair.publicKey, "finalized", TOKEN_PROGRAM_ID);
      if (confirmedMint.decimals !== tokenDecimals || confirmedMint.supply !== baseUnits) {
        throw new Error("The transaction finalized, but the on-chain mint decimals or supply do not match the token configuration.");
      }

      const token = {
        mint: mintKeypair.publicKey.toBase58(),
        tokenAccount: associatedTokenAccount.toBase58(),
        signature,
        name: name.trim(),
        symbol,
        description,
        supply,
        decimals: tokenDecimals,
        mintRevoked: mintAuthority === "revoke",
        freezeRevoked: freezeAuthority === "revoke",
        metadataAttached,
        updateRevoked: metadataAttached && updateAuthority === "revoke",
        image,
        createdAt: Date.now(),
      };

      // Confirmed mint: advance the reserved global lifecycle before routing to liquidity.
      markTokenCreated({ wallet: publicKey.toBase58(), signature, mint: token.mint, name: token.name, symbol: token.symbol, decimals: tokenDecimals, supply });
      lifecycleOperation.update("confirmed", { signature });
      lifecycleOperation.release();
      lifecycleOperation = null;

      // Remember name/symbol locally (the logo is too large for localStorage).
      saveLocalToken({
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        decimals: tokenDecimals,
        supply,
        createdAt: token.createdAt,
      });

      // The global lifecycle is already persisted; route directly to its liquidity workflow.
      setCreatedToken(token);
      notify("Token created. Now create its liquidity pool.", "success");
      walletTokens.refresh();
      openLiquidity(token.mint);
    } catch (error) {
      console.error("Token creation error:", error);
      if (lifecycleOperation) {
        try {
          if (submittedSignature || walletSigned) {
            lifecycleOperation.update("unknown", {
              ...(submittedSignature || signedSignature ? { signature: submittedSignature || signedSignature } : {}),
              reason: "Token transaction submission or confirmation outcome is uncertain.",
            });
          } else {
            lifecycleOperation.update("failed_no_submission", { reason: "Wallet signing failed or transaction was not submitted." });
          }
        } catch (persistError) {
          console.error("[BALNEX] Could not update lifecycle recovery state:", persistError);
        }
        lifecycleOperation.release();
      }
      const message = friendlyError(error);
      setCreateError(message);
      notify(message, "error");
    } finally {
      creatingRef.current = false;
      setIsCreating(false);
    }
  }

  function resetForm() {
    setName("");
    setSymbol("");
    setDescription("");
    setSupply("1000000000");
    setDecimals("9");
    setMintAuthority("revoke");
    setFreezeAuthority("revoke");
    setUpdateAuthority("retain");
    setImage(null);
    setInspiration(null);
    setCreatedToken(null);
    setCreateError("");
    setCreateStep(1);
    navigate("create");
  }

  // Trending -> Create Similar Token: pre-fills the real creation form. The original
  // token's mint address is never copied; the user launches a new, independent token.
  function createSimilar(payload) {
    setName(payload.name);
    setSymbol(payload.symbol);
    setDescription(payload.description);
    setImage(payload.image);
    setInspiration({
      name: payload.name,
      symbol: payload.symbol,
      url: payload.source.url,
      imageRequested: payload.imageRequested,
    });
    setCreatedToken(null);
    setCreateError("");
    setCreateStep(1);
    navigate("create");

    if (payload.imageRequested && !payload.image) {
      notify("Details copied. The logo couldn't be copied automatically, so upload your own.", "info");
    } else {
      notify("Details copied. Edit anything before you launch.", "success");
    }
  }

  function startBlank() {
    setName("");
    setSymbol("");
    setDescription("");
    setImage(null);
    setInspiration(null);
  }

  function openLiquidity(mint) {
    setLiquidityMint(mint);
    navigate("liquidity");
  }

  const ticker = symbol ? `$${symbol}` : "";

  return (
    <div className="app">
      {/* HEADER */}
      <header className="navbar">
        <div className="nav-left">
          <button
            className="menu-toggle"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={menuOpen}
            aria-controls="main-menu"
            type="button"
          >
            <span className={menuOpen ? "burger open" : "burger"} aria-hidden="true" />
          </button>

          <button className="brand" onClick={() => navigate("create")} type="button" aria-label="BALNEX home">
            <span className="brand-b" aria-hidden="true">B</span>
            <span aria-hidden="true">ALNEX</span>
          </button>
        </div>

        <nav className="top-links" aria-label="Primary">
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.id === "create" && Boolean(lifecycleLock)}
              title={item.id === "create" && lifecycleLock ? "Complete the locked token's liquidity lifecycle first." : undefined}
              className={page === item.id ? "top-link active" : "top-link"}
              onClick={() => navigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="nav-right">
          <span className="network-badge">{CLUSTER}</span>
          <WalletMenu />
        </div>
      </header>

      {lifecycleLock && (
        <section className="global-lock-banner" role="status">
          <div className="global-lock-copy">
            <strong>LIQUIDITY WORKFLOW LOCKED</strong>
            <span>Token: {lifecycleLock.name || "Unnamed"} ({lifecycleLock.symbol || "—"})</span>
            <span>Status: {lifecycleLock.status.replaceAll("_", " ")}</span>
            <span>Network: {String(lifecycleLock.cluster || CLUSTER).toUpperCase()}</span>
            <small>You must complete or resolve this token's liquidity lifecycle before creating another token.</small>
          </div>
          <button type="button" className="primary" onClick={() => {
            if (lifecycleLock.status === "TOKEN_RESERVED") navigate("create");
            else openLiquidity(lifecycleLock.mint);
          }}>{lifecycleLock.status === "TOKEN_RESERVED" ? "RESUME TOKEN CREATION" : "RESUME CURRENT TOKEN"}</button>
        </section>
      )}

      {/* MENU */}
      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
          <nav className="nav-links" id="main-menu" aria-label="Menu">
            <div className="menu-heading">NAVIGATION</div>
            {NAVIGATION.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={item.id === "create" && Boolean(lifecycleLock)}
                title={item.id === "create" && lifecycleLock ? "Complete the locked token's liquidity lifecycle first." : undefined}
                className={page === item.id ? "nav-item selected" : "nav-item"}
                onClick={() => navigate(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
                <span className="nav-arrow">›</span>
              </button>
            ))}
            <div className="menu-footer">BALNEX · SOLANA · {CLUSTER.toUpperCase()}</div>
          </nav>
        </>
      )}

      <main className="main">
        {/* CREATE TOKEN */}
        {page === "create" && launch && (
          <section className="panel">
            <LaunchCard launch={launch} onContinue={() => {
              if (lifecycleLock?.status === "TOKEN_RESERVED" && lifecycleLock.operation?.state === "failed_no_submission") createToken();
              else if (lifecycleLock?.status === "TOKEN_RESERVED") notify("Token creation is reserved. Verify the prior operation before retrying.", "info");
              else openLiquidity(launch.mint);
            }} />
          </section>
        )}

        {page === "create" && !launch && !createdToken && (
          <>
            <section className="intro">
              <div className="status">
                <span className="status-dot" />
                SOLANA TOKEN LAUNCHPAD
              </div>
              <h1>
                Launch your own<span> token.</span>
              </h1>
              <p>Create, secure and list a Solana token in minutes.</p>
            </section>

            <section className="panel guided-panel">
              <div className="guided-progress">
                <div className="guided-progress-meta">
                  <span>
                    STEP {createStep} OF {STEPS.length}
                  </span>
                  <span>{STEPS[createStep - 1].toUpperCase()}</span>
                </div>
                <div className="guided-progress-track">
                  <span style={{ width: `${(createStep / STEPS.length) * 100}%` }} />
                </div>
                <div className="guided-step-labels">
                  {STEPS.map((label, index) => (
                    <span key={label} className={createStep >= index + 1 ? "current" : ""}>
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              {createStep === 1 && (
                <div className="guided-step">
                  <div className="section-heading">
                    <span>01</span> Token details
                  </div>
                  <p className="step-description">Give your token an identity and set its supply.</p>

                  {inspiration && (
                    <div className="notice inspiration">
                      <span className="notice-icon">✦</span>
                      <div>
                        <strong>
                          Inspired by {inspiration.name} (${inspiration.symbol})
                        </strong>
                        <p>
                          This creates a brand-new token with its own mint address. It isn't {inspiration.name} and
                          won't share its price, holders or liquidity. Everything below is editable
                          {inspiration.imageRequested && !image ? " — the logo couldn't be copied, so upload your own" : ""}.
                        </p>
                        <div className="inspiration-actions">
                          {inspiration.url && (
                            <a href={inspiration.url} target="_blank" rel="noopener noreferrer">
                              View original ↗
                            </a>
                          )}
                          <button type="button" className="text-button" onClick={startBlank}>
                            Start blank
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="field">
                    <label htmlFor="token-name">Token name *</label>
                    <input
                      id="token-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. My Project Token"
                      maxLength={32}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="token-symbol">Token symbol *</label>
                    <input
                      id="token-symbol"
                      value={ticker}
                      onChange={(e) => setSymbol(e.target.value.replace(/\$/g, "").toUpperCase())}
                      placeholder="$TOKEN"
                      maxLength={11}
                      autoCapitalize="characters"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="token-description">Description</label>
                    <textarea
                      id="token-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Tell people about your project…"
                      rows={3}
                      maxLength={500}
                    />
                    <small className="helper">{description.length}/500</small>
                  </div>

                  <div className="field">
                    <label htmlFor="token-logo">Token logo</label>
                    <label className="upload" htmlFor="token-logo">
                      {image ? (
                        <>
                          <img src={image} alt="Token logo preview" />
                          <strong>Change image</strong>
                        </>
                      ) : (
                        <>
                          <span className="upload-icon">↑</span>
                          <strong>Upload your token logo</strong>
                          <small>PNG, JPG or WEBP · max 2MB</small>
                        </>
                      )}
                    </label>
                    <input id="token-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImage} hidden />
                  </div>

                  <div className="two-fields">
                    <div className="field">
                      <label htmlFor="supply">Total supply *</label>
                      <input
                        id="supply"
                        type="number"
                        inputMode="numeric"
                        min="1"
                        step="1"
                        value={supply}
                        onChange={(e) => setSupply(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="decimals">Decimals</label>
                      <select id="decimals" value={decimals} onChange={(e) => setDecimals(e.target.value)}>
                        <option value="9">9</option>
                        <option value="6">6</option>
                        <option value="2">2</option>
                        <option value="0">0</option>
                      </select>
                    </div>
                  </div>

                  <button className="primary" type="button" onClick={continueFromDetails}>
                    Continue <span>→</span>
                  </button>
                </div>
              )}

              {createStep === 2 && (
                <div className="guided-step">
                  <div className="section-heading">
                    <span>02</span> Authority settings
                  </div>
                  <p className="step-description">Choose whether to keep control of minting and freezing after launch.</p>

                  <div className="authority-setting">
                    <div className="authority-copy">
                      <label htmlFor="mint-authority">Revoke mint authority</label>
                      <p className="helper">
                        {mintAuthority === "revoke"
                          ? "Supply will be fixed. No one can mint more tokens."
                          : "You keep the ability to mint more tokens later."}
                      </p>
                    </div>
                    <label className="switch" htmlFor="mint-authority">
                      <input
                        id="mint-authority"
                        type="checkbox"
                        role="switch"
                        checked={mintAuthority === "revoke"}
                        onChange={(e) => setMintAuthority(e.target.checked ? "revoke" : "retain")}
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>

                  <div className="authority-setting">
                    <div className="authority-copy">
                      <label htmlFor="freeze-authority">Revoke freeze authority</label>
                      <p className="helper">
                        {freezeAuthority === "revoke"
                          ? "Token accounts can never be frozen."
                          : "You keep the ability to freeze token accounts."}
                      </p>
                    </div>
                    <label className="switch" htmlFor="freeze-authority">
                      <input
                        id="freeze-authority"
                        type="checkbox"
                        role="switch"
                        checked={freezeAuthority === "revoke"}
                        onChange={(e) => setFreezeAuthority(e.target.checked ? "revoke" : "retain")}
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>

                  <div className="authority-setting">
                    <div className="authority-copy">
                      <label htmlFor="update-authority">Revoke update authority</label>
                      <p className="helper">
                        {updateAuthority === "revoke"
                          ? "Name and symbol are locked permanently. You can never edit this token's metadata."
                          : "You keep the ability to change this token's metadata (name, symbol, URI)."}{" "}
                        Controls whether token metadata can be modified. Revoking this authority permanently locks
                        metadata changes where supported.
                      </p>
                    </div>
                    <label className="switch" htmlFor="update-authority">
                      <input
                        id="update-authority"
                        type="checkbox"
                        role="switch"
                        checked={updateAuthority === "revoke"}
                        onChange={(e) => setUpdateAuthority(e.target.checked ? "revoke" : "retain")}
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>

                  <div className="notice">
                    <span className="notice-icon">ⓘ</span>
                    <div>
                      <strong>Choose carefully</strong>
                      <p>Revoking an authority is permanent once the transaction is confirmed.</p>
                    </div>
                  </div>

                  <div className="guided-actions">
                    <button className="secondary-button" type="button" onClick={() => goToStep(1)}>
                      ← Back
                    </button>
                    <button className="primary" type="button" onClick={() => goToStep(3)}>
                      Review <span>→</span>
                    </button>
                  </div>
                </div>
              )}

              {createStep === 3 && (
                <div className="guided-step">
                  <div className="section-heading">
                    <span>03</span> Review your launch
                  </div>
                  <p className="step-description">Check everything before you approve the transaction.</p>

                  <div className="launch-review">
                    <div className="review-token">
                      {image ? <img src={image} alt="" /> : <span>{symbol.slice(0, 1) || "B"}</span>}
                      <div>
                        <strong>
                          {name} {ticker && `(${ticker})`}
                        </strong>
                        <small>{description || "No description added"}</small>
                      </div>
                    </div>
                    {inspiration && (
                      <div className="review-row">
                        <span>Inspired by</span>
                        <strong>New token, not {inspiration.name}</strong>
                      </div>
                    )}
                    <div className="review-row">
                      <span>Total supply</span>
                      <strong>{Number(supply || 0).toLocaleString()}</strong>
                    </div>
                    <div className="review-row">
                      <span>Decimals</span>
                      <strong>{decimals}</strong>
                    </div>
                    <div className="review-row">
                      <span>Mint authority</span>
                      <strong>{mintAuthority === "revoke" ? "Revoke" : "Retain"}</strong>
                    </div>
                    <div className="review-row">
                      <span>Freeze authority</span>
                      <strong>{freezeAuthority === "revoke" ? "Revoke" : "Retain"}</strong>
                    </div>
                    <div className="review-row">
                      <span>Update authority</span>
                      <strong>{updateAuthority === "revoke" ? "Revoke" : "Retain"}</strong>
                    </div>
                    <div className="review-row">
                      <span>Network</span>
                      <strong>Solana {CLUSTER}</strong>
                    </div>
                  </div>

                  <div className="notice">
                    <span className="notice-icon">ⓘ</span>
                    <div>
                      <strong>One wallet approval</strong>
                      <p>
                        Phantom will ask you to approve one transaction that creates the token, creates your token
                        account and mints the full supply to you. Your wallet pays the network fee and account rent, including about 0.006 SOL for the on-chain metadata account.
                      </p>
                    </div>
                  </div>

                  {createError && (
                    <div className="notice notice-error" role="alert">
                      <div>
                        <strong>Creation failed</strong>
                        <p>{createError}</p>
                      </div>
                    </div>
                  )}

                  <div className="guided-actions">
                    <button className="secondary-button" type="button" disabled={isCreating} onClick={() => goToStep(2)}>
                      ← Back
                    </button>
                    <button className="primary" type="button" disabled={isCreating || Boolean(lifecycleLock)} onClick={createToken}>
                      {isCreating ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> Waiting for confirmation…
                        </>
                      ) : connected ? (
                        <>
                          Create Token <span>→</span>
                        </>
                      ) : (
                        <>
                          Connect Wallet to Create <span>→</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        {/* CREATION SUCCESS */}
        {page === "create" && !launch && createdToken && (
          <section className="panel">
            <div className="success-banner">
              <span>✓</span>
              <div>
                <strong>Token created on {CLUSTER}</strong>
                <p>Your token and its full supply are confirmed on Solana.</p>
              </div>
            </div>

            <div className="token-preview">
              <div className="token-avatar">
                {createdToken.image ? <img src={createdToken.image} alt="" /> : (createdToken.symbol || "B").slice(0, 1)}
              </div>
              <div className="token-info">
                <strong>
                  {createdToken.name} {createdToken.symbol && `($${createdToken.symbol})`}
                </strong>
                <small>Supply: {Number(createdToken.supply).toLocaleString()}</small>
              </div>
              <span className="preview-tag">{CLUSTER.toUpperCase()}</span>
            </div>

            <div className="launch-review">
              <div className="review-row">
                <span>Mint address</span>
                <a href={explorerAddress(createdToken.mint)} target="_blank" rel="noopener noreferrer">
                  {shorten(createdToken.mint, 6, 6)} ↗
                </a>
              </div>
              <div className="review-row">
                <span>Token account</span>
                <a href={explorerAddress(createdToken.tokenAccount)} target="_blank" rel="noopener noreferrer">
                  {shorten(createdToken.tokenAccount, 6, 6)} ↗
                </a>
              </div>
              <div className="review-row">
                <span>Transaction</span>
                <a href={explorerTx(createdToken.signature)} target="_blank" rel="noopener noreferrer">
                  View ↗
                </a>
              </div>
            </div>

            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(createdToken.mint).then(
                  () => notify("Mint address copied.", "success"),
                  () => notify("Couldn't copy automatically.", "error")
                );
              }}
            >
              Copy mint address
            </button>

            <div className="guided-actions">
              <button className="secondary-button" type="button" onClick={() => navigate("tokens")}>
                Manage token
              </button>
              <button className="primary" type="button" onClick={() => openLiquidity(createdToken.mint)}>
                Create pool <span>→</span>
              </button>
            </div>

            <button className="text-button" type="button" onClick={resetForm}>
              Create another token
            </button>
          </section>
        )}

        {page === "tokens" && (
          <Manage walletTokens={walletTokens} onNavigate={navigate} onUseForLiquidity={openLiquidity} />
        )}

        {page === "liquidity" && (
          <Liquidity walletTokens={walletTokens} initialMint={launch?.mint || liquidityMint} onNavigate={navigate} />
        )}

        {page === "trending" && <Trending onCreateSimilar={createSimilar} />}

        {page === "help" && (
          <section className="panel">
            <span className="eyebrow">GETTING STARTED</span>
            <h2>Help</h2>
            <p className="muted">How BALNEX works, and answers to common questions.</p>

            <div className="section-heading">How to use</div>
            {GUIDE.map(([title, text], index) => (
              <div className="guide" key={title}>
                <span className="guide-number">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
              </div>
            ))}

            <div className="section-heading">FAQ</div>
            <div className="faq-list">
              {FAQS.map((faq, index) => (
                <div className="faq-item" key={faq.question}>
                  <button
                    className="faq-question"
                    type="button"
                    onClick={() => setFaqOpen(faqOpen === index ? null : index)}
                    aria-expanded={faqOpen === index}
                  >
                    {faq.question}
                    <span>{faqOpen === index ? "−" : "+"}</span>
                  </button>
                  {faqOpen === index && <div className="faq-answer">{faq.answer}</div>}
                </div>
              ))}
            </div>

            <div className="notice">
              <span className="notice-icon">ⓘ</span>
              <div>
                <strong>Stay safe</strong>
                <p>Always review transaction details in your wallet. Never share your recovery phrase.</p>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <div className="footer-brand" aria-label="BALNEX">
          <span className="brand-b" aria-hidden="true">B</span>
          <span aria-hidden="true">ALNEX</span>
        </div>
        <p>Built for the Solana ecosystem.</p>
        <div className="footer-links">
          <button type="button" disabled={Boolean(lifecycleLock)} title={lifecycleLock ? "Complete the locked token's liquidity lifecycle first." : undefined} onClick={() => navigate("create")}>Create</button>
          <button type="button" onClick={() => navigate("tokens")}>My Tokens</button>
          <button type="button" onClick={() => navigate("liquidity")}>Liquidity</button>
          <button type="button" onClick={() => navigate("help")}>Help</button>
        </div>
        <small>© 2026 BALNEX. All rights reserved.</small>
      </footer>
    </div>
  );
}
