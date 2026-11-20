import { ExchangeClient, HttpTransport, InfoClient, TransportError } from "@nktkas/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AGENT_NAME, AGENT_VALIDITY_MS, ORDER_EXPIRES_MS, type NetworkConfig, type NetworkName } from "./config";
import type { Wallet } from "./wallet";

export type Info = InfoClient;
export type MetaAndCtx = Awaited<ReturnType<InfoClient["metaAndAssetCtxs"]>>;
export type Clearinghouse = Awaited<ReturnType<InfoClient["clearinghouseState"]>>;
export type SpotState = Awaited<ReturnType<InfoClient["spotClearinghouseState"]>>;
export type OpenOrders = Awaited<ReturnType<InfoClient["openOrders"]>>;
/** The API can also return "dexAbstraction", which the SDK type omits. */
export type Abstraction = Awaited<ReturnType<InfoClient["userAbstraction"]>> | "dexAbstraction";

export { TransportError };

export interface Asset {
  /** Network these indices belong to. Asset indices differ between mainnet and testnet! */
  net: NetworkName;
  index: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  delisted: boolean;
  markPx: number;
  midPx: number;
}

export function makeTransport(net: NetworkConfig) {
  return new HttpTransport({ isTestnet: net.isTestnet });
}

export function makeInfo(net: NetworkConfig): InfoClient {
  return new InfoClient({ transport: makeTransport(net) });
}

/** Exchange client signed by MetaMask — used for user-signed actions (withdraw, transfers, approveAgent). */
export function makeUserExchange(net: NetworkConfig, w: Wallet): ExchangeClient {
  return new ExchangeClient({ transport: makeTransport(net), wallet: w.client });
}

/** Exchange client signed by the local agent key — used for L1 actions (orders, leverage, cancel). */
export function makeAgentExchange(net: NetworkConfig, agent: StoredAgent): ExchangeClient {
  if (agent.net !== net.name) throw new Error("Internal: agent belongs to a different network.");
  return new ExchangeClient({ transport: makeTransport(net), wallet: privateKeyToAccount(agent.key) });
}

export function parseAssets(mc: MetaAndCtx, net: NetworkName): Asset[] {
  const [meta, ctxs] = mc;
  return meta.universe.map((u, i) => {
    const ctx = ctxs[i];
    const mark = Number(ctx?.markPx ?? 0);
    const mid = ctx?.midPx != null ? Number(ctx.midPx) : mark;
    return {
      net,
      index: i,
      name: u.name,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      onlyIsolated: !!u.onlyIsolated || u.marginMode === "strictIsolated" || u.marginMode === "noCross",
      delisted: !!u.isDelisted,
      markPx: mark,
      midPx: mid,
    };
  });
}

/** Fresh mid price for one coin (allMids, weight 2). Throws if unavailable. */
export async function fetchMid(info: InfoClient, coin: string): Promise<number> {
  const mids = (await info.allMids()) as Record<string, string>;
  const px = Number(mids[coin]);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`No live mid price for ${coin}.`);
  return px;
}

/** True when an error means "we don't know whether the server executed it" (timeout / network). */
export function isUnknownOutcome(e: unknown): boolean {
  // Walk the whole cause chain: viem wraps transport failures (e.g. ContractFunctionExecutionError → HttpRequestError).
  const UNKNOWN = new Set(["TimeoutError", "AbortError", "HttpRequestError", "WebSocketRequestError", "RpcRequestError", "TransportError"]);
  for (let c: unknown = e, depth = 0; c && depth < 10; c = (c as { cause?: unknown }).cause, depth++) {
    if (c instanceof TransportError) return true;
    if (UNKNOWN.has((c as { name?: string }).name ?? "")) return true;
    if (c instanceof TypeError && /fetch|network/i.test(c.message)) return true; // browser fetch network failure
  }
  return false;
}

/**
 * Round a price UP to the nearest valid Hyperliquid perp tick (≤ 5 significant figures, ≤ 6 − szDecimals decimals,
 * integers always allowed). Used for SELL bounds so a sell never executes below the price the user accepted.
 * (The SDK's formatPrice always truncates, which is the safe direction for BUY bounds only.)
 */
export function roundPriceUp(px: number, szDecimals: number): string {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error(`Invalid price ${px}`);
  const down = formatPrice(px, szDecimals, "perp");
  if (Number(down) >= px) return down;
  const intDigits = Math.floor(Math.log10(px)) + 1;
  // ≥ 5 integer digits: only integer prices are valid → plain ceiling (integers are always allowed).
  if (intDigits >= 5) return String(Math.ceil(px));
  const d = Math.max(0, Math.min(Math.max(0, 6 - szDecimals), 5 - intDigits));
  const f = 10 ** d;
  // Direct ceiling at d decimals (scaled value < 1e5, so a 1e-7 epsilon only absorbs float noise).
  let n = Math.ceil(px * f - 1e-7);
  let s = formatPrice((n / f).toFixed(d), szDecimals, "perp");
  while (Number(s) < px) {
    n += 1;
    s = formatPrice((n / f).toFixed(d), szDecimals, "perp");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Agent ("API wallet") management
// ---------------------------------------------------------------------------

export interface StoredAgent {
  key: `0x${string}`;
  address: `0x${string}`;
  validUntil: number;
  /** Master account this agent was approved for. */
  user: `0x${string}`;
  net: NetworkName;
}

const agentStorageKey = (net: NetworkConfig, user: string) => `hlcontrol:agent:${net.name}:${user.toLowerCase()}`;

/**
 * Agent keys live ONLY in sessionStorage: this tab, gone when it closes; other tabs/pages on the same origin can't read it.
 * Older versions could persist keys in localStorage — those are deleted on sight and never used.
 */
export function loadAgent(net: NetworkConfig, user: `0x${string}`): StoredAgent | null {
  const k = agentStorageKey(net, user);
  purgeLegacyPersistedKeys();
  try {
    const raw = sessionStorage.getItem(k);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<StoredAgent>;
    if (!a.key || !a.address || !a.validUntil || Date.now() > a.validUntil) return null;
    // Sanity check the key matches the stored address.
    if (privateKeyToAccount(a.key).address.toLowerCase() !== a.address.toLowerCase()) return null;
    return { key: a.key, address: a.address, validUntil: a.validUntil, user, net: net.name };
  } catch {
    return null;
  }
}

/** Returns how many legacy plaintext keys were removed from localStorage. */
export function purgeLegacyPersistedKeys(): number {
  let n = 0;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith("hlcontrol:agent:")) {
      localStorage.removeItem(k);
      n++;
    }
  }
  return n;
}

