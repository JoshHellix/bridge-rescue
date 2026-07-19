/**
 * Bridge Rescue — on-chain data layer.
 *
 * Detects stuck / failed cross-chain bridge transfers and resolves the
 * recovery path. Reuses the same free, key-less RPC pattern as the other
 * On-Chain Risk Suite agents (Token Trust Score / Approval Guardian).
 *
 * Supported bridges (read-only, no keys):
 *  - OKX / X Layer native bridge (official OKX Bridge)
 *  - Across
 *  - Stargate / LayerZero
 *  - Arbitrum Bridge
 *  - Polygon PoS Bridge
 *  - Synapse
 *
 * The detector works in two modes:
 *  1. txHash mode: inspect a specific bridge transaction and classify it.
 *  2. wallet mode: scan recent outbound bridge txs for stuck ones.
 */

import { ethers } from "ethers";

const RPCS: Record<string, string> = {
    ethereum: "https://eth.llamarpc.com",
    bsc: "https://bsc-dataseed.bnbchain.org",
    base: "https://mainnet.base.org",
    arbitrum: "https://arb1.arbitrum.io/rpc",
    polygon: "https://polygon-rpc.com",
    xlayer: "https://rpc.xlayer.tech",
    optimism: "https://mainnet.optimism.io",
    avalanche: "https://api.avax.network/ext/bc/C/rpc",
};

// Known bridge contract addresses (lowercase) per chain for quick tagging.
const BRIDGE_CONTRACTS: Record<string, string[]> = {
    ethereum: [
        "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", // Across SpokePool
        "0xae0ecf7a3f3ce4499e906e9bfc0ba50c3e3d0a0e", // Stargate Router
        "0x25ace71c97b33cc4729cf772ae268934f7ab5fa1", // Arbitrum Bridge
        "0x8484ef722627bf18ca5ae6bc6c87121e8d8abf8c", // Synapse
        "0x40ec5b33f54e0e8a33a1b6442c1d9a4c5c1f5e3a", // OKX Bridge (example)
    ],
    arbitrum: [
        "0x4dbd4fc535ac27206064b68ffcf827b4a0664a97", // Arbitrum Bridge
    ],
    polygon: [
        "0x40ec5b33f54e0e8a33a1b6442c1d9a4c5c1f5e3a", // OKX Bridge (example)
    ],
    xlayer: [
        "0x40ec5b33f54e0e8a33a1b6442c1d9a4c5c1f5e3a", // OKX Bridge (example)
    ],
    base: [
        "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", // Across SpokePool
    ],
    bsc: [
        "0x40ec5b33f54e0e8a33a1b6442c1d9a4c5c1f5e3a", // OKX Bridge (example)
    ],
    optimism: [
        "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", // Across SpokePool
    ],
    avalanche: [
        "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", // Across SpokePool
    ],
};

export interface BridgeFinding {
    mode: "txHash" | "wallet";
    chain: string;
    // Classification of the bridge state.
    status: "STUCK" | "FAILED" | "PENDING" | "COMPLETED" | "UNKNOWN";
    // Human-readable recovery path.
    recoveryPath: string;
    // Confidence 0..1 that this is a real stuck bridge.
    confidence: number;
    // The bridge protocol we think handled it.
    bridge: string;
    // Suggested next action (what the user should do / sign).
    action: string;
    // Raw evidence for transparency.
    evidence: string[];
    // Estimated value at risk (best-effort, may be 0 if unknown).
    valueAtRiskUsd: number;
}

function isBridgeContract(chain: string, address: string): string | null {
    const list = BRIDGE_CONTRACTS[chain] ?? [];
    const hit = list.find((c) => c.toLowerCase() === address.toLowerCase());
    if (!hit) return null;
    // Map known addresses to friendly names (best-effort).
    const names: Record<string, string> = {
        "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1": "Across",
        "0xae0ecf7a3f3ce4499e906e9bfc0ba50c3e3d0a0e": "Stargate",
        "0x25ace71c97b33cc4729cf772ae268934f7ab5fa1": "Arbitrum Bridge",
        "0x8484ef722627bf18ca5ae6bc6c87121e8d8abf8c": "Synapse",
        "0x4dbd4fc535ac27206064b68ffcf827b4a0664a97": "Arbitrum Bridge",
        "0x40ec5b33f54e0e8a33a1b6442c1d9a4c5c1f5e3a": "OKX Bridge",
    };
    return names[hit.toLowerCase()] ?? "Unknown Bridge";
}

function classifyReceipt(receipt: ethers.TransactionReceipt | null): BridgeFinding["status"] {
    if (!receipt) return "UNKNOWN";
    if (receipt.status === 0) return "FAILED";
    // If the tx succeeded on the source chain but we can't confirm the
    // destination claim, we treat it as STUCK (the common user complaint).
    return "STUCK";
}

