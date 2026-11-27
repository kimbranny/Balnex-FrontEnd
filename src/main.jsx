import { StrictMode, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'

import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react'

import './index.css'
import { ENDPOINT } from './config'
import { friendlyWalletError } from './lib/utils'
import { ToastProvider, useToast } from './components/Toast'
import { WalletSheetProvider } from './components/WalletSheet'

// Set Buffer before loading App.jsx and the Solana wallet/SPL Token imports.
globalThis.Buffer = Buffer

function Providers({ wallets, children }) {
  const notify = useToast()

  // Wallet errors raised outside the connect sheet (auto-connect, signing, disconnect).
  const onError = useCallback(
    (error) => {
      console.error('Wallet error:', error)
      notify(friendlyWalletError(error), 'error')
    },
    [notify],
  )

  return (
    <ConnectionProvider endpoint={ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletSheetProvider>{children}</WalletSheetProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

async function startApp() {
  const [{ default: App }, { PhantomWalletAdapter }] = await Promise.all([
    import('./App.jsx'),
    import('@solana/wallet-adapter-phantom'),
  ])

  // Phantom is registered explicitly so it is always offered. Wallets that
  // support the Wallet Standard (and Mobile Wallet Adapter on Android) are
  // discovered automatically and listed alongside it.
  const wallets = [new PhantomWalletAdapter()]

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ToastProvider>
        <Providers wallets={wallets}>
          <App />
        </Providers>
      </ToastProvider>
    </StrictMode>,
  )
}

startApp()
