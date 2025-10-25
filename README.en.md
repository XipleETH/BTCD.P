# Perp‑it — Turn anything into a market

A decentralized futures exchange for perpetuals where prices come from algorithms and real‑world APIs, not order books. Trade synthetic indices like BTC Dominance, sports (Home/Away), or even a Random index. Stake ETH to the on‑chain treasury and “be the house.”

## What it does
- Trade long/short perps (up to 150x) on data‑driven indices: BTC.D, Home/Away, Random.
- Stake ETH into the Treasury (locked 1 month) to back PnL and earn fees.
- Propose and vote new markets in the Perp Lab; the winning idea deploys as a Test PERP.

## How it works
- Oracles publish index values on‑chain; candles are pre‑aggregated with deterministic continuity.
- Testnet infra uses Web2 workers + Redis to ingest data and push oracle updates.
- Mainnet plan: Chainlink (Functions/Data Feeds + Automation) for decentralized, verifiable updates.
- Built‑in risk tooling: SL/TP (absolute/relative), liquidation self‑check, solvency warning on close.
- Mobile‑first UI with responsive charts and event/number banners.

## Problems it solves
- Manipulation‑resistant: prices from open math and neutral oracles (not thin order books).
- No token rug/illiquidity risk: you trade data values, not illiquid tokens.
- Reduces wash‑trading/insider games: movement is driven by external data; traders can’t move the chart.
- Faster iteration: community proposals → Test PERPs → rapid validation on Base.

## Tech stack
- Blockchain: Base, Base Sepolia (EVM); Perps + Oracle contracts
- Web3: wagmi, viem, RainbowKit (WalletConnect)
- Frontend: React, TypeScript, Vite, TanStack Query, Lightweight Charts
- Infra (test): Railway workers/scripts, Upstash Redis, REST API (VITE_API_BASE)
- Oracles (plan): Chainlink Functions/Data Feeds + Automation
- Deploy: Vercel (frontend)

## Key flows
- Trade: connect wallet → choose index → set leverage/margin → open/close
- Treasury: Stake on treasury → ETH is staked for one month (visible toast)
- Perp Lab: submit formula/API + spec → sign and vote → top idea deploys to testnet
