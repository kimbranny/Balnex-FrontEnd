import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { friendlyWalletError } from "../lib/utils";

const SheetContext = createContext({ open: () => {}, close: () => {} });

// eslint-disable-next-line react-refresh/only-export-components
export function useConnectSheet() {
  return useContext(SheetContext);
}

const isMobileWallet = (wallet) => /mobile wallet adapter/i.test(wallet.adapter.name);
const isPhantom = (wallet) => /^phantom$/i.test(wallet.adapter.name);
const isMobileBrowser = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const canConnect = (wallet) =>
  wallet.readyState === WalletReadyState.Installed || wallet.readyState === WalletReadyState.Loadable;

// Opens this exact page inside Phantom's in-app browser, where Phantom is injected.
function phantomBrowseLink() {
  const url = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  return `https://phantom.app/ul/browse/${url}?ref=${ref}`;
}

function WalletSheet({ onClose }) {
  const { wallets, wallet, select, connect, connected, connecting } = useWallet();
  const [error, setError] = useState("");
  const [activeName, setActiveName] = useState("");
  const pendingName = useRef("");

  useEffect(() => {
    if (connected) onClose();
  }, [connected, onClose]);

  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const runConnect = useCallback(async () => {
    try {
      await connect();
    } catch (err) {
      console.error("Wallet connect error:", err);
      setError(friendlyWalletError(err));
      setActiveName("");
    }
  }, [connect]);

  // After select() swaps the active wallet, start the connection once.
  useEffect(() => {
    if (pendingName.current && wallet?.adapter.name === pendingName.current) {
      pendingName.current = "";
      runConnect();
    }
  }, [wallet, runConnect]);

  function choose(target) {
    setError("");
    setActiveName(target.adapter.name);
    if (wallet?.adapter.name === target.adapter.name) {
      runConnect();
    } else {
      pendingName.current = target.adapter.name;
      select(target.adapter.name);
    }
  }

  const phantom = wallets.find(isPhantom);
  const mobileAdapter = wallets.find(isMobileWallet);
  const otherInstalled = wallets.filter(
    (item) => !isPhantom(item) && !isMobileWallet(item) && item.readyState === WalletReadyState.Installed
  );
  const phantomReady = phantom && canConnect(phantom);
  const mobile = isMobileBrowser();

  function renderOption(item, tag) {
    const busy = activeName === item.adapter.name;
    return (
      <button
        key={item.adapter.name}
        type="button"
        className="wallet-option"
        disabled={connecting}
        onClick={() => choose(item)}
      >
        {item.adapter.icon ? <img src={item.adapter.icon} alt="" /> : <span className="wallet-option-fallback" />}
        <span className="wallet-option-name">{item.adapter.name}</span>
        <span className="wallet-option-tag">{busy ? "Connecting…" : tag}</span>
      </button>
    );
  }

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h2>Connect wallet</h2>
            <p className="muted">Connect a Solana wallet to create and manage tokens.</p>
          </div>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {phantomReady ? (
          renderOption(phantom, "Detected")
        ) : (
          <div className="wallet-option-group">
            <div className="wallet-option static">
              {phantom?.adapter.icon ? <img src={phantom.adapter.icon} alt="" /> : <span className="wallet-option-fallback" />}
              <span className="wallet-option-name">Phantom</span>
              <span className="wallet-option-tag">Not detected</span>
            </div>
            {mobile ? (
              <a className="primary" href={phantomBrowseLink()}>
                Open in Phantom app <span>→</span>
              </a>
            ) : (
              <a className="primary" href="https://phantom.app/download" target="_blank" rel="noopener noreferrer">
                Install Phantom <span>→</span>
              </a>
            )}
            <small className="helper">
              {mobile
                ? "Opens BALNEX inside Phantom's browser, where your wallet connects directly. Don't have Phantom? The link takes you to the install page."
                : "Already installed? Unlock Phantom and refresh this page."}
            </small>
          </div>
        )}

        {otherInstalled.map((item) => renderOption(item, "Detected"))}

        {mobileAdapter && (
          <>
            <div className="sheet-divider">More options</div>
            {renderOption(mobileAdapter, "Android")}
          </>
        )}

        {error && (
          <div className="notice notice-error" role="alert">
            <div>
              <strong>Couldn't connect</strong>
              <p>{error}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function WalletSheetProvider({ children }) {
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <SheetContext.Provider value={value}>
      {children}
      {visible && <WalletSheet onClose={close} />}
    </SheetContext.Provider>
  );
}
