import { useEffect, useState } from "react";
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
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { useToast } from "./components/Toast";
import { CLUSTER } from "./config";
import { explorerAddress, explorerTx, friendlyError, saveLocalToken, shorten } from "./lib/utils";
import { useWalletTokens } from "./lib/useWalletTokens";
import Liquidity from "./pages/Liquidity";
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
      "Your name, symbol and logo are shown inside BALNEX only. On-chain token metadata (so wallets and explorers display them) isn't added yet.",
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
  const [image, setImage] = useState(null);

  // Set when the form was pre-filled from a trending token ("Create Similar Token").
  const [inspiration, setInspiration] = useState(null);

  // Creation result
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdToken, setCreatedToken] = useState(null);

  const [faqOpen, setFaqOpen] = useState(null);

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

    setIsCreating(true);
    setCreateError("");

    try {
      // Generate a new mint account for this token.
      const mintKeypair = Keypair.generate();

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

      // Sign the new mint account with its generated keypair.
      transaction.partialSign(mintKeypair);

      // Ask Phantom to approve and sign the transaction.
      const signedTransaction = await signTransaction(transaction);

      // Submit the signed transaction to the configured Solana network.
      const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      // Wait for blockchain confirmation.
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error("The Solana transaction failed. No successful token creation was confirmed.");
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
        image,
        createdAt: Date.now(),
      };

      // Remember name/symbol locally (the logo is too large for localStorage).
      saveLocalToken({
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        decimals: tokenDecimals,
        supply,
        createdAt: token.createdAt,
      });

      setCreatedToken(token);
      notify("Token created successfully.", "success");
      walletTokens.refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      console.error("Token creation error:", error);
      const message = friendlyError(error);
      setCreateError(message);
      notify(message, "error");
    } finally {
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
        {page === "create" && !createdToken && (
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
                        account and mints the full supply to you. Your wallet pays the network fee and account rent.
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
                    <button className="primary" type="button" disabled={isCreating} onClick={createToken}>
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
        {page === "create" && createdToken && (
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
          <Liquidity walletTokens={walletTokens} initialMint={liquidityMint} onNavigate={navigate} />
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
          <button type="button" onClick={() => navigate("create")}>Create</button>
          <button type="button" onClick={() => navigate("tokens")}>My Tokens</button>
          <button type="button" onClick={() => navigate("liquidity")}>Liquidity</button>
          <button type="button" onClick={() => navigate("help")}>Help</button>
        </div>
        <small>© 2026 BALNEX. All rights reserved.</small>
      </footer>
    </div>
  );
}
