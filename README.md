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

## Nuevo mercado: Home/Away (goles en vivo)
Este mercado agrega +1 por cada gol del equipo local y -1 por cada gol del visitante sobre todos los partidos en vivo, partiendo del índice 10000.

Componentes:
- `LocalAwayOracle.sol` (1e8, >0): oráculo push-based
- `LocalAwayPerps.sol`: perps sin límites superiores para stops
- Endpoint Edge `packages/frontend/api/football-live-goals.ts`: consulta API-Football v3
- Daemon `packages/contracts/scripts/localaway-daemon.ts`: lee el endpoint, computa índice y hace push on-chain

Configurar entorno:
- En Vercel (frontend): `API_FOOTBALL_KEY` y opcional `API_SECRET`.
- En Railway u host del daemon: `LOCALAWAY_ORACLE`, `LOCALAWAY_PRIVATE_KEY`, `API_BASE` (URL pública del endpoint Edge), `API_SECRET` (si definido en Vercel), `INGEST_URL`, `INGEST_SECRET`, `CHAIN=base-sepolia`, `MARKET=localaway`.
  - Opcional para reducir consumo de API: `LEAGUES` (CSV de IDs de ligas, p.ej. `39,140,135,78`), `INTERVAL_MS` (base, por defecto 60000), `MAX_INTERVAL_MS` (backoff máx, por defecto 300000).

Optimización de llamadas a API-Football:
- El endpoint Edge soporta `?leagues=...` para limitar fixtures y `?lite=1` para no pedir eventos por partido; además mantiene un caché en memoria de 10s por combinación de filtros.
- El daemon usa el modo `lite` y calcula deltas a partir de los marcadores (home/away) en lugar de consultar eventos, y aplica backoff dinámico hasta `MAX_INTERVAL_MS` cuando no hay goles nuevos.
- Recomendado: configurar `LEAGUES` con las ligas que realmente te interesan (EPL=39, LaLiga=140, Serie A=135, Bundesliga=78, etc.) y mantener `INTERVAL_MS` en 60s con `MAX_INTERVAL_MS` en 300–600s.

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
Frontend: ver pestaña Home/Away (#localaway) junto a BTC.D y Random.

### Modo multi-deporte (una sola llamada por verificación)

Para reducir llamadas y ampliar cobertura, existe un agregador de deportes que consolida fútbol, básquet, vóley y handball en una única respuesta:

- Endpoint (Edge): `/api/sports-live` (existe tanto en la raíz como en `packages/frontend/api` para Vercel).
- Input: `?secret=<API_SECRET opcional>&chain=base-sepolia`
- Output: `{ ts, chain, items: [...], summary: { football, basketball, volleyball, handball } }`
- Comportamiento: actualiza snapshots `btcd:last:<sport>:<fixture>` en Redis y devuelve solo los ítems que tienen delta desde la última llamada. No escribe eventos ni ticks (eso lo hace el daemon vía `/api/ingest`).

Configurar el daemon para usar el agregador:

- En Railway: `API_BASE=https://<tu-vercel>.vercel.app/api/sports-live`
- Opcionales:
  - `AGGREGATOR_FALLBACK_LEGACY=true` (por defecto) → si no hay deltas por N ciclos, hace un sondeo fútbol “legacy” una vez.
  - `AGGREGATOR_FALLBACK_EMPTY_CYCLES=3` → N ciclos vacíos antes del fallback.
  - `PUSH_EVERY_TICK=false` → evita escribir “ticks” sin actividad (menos ruido en eventos).

Persistencia y eventos recientes:

- El endpoint `/api/ingest` ahora sólo guarda en la lista de eventos los sucesos “reales” (no guarda `meta.type = tick`).
- Límite de retención configurable con `EVENTS_MAX` (por defecto 5000) en Vercel/Railway.
- El UI (tarjeta “Eventos (recientes)”) fusiona resultados por `meta.id` estable para evitar parpadeos.

Variables de entorno relevantes (Vercel/Railway):

- `API_FOOTBALL_KEY`: clave de API-Sports (se reutiliza para básquet/vóley/handball).
- `API_SECRET`: secreto opcional para proteger las rutas Edge.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`: Redis (Upstash).
- `EVENTS_MAX`: tamaño máximo de la lista de eventos (recomendado 5000+).
- `INGEST_URL` / `INGEST_SECRET`: para que el daemon sincronice ticks/eventos.
- `LAST_URL`: (opcional) espejo de `/api/last` para snapshots al reiniciar.

Verificación rápida:

1) Asegúrate de tener partidos en vivo (fútbol u otros). 2) Llama a `/api/sports-live?secret=...` y revisa `summary`. 3) En Railway, los logs del daemon mostrarán, cuando no haya deltas, algo como:

```
aggregator: no deltas. live summary -> football:12 basket:4 volley:0 hand:2 (emptyCycles=1)
```

Cuando haya deltas, verás líneas por deporte con `ΔH`, `ΔA` y `netPct` aplicados y el `tx` on-chain.

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

