# Runtime: Node 20 slim
FROM node:20-slim

WORKDIR /app

# Install git (if needed for npm) and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package manifests (root and contracts workspace)
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json

# Install only needed workspaces
RUN npm ci --omit=dev && npm i --workspace packages/contracts --omit=dev --no-audit --no-fund

# Copy source
COPY packages/contracts packages/contracts

# Build contracts TS if needed (hardhat compile also sets types)
RUN npx --yes hardhat --version && npm -w packages/contracts run build

# Default envs
ENV CG_INTERVAL_SEC=15 \
    MIN_CHANGE=0 \
    EXCLUDE_STABLES=true

# Start daemon
CMD ["npm", "-w", "packages/contracts", "run", "daemon:cg"]
