/**
 * Bridge Rescue — A2MCP server for OKX.AI.
 *
 * Detects stuck / failed cross-chain bridge transfers and returns a clear
 * recovery path. Pay-per-call via x402 (USDT on X Layer, eip155:196).
 *
 * Companion to Token Trust Score (#4945) and Approval Guardian (#5003) in the
 * On-Chain Risk Suite — this one answers "my bridge funds are stuck, what now?"
 */
import express from "express";
import { config as loadEnv } from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { analyzeBridgeTx, scanWalletBridges } from "./onchainData.js";

loadEnv();

const PORT = Number(process.env.PORT ?? 3000);
const PAY_TO = process.env.PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000000";
const PRICE_USD = process.env.PRICE_USD ?? "0.01";
const RAW_PUBLIC_URL = process.env.PUBLIC_URL;
const PUBLIC_URL =
    RAW_PUBLIC_URL && !RAW_PUBLIC_URL.includes("localhost")
        ? RAW_PUBLIC_URL
        : `http://localhost:${PORT}`;

const XLAYER_NETWORK = "eip155:196";

const usage = { scans: 0, paidCalls: 0, lastCaller: "" as string };

const app = express();
app.use(express.json());
app.use(express.static(`${process.cwd()}/public`));

app.get("/.well-known/agent.json", (req, res) => res.json(agentCard(req)));
app.get("/health", (_req, res) => res.json({ ok: true, service: "bridge-rescue" }));

// x402 enforcement is unconditional. The OKX facilitator requires API
// credentials, so we fail fast at startup if they are missing — the server
// must not silently serve the paid endpoint for free (that failed review).
const OKX_API_KEY = process.env.OKX_API_KEY;
const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY;
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE;
if (!OKX_API_KEY || !OKX_SECRET_KEY || !OKX_PASSPHRASE) {
    throw new Error(
        "[bridge-rescue] Missing OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE. " +
        "x402 enforcement requires the OKX facilitator credentials."
    );
}
const facilitatorClient = new OKXFacilitatorClient({
    apiKey: OKX_API_KEY,
    secretKey: OKX_SECRET_KEY,
    passphrase: OKX_PASSPHRASE,
});
const resourceServer = new x402ResourceServer(facilitatorClient).register(
    XLAYER_NETWORK,
    new ExactEvmScheme()
);
app.use(
    paymentMiddleware(
        {
            "POST /v1/bridge-rescue": {
                accepts: {
                    scheme: "exact",
                    price: `$${PRICE_USD}`,
                    network: XLAYER_NETWORK,
                    payTo: PAY_TO,
                    maxTimeoutSeconds: 60,
                },
                description: "Bridge Rescue — stuck/failed cross-chain transfer recovery",
            },
        },
        resourceServer
    )
);
console.log("[bridge-rescue] x402 enforcement enabled (OKX facilitator).");

app.post("/v1/bridge-rescue", async (req, res) => {
    const { chain = "ethereum", txHash, wallet } = req.body ?? {};
    try {
        let result;
        if (txHash) {
            result = await analyzeBridgeTx(chain, txHash);
        } else if (wallet) {
            const findings = await scanWalletBridges(chain, wallet);
            result = {
                mode: "wallet",
                chain,
                count: findings.length,
                findings,
                summary:
                    findings.length === 0
                        ? "No stuck or failed bridge transfers found in recent history."
                        : `Found ${findings.length} stuck/failed bridge transfer(s).`,
            };
        } else {
            return res
                .status(400)
                .json({ error: "Provide either 'txHash' or 'wallet'." });
        }
        usage.paidCalls += 1;
        usage.lastCaller = req.header("x-agent-id") ?? req.ip ?? "unknown";
        return res.json(result);
    } catch (e: any) {
        return res.status(502).json({ error: e?.message ?? "Bridge analysis failed." });
    }
});

app.post("/v1/bridge-rescue/preview", async (req, res) => {
    const { chain = "ethereum", txHash, wallet } = req.body ?? {};
    if (!txHash && !wallet) {
        return res.status(400).json({ error: "Provide either 'txHash' or 'wallet'." });
    }
    try {
        usage.scans += 1;
        return res.json({
            chain,
            preview: true,
            note: "Preview confirms the endpoint is live. The full recovery path is a paid call.",
            upgrade: {
                endpoint: "/v1/bridge-rescue",
                price: `${PRICE_USD} USDT`,
                paymentStandard: "x402",
            },
        });
    } catch (e: any) {
        return res.status(502).json({ error: e?.message ?? "Preview failed." });
    }
});

app.get("/metrics", (_req, res) => {
    res.json({
        scans: usage.scans,
        paidCalls: usage.paidCalls,
        lastCaller: usage.lastCaller,
        payTo: PAY_TO,
        priceUsd: PRICE_USD,
        network: XLAYER_NETWORK,
    });
});

function agentCard(req?: express.Request) {
    const host = req?.headers.host as string | undefined;
    const proto =
        host && (host.includes("localhost") || host.includes("127.0.0.1"))
            ? "http"
            : "https";
    const base = host ? `${proto}://${host}` : PUBLIC_URL;
    return {
        schema: "okx-a2mcp/v1",
        name: "Bridge Rescue",
        description:
            "Detects stuck or failed cross-chain bridge transfers and returns a clear recovery path " +
            "(claim on destination chain, retry, or source-chain refund) across Across, Stargate, " +
            "Arbitrum, Synapse, and OKX Bridge. Part of the On-Chain Risk Suite.",
        version: "0.1.0",
        endpoints: [
            {
                method: "POST",
                path: "/v1/bridge-rescue/preview",
                contentType: "application/json",
                price: { amount: "0", asset: "USDT", chain: "xlayer", scheme: "free" },
                params: { chain: "string", txHash: "string (0x...)", wallet: "string (0x...)" },
                returns: "Preview confirmation + upgrade info",
            },
            {
                method: "POST",
                path: "/v1/bridge-rescue",
                contentType: "application/json",
                price: { amount: PRICE_USD, asset: "USDT", chain: "xlayer", scheme: "x402" },
                params: { chain: "string", txHash: "string (0x...)", wallet: "string (0x...)" },
                returns: "BridgeFinding { status, recoveryPath, action, bridge, confidence, evidence }",
            },
        ],
        payment: { standard: "x402", facilitator: "OKX", network: XLAYER_NETWORK },
        resource: { url: `${base}/v1/bridge-rescue`, description: "Pay-per-call bridge recovery", mimeType: "application/json" },
    };
}

app.get("/", (_req, res) => {
    res.sendFile("index.html", { root: `${process.cwd()}/public` });
});

app.listen(PORT, () => {
    console.log(`[bridge-rescue] A2MCP listening on :${PORT} @ $${PRICE_USD}/call on ${XLAYER_NETWORK}`);
});
