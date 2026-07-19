# Bridge Rescue — On-Chain Risk Suite

Detects stuck or failed cross-chain bridge transfers and returns a clear
recovery path (claim on destination chain, retry, or source-chain refund)
across Across, Stargate, Arbitrum, Synapse, and OKX Bridge.

Pay-per-call A2MCP agent on OKX.AI. Part of the On-Chain Risk Suite
(Token Trust Score #4945 + Approval Guardian #5003).

## Stack
- Node.js + TypeScript + Express
- x402 payment gating (USDT, X Layer `eip155:196`) via `@okxweb3/x402-*`
- Read-only public RPC (ethers v6) — no API keys for data
- onchainos CLI for registration

## Endpoints
- `POST /v1/bridge-rescue/preview` — free preview
- `POST /v1/bridge-rescue` — paid recovery path ($0.01 USDT, x402)
- `GET /.well-known/agent.json` — agent card
- `GET /health` — healthcheck

## Run locally
```bash
cp .env.example .env   # fill OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE
npm install
npm run build
npm start
```

## Deploy
Railway: `railway.toml` provided. Set the same env vars as `.env.example`
in the Railway dashboard, then deploy. The server fails fast if OKX
facilitator credentials are missing — x402 enforcement is unconditional.

## Register (onchainos)
```bash
node scripts/do-register.cjs
```