export async function analyzeBridgeTx(
    chain: string,
    txHash: string
): Promise<BridgeFinding> {
    if (!RPCS[chain]) {
        throw new Error(`Unsupported chain: ${chain}. Supported: ${Object.keys(RPCS).join(", ")}`);
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        throw new Error(`Invalid tx hash: ${txHash}`);
    }

    const provider = new ethers.JsonRpcProvider(RPCS[chain]);
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
        return {
            mode: "txHash",
            chain,
            status: "UNKNOWN",
            recoveryPath: "Transaction not found on this chain. Double-check the chain and hash.",
            confidence: 0.2,
            bridge: "Unknown",
            action: "Verify the chain selector and re-paste the hash.",
            evidence: ["No transaction returned from RPC."],
            valueAtRiskUsd: 0,
        };
    }

    const bridgeName = tx.to ? isBridgeContract(chain, tx.to) : null;
    const receipt = await provider.getTransactionReceipt(txHash);
    const status = classifyReceipt(receipt as ethers.TransactionReceipt | null);

    const evidence: string[] = [];
    if (bridgeName) evidence.push(`Routed through ${bridgeName} contract.`);
    else evidence.push("Destination contract is not a known bridge; may be a direct transfer.");
    if (tx.value) evidence.push(`Bridged value: ${ethers.formatEther(tx.value)} ETH-equivalent.`);

    let recoveryPath: string;
    let action: string;
    let confidence: number;

    if (status === "FAILED") {
        recoveryPath =
            "The source bridge transaction reverted. Funds never left your wallet on the source chain. " +
            "No recovery needed — simply retry the bridge with higher gas or after the bridge resumes.";
        action = "Retry the bridge from your wallet. No funds are lost.";
        confidence = 0.9;
    } else if (status === "STUCK") {
        recoveryPath =
            "The source transfer succeeded but the destination claim is missing. For most bridges " +
            "(Across, Stargate, OKX, Arbitrum, Synapse) you can manually claim the funds on the " +
            "destination chain using the bridge's official claim page, or wait for the relayer. " +
            "If the bridge supports refunds, request a source-chain refund.";
        action =
            "Open the bridge's official claim UI on the destination chain and connect the same wallet, " +
            "OR use the bridge's 'claim' function with this tx hash.";
        confidence = bridgeName ? 0.85 : 0.5;
    } else {
        recoveryPath = "Transaction completed successfully. No recovery needed.";
        action = "None.";
        confidence = 0.7;
    }

    return {
        mode: "txHash",
        chain,
        status,
        recoveryPath,
        confidence,
        bridge: bridgeName ?? "Unknown",
        action,
        evidence,
        valueAtRiskUsd: tx.value ? Number(ethers.formatEther(tx.value)) * 2500 : 0,
    };
}

export async function scanWalletBridges(
    chain: string,
    wallet: string
): Promise<BridgeFinding[]> {
    if (!ethers.isAddress(wallet)) {
        throw new Error(`Invalid wallet address: ${wallet}`);
    }
    if (!RPCS[chain]) {
        throw new Error(`Unsupported chain: ${chain}. Supported: ${Object.keys(RPCS).join(", ")}`);
    }

    const provider = new ethers.JsonRpcProvider(RPCS[chain]);
    const latest = await provider.getBlockNumber();
    // Scan a bounded recent window to keep RPC load reasonable.
    const fromBlock = Math.max(0, latest - 800);
    const findings: BridgeFinding[] = [];

    for (let b = fromBlock; b <= latest; b += 1) {
        const block = await provider.getBlock(b, false);
        if (!block || !block.transactions) continue;
        for (const hash of block.transactions) {
            const tx = await provider.getTransaction(hash);
            if (!tx || !tx.to) continue;
            if (tx.from.toLowerCase() !== wallet.toLowerCase()) continue;
            const bridgeName = isBridgeContract(chain, tx.to);
            if (!bridgeName) continue;
            const receipt = await provider.getTransactionReceipt(hash);
            const status = classifyReceipt(receipt as ethers.TransactionReceipt | null);
            if (status !== "STUCK" && status !== "FAILED") continue;

            findings.push({
                mode: "wallet",
                chain,
                status,
                recoveryPath:
                    status === "FAILED"
                        ? "Source tx reverted; retry the bridge."
                        : "Claim on destination chain via the bridge's official UI.",
                confidence: 0.8,
                bridge: bridgeName,
                action:
                    status === "FAILED"
                        ? "Retry the bridge."
                        : `Claim with tx ${tx.hash} on the destination chain.`,
                evidence: [`Bridge tx ${tx.hash} (${bridgeName}) on ${chain}.`],
                valueAtRiskUsd: tx.value ? Number(ethers.formatEther(tx.value)) * 2500 : 0,
            });
            if (findings.length >= 25) break;
        }
        if (findings.length >= 25) break;
    }

    return findings;
}
