
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
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
import {
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import "./App.css";

export default function App() {
  const { connection } = useConnection();
  const {
    publicKey,
    connected,
    disconnect,
    signTransaction,
  } = useWallet();
  const { setVisible } = useWalletModal();

  function handleWalletClick() {
    if (connected) {
      disconnect();
    } else {
      setVisible(true);
    }
  }

  const walletAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : "";

  const [page, setPage] = useState("create");
  const [menuOpen, setMenuOpen] = useState(false);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [supply, setSupply] = useState("1000000000");
  const [decimals, setDecimals] = useState("9");
  const [mintAuthority, setMintAuthority] = useState("revoke");
  const [freezeAuthority, setFreezeAuthority] = useState("revoke");

  const [image, setImage] = useState(null);
  const [tokenCreated, setTokenCreated] = useState(false);
  const [tokenAmount, setTokenAmount] = useState("");
  const [selectedTokenPercentage, setSelectedTokenPercentage] = useState("");
  const [solAmount, setSolAmount] = useState("");
  const [createStep, setCreateStep] = useState(1);
  const [tradingFee, setTradingFee] = useState("1");
  const [firstBuy, setFirstBuy] = useState("");

  const [mintAddress, setMintAddress] = useState("");
  const [tokenAccountAddress, setTokenAccountAddress] = useState("");
  const [transactionSignature, setTransactionSignature] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [faqOpen, setFaqOpen] = useState(null);

  const navigation = [
    { id: "create", label: "Create Token", icon: "＋" },
    { id: "how", label: "How to Use", icon: "▤" },
    { id: "faq", label: "FAQ", icon: "?" },
    { id: "liquidity", label: "Manage Liquidity", icon: "◈" }
  ];

  function navigate(destination) {
    setPage(destination);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      alert("Please upload a PNG, JPG or WEBP image.");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      alert("Please choose an image smaller than 2MB.");
      return;
    }

    const reader = new FileReader();

    reader.onload = () => setImage(reader.result);
    reader.readAsDataURL(file);
  }

  function selectTokenPercentage(percentage) {
    const totalSupply = Number(supply);
    if (!Number.isFinite(totalSupply) || totalSupply <= 0) return;

    const precision = Math.min(Math.max(Number(decimals) || 0, 0), 9);
    const amount = (totalSupply * percentage) / 100;
    setSelectedTokenPercentage(String(percentage));
    const formattedAmount = amount.toFixed(precision);
    setTokenAmount(formattedAmount.includes(".") ? formattedAmount.replace(/0+$/, "").replace(/\.$/, "") : formattedAmount);
  }

  async function createToken() {
    if (!name.trim() || !symbol.trim() || !supply || Number(supply) <= 0) {
      alert("Please complete all required fields.");
      return;
    }

    if (!/^\d+$/.test(supply) || !Number.isSafeInteger(Number(supply))) {
      alert("Please enter a whole-number token supply within the supported limit.");
      return;
    }

    if (!connected || !publicKey) {
      alert("Please connect your Phantom wallet first.");
      setVisible(true);
      return;
    }

    if (!signTransaction) {
      alert("Your connected wallet does not support transaction signing. Please reconnect Phantom.");
      return;
    }

    if (tokenCreated) {
      alert("This token has already been created.");
      return;
    }

    setIsCreating(true);
    setCreateError("");

    try {
      // Generate a new mint account for this token.
      const mintKeypair = Keypair.generate();

      // Convert the whole-number supply into the smallest token units.
      const tokenDecimals = Number(decimals);
      const baseUnits = BigInt(supply) * (10n ** BigInt(tokenDecimals));

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

      // Submit the signed transaction to Solana Devnet.
      const signature = await connection.sendRawTransaction(
        signedTransaction.serialize(),
        {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        }
      );

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

      // Save the confirmed token details.
      setMintAddress(mintKeypair.publicKey.toBase58());
      setTokenAccountAddress(associatedTokenAccount.toBase58());
      setTransactionSignature(signature);
      setTokenCreated(true);

      // Continue to the existing liquidity page.
      navigate("liquidity");

    } catch (error) {
      console.error("Token creation error:", error);

      const message = error?.message || "An unexpected error occurred.";

      setCreateError(message);

      alert(`Token creation failed:\n${message}`);

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
    setTokenCreated(false);
    setTokenAmount("");
    setSelectedTokenPercentage("");
    setSolAmount("");
    setCreateStep(1);
    setTradingFee("1");
    setFirstBuy("");
    setMintAddress("");
    setTokenAccountAddress("");
    setTransactionSignature("");
    setCreateError("");
    navigate("create");
  }

  const faqs = [
    {
      question: "What is BALNEX?",
      answer: "BALNEX is a Solana token creation and liquidity management platform currently under development."
    },
    {
      question: "Which blockchain does BALNEX support?",
      answer: "Our first supported blockchain is Solana."
    },
    {
      question: "Do I need a wallet?",
      answer: "Yes. A compatible Solana wallet such as Phantom is required to approve blockchain transactions."
    },
    {
      question: "What is token supply?",
      answer: "Token supply is the number of tokens initially created for your project."
    },
    {
      question: "What are mint and freeze authorities?",
      answer: "Mint authority controls whether additional tokens can be created. Freeze authority controls whether token accounts can be frozen."
    },
    {
      question: "What is Raydium liquidity?",
      answer: "Liquidity allows people to swap your token against another asset, such as SOL, through a supported Raydium pool."
    },
    {
      question: "Does BALNEX create real tokens?",
      answer: "BALNEX now supports real SPL token creation on the configured Solana Devnet. Raydium liquidity creation and on-chain token metadata are separate integrations."
    }
  ];

  return (
    <div className="app">

      {/* HEADER */}

      <header className="navbar">
        <div className="nav-left">

          <button
            className="menu-toggle"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
          >
            {menuOpen ? "✕" : "☰"}
          </button>

          <div className="brand" onClick={() => navigate("create")}>
            <span className="brand-icon">B</span>
            BALNEX<span className="brand-dot">.</span>
          </div>

        </div>

        <button
          className="wallet"
          onClick={handleWalletClick}
          title={connected ? "Click to disconnect wallet" : "Connect your Solana wallet"}
        >
          <span>◉</span>
          {connected ? walletAddress : "Connect Wallet"}
        </button>
      </header>

      {/* DROPDOWN NAVIGATION */}

      {menuOpen && (
        <>
          <div
            className="menu-backdrop"
            onClick={() => setMenuOpen(false)}
          />

          <nav className="nav-links">
            <div className="menu-heading">NAVIGATION</div>

            {navigation.map((item) => (
              <button
                key={item.id}
                className={page === item.id ? "nav-item selected" : "nav-item"}
                onClick={() => navigate(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
                <span className="nav-arrow">›</span>
              </button>
            ))}

            <div className="menu-footer">
              BALNEX · SOLANA ECOSYSTEM
            </div>
          </nav>
        </>
      )}

      {/* MAIN CONTENT */}

      <main className="main">

        {/* INTRO */}

        <section className="intro">
          <div className="status">
            <span className="status-dot" />
            SOLANA TOKEN LAUNCHPAD
          </div>

          <h1>
            Launch Your Own
            <span> Token.</span>
          </h1>

          <p>
            Create tokens on Solana.
            Simple, fast and transparent.
          </p>
        </section>

        {/* CREATE TOKEN — GUIDED, ONE STEP AT A TIME */}

        {page === "create" && (
          <section className="panel guided-panel">
            <div className="panel-top">
              <div>
                <span className="eyebrow">TOKEN CREATOR</span>
                <h2>Create Your Token</h2>
                <p className="muted">A simple, guided launch process. Complete each step to continue.</p>
              </div>
              <div className="panel-icon">✦</div>
            </div>

            <div className="guided-progress">
              <div className="guided-progress-meta"><span>STEP {createStep} OF 5</span><span>{Math.round(createStep / 5 * 100)}% COMPLETE</span></div>
              <div className="guided-progress-track"><span style={{ width: `${createStep / 5 * 100}%` }} /></div>
              <div className="guided-step-labels"><span className={createStep >= 1 ? "current" : ""}>Details</span><span className={createStep >= 2 ? "current" : ""}>Authorities</span><span className={createStep >= 3 ? "current" : ""}>Trading fee</span><span className={createStep >= 4 ? "current" : ""}>First buy</span><span className={createStep >= 5 ? "current" : ""}>Review</span></div>
            </div>

            {createStep === 1 && (
              <div className="guided-step">
                <div className="section-heading"><span>01</span> Token details</div>
                <p className="step-description">First, give your token its identity and set its supply.</p>
                <div className="field"><label htmlFor="token-name">Token Name *</label><input id="token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Project Token" maxLength={32} /><small className="helper">Maximum 32 characters.</small></div>
                <div className="field"><label htmlFor="token-symbol">Token Symbol *</label><input id="token-symbol" value={symbol ? `$${symbol}` : ""} onChange={(e) => setSymbol(e.target.value.replace(/\$/g, "").toUpperCase())} placeholder="$TOKEN" maxLength={11} /><small className="helper">Maximum 10 characters.</small></div>
                <div className="field"><label htmlFor="token-description">Description</label><textarea id="token-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Tell people about your project..." rows={3} maxLength={500} /><small className="helper">{description.length}/500 characters</small></div>
                <div className="field"><label>Token Logo</label><label className="upload">{image ? <><img src={image} alt="Token logo preview" /><strong>Change image</strong></> : <><span className="upload-icon">↑</span><strong>Upload your token logo</strong><small>PNG, JPG or WEBP · Maximum 2MB</small></>}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImage} hidden /></label></div>
                <div className="two-fields"><div className="field"><label htmlFor="supply">Total Supply *</label><input id="supply" type="number" min="1" step="1" value={supply} onChange={(e) => setSupply(e.target.value)} /></div><div className="field"><label htmlFor="decimals">Decimals</label><select id="decimals" value={decimals} onChange={(e) => setDecimals(e.target.value)}><option value="9">9</option><option value="6">6</option><option value="2">2</option><option value="0">0</option></select></div></div>
                <button className="primary" type="button" onClick={() => { if (!name.trim() || !symbol.trim() || !supply || Number(supply) <= 0) { alert("Enter a token name, symbol and valid supply to continue."); return; } if (!/^\d+$/.test(supply) || !Number.isSafeInteger(Number(supply))) { alert("Please enter a whole-number token supply within the supported limit."); return; } setCreateStep(2); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Continue to Authorities <span>→</span></button>
              </div>
            )}

            {createStep === 2 && (
              <div className="guided-step">
                <div className="section-heading"><span>02</span> Authority settings</div>
                <p className="step-description">Choose whether you want to keep control of minting and freezing tokens after launch.</p>
                <div className="authority-setting"><div className="authority-copy"><label htmlFor="mint-authority">Mint Authority</label><p className="helper">{mintAuthority === "revoke" ? "Will be revoked after token creation. You will not be able to mint more tokens." : "Will be retained so you can mint more tokens later."}</p></div><label className="switch" htmlFor="mint-authority"><input id="mint-authority" type="checkbox" role="switch" checked={mintAuthority === "revoke"} onChange={(e) => setMintAuthority(e.target.checked ? "revoke" : "retain")} aria-label="Revoke mint authority after creation" /><span className="switch-slider" /></label></div>
                <div className="authority-setting"><div className="authority-copy"><label htmlFor="freeze-authority">Freeze Authority</label><p className="helper">{freezeAuthority === "revoke" ? "Will be revoked after token creation." : "Will be retained so you can manage account freezing."}</p></div><label className="switch" htmlFor="freeze-authority"><input id="freeze-authority" type="checkbox" role="switch" checked={freezeAuthority === "revoke"} onChange={(e) => setFreezeAuthority(e.target.checked ? "revoke" : "retain")} aria-label="Revoke freeze authority after creation" /><span className="switch-slider" /></label></div>
                <div className="notice"><span className="notice-icon">ⓘ</span><div><strong>Choose carefully</strong><p>Revoking an authority is generally irreversible once the on-chain transaction is confirmed.</p></div></div>
                <div className="guided-actions"><button className="secondary-button" type="button" onClick={() => setCreateStep(1)}>← Back</button><button className="primary" type="button" onClick={() => setCreateStep(3)}>Continue to Trading Fee <span>→</span></button></div>
              </div>
            )}

            {createStep === 3 && (
              <div className="guided-step">
                <div className="section-heading"><span>03</span> Trading fee</div>
                <p className="step-description">Choose the trading fee setting for your launch. The creator share shown here follows the reference fee schedule and must be supported by the selected launch protocol.</p>
                <div className="fee-options">{[{value:"1",share:"0.375%"},{value:"2",share:"0.5%"},{value:"2.5",share:"0.5%"}].map((option) => <button type="button" key={option.value} className={`fee-option ${tradingFee === option.value ? "selected" : ""}`} onClick={() => setTradingFee(option.value)}><strong>{option.value}%</strong><span>You get {option.share} of each trade</span></button>)}</div>
                <div className="notice"><span className="notice-icon">ⓘ</span><div><strong>Fee configuration preview</strong><p>Actual fee collection depends on the launch and liquidity protocol. This selection is saved in the frontend preview only; no fee settings are submitted on-chain yet.</p></div></div>
                <div className="guided-actions"><button className="secondary-button" type="button" onClick={() => setCreateStep(2)}>← Back</button><button className="primary" type="button" onClick={() => setCreateStep(4)}>Continue to First Buy <span>→</span></button></div>
              </div>
            )}

            {createStep === 4 && (
              <div className="guided-step">
                <div className="section-heading"><span>04</span> First buy</div>
                <p className="step-description">Enter the amount of SOL you want to commit to the first buy during launch. This step is required to continue.</p>
                <div className="field"><label htmlFor="first-buy">SOL amount <span className="required-mark">*</span></label><div className="amount-input"><input id="first-buy" type="number" min="0.000000001" step="any" required value={firstBuy} onChange={(e) => setFirstBuy(e.target.value)} placeholder="Enter SOL amount" /><span>SOL</span></div></div>
                <div className="quick-amounts">{["0.1","0.5","1"].map((amount) => <button type="button" key={amount} className={firstBuy === amount ? "chosen" : ""} onClick={() => setFirstBuy(amount)}>{amount} SOL</button>)}</div>
                <div className="notice"><span className="notice-icon">ⓘ</span><div><strong>Required launch commitment</strong><p>You must enter a SOL amount before reviewing your launch. This amount is saved as a launch setting but is not charged during token creation.</p></div></div>
                <div className="guided-actions"><button className="secondary-button" type="button" onClick={() => setCreateStep(3)}>← Back</button><button className="primary" type="button" onClick={() => { if (!Number.isFinite(Number(firstBuy)) || Number(firstBuy) <= 0) { alert("Please enter a SOL amount greater than 0 to continue."); return; } setCreateStep(5); }}>Review Launch <span>→</span></button></div>
              </div>
            )}

            {createStep === 5 && (
              <div className="guided-step">
                <div className="section-heading"><span>05</span> Review your launch</div>
                <p className="step-description">Check your choices before continuing. You can go back and change any setting.</p>
                <div className="launch-review">
                  <div className="review-token">{image ? <img src={image} alt="" /> : <span>{symbol.slice(0,1) || "B"}</span>}<div><strong>{name} ({symbol ? `$${symbol}` : ""})</strong><small>{description || "No description added"}</small></div></div>
                  <div className="review-row"><span>Total supply</span><strong>{Number(supply || 0).toLocaleString()}</strong></div>
                  <div className="review-row"><span>Decimals</span><strong>{decimals}</strong></div>
                  <div className="review-row"><span>Mint authority</span><strong>{mintAuthority === "revoke" ? "Revoke" : "Retain"}</strong></div>
                  <div className="review-row"><span>Freeze authority</span><strong>{freezeAuthority === "revoke" ? "Revoke" : "Retain"}</strong></div>
                  <div className="review-row"><span>Trading fee</span><strong>{tradingFee}%</strong></div>
                  <div className="review-row"><span>First buy</span><strong>{Number(firstBuy || 0)} SOL</strong></div>
                </div>
                <div className="notice"><span className="notice-icon">ⓘ</span><div><strong>Ready for Devnet token creation</strong><p>Phantom will ask you to approve a transaction that creates your token, creates your wallet token account and mints the full supply. Your wallet will pay the network fee and mint-account rent. Your first-buy amount and trading fee are not included.</p></div></div>

                {createError && (
                  <div className="notice">
                    <strong>Creation error</strong>
                    <p>{createError}</p>
                  </div>
                )}

                <div className="guided-actions">
                  <button className="secondary-button" type="button" disabled={isCreating} onClick={() => setCreateStep(4)}>← Back</button>
                  <button className="primary" type="button" disabled={isCreating || tokenCreated} onClick={createToken}>
                    {isCreating ? "Creating Token..." : "Create Token on Devnet"}
                    {!isCreating && <span> →</span>}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* MANAGE LIQUIDITY */}

        {page === "liquidity" && (
          <section className="panel">

            <div className="panel-top">
              <div>
                <span className="eyebrow">RAYDIUM INTEGRATION</span>
                <h2>Manage Liquidity</h2>
                <p className="muted">
                  Prepare your token liquidity pool.
                </p>
              </div>
              <div className="panel-icon">◈</div>
            </div>

            {tokenCreated ? (
              <div className="success-banner">
                <span>✓</span>
                <div>
                  <strong>Token successfully created on Devnet!</strong>
                  <p>
                    Your SPL token and initial supply have been confirmed on Solana.
                  </p>

                  <p>
                    <strong>Mint address:</strong><br />
                    <a
                      href={`https://explorer.solana.com/address/${mintAddress}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {mintAddress}
                    </a>
                  </p>

                  <p>
                    <strong>Token account:</strong><br />
                    <a
                      href={`https://explorer.solana.com/address/${tokenAccountAddress}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {tokenAccountAddress}
                    </a>
                  </p>

                  <p>
                    <strong>Transaction:</strong><br />
                    <a
                      href={`https://explorer.solana.com/tx/${transactionSignature}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View confirmed transaction →
                    </a>
                  </p>
                </div>
              </div>
            ) : (
              <div className="notice">
                <strong>No token selected</strong>
                <p>Create a token first to continue to liquidity management.</p>
                <button
                  className="text-button"
                  onClick={() => navigate("create")}
                >
                  Create a token →
                </button>
              </div>
            )}

            {tokenCreated && (
              <>
                <div className="section-heading">
                  Selected Token
                </div>

                <div className="token-preview">
                  <div className="token-avatar">
                    {image ? <img src={image} alt="" /> : "B"}
                  </div>
                  <div className="token-info">
                    <strong>{name} ({symbol ? `$${symbol}` : ""})</strong>
                    <small>Supply: {Number(supply).toLocaleString()}</small>
                    <small>Decimals: {decimals}</small>
                  </div>
                  <span className="preview-tag">DEVNET</span>
                </div>

                {description && (
                  <p className="token-description">{description}</p>
                )}
              </>
            )}

            <div className="section-heading">
              Liquidity Configuration
            </div>

            <div className="field">
              <label>Token Amount</label>
              <p className="helper liquidity-helper">
                Select a percentage of your total token supply to add to the liquidity pool.
              </p>
              <div className="liquidity-percentages" role="group" aria-label="Select token supply percentage">
                {[25, 50, 75, 90].map((percentage) => (
                  <button
                    type="button"
                    key={percentage}
                    className={selectedTokenPercentage === String(percentage) ? "liquidity-percentage selected" : "liquidity-percentage"}
                    aria-pressed={selectedTokenPercentage === String(percentage)}
                    onClick={() => selectTokenPercentage(percentage)}
                    disabled={!tokenCreated || !supply || Number(supply) <= 0}
                  >
                    {percentage}%
                  </button>
                ))}
              </div>
              <input
                id="token-amount"
                type="number"
                min="0"
                max={supply}
                step="any"
                placeholder="Enter token amount"
                value={tokenAmount}
                onChange={(e) => {
                  setTokenAmount(e.target.value);
                  setSelectedTokenPercentage("");
                }}
              />
              <small className="helper">
                Total supply: {Number(supply || 0).toLocaleString()} tokens
                {selectedTokenPercentage ? ` · ${selectedTokenPercentage}% selected` : ""}
              </small>
            </div>

            <div className="field">
              <label htmlFor="sol-amount">SOL Amount</label>
              <input
                id="sol-amount"
                type="number"
                min="0"
                placeholder="Enter SOL amount"
                value={solAmount}
                onChange={(e) => setSolAmount(e.target.value)}
              />
            </div>

            <div className="pool-preview">
              <div>
                <span>Pool type</span>
                <strong>Raydium CPMM</strong>
              </div>
              <div>
                <span>Token amount</span>
                <strong>{tokenAmount || "0"}</strong>
              </div>
              <div>
                <span>SOL amount</span>
                <strong>{solAmount || "0"} SOL</strong>
              </div>
            </div>

            <div className="notice">
              <span className="notice-icon">ⓘ</span>
              <div>
                <strong>Raydium is not connected yet</strong>
                <p>
                  Your token is now created on Devnet. Real pool creation
                  still requires the Raydium CPMM integration and a separate
                  wallet-approved transaction.
                </p>
              </div>
            </div>

            <button
              className="primary"
              disabled={!tokenCreated}
              onClick={() => alert("Raydium CPMM integration is coming next.")}
            >
              Continue to Raydium <span>→</span>
            </button>

            <button
              className="secondary-button"
              onClick={() => navigate("create")}
            >
              ← Back to Token Creator
            </button>

          </section>
        )}

        {/* HOW TO USE */}

        {page === "how" && (
          <section className="panel">

            <span className="eyebrow">GETTING STARTED</span>
            <h2>How to Use BALNEX</h2>
            <p className="muted">
              Follow these steps to create and prepare your Solana token.
            </p>

            {[
              ["Connect your wallet", "Connect a compatible Solana wallet such as Phantom."],
              ["Enter token information", "Choose your token name, symbol and description."],
              ["Upload your logo", "Add an image to represent your token."],
              ["Configure your supply", "Choose your total supply and decimal precision."],
              ["Set token authorities", "Decide whether to retain or revoke mint and freeze authorities."],
              ["Create your token", "Review your information and approve the Devnet transaction in your wallet."],
              ["Manage liquidity", "Proceed to the Raydium integration to prepare your token and SOL liquidity pool."]
            ].map((item, index) => (
              <div className="guide" key={index}>
                <span className="guide-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <strong>{item[0]}</strong>
                  <p>{item[1]}</p>
                </div>
              </div>
            ))}

            <div className="notice">
              <strong>Important</strong>
              <p>
                Always review transaction details before approving them
                in your wallet. Never share your recovery phrase.
              </p>
            </div>

            <button
              className="primary"
              onClick={() => navigate("create")}
            >
              Start Creating <span>→</span>
            </button>

          </section>
        )}

        {/* FAQ */}

        {page === "faq" && (
          <section className="panel">

            <span className="eyebrow">HELP CENTRE</span>
            <h2>Frequently Asked Questions</h2>
            <p className="muted">
              Answers to common questions about BALNEX.
            </p>

            <div className="faq-list">
              {faqs.map((faq, index) => (
                <div className="faq-item" key={index}>
                  <button
                    className="faq-question"
                    onClick={() =>
                      setFaqOpen(faqOpen === index ? null : index)
                    }
                    aria-expanded={faqOpen === index}
                  >
                    {faq.question}
                    <span>{faqOpen === index ? "−" : "+"}</span>
                  </button>

                  {faqOpen === index && (
                    <div className="faq-answer">
                      {faq.answer}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="notice">
              <strong>Need help?</strong>
              <p>
                BALNEX is under development. More support
                information will be added as the platform grows.
              </p>
            </div>

            <button
              className="primary"
              onClick={() => navigate("create")}
            >
              Create a Token <span>→</span>
            </button>

          </section>
        )}

      </main>

      {/* FOOTER */}

      <footer className="footer">
        <div className="footer-brand">
          BALNEX<span>.</span>
        </div>

        <p>Built for the Solana ecosystem.</p>

        <div className="footer-links">
          <button onClick={() => navigate("create")}>Create Token</button>
          <button onClick={() => navigate("how")}>How to Use</button>
          <button onClick={() => navigate("faq")}>FAQ</button>
        </div>

        <small>© 2026 BALNEX. All rights reserved.</small>
        <small className="development-label">DEVNET DEVELOPMENT</small>
      </footer>

    </div>
  );
}