export function forgetAgent(net: NetworkConfig, user: string) {
  sessionStorage.removeItem(agentStorageKey(net, user));
}

/**
 * Generate a fresh agent key and approve it with MetaMask (one EIP-712 signature).
 * Agents can place/cancel orders and change leverage; they can NOT withdraw to external addresses.
 * Re-approving with the same name replaces (revokes) the previous agent of that name.
 */
export async function approveNewAgent(net: NetworkConfig, w: Wallet): Promise<StoredAgent> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  // Tab-only key → short server-side lifetime too, so a forgotten approval dies quickly.
  const validUntil = Date.now() + AGENT_VALIDITY_MS;
  await makeUserExchange(net, w).approveAgent({
    agentAddress: address,
    agentName: `${AGENT_NAME} valid_until ${validUntil}`,
  });
  const stored: StoredAgent = { key, address, validUntil, user: w.address, net: net.name };
  sessionStorage.setItem(agentStorageKey(net, w.address), JSON.stringify({ key, address, validUntil }));
  return stored;
}

/**
 * Revoke our named agent by replacing it with a throwaway key that is never stored,
 * set to expire almost immediately so no keyless agent lingers in the slot.
 */
export async function revokeAgent(net: NetworkConfig, w: Wallet): Promise<void> {
  const throwaway = privateKeyToAccount(generatePrivateKey()).address;
  await makeUserExchange(net, w).approveAgent({
    agentAddress: throwaway,
    agentName: `${AGENT_NAME} valid_until ${Date.now() + 2 * 60_000}`,
  });
  forgetAgent(net, w.address);
}

/** true = approved & valid on the server, false = not approved, null = couldn't check. */
export async function isAgentApproved(info: InfoClient, user: `0x${string}`, agent: `0x${string}`): Promise<boolean | null> {
  try {
    const agents = await info.extraAgents({ user });
    const hit = agents.find((a) => a.address.toLowerCase() === agent.toLowerCase());
    if (!hit) return false;
    return hit.validUntil == null || hit.validUntil > Date.now();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderRequest {
  asset: Asset;
  isBuy: boolean;
  /** Size in coin units. */
  size: number | string;
  reduceOnly: boolean;
  /** GTC limit price. If undefined → market (aggressive IOC at refPx ± slippage). */
  limitPx?: number;
  /** Reference (fresh mid) price for market orders. */
  refPx: number;
  slippagePct: number;
}

export interface BuiltOrder {
  asset: Asset;
  isBuy: boolean;
  reduceOnly: boolean;
  price: string;
  size: string;
  tif: "Ioc" | "Gtc";
}

export function buildOrder(req: OrderRequest): BuiltOrder {
  const size = formatSize(req.size, req.asset.szDecimals);
  if (!(Number(size) > 0)) throw new Error("Size rounds to 0 for this asset.");
  let rawPx: number;
  let tif: "Ioc" | "Gtc";
  if (req.limitPx != null) {
    rawPx = req.limitPx;
    tif = "Gtc";
  } else {
    if (!(req.refPx > 0)) throw new Error(`No price available for ${req.asset.name}.`);
    const slip = req.slippagePct / 100;
    rawPx = req.isBuy ? req.refPx * (1 + slip) : req.refPx * (1 - slip);
    tif = "Ioc";
  }
  return {
    asset: req.asset,
    isBuy: req.isBuy,
    reduceOnly: req.reduceOnly,
    // Buy bound rounds down (never pay more), sell bound rounds up (never receive less).
    price: req.isBuy ? formatPrice(rawPx, req.asset.szDecimals, "perp") : roundPriceUp(rawPx, req.asset.szDecimals),
    size,
    tif,
  };
}

/** Send exactly the order that was shown to / confirmed by the user. */
export async function sendOrder(ex: ExchangeClient, o: BuiltOrder) {
  const res = await ex.order(
    {
      orders: [
        {
          a: o.asset.index,
          b: o.isBuy,
          p: o.price,
          s: o.size,
          r: o.reduceOnly,
          t: { limit: { tif: o.tif } },
        },
      ],
      grouping: "na",
    },
    // If the request is delayed (network hiccup), the server rejects it instead of executing it late.
    { expiresAfter: Date.now() + ORDER_EXPIRES_MS },
  );
  return res.response.data.statuses[0];
}
