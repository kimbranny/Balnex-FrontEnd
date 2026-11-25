
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'

import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react'

import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { clusterApiUrl } from '@solana/web3.js'

import '@solana/wallet-adapter-react-ui/styles.css'
import './index.css'

const endpoint = clusterApiUrl('devnet')

// Set Buffer before loading App.jsx and its Solana SPL Token imports.
globalThis.Buffer = Buffer

async function startApp() {
  const { default: App } = await import('./App.jsx')

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={[]} autoConnect>
          <WalletModalProvider>
            <App />
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </StrictMode>,
  )
}

startApp()
