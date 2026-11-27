import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSolBalance } from "../lib/useSolBalance";
import { explorerAddress, friendlyWalletError, shorten } from "../lib/utils";
import { useToast } from "./Toast";
import { useConnectSheet } from "./WalletSheet";

// Header wallet control: "Connect Wallet" when disconnected, otherwise the
// address with a menu showing the real SOL balance, copy, explorer and disconnect.
export default function WalletMenu() {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { open } = useConnectSheet();
  const notify = useToast();
  const { sol, loading, error, refresh } = useSolBalance();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!connected) setMenuOpen(false);
  }, [connected]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => event.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!connected || !publicKey) {
    return (
      <button className="wallet" type="button" onClick={open} disabled={connecting}>
        {connecting ? (
          <>
            <span className="spinner" aria-hidden="true" /> Connecting…
          </>
        ) : (
          <>
            <span className="wallet-dot" aria-hidden="true" /> Connect Wallet
          </>
        )}
      </button>
    );
  }

  const address = publicKey.toBase58();

  async function handleDisconnect() {
    try {
      await disconnect();
      notify("Wallet disconnected.", "info");
    } catch (err) {
      notify(friendlyWalletError(err), "error");
    }
    setMenuOpen(false);
  }

  function copyAddress() {
    navigator.clipboard?.writeText(address).then(
      () => notify("Wallet address copied.", "success"),
      () => notify("Couldn't copy automatically.", "error")
    );
  }

  return (
    <div className="wallet-wrap">
      <button
        className="wallet"
        type="button"
        onClick={() => setMenuOpen((current) => !current)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        {wallet?.adapter.icon ? (
          <img className="wallet-icon" src={wallet.adapter.icon} alt={wallet.adapter.name} />
        ) : (
          <span className="wallet-dot on" aria-hidden="true" />
        )}
        {shorten(address)}
      </button>

      {menuOpen && (
        <>
          <div className="wallet-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="wallet-menu" role="menu">
            <div className="wallet-menu-head">
              <span>{wallet?.adapter.name || "Wallet"}</span>
              <strong>{shorten(address, 6, 6)}</strong>
            </div>

            <div className="wallet-balance">
              <span>SOL balance</span>
              <strong>
                {sol === null
                  ? loading
                    ? "Loading…"
                    : "—"
                  : `${sol.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`}
              </strong>
              {error && <small className="warning-text">{error}</small>}
            </div>

            <button type="button" className="wallet-menu-item" role="menuitem" onClick={copyAddress}>
              Copy address
            </button>
            <a
              className="wallet-menu-item"
              role="menuitem"
              href={explorerAddress(address)}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on explorer ↗
            </a>
            <button type="button" className="wallet-menu-item" role="menuitem" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh balance"}
            </button>
            <button type="button" className="wallet-menu-item danger" role="menuitem" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}
