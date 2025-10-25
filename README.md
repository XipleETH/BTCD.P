# Perp‑it — Turn anything into a market

Una DEX de futuros perpetuos donde los precios vienen de algoritmos y APIs del mundo real, no de order books. Tradea índices sintéticos como BTC Dominance, deportes (Home/Away) o incluso un índice Random. Stakea ETH al tesoro on‑chain y “sé la casa”.

## Qué hace
- Long/short perps (hasta 150x) sobre índices guiados por datos: BTC.D, Home/Away, Random.
- Stake de ETH al Treasury (bloqueo 1 mes) para respaldar PnL y ganar fees.
- Proponer y votar nuevos mercados en el Perp Lab; la idea ganadora se despliega como Test PERP.

## Cómo funciona
- Oráculos publican valores on‑chain; velas pre‑agregadas con continuidad determinística.
- En testnet: workers Web2 + Redis para ingerir datos y pushear actualizaciones.
- Plan mainnet: Chainlink (Functions/Data Feeds + Automation) para updates verificables.
- Riesgo integrado: SL/TP (absoluto/relativo), auto‑chequeo de liquidación, alerta de solvencia al cerrar.
- UI mobile‑first con gráficas responsivas y banners de eventos/números.

## Problemas que resuelve
- Resistencia a manipulación: precios de matemática abierta y oráculos neutrales (no de libros finos).
- Sin riesgo de rug/token: se tradean valores de datos, no tokens ilíquidos.
- Menos wash trading e insiders: el movimiento viene de datos externos; traders no mueven la gráfica.
- Iteración veloz: propuestas de comunidad → Test PERPs → validación rápida en Base.

## Stack tecnológico
- Blockchain: Base, Base Sepolia (EVM); contratos Perps + Oracle
- Web3: wagmi, viem, RainbowKit (WalletConnect)
- Frontend: React, TypeScript, Vite, TanStack Query, Lightweight Charts
- Infra (test): Railway workers/scripts, Upstash Redis, API REST (VITE_API_BASE)
- Oráculos (plan): Chainlink Functions/Data Feeds + Automation
- Deploy: Vercel (frontend)

## Flujos clave
- Trading: conecta wallet → elige índice → setea leverage/margen → abrir/cerrar
- Treasury: Stake on treasury → el ETH queda staked por un mes (toast visible)
- Perp Lab: envía fórmula/API + spec → firma y vota → la idea top va a testnet

