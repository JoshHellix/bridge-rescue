// Registers Bridge Rescue via onchainos CLI, passing the --service JSON
// as a real argv element (no shell word-splitting).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const CLI = "C:\\Users\\dell\\onchainos-bin\\onchainos.exe";
const service = JSON.parse(fs.readFileSync("scripts/service-draft.json", "utf8"));

const args = [
    "agent", "create",
    "--role", "asp",
    "--name", "Bridge Rescue",
    "--description",
    "Detects stuck or failed cross-chain bridge transfers and returns a clear recovery path " +
    "(claim on destination chain, retry, or source-chain refund) across Across, Stargate, " +
    "Arbitrum, Synapse, and OKX Bridge. Part of the On-Chain Risk Suite.",
    "--picture",
    "https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/facb8b69-1f28-4a44-9c58-c140cb8cfdba.png",
    "--service", JSON.stringify(service),
];

const out = execFileSync(CLI, args, { encoding: "utf8" });
console.log(out);
