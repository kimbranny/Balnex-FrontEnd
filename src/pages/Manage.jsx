import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useConnectSheet } from "../components/WalletSheet";
import { PublicKey, Transaction } from "@solana/web3.js";
import { AuthorityType, createSetAuthorityInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useToast } from "../components/Toast";
import { explorerAddress, friendlyError, shorten } from "../lib/utils";

const AUTHORITY_LABEL = {
  [AuthorityType.MintTokens]: "mint",
  [AuthorityType.FreezeAccount]: "freeze",
};

export default function Manage({ walletTokens, onNavigate, onUseForLiquidity }) {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();
  const { open: openConnect } = useConnectSheet();
  const notify = useToast();
  const { tokens, loading, error, refresh } = walletTokens;

  const [busyKey, setBusyKey] = useState("");
  const [confirming, setConfirming] = useState(null);

  async function revoke(token, authorityType) {
    if (!publicKey || !signTransaction) {
      notify("Reconnect Phantom — your wallet cannot sign transactions.", "error");
      return;
    }

    const label = AUTHORITY_LABEL[authorityType];
    const key = `${token.mint}:${label}`;
    setBusyKey(key);

    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction();
      transaction.feePayer = publicKey;
      transaction.recentBlockhash = latest.blockhash;
      transaction.add(
        createSetAuthorityInstruction(
          new PublicKey(token.mint),
          publicKey,
          authorityType,
          null,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      const signed = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error("The transaction failed on-chain. The authority was not revoked.");
      }

      notify(`${label[0].toUpperCase()}${label.slice(1)} authority revoked.`, "success");
      setConfirming(null);
      await refresh();
    } catch (err) {
      console.error("Revoke authority error:", err);
      notify(friendlyError(err), "error");
    } finally {
      setBusyKey("");
    }
  }

  if (!connected) {
    return (
      <section className="panel">
        <span className="eyebrow">TOKEN MANAGEMENT</span>
        <h2>My Tokens</h2>
        <p className="muted">Connect your wallet to see the tokens it holds and manage their authorities.</p>
        <button className="primary" type="button" onClick={() => openConnect()}>
          Connect Wallet <span>→</span>
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">TOKEN MANAGEMENT</span>
          <h2>My Tokens</h2>
          <p className="muted">SPL tokens in your wallet. Revoke authorities you control, or add liquidity.</p>
        </div>
        <button className="secondary-button compact" type="button" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="notice notice-error">
          <div>
            <strong>Couldn't load your tokens</strong>
            <p>{error}</p>
          </div>
          <button className="text-button" type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {loading && tokens.length === 0 && (
        <div className="skeleton-list" aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {!loading && !error && tokens.length === 0 && (
        <div className="empty-state">
          <strong>No tokens yet</strong>
          <p>This wallet doesn't hold any SPL tokens on this network.</p>
          <button className="primary" type="button" onClick={() => onNavigate("create")}>
            Create a token <span>→</span>
          </button>
        </div>
      )}

      <div className="token-list">
        {tokens.map((token) => {
          const wallet = publicKey?.toBase58();
          const canRevokeMint = token.mintAuthority && token.mintAuthority === wallet;
          const canRevokeFreeze = token.freezeAuthority && token.freezeAuthority === wallet;
          const title = token.name ? `${token.name}${token.symbol ? ` ($${token.symbol})` : ""}` : shorten(token.mint, 6, 6);

          return (
            <article className="token-card" key={token.mint}>
              <div className="token-card-head">
                <div className="token-avatar">{(token.symbol || token.name || "T").slice(0, 1).toUpperCase()}</div>
                <div className="token-info">
                  <strong>{title}</strong>
                  <a href={explorerAddress(token.mint)} target="_blank" rel="noopener noreferrer">
                    {shorten(token.mint, 6, 6)} ↗
                  </a>
                </div>
                <div className="token-balance">
                  <strong>{token.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong>
                  <small>balance</small>
                </div>
              </div>

              <div className="authority-row">
                <div>
                  <span>Mint authority</span>
                  <strong className={token.mintAuthority ? "status-open" : "status-revoked"}>
                    {token.mintAuthority ? (canRevokeMint ? "You control it" : shorten(token.mintAuthority)) : "Revoked"}
                  </strong>
                </div>
                {canRevokeMint && (
                  confirming === `${token.mint}:mint` ? (
                    <div className="confirm-inline">
                      <button
                        type="button"
                        className="danger-button"
                        disabled={busyKey === `${token.mint}:mint`}
                        onClick={() => revoke(token, AuthorityType.MintTokens)}
                      >
                        {busyKey === `${token.mint}:mint` ? "Revoking…" : "Confirm revoke"}
                      </button>
                      <button type="button" className="text-button" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={Boolean(busyKey)}
                      onClick={() => setConfirming(`${token.mint}:mint`)}
                    >
                      Revoke
                    </button>
                  )
                )}
              </div>

              <div className="authority-row">
                <div>
                  <span>Freeze authority</span>
                  <strong className={token.freezeAuthority ? "status-open" : "status-revoked"}>
                    {token.freezeAuthority ? (canRevokeFreeze ? "You control it" : shorten(token.freezeAuthority)) : "Revoked"}
                  </strong>
                </div>
                {canRevokeFreeze && (
                  confirming === `${token.mint}:freeze` ? (
                    <div className="confirm-inline">
                      <button
                        type="button"
                        className="danger-button"
                        disabled={busyKey === `${token.mint}:freeze`}
                        onClick={() => revoke(token, AuthorityType.FreezeAccount)}
                      >
                        {busyKey === `${token.mint}:freeze` ? "Revoking…" : "Confirm revoke"}
                      </button>
                      <button type="button" className="text-button" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={Boolean(busyKey)}
                      onClick={() => setConfirming(`${token.mint}:freeze`)}
                    >
                      Revoke
                    </button>
                  )
                )}
              </div>

              {(canRevokeMint || canRevokeFreeze) && confirming?.startsWith(token.mint) && (
                <p className="helper warning-text">Revoking is permanent. It cannot be undone once confirmed on-chain.</p>
              )}

              <div className="token-actions">
                <button type="button" className="secondary-button compact" onClick={() => onUseForLiquidity(token.mint)}>
                  Add liquidity →
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
