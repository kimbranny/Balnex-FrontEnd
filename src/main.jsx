import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'

import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react'

import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'

import '@solana/wallet-adapter-react-ui/styles.css'
import './index.css'
import { ENDPOINT } from './config'
import { ToastProvider } from './components/Toast'

// Set Buffer before loading App.jsx and its Solana SPL Token imports.
globalThis.Buffer = Buffer

async function startApp() {
  const { default: App } = await import('./App.jsx')

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ConnectionProvider endpoint={ENDPOINT}>
        <WalletProvider wallets={[]} autoConnect>
          <WalletModalProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </StrictMode>,
  )
}

startApp()
