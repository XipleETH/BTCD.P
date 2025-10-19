# BTC Dominance Perps (Prototype)

Aviso: Este repositorio es un prototipo educativo no auditado. No usar en producción ni con fondos reales.

## Estructura
- `packages/contracts`: Contratos (Hardhat)
- `packages/frontend`: dApp (Vite + React + RainbowKit/wagmi)

## Requisitos
- Node.js 18+ y npm
- Una clave privada con fondos en Base Sepolia para pruebas
- RPCs:
  - Base Sepolia: https://sepolia.base.org
  - Base mainnet: https://mainnet.base.org

## Instalación
1. Instalar dependencias
```
npm install
```

2. Variables de entorno (contratos)
Copia `packages/contracts/.env.example` a `.env` y rellena:
```
PRIVATE_KEY=0x...
BASE_SEPOLIA_RPC=https://sepolia.base.org
BASE_MAINNET_RPC=https://mainnet.base.org
BASESCAN_API_KEY=...
```

## Compilar y testear contratos
```
cd packages/contracts
npx hardhat compile
npx hardhat test
```

## Desplegar a Base Sepolia
```
cd packages/contracts
npx hardhat run scripts/deploy.ts --network baseSepolia
```
Anota las direcciones de Oracle y Perps que imprime el script.

## Oráculo con CoinGecko (BTC Dominance)
El oráculo puede alimentarse con los datos públicos de CoinGecko (`/api/v3/global`, campo `data.market_cap_percentage.btc`).

1. Configura `ORACLE` en `packages/contracts/.env` con la dirección del oráculo desplegado. Opcionalmente ajusta `CG_INTERVAL_SEC`.
2. Ejecuta un push puntual:
```
cd packages/contracts
npm run push:cg -- --network baseSepolia
```
3. Ejecuta el daemon (cada N segundos):
```
cd packages/contracts
npm run daemon:cg -- --network baseSepolia
```
Nota: el endpoint de CoinGecko tiene límites de rate. Ajusta el intervalo si recibes 429. Recomendado: 15s para mantener la UI fluida.

Puedes configurar intervalo y umbral mínimo de cambio en `packages/contracts/.env`:
```
CG_INTERVAL_SEC=15   # cada 15 segundos (la UI hace polling cada ~15s)
MIN_CHANGE=0.01      # 1 basis point (0.01%) para evitar pushes redundantes
```
Ten en cuenta que intervalos muy cortos (p.ej., 1 segundo) podrían gatillar rate limits y/o gas innecesario. Se recomienda 15–60s y habilitar `MIN_CHANGE`.

## Nuevo mercado: Local/Away (goles en vivo)
Este mercado agrega +1 por cada gol del equipo local y -1 por cada gol del visitante sobre todos los partidos en vivo, partiendo del índice 10000.

Componentes:
- `LocalAwayOracle.sol` (1e8, >0): oráculo push-based
- `LocalAwayPerps.sol`: perps sin límites superiores para stops
- Endpoint Edge `packages/frontend/api/football-live-goals.ts`: consulta API-Football v3
- Daemon `packages/contracts/scripts/localaway-daemon.ts`: lee el endpoint, computa índice y hace push on-chain

Configurar entorno:
- En Vercel (frontend): `API_FOOTBALL_KEY` y opcional `API_SECRET`.
- En Railway u host del daemon: `LOCALAWAY_ORACLE`, `LOCALAWAY_PRIVATE_KEY`, `API_BASE` (URL pública del endpoint Edge), `API_SECRET` (si definido en Vercel), `INGEST_URL`, `INGEST_SECRET`, `CHAIN=base-sepolia`, `MARKET=localaway`.

Despliegue:
```
cd packages/contracts
npm run deploy:localaway -- --network baseSepolia
```
Otorga updater al signer del daemon:
```
# set KIND=localaway ORACLE=<addr> UPDATER=<daemon_signer>
npm run grant-updater:localaway -- --network baseSepolia
```
Daemon:
```
npm run daemon:localaway -- --network baseSepolia
```
Frontend: ver pestaña Local/Away (#localaway) junto a BTC.D y Random.

## Iniciar frontend
```
cd ../../packages/frontend
npm run dev
```
Abre http://localhost:5173 y:
- Conecta tu wallet a Base Sepolia
- Pega las direcciones de Oracle y Perps
- Observa la gráfica de TradingView (BTC.D) y abre/cierra posiciones

## Nota sobre el oráculo
El contrato `BTCDOracle` es actualizable por cuentas con rol `updater`. En producción deberías reemplazarlo por un oráculo descentralizado (Chainlink/UMA/Pyth) o un relayer confiable que tome BTC.D de un feed verificable.

## Riesgos/Limitaciones
- Cálculo de PnL lineal simple sobre índice porcentual 0-100
- Sin fondos de contraparte ni AMM; los pagos salen del margen de cada posición
- Liquidación basada en mantenimiento 6.25% y tarifa de liquidación 0.5%
- Colateral en ETH (Base); no hay soporte multi-colateral

