import { arbitrum, arbitrumSepolia, type Chain } from "viem/chains";

export type NetworkName = "mainnet" | "testnet";

export interface NetworkConfig {
  name: NetworkName;
  isTestnet: boolean;
  /** Arbitrum chain used for deposits (Hyperliquid Bridge2). */
  chain: Chain;
  rpcUrl: string;
  /** Native USDC on Arbitrum (the ONLY token the bridge credits). */
  usdc: `0x${string}`;
  /** Hyperliquid Bridge2 contract. Sending USDC here credits the SENDER's Hyperliquid account. */
  bridge: `0x${string}`;
  explorerTx: (hash: string) => string;
  /** Address page filtered to token transfers — used when a deposit's tx hash is unknown. */
  explorerAddrTokens: (addr: string) => string;
}

// Addresses from https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2
// (verified on-chain: contracts have code, USDC tokens report 6 decimals).
export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  mainnet: {
    name: "mainnet",
    isTestnet: false,
    chain: arbitrum,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
    explorerTx: (h) => `https://arbiscan.io/tx/${h}`,
    explorerAddrTokens: (a) => `https://arbiscan.io/address/${a}#tokentxns`,
  },
  testnet: {
    name: "testnet",
    isTestnet: true,
    chain: arbitrumSepolia,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
    explorerTx: (h) => `https://sepolia.arbiscan.io/tx/${h}`,
    explorerAddrTokens: (a) => `https://sepolia.arbiscan.io/address/${a}#tokentxns`,
  },
};

/** Deposits below this are NOT credited and are lost forever (per Hyperliquid docs). */
export const MIN_DEPOSIT_USDC = 5;
/** Hyperliquid charges a flat fee on withdrawals to Arbitrum. */
export const WITHDRAW_FEE_USDC = 1;
/** Hyperliquid minimum order value (USD notional) for opening orders. */
export const MIN_ORDER_NOTIONAL = 10;

/** Named agent so we never clobber the official frontend's (unnamed) agent wallet. */
export const AGENT_NAME = "hlcontrol";
/** Agent approval lifetime (key is kept for this browser tab only). */
export const AGENT_VALIDITY_MS = 24 * 60 * 60 * 1000;
/** Leverage updates also expire, so a timed-out one can't apply later. */
export const LEVERAGE_EXPIRES_MS = 20_000;
/** Orders not processed within this window are rejected by the server (avoids late execution after a timeout). */
export const ORDER_EXPIRES_MS = 20_000;
/** Market-order slippage used by Close/25%/50% if the form field is empty/invalid. */
export const DEFAULT_SLIPPAGE_PCT = 1;
/** Abort a market order if the mid moved more than this fraction of the slippage while the user was confirming. */
export const MAX_DRIFT_FRACTION_OF_SLIPPAGE = 0.5;
/** Meta (asset list / indices) is re-fetched at least this often. */
export const META_TTL_MS = 60_000;
/** Refuse to trade on data older than this. */
export const MAX_DATA_AGE_MS = 15_000;
