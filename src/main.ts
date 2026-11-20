import { formatUnits, parseUnits } from "viem";
import {
  DEFAULT_SLIPPAGE_PCT,
  LEVERAGE_EXPIRES_MS,
  MAX_DRIFT_FRACTION_OF_SLIPPAGE,
  META_TTL_MS,
  MIN_DEPOSIT_USDC,
  MIN_ORDER_NOTIONAL,
  NETWORKS,
  WITHDRAW_FEE_USDC,
  type NetworkConfig,
  type NetworkName,
} from "./config";
import {
  approveNewAgent,
  buildOrder,
  fetchMid,
  isAgentApproved,
  isUnknownOutcome,
  loadAgent,
  makeAgentExchange,
  makeInfo,
  makeUserExchange,
  parseAssets,
  purgeLegacyPersistedKeys,
  revokeAgent,
  sendOrder,
  type Abstraction,
  type Asset,
  type BuiltOrder,
  type Clearinghouse,
  type OpenOrders,
  type SpotState,
  type StoredAgent,
} from "./hl";
import {
  connectWallet,
  DepositUnresolved,
  depositUsdc,
  getUsdcBalance,
  waitForDeposit,
  walletForAccount,
  type PendingDeposit,
  type Wallet,
} from "./wallet";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Position = Clearinghouse["assetPositions"][number]["position"];
type LockName = "wallet" | "agent";

const savedNet = localStorage.getItem("hlcontrol:net");
let net: NetworkConfig = NETWORKS[(savedNet === "testnet" ? "testnet" : "mainnet") as NetworkName];
let info = makeInfo(net);
let wallet: Wallet | null = null;
let walletChainId: number | null = null;
let agent: StoredAgent | null = null;
let agentApproved: boolean | null = null;
let agentCheckedAt = 0;

/** Asset list + the network it was loaded for. Asset indices differ per network. */
let assets: Asset[] = [];
let assetsNet: NetworkName | null = null;
const assetByName = new Map<string, Asset>();
let metaFetchedAt = 0;

let ch: Clearinghouse | null = null;
let spot: SpotState | null = null;
let orders: OpenOrders = [];
let abstraction: Abstraction | null = null;
let arbUsdc: bigint | null = null;
/** Deposit broadcast but not yet resolved. Persisted per network+account so a reload can't lose it. */
let pendingDeposit: PendingDeposit | null = null;
let pendingDepositUnresolved = false;
let abstractionFetchedAt = 0;

let side: "long" | "short" = "long";
const locks: Record<LockName, boolean> = { wallet: false, agent: false };
let refreshing = false;
let refreshQueued = false;
/** Coin whose live leverage setting is currently loaded into the form ("" = none / stale). */
let levSyncedCoin = "";
/**
 * Leverage / margin-mode values the user typed by hand, keyed by network + account + coin, WITH the values.
 * Restored only for that exact context; cleared on any account/network change (resetUserState).
 */
const levOverrides = new Map<string, { leverage: string; mode: string }>();
const levKey = (coin: string) => `${net.name}:${wallet?.address.toLowerCase() ?? "-"}:${coin}`;

let levSyncPromise: Promise<void> | null = null;
let levSyncCoin = "";
/** Increments on every network/account change so stale async results are dropped. */
let epoch = 0;

// ---------------------------------------------------------------------------
// DOM + formatting helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const inp = (id: string) => $<HTMLInputElement>(id);
const sel = (id: string) => $<HTMLSelectElement>(id);

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtUsd = (v: number | string | null | undefined, d = 2) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtNum = (v: number | string | null | undefined, maxD = 6) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxD });
};
/** Signed dollar amount: -$1.23 instead of $-1.23. */
const money = (v: number | string | null | undefined, d = 2) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${fmtUsd(Math.abs(n), d)}`;
};
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sign = (n: number) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
const netTag = () => (net.isTestnet ? "[TESTNET]" : "[MAINNET]");

/** Floor a decimal string/number to `d` decimals, returned as a plain string. */
function floorStr(v: number | string, d: number): string {
  const s = typeof v === "number" ? v.toFixed(12) : v;
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, d).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : (i ?? "0");
}

/**
 * Strict positive-decimal parser. Commas are rejected (not converted): "95,000" must never become 95.
 * Returns the cleaned string and its number.
 */
function parseAmount(raw: string, what: string, maxDecimals?: number): { str: string; n: number } {
  const t = raw.trim();
  if (t.includes(",")) throw new Error(`${what}: use "." as the decimal separator and no thousands separators (got "${t}").`);
  if (!/^\d*\.?\d+$/.test(t)) throw new Error(`${what}: enter a valid positive number.`);
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what}: must be greater than 0.`);
  if (maxDecimals != null && (t.split(".")[1]?.length ?? 0) > maxDecimals) {
    throw new Error(`${what}: at most ${maxDecimals} decimals.`);
  }
  return { str: t, n };
}

function log(msg: string) {
  const el = $("log");
  const ts = new Date().toLocaleTimeString();
  el.textContent = `[${ts}] ${msg}\n` + el.textContent;
}

function banner(msg: string, kind: "ok" | "err" | "info" | "warn" = "info") {
  const b = $("banner");
  b.className = `banner ${kind}`;
  b.textContent = msg;
  if (kind === "ok" || kind === "info") {
    const snap = msg;
    setTimeout(() => {
      if (b.textContent === snap) b.classList.add("hidden");
    }, 10_000);
  }
}

/** True if the wallet user rejected the request. Walks viem's wrapped cause chain. */
function isUserRejection(e: unknown): boolean {
  for (let c: unknown = e, d = 0; c && d < 10; c = (c as { cause?: unknown }).cause, d++) {
    const x = c as { code?: number; name?: string };
    if (x.code === 4001 || x.name === "UserRejectedRequestError") return true;
  }
  return false;
}

/** An action whose result is unknown (may have executed). Shown as a warning, never as "failed". */
class OutcomeUnknown extends Error {}

function errMsg(e: unknown): string {
  if (isUserRejection(e)) return "Request rejected in wallet.";
  const any = e as { shortMessage?: string; details?: string };
  if (any?.shortMessage) return any.shortMessage + (any.details ? `\n${any.details}` : "");
  if (e instanceof Error) {
    let m = e.message;
    const c = e.cause;
    if (c instanceof Error && c.message && !m.includes(c.message)) m += `\n↳ ${c.message}`;
    return m;
  }
  return String(e);
}

class Cancelled extends Error {}

function updateLockUi() {
  const anyBusy = locks.wallet || locks.agent;
  document.body.style.cursor = anyBusy ? "progress" : "";
  sel("network").disabled = anyBusy;
  $<HTMLButtonElement>("connectBtn").disabled = locks.wallet;
  for (const id of ["depositForm", "withdrawForm", "transferForm"]) {
    $(id).querySelectorAll<HTMLButtonElement>("button[type=submit]").forEach((b) => (b.disabled = locks.wallet));
  }
  $<HTMLButtonElement>("orderBtn").disabled = locks.agent;
  renderFundsHints(); // deposit / transfer buttons have extra disable conditions
}

/**
 * Wrap a user action: per-lock single-flight, error banner, log.
 * "wallet" = needs a MetaMask prompt; "agent" = signed locally (orders/cancel), so a stuck
 * MetaMask popup can never block closing a position.
 */
async function action(label: string, lock: LockName, fn: (startEpoch: number) => Promise<string | void>) {
  if (locks[lock]) {
    banner(
      lock === "wallet"
        ? "A wallet action is in progress — finish or reject it in MetaMask first."
        : "An order action is in progress — wait for it to finish.",
      "info",
    );
    return;
  }
  locks[lock] = true;
  updateLockUi();
  const startEpoch = epoch;
  try {
    log(`${label}…`);
    const res = await fn(startEpoch);
    if (res) {
      banner(res, "ok");
      log(`✔ ${res}`);
    }
  } catch (e) {
    if (e instanceof Cancelled) {
      log(`${label}: ${e.message}`);
    } else if (e instanceof OutcomeUnknown) {
      banner(e.message, "warn");
      log(`⚠ ${e.message}`);
      console.error(e);
    } else if (isUnknownOutcome(e)) {
      const m =
        `${label}: OUTCOME UNKNOWN (network error / timeout).\nIt may or may not have executed. ` +
        `Wait ~20 s and check balances, positions and open orders below BEFORE retrying.\n(${errMsg(e)})`;
      banner(m, "warn");
      log(`⚠ ${m}`);
      console.error(e);
    } else {
      const m = errMsg(e);
      banner(`${label} failed:\n${m}`, "err");
      log(`✖ ${label}: ${m}`);
      console.error(e);
    }
  } finally {
    locks[lock] = false;
    updateLockUi();
    void refresh();
  }
}

function requireWallet(): Wallet {
  if (!wallet) throw new Error("Connect your wallet first.");
  return wallet;
}

function requireAgent(): StoredAgent {
  const w = requireWallet();
  if (!agent || agentApproved === false) throw new Error('Trading is not enabled. Click "Enable trading" first.');
  if (agent.user.toLowerCase() !== w.address.toLowerCase() || agent.net !== net.name) {
    throw new Error("Trading key does not match the connected account/network. Reconnect and enable trading again.");
  }
  return agent;
}

/** Throw if the account or network changed since the action started. */
function assertSameContext(startEpoch: number) {
  if (startEpoch !== epoch) throw new Error("Account or network changed during this action — nothing (further) was sent.");
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function setAssets(list: Asset[], forNet: NetworkName) {
  const firstForNet = assetsNet !== forNet;
  assets = list;
  assetsNet = forNet;
  assetByName.clear();
  for (const a of list) assetByName.set(a.name, a);
  if (firstForNet) renderCoinList();
}

function clearAssets() {
  assets = [];
  assetsNet = null;
  assetByName.clear();
  metaFetchedAt = 0;
  renderCoinList();
}

/** Only returns assets loaded for the CURRENT network. */
function findAsset(name: string): Asset | undefined {
  if (assetsNet !== net.name) return undefined;
  const t = name.trim();
  return assetByName.get(t) ?? assets.find((a) => a.name.toLowerCase() === t.toLowerCase());
}

const isUnified = () => abstraction === "unifiedAccount" || abstraction === "portfolioMargin";

/**
 * Re-read account mode + balances right before a mode-dependent fund operation.
 * Commits to global state ONLY if account/network are unchanged (otherwise throws, committing nothing).
 */
async function refreshAccountMode(w: Wallet, startEpoch: number) {
  const n = net;
  const i = info;
  const [m, c, sp] = await Promise.all([
    i.userAbstraction({ user: w.address }).catch(() => null),
    i.clearinghouseState({ user: w.address }),
    i.spotClearinghouseState({ user: w.address }),
  ]);
  if (startEpoch !== epoch || wallet !== w || net !== n) {
    throw new Error("Account or network changed during this action — nothing was sent.");
  }
  abstraction = m as Abstraction | null;
  abstractionFetchedAt = m ? Date.now() : 0;
  ch = c;
  spot = sp;
}

function spotUsdc() {
  const b = spot?.balances.find((x) => x.coin === "USDC");
  const total = Number(b?.total ?? 0);
  const hold = Number(b?.hold ?? 0);
  return { total, hold, free: Math.max(0, total - hold) };
}

/** Best estimate of withdrawable USDC for the account mode. */
function withdrawableUsd(): number {
  if (isUnified()) return spotUsdc().free;
  return Number(ch?.withdrawable ?? 0);
}

async function refresh() {
  if (refreshing) {
    refreshQueued = true; // don't drop it — run again once the current one finishes
    return;
  }
  refreshing = true;
  try {
    do {
      refreshQueued = false;
      await refreshOnce();
    } while (refreshQueued);
  } finally {
    refreshing = false;
  }
}

async function refreshOnce() {
  const myEpoch = epoch;
  const n = net;
  const i = info;
  const w = wallet;
  try {
    if (assetsNet !== n.name || Date.now() - metaFetchedAt > META_TTL_MS) {
      const mc = await i.metaAndAssetCtxs();
      if (myEpoch !== epoch || n !== net) return;
      setAssets(parseAssets(mc, n.name), n.name);
      metaFetchedAt = Date.now();
    } else {
      const mids = (await i.allMids()) as Record<string, string>;
      if (myEpoch !== epoch || n !== net) return;
      for (const a of assets) {
        const m = Number(mids[a.name]);
        if (m > 0) a.midPx = m;
      }
    }

    if (w) {
      const user = w.address;
      const [c, s, o, bal, cid, ab] = await Promise.all([
        i.clearinghouseState({ user }),
        i.spotClearinghouseState({ user }),
        i.openOrders({ user }),
        getUsdcBalance(n, user).catch(() => null),
        w.client.getChainId().catch(() => null),
        abstraction == null || Date.now() - abstractionFetchedAt > 60_000
          ? i.userAbstraction({ user }).then((m) => ((abstractionFetchedAt = Date.now()), m)).catch(() => null)
          : Promise.resolve(abstraction),
      ]);
      if (myEpoch !== epoch || w !== wallet) return;
      ch = c;
      spot = s;
      orders = o;
      arbUsdc = bal;
      walletChainId = cid;
      abstraction = ab as Abstraction | null;

      if (agent && Date.now() - agentCheckedAt > 60_000) {
        const ok = await isAgentApproved(i, user, agent.address);
        if (myEpoch !== epoch) return;
        agentCheckedAt = Date.now();
        if (ok !== null) agentApproved = ok;
      }
    }
    renderAll();
  } catch (e) {
    log(`refresh error: ${errMsg(e)}`);
  }
}

/** Fetch the live position for a coin (never trust the 5 s-old cache for sizing). */
async function freshPosition(user: `0x${string}`, coin: string): Promise<Position | undefined> {
  const c = await info.clearinghouseState({ user });
  return c.assetPositions.find((p) => p.position.coin === coin && Number(p.position.szi) !== 0)?.position;
}

function cachedPosition(coin: string): Position | undefined {
  return ch?.assetPositions.find((p) => p.position.coin === coin && Number(p.position.szi) !== 0)?.position;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCoinList() {
  $("coinList").innerHTML = assets
    .filter((a) => !a.delisted)
    .map((a) => `<option value="${esc(a.name)}">${esc(a.name)} (max ${a.maxLeverage}x)</option>`)
    .join("");
}

function renderAll() {
  renderHeader();
  renderAccount();
  renderFundsHints();
  renderAgent();
  renderPositions();
  renderOrders();
  renderPreview();
}

function renderHeader() {
  const btn = $<HTMLButtonElement>("connectBtn");
  if (!wallet) {
    $("walletInfo").textContent = "";
    btn.textContent = "Connect MetaMask";
    return;
  }
  btn.textContent = "Reconnect";
  const chainName =
    walletChainId == null ? "?" : walletChainId === net.chain.id ? net.chain.name : `chain ${walletChainId}`;
  $("walletInfo").innerHTML =
    `${esc(wallet.name)} · <b>${esc(shortAddr(wallet.address))}</b> · ${esc(chainName)}` +
    ` · ${arbUsdc == null ? "—" : fmtUsd(formatUnits(arbUsdc, 6))} USDC on ${esc(net.chain.name)}`;
}

function renderAccount() {
  const el = $("account");
  if (!wallet || !ch) {
    el.className = "kv muted";
    el.textContent = wallet ? "Loading…" : "Connect your wallet.";
    return;
  }
  const m = ch.marginSummary;
  const s = spotUsdc();
  const upnl = ch.assetPositions.reduce((acc, p) => acc + Number(p.position.unrealizedPnl), 0);
  const rows: [string, string][] = isUnified()
    ? [
        ["USDC balance (unified)", `$${fmtUsd(s.total)}`],
        ["Available / withdrawable ≈", `$${fmtUsd(s.free)}`],
        ["Margin used", `$${fmtUsd(m.totalMarginUsed)}`],
        ["Total position notional", `$${fmtUsd(m.totalNtlPos)}`],
        ["Unrealized PnL", `<span class="${sign(upnl)}">${money(upnl)}</span>`],
      ]
    : [
        ["Perp account value", `$${fmtUsd(m.accountValue)}`],
        ["Withdrawable (perp)", `$${fmtUsd(ch.withdrawable)}`],
        ["Margin used", `$${fmtUsd(m.totalMarginUsed)}`],
        ["Total position notional", `$${fmtUsd(m.totalNtlPos)}`],
        ["Unrealized PnL", `<span class="${sign(upnl)}">${money(upnl)}</span>`],
        ["Spot USDC (free / total)", `$${fmtUsd(s.free)} / $${fmtUsd(s.total)}`],
      ];
  rows.push(["Account mode", esc(abstraction ?? "unknown")]);
  el.className = "kv";
  el.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
}

function renderFundsHints() {
  const s = spotUsdc();
  const unified = isUnified();
  $("depositHint").innerHTML =
    `Sends native USDC on <b>${esc(net.chain.name)}</b> to the Hyperliquid bridge. ` +
    `<span class="warn">Minimum ${MIN_DEPOSIT_USDC} USDC — less is lost forever.</span> Credited to the same address in ~1 min. ` +
    `First time? Send a small test (e.g. 6 USDC) first.` +
    (arbUsdc != null ? `<br>Wallet: ${fmtUsd(formatUnits(arbUsdc, 6))} USDC` : "") +
    (pendingDeposit
      ? `<br><span class="warn">Deposit ${pendingDepositUnresolved ? "UNRESOLVED" : "pending"}: ` +
        `<a href="${esc(pendingLink(net, pendingDeposit))}" target="_blank" rel="noopener noreferrer">${pendingDeposit.hash ? esc(shortAddr(pendingDeposit.hash)) : "tx hash unknown — check your USDC transfers"}</a>` +
        ` — new deposits are blocked until it resolves.</span>` +
        (pendingDepositUnresolved ? ` <button type="button" id="clearPendingDeposit" class="sm">I checked Arbiscan — clear</button>` : "")
      : "");
  $("depositForm").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = locks.wallet || !!pendingDeposit;

  $("withdrawHint").innerHTML =
    `To your connected address on Arbitrum. Fee: $${WITHDRAW_FEE_USDC}. Arrives in ~3–5 min.` +
    (ch ? `<br>Withdrawable${unified ? " ≈" : ""}: $${fmtUsd(withdrawableUsd())}` : "");

  const tBtn = $("transferForm").querySelector<HTMLButtonElement>("button[type=submit]")!;
  tBtn.disabled = locks.wallet || unified;
  $("transferHint").innerHTML = unified
    ? `<span class="warn">Account mode is “${esc(abstraction)}” — spot and perp share one balance; transfers are not needed.</span>`
    : ch
      ? `Perp withdrawable: $${fmtUsd(ch.withdrawable)} · Spot free: $${fmtUsd(s.free)}`
      : "";
}

function renderAgent() {
  const box = $("agentBox");
  if (!wallet) {
    box.innerHTML = `<span class="muted">Connect your wallet to trade.</span>`;
    return;
  }
  if (!agent || agentApproved === false) {
    box.innerHTML =
      `<span class="warn">Trading not enabled.</span>` +
      `<span class="small muted">MetaMask cannot sign Hyperliquid orders directly, so this tool creates a local “agent” key ` +
      `that you approve once with MetaMask (like the official app). The agent can trade and change leverage, but cannot withdraw. ` +
      `Requires a funded Hyperliquid account.</span>` +
      `<span class="small muted">The key is kept only in this browser tab (approved for 24 h); a new tab needs one more signature.</span>` +
      `<button id="enableAgent" class="primary">Enable trading</button>`;
    return;
  }
  const status = agentApproved === null ? "checking…" : "approved";
  box.innerHTML =
    `<span class="pos">Trading enabled</span>` +
    `<span class="small muted">agent ${esc(shortAddr(agent.address))} · ${status} · this tab only · expires ${esc(new Date(agent.validUntil).toLocaleString())}</span>` +
    `<button id="revokeAgent" class="sm danger">Revoke</button>`;
}

function renderPositions() {
  const el = $("positions");
  const ps = ch?.assetPositions.filter((p) => Number(p.position.szi) !== 0) ?? [];
  if (!wallet) {
    el.innerHTML = "—";
    return;
  }
  if (ps.length === 0) {
    el.innerHTML = `<span class="muted">No open positions.</span>`;
    return;
  }
  const rows = ps
    .map(({ position: p }) => {
      const szi = Number(p.szi);
      const mark = Number(p.positionValue) / Math.abs(szi);
      const upnl = Number(p.unrealizedPnl);
      const roe = Number(p.returnOnEquity) * 100;
      const lev = `${p.leverage.value}x ${p.leverage.type}`;
      const c = esc(p.coin);
      return `<tr>
        <td><b>${c}</b> <span class="${szi > 0 ? "pos" : "neg"}">${szi > 0 ? "LONG" : "SHORT"}</span></td>
        <td>${fmtNum(Math.abs(szi))}</td>
        <td>$${fmtUsd(p.positionValue)}</td>
        <td>${fmtNum(p.entryPx)}</td>
        <td>${fmtNum(mark)}</td>
        <td class="${sign(upnl)}">${money(upnl)} (${fmtUsd(roe, 1)}%)</td>
        <td>${esc(lev)}</td>
        <td>${p.liquidationPx ? fmtNum(p.liquidationPx) : "—"}</td>
        <td>$${fmtUsd(p.marginUsed)}</td>
        <td class="actions">
          <button class="sm" data-act="add" data-coin="${c}">Add</button>
          <button class="sm" data-act="reduce" data-coin="${c}">Reduce…</button>
          <button class="sm" data-act="close" data-pct="25" data-coin="${c}">25%</button>
          <button class="sm" data-act="close" data-pct="50" data-coin="${c}">50%</button>
          <button class="sm danger" data-act="close" data-pct="100" data-coin="${c}">Close</button>
        </td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `<div class="tbl"><table>
    <thead><tr><th>Coin</th><th>Size</th><th>Value</th><th>Entry</th><th>Mark</th><th>uPnL (ROE)</th><th>Leverage</th><th>Liq.</th><th>Margin</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="small muted">Close / 25% / 50% send a reduce-only market order at the live price, using the Trade form's slippage (default ${DEFAULT_SLIPPAGE_PCT}%).</div>`;
}

function renderOrders() {
  const el = $("orders");
  if (!wallet) {
    el.innerHTML = "—";
    return;
  }
  // openOrders also returns spot orders (e.g. "@107"); this tool only manages main-dex perps.
  const perp = orders.filter((o) => findAsset(o.coin)?.name === o.coin);
  const hidden = orders.length - perp.length;
  const hiddenNote = hidden ? `<div class="small muted">${hidden} spot/other order(s) not shown — manage them in the Hyperliquid app.</div>` : "";
  if (perp.length === 0) {
    el.innerHTML = `<span class="muted">No open perp orders.</span>${hiddenNote}`;
    return;
  }
  el.innerHTML = `<div class="tbl"><table>
    <thead><tr><th>Coin</th><th>Side</th><th>Price</th><th>Size</th><th>Orig size</th><th>Placed</th><th></th></tr></thead>
    <tbody>${perp
      .map(
        (o) => `<tr>
        <td>${esc(o.coin)}</td>
        <td class="${o.side === "B" ? "pos" : "neg"}">${o.side === "B" ? "Buy" : "Sell"}</td>
        <td>${fmtNum(o.limitPx)}</td>
        <td>${fmtNum(o.sz)}</td>
        <td>${fmtNum(o.origSz)}</td>
        <td>${esc(new Date(o.timestamp).toLocaleString())}</td>
        <td class="actions"><button class="sm danger" data-act="cancel" data-coin="${esc(o.coin)}" data-oid="${Number(o.oid)}">Cancel</button></td>
      </tr>`,
      )
      .join("")}</tbody></table></div>${hiddenNote}`;
}

// ---------------------------------------------------------------------------
// Order form
// ---------------------------------------------------------------------------

interface FormOrder {
  asset: Asset;
  isBuy: boolean;
  sizeVal: number;
  sizeUnit: "usd" | "coin";
  limitPx?: number;
  slippagePct: number;
  reduceOnly: boolean;
  leverage: number;
  isCross: boolean;
}

function readSlippage(fallback?: number): number {
  const raw = inp("slippage").value;
  try {
    const { n } = parseAmount(raw, "Slippage");
    if (n > 50) throw new Error("Slippage must be ≤ 50 %.");
    return n;
  } catch (e) {
    if (fallback != null) return fallback;
    throw e;
  }
}

function readOrderForm(): FormOrder {
  const asset = findAsset(inp("coin").value);
  if (!asset) throw new Error(assetsNet === net.name ? "Unknown coin. Pick one from the list (e.g. BTC, ETH, SOL)." : "Market data is loading…");
  if (asset.delisted) throw new Error(`${asset.name} is delisted.`);
  const isLimit = sel("orderType").value === "limit";
  const limitPx = isLimit ? parseAmount(inp("limitPx").value, "Limit price").n : undefined;
  const sizeVal = parseAmount(inp("size").value, "Size").n;
  const leverage = Number(inp("leverage").value);
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("Leverage must be a whole number ≥ 1.");
  if (leverage > asset.maxLeverage) throw new Error(`Max leverage for ${asset.name} is ${asset.maxLeverage}x.`);
  const isCross = sel("marginMode").value === "cross";
  if (isCross && asset.onlyIsolated) throw new Error(`${asset.name} supports isolated margin only.`);
  return {
    asset,
    isBuy: side === "long",
    sizeVal,
    sizeUnit: sel("sizeUnit").value === "usd" ? "usd" : "coin",
    limitPx,
    slippagePct: isLimit ? 0 : readSlippage(),
    reduceOnly: inp("reduceOnly").checked,
    leverage,
    isCross,
  };
}

/** Build the concrete order from the form at a given reference (mid) price. */
function buildFromForm(f: FormOrder, mid: number): BuiltOrder {
  const pxForSizing = f.limitPx ?? mid;
  const sizeCoin = f.sizeUnit === "usd" ? f.sizeVal / pxForSizing : f.sizeVal;
  return buildOrder({
    asset: f.asset,
    isBuy: f.isBuy,
    size: sizeCoin,
    reduceOnly: f.reduceOnly,
    limitPx: f.limitPx,
    refPx: mid,
    slippagePct: f.slippagePct,
  });
}

/** Leverage/margin inputs are editable only while they hold the selected coin's loaded (or hand-set) values. */
function updateLevInputs() {
  const a = findAsset(inp("coin").value);
  const locked = !!a && !!wallet && levSyncedCoin !== a.name;
  inp("leverage").disabled = locked;
  sel("marginMode").disabled = locked;
  inp("leverage").title = locked ? "Loading your current setting for this coin…" : "";
}

function renderPreview() {
  updateLevInputs();
  const el = $("orderPreview");
  try {
    if (!inp("coin").value || !inp("size").value) {
      el.textContent = "";
      return;
    }
    const f = readOrderForm();
    const mid = f.asset.midPx || f.asset.markPx;
    const built = buildFromForm(f, mid);
    const notional = Number(built.size) * (f.limitPx ?? mid);
    const pos = cachedPosition(f.asset.name);
    const name = esc(f.asset.name);
    el.innerHTML =
      `${f.isBuy ? "BUY" : "SELL"} ${esc(built.size)} ${name} ≈ $${fmtUsd(notional)}` +
      ` @ ${f.limitPx ? `limit ${esc(built.price)}` : `market (worst ≈ ${esc(built.price)}, mid ${fmtNum(mid)})`}` +
      ` · margin ≈ $${fmtUsd(notional / f.leverage)} at ${f.leverage}x ${f.isCross ? "cross" : "isolated"}` +
      (f.reduceOnly ? " · reduce-only" : "") +
      (pos ? ` · current position ${fmtNum(pos.szi)} ${name}` : "") +
      (!f.reduceOnly && notional < MIN_ORDER_NOTIONAL ? ` · <span class="warn">below $${MIN_ORDER_NOTIONAL} minimum</span>` : "") +
      (f.slippagePct > 5 ? ` · <span class="warn">high slippage</span>` : "") +
      `<br><span class="muted">Preview uses cached prices; the live price is fetched when you submit.</span>`;
  } catch (e) {
    el.innerHTML = `<span class="warn">${esc(errMsg(e))}</span>`;
  }
}

/**
 * Load the account's current leverage/margin mode for the selected coin into the form.
 * Returns the in-flight promise so submit can await it. Never overwrites values the user edited by hand.
 */
function syncLeverage(force = false): Promise<void> {
  const asset = findAsset(inp("coin").value);
  const w = wallet;
  if (!asset || !w) return Promise.resolve();
  if (!force && asset.name === levSyncedCoin) return Promise.resolve();
  if (!force && levSyncPromise && levSyncCoin === asset.name) return levSyncPromise;
  inp("leverage").max = String(asset.maxLeverage);
  // A hand-set value for THIS net/account/coin wins and is restored synchronously — no fetch needed or awaited.
  const ov = levOverrides.get(levKey(asset.name));
  if (ov) {
    inp("leverage").value = ov.leverage;
    sel("marginMode").value = ov.mode;
    levSyncedCoin = asset.name;
    renderPreview();
    return Promise.resolve();
  }
  const myEpoch = epoch;
  levSyncCoin = asset.name;
  let p: Promise<void> | null = null;
  p = (async () => {
    try {
      const d = await info.activeAssetData({ user: w.address, coin: asset.name });
      if (myEpoch !== epoch || w !== wallet || findAsset(inp("coin").value)?.name !== asset.name) return;
      const ov2 = levOverrides.get(levKey(asset.name)); // user may have typed while the fetch was in flight
      if (ov2) {
        inp("leverage").value = ov2.leverage;
        sel("marginMode").value = ov2.mode;
      } else {
        inp("leverage").value = String(d.leverage.value);
        sel("marginMode").value = d.leverage.type;
      }
      levSyncedCoin = asset.name;
    } catch {
      /* leave levSyncedCoin unset → submit will refuse unless the user set leverage explicitly */
    } finally {
      if (levSyncPromise === p) levSyncPromise = null;
      renderPreview();
    }
  })();
  levSyncPromise = p;
  return p!;
}

async function currentLeverage(user: `0x${string}`, coin: string, pos: Position | undefined) {
  if (pos) return { value: pos.leverage.value, isCross: pos.leverage.type === "cross" };
  try {
    const d = await info.activeAssetData({ user, coin });
    return { value: d.leverage.value, isCross: d.leverage.type === "cross" };
  } catch {
    return null;
  }
}

function describeStatus(st: unknown): string {
  const s = st as { filled?: { totalSz: string; avgPx: string; oid: number }; resting?: { oid: number }; error?: string };
  if (s?.filled) return `filled ${s.filled.totalSz} @ ${s.filled.avgPx} (oid ${s.filled.oid})`;
  if (s?.resting) return `resting (oid ${s.resting.oid})`;
  if (s?.error) return `error: ${s.error}`;
  return JSON.stringify(st);
}

/** Market orders: re-read the mid right before sending; abort if it drifted while the user was confirming. */
async function assertNoDrift(coin: string, confirmedMid: number, slippagePct: number) {
  const now = await fetchMid(info, coin);
  const driftPct = (Math.abs(now - confirmedMid) / confirmedMid) * 100;
  const maxDrift = slippagePct * MAX_DRIFT_FRACTION_OF_SLIPPAGE;
  if (driftPct > maxDrift) {
    throw new Error(
      `${coin} moved ${driftPct.toFixed(2)}% (${fmtNum(confirmedMid)} → ${fmtNum(now)}) while you were confirming ` +
        `(limit ${maxDrift.toFixed(2)}%). Nothing was sent — review and submit again.`,
    );
  }
}

async function submitOrder(startEpoch: number) {
  const w = requireWallet();
  const ag = requireAgent();
  const f = readOrderForm();
  const n = net;

  // Live data — never the 5 s cache.
  const [mid, pos] = await Promise.all([fetchMid(info, f.asset.name), freshPosition(w.address, f.asset.name)]);
  assertSameContext(startEpoch);
  const built = buildFromForm(f, mid);
  const notional = Number(built.size) * (f.limitPx ?? mid);

  if (!f.reduceOnly && notional < MIN_ORDER_NOTIONAL) {
    throw new Error(`Order value $${fmtUsd(notional)} is below Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum.`);
  }
  if (f.reduceOnly && !pos) throw new Error(`No open ${f.asset.name} position to reduce.`);
  if (f.reduceOnly && pos && Number(pos.szi) > 0 === f.isBuy) {
    throw new Error(`Reduce-only ${f.isBuy ? "buy" : "sell"} cannot reduce a ${Number(pos.szi) > 0 ? "long" : "short"}. Flip the side.`);
  }

  let warn = "";
  if (f.limitPx != null) {
    const through = f.isBuy ? (f.limitPx - mid) / mid : (mid - f.limitPx) / mid;
    if (through > 0.02) {
      warn += `\n⚠ This limit is ${(through * 100).toFixed(1)}% THROUGH the market (mid ${fmtNum(mid)}) and will execute immediately at worse prices.`;
    }
  }
  if (f.slippagePct > 5) warn += `\n⚠ High slippage: ${f.slippagePct}%.`;

  let levChange = false;
  if (!f.reduceOnly) {
    const cur = await currentLeverage(w.address, f.asset.name, pos);
    levChange = !cur || cur.value !== f.leverage || cur.isCross !== f.isCross;
  }
  const levTxt = `${f.leverage}x ${f.isCross ? "cross" : "isolated"}`;
  const msg =
    `${netTag()} ${f.isBuy ? "BUY / LONG" : "SELL / SHORT"} ${built.size} ${f.asset.name}\n` +
    `≈ $${fmtUsd(notional)} ${f.limitPx != null ? `limit @ ${built.price} (GTC)` : `market, mid ${fmtNum(mid)}, worst price ${built.price} (${f.slippagePct}% slippage)`}` +
    (f.reduceOnly ? "\nReduce-only" : "") +
    (pos ? `\nCurrent position: ${pos.szi} ${f.asset.name}` : "") +
    (levChange ? `\nLeverage will be set to ${levTxt} first.` : "") +
    warn +
    "\n\nConfirm?";
  if (!confirm(msg)) throw new Cancelled("cancelled by user");
  assertSameContext(startEpoch);
  if (f.limitPx == null) await assertNoDrift(f.asset.name, mid, f.slippagePct);
  assertSameContext(startEpoch);

  const ex = makeAgentExchange(n, ag);
  if (levChange) {
    await ex.updateLeverage(
      { asset: f.asset.index, isCross: f.isCross, leverage: f.leverage },
      { expiresAfter: Date.now() + LEVERAGE_EXPIRES_MS },
    );
    log(`leverage set: ${f.asset.name} ${levTxt}`);
  }
  try {
    // Re-check everything right before the order leaves: account/network unchanged, price still within tolerance.
    assertSameContext(startEpoch);
    if (levChange && f.limitPx == null) await assertNoDrift(f.asset.name, mid, f.slippagePct);
    assertSameContext(startEpoch);
    const status = await sendOrder(ex, built);
    return `${f.asset.name} order: ${describeStatus(status)}`;
  } catch (e) {
    if (levChange && e instanceof Error) e.message = `Leverage WAS changed to ${levTxt}, but the order failed: ${e.message}`;
    throw e;
  }
}

async function closePercent(coin: string, pct: number, startEpoch: number) {
  const w = requireWallet();
  const ag = requireAgent();
  const asset = findAsset(coin);
  if (!asset) throw new Error(`Unknown coin ${coin}.`);
  const slippagePct = readSlippage(DEFAULT_SLIPPAGE_PCT);

  const [mid, pos] = await Promise.all([fetchMid(info, coin), freshPosition(w.address, coin)]);
  assertSameContext(startEpoch);
  if (!pos) throw new Error(`No open ${coin} position.`);
  const szi = Number(pos.szi);
  // Full close uses the exact live position size string; partial floors to szDecimals.
  const size = pct >= 100 ? pos.szi.replace("-", "") : floorStr(Math.abs(szi) * (pct / 100), asset.szDecimals);
  if (!(Number(size) > 0)) throw new Error("Size too small to reduce at this percentage.");
  const isBuy = szi < 0;
  const built = buildOrder({ asset, isBuy, size, reduceOnly: true, refPx: mid, slippagePct });
  const msg =
    `${netTag()} ${pct >= 100 ? "CLOSE" : `REDUCE ${pct}% of`} ${coin} ${szi > 0 ? "long" : "short"} (${pos.szi})\n` +
    `${isBuy ? "Buy" : "Sell"} ${built.size} ${coin} reduce-only, market: mid ${fmtNum(mid)}, worst ${built.price} (${slippagePct}% slippage)` +
    (slippagePct > 5 ? `\n⚠ High slippage.` : "") +
    `\n\nConfirm?`;
  if (!confirm(msg)) throw new Cancelled("cancelled by user");
  assertSameContext(startEpoch);
  await assertNoDrift(coin, mid, slippagePct);
  assertSameContext(startEpoch);
  const status = await sendOrder(makeAgentExchange(net, ag), built);
  return `${coin} reduce: ${describeStatus(status)}`;
}

async function cancelOrder(coin: string, oid: number, startEpoch: number) {
  requireWallet();
  const ag = requireAgent();
  const asset = findAsset(coin);
  if (!asset) throw new Error(`Unknown coin ${coin}.`);
  assertSameContext(startEpoch);
  await makeAgentExchange(net, ag).cancel({ cancels: [{ a: asset.index, o: oid }] });
  return `Cancelled ${coin} order ${oid}.`;
}

function prefill(coin: string, mode: "add" | "reduce") {
  const pos = cachedPosition(coin);
  if (!pos) return;
  const isLong = Number(pos.szi) > 0;
  inp("coin").value = coin;
  setSide(mode === "add" ? (isLong ? "long" : "short") : isLong ? "short" : "long");
  inp("reduceOnly").checked = mode === "reduce";
  sel("orderType").value = "market";
  inp("limitPx").classList.add("hidden");
  if (mode === "reduce") {
    sel("sizeUnit").value = "coin";
    inp("size").value = pos.szi.replace("-", "");
  } else {
    sel("sizeUnit").value = "usd";
    inp("size").value = "";
  }
  inp("leverage").value = String(pos.leverage.value);
  sel("marginMode").value = pos.leverage.type;
  levSyncedCoin = coin;
  levOverrides.delete(levKey(coin)); // prefill uses the position's live leverage
  $("orderForm").scrollIntoView({ behavior: "smooth", block: "center" });
  inp("size").focus();
  renderPreview();
}

function setSide(s: "long" | "short") {
  side = s;
  document.querySelectorAll<HTMLButtonElement>("#sideSeg button").forEach((b) => b.classList.toggle("on", b.dataset.side === s));
  renderPreview();
}

// ---------------------------------------------------------------------------
// Wallet / network lifecycle
// ---------------------------------------------------------------------------

function resetUserState() {
  epoch++;
  ch = null;
  spot = null;
  orders = [];
  abstraction = null;
  arbUsdc = null;
  agent = null;
  agentApproved = null;
  agentCheckedAt = 0;
  levSyncedCoin = "";
  levSyncPromise = null;
  levOverrides.clear();
  pendingDeposit = null;
  pendingDepositUnresolved = false;
  abstractionFetchedAt = 0;
}

async function onConnected() {
  const w = wallet;
  if (!w) return;
  const myEpoch = epoch;
  resumePendingDeposit(w); // synchronously, before any await, so the deposit block is never missing
  const a = loadAgent(net, w.address);
  agent = a;
  if (a) {
    const ok = await isAgentApproved(info, w.address, a.address);
    if (myEpoch !== epoch) return;
    agentApproved = ok;
    agentCheckedAt = Date.now();
    if (ok === false) log("Stored trading key is no longer approved on Hyperliquid — enable trading again.");
  }
  await refresh();
  void syncLeverage(true);
}

// ---------------------------------------------------------------------------
// Pending deposit tracking (persisted, so neither an RPC hiccup nor a reload can re-enable a double deposit)
// ---------------------------------------------------------------------------

const pendingKey = (n: NetworkConfig, user: string) => `hlcontrol:pendingDeposit:${n.name}:${user.toLowerCase()}`;

/** Where the user should look to resolve a pending deposit (tx page, or their token-transfer list if no hash). */
const pendingLink = (n: NetworkConfig, p: PendingDeposit) => (p.hash ? n.explorerTx(p.hash) : n.explorerAddrTokens(p.from));

function resumePendingDeposit(w: Wallet) {
  try {
    const raw = localStorage.getItem(pendingKey(net, w.address));
    if (!raw) return;
    const p = JSON.parse(raw) as PendingDeposit;
    if (p.hash) {
      trackDeposit(net, w, { ...p, hash: p.hash }, epoch);
    } else {
      // Wallet was asked to send but no hash ever came back (e.g. reload / RPC failure mid-send): unknown outcome.
      pendingDeposit = p;
      pendingDepositUnresolved = true;
      renderFundsHints();
      log(`⚠ A deposit of ${formatUnits(BigInt(p.amount), 6)} USDC has an UNKNOWN outcome — check ${pendingLink(net, p)} before depositing again.`);
    }
  } catch {
    /* ignore corrupt entry */
  }
}

function trackDeposit(n: NetworkConfig, w: Wallet, p: PendingDeposit & { hash: `0x${string}` }, startEpoch: number) {
  const myEpoch = startEpoch;
  const key = pendingKey(n, w.address);
  localStorage.setItem(key, JSON.stringify(p));
  pendingDeposit = p;
  pendingDepositUnresolved = false;
  renderFundsHints();
  const visible = () => myEpoch === epoch;
  void waitForDeposit(n, p)
    .then((finalHash) => {
      localStorage.removeItem(key);
      log(`✔ deposit confirmed: ${n.explorerTx(finalHash)}`);
      if (visible()) {
        pendingDeposit = null;
        banner(`Deposit confirmed on Arbitrum (${shortAddr(finalHash)}). Hyperliquid credits it in ~1 minute.`, "ok");
      }
    })
    .catch((err) => {
      if (err instanceof DepositUnresolved) {
        // Keep it persisted and keep new deposits blocked until the user confirms they checked.
        if (visible()) pendingDepositUnresolved = true;
        log(`⚠ ${err.message}`);
        if (visible()) banner(err.message, "warn");
        return;
      }
      localStorage.removeItem(key); // definite outcome (reverted / not a deposit)
      log(`✖ deposit: ${errMsg(err)}`);
      if (visible()) {
        pendingDeposit = null;
        banner(`Deposit: ${errMsg(err)}`, "err");
      }
    })
    .finally(() => {
      if (visible()) {
        renderFundsHints();
        void refresh();
      }
    });
}

type ListenerProvider = {
  on?: (ev: string, cb: (...a: unknown[]) => void) => void;
  removeListener?: (ev: string, cb: (...a: unknown[]) => void) => void;
};
let bound: { provider: ListenerProvider; acc: (...a: unknown[]) => void; chain: (...a: unknown[]) => void } | null = null;

/**
 * Listen to account/chain changes of the CURRENT provider only. Listeners on a previously bound provider are removed,
 * and every event is ignored unless it comes from the provider the active wallet was built on.
 */
function attachWalletListeners(w: Wallet) {
  const provider = w.provider as unknown as ListenerProvider;
  if (bound?.provider === provider) return;
  if (bound) {
    bound.provider.removeListener?.("accountsChanged", bound.acc);
    bound.provider.removeListener?.("chainChanged", bound.chain);
    bound = null;
  }
  const isCurrent = () => !!wallet && (wallet.provider as unknown) === provider;
  const acc = (accs: unknown) => {
    if (!isCurrent()) return;
    const list = accs as string[];
    const prev = wallet!;
    resetUserState();
    if (!list?.[0]) {
      wallet = null;
      log("Wallet disconnected.");
      renderAll();
      return;
    }
    // Build synchronously from the SAME provider and the account it just announced — no async gap.
    wallet = walletForAccount(prev, list[0]);
    log(`Account changed → ${wallet.address}`);
    renderAll();
    void onConnected();
  };
  const chain = (cid: unknown) => {
    if (!isCurrent()) return;
    walletChainId = Number(cid);
    renderHeader();
  };
  provider.on?.("accountsChanged", acc);
  provider.on?.("chainChanged", chain);
  bound = { provider, acc, chain };
}

function setNetwork(name: NetworkName) {
  net = NETWORKS[name];
  localStorage.setItem("hlcontrol:net", name);
  info = makeInfo(net);
  resetUserState();
  clearAssets();
  document.title = `HL Control${net.isTestnet ? " (testnet)" : ""}`;
  log(`Network: ${name}`);
  renderAll();
  if (wallet) void onConnected();
  else void refresh();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bind() {
  sel("network").value = net.name;
  sel("network").addEventListener("change", () => setNetwork(sel("network").value as NetworkName));

  $("connectBtn").addEventListener("click", () =>
    action("Connect", "wallet", async () => {
      const w = await connectWallet();
      resetUserState(); // bumps epoch: anything from the previous account is now ignored
      wallet = w;
      attachWalletListeners(w);
      renderAll();
      await onConnected();
      return `Connected ${shortAddr(w.address)} (${net.name}).`;
    }),
  );

  // Deposit
  $("depositMax").addEventListener("click", () => {
    if (arbUsdc != null) inp("depositAmt").value = formatUnits(arbUsdc, 6);
  });
  $("depositForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void action("Deposit", "wallet", async (startEpoch) => {
      const w = requireWallet();
      const n = net;
      if (pendingDeposit || localStorage.getItem(pendingKey(n, w.address))) {
        throw new Error("A deposit is still pending/unresolved — wait for it, or check Arbiscan and clear it.");
      }
      const { str: amt, n: val } = parseAmount(inp("depositAmt").value, "Deposit amount", 6);
      if (val < MIN_DEPOSIT_USDC) throw new Error(`Minimum deposit is ${MIN_DEPOSIT_USDC} USDC — smaller deposits are LOST.`);
      if (
        !confirm(
          `${netTag()} Deposit ${amt} USDC from ${w.address} on ${n.chain.name} to Hyperliquid?\n\n` +
            `You will sign a USDC transfer to the Hyperliquid bridge ${n.bridge}.\n` +
            `It is credited to this same address (${shortAddr(w.address)}) on Hyperliquid.`,
        )
      )
        throw new Cancelled("cancelled by user");
      assertSameContext(startEpoch);
      // Persist a deposit INTENT right before the wallet is asked to send, so an uncertain broadcast
      // (no hash returned, page reload, RPC failure) can never re-enable a duplicate deposit.
      const key = pendingKey(n, w.address);
      const intent: PendingDeposit = { hash: null, from: w.address, amount: parseUnits(amt, 6).toString(), sentAt: Date.now() };
      let intentSaved = false;
      let hash: `0x${string}`;
      try {
        hash = await depositUsdc(
          w,
          n,
          amt,
          () => {
            localStorage.setItem(key, JSON.stringify(intent));
            intentSaved = true;
            if (startEpoch === epoch) {
              pendingDeposit = intent;
              pendingDepositUnresolved = false;
              renderFundsHints();
            }
          },
          (h) => log(`deposit tx sent: ${n.explorerTx(h)}`),
        );
      } catch (e) {
        if (intentSaved) {
          if (isUserRejection(e)) {
            localStorage.removeItem(key); // the only DEFINITE "nothing was broadcast" outcome
            if (startEpoch === epoch) pendingDeposit = null;
          } else {
            // Anything else after the wallet was asked to send may have broadcast → keep it blocked & unresolved.
            if (startEpoch === epoch) pendingDepositUnresolved = true;
            throw new OutcomeUnknown(
              `Deposit outcome UNKNOWN — the wallet may have sent it. Deposits stay blocked until you check ` +
                `${pendingLink(n, intent)} and clear it.\n(${errMsg(e)})`,
            );
          }
        }
        throw e;
      }
      inp("depositAmt").value = "";
      trackDeposit(n, w, { ...intent, hash }, startEpoch);
      return `Deposit sent (${shortAddr(hash)}) — waiting for Arbitrum confirmation…`;
    });
  });

  $("depositHint").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id !== "clearPendingDeposit" || !wallet || !pendingDeposit) return;
    if (!confirm(`Only clear this after checking Arbiscan — either the deposit confirmed (and was credited) or it was never sent:\n${pendingLink(net, pendingDeposit)}\n\nClear it?`)) return;
    localStorage.removeItem(pendingKey(net, wallet.address));
    pendingDeposit = null;
    pendingDepositUnresolved = false;
    renderFundsHints();
  });

  // Withdraw
  $("withdrawMax").addEventListener("click", () => {
    if (ch) inp("withdrawAmt").value = floorStr(withdrawableUsd(), 2);
  });
  $("withdrawForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void action("Withdraw", "wallet", async (startEpoch) => {
      const w = requireWallet();
      const { str: amt, n: val } = parseAmount(inp("withdrawAmt").value, "Withdraw amount", 6);
      if (val <= WITHDRAW_FEE_USDC) throw new Error(`Amount must exceed the $${WITHDRAW_FEE_USDC} withdrawal fee.`);
      await refreshAccountMode(w, startEpoch);
      const avail = withdrawableUsd();
      let extra = "";
      if (abstraction == null) extra += "\n⚠ Couldn't determine account mode; the balance check is an estimate.";
      if (ch && val > avail) {
        if (abstraction === "default" || abstraction === "disabled" || abstraction === "dexAbstraction") {
          throw new Error(`Exceeds withdrawable $${fmtUsd(avail)}.`);
        }
        extra = `\n⚠ This exceeds the estimated available balance ($${fmtUsd(avail)}); Hyperliquid may reject it.`;
      }
      if (
        !confirm(
          `${netTag()} Withdraw ${amt} USDC to ${w.address} on Arbitrum?\n` +
            `You receive ≈ ${fmtUsd(val - WITHDRAW_FEE_USDC)} USDC after the $${WITHDRAW_FEE_USDC} fee.${extra}\n\n` +
            `MetaMask will ask you to sign a message (no gas).`,
        )
      )
        throw new Cancelled("cancelled by user");
      assertSameContext(startEpoch);
      await makeUserExchange(net, w).withdraw3({ destination: w.address, amount: amt });
      inp("withdrawAmt").value = "";
      return `Withdrawal of ${amt} USDC submitted. Arrives on Arbitrum in ~3–5 minutes.`;
    });
  });

  // Spot <-> Perp
  $("transferMax").addEventListener("click", () => {
    const toPerp = sel("transferDir").value === "toPerp";
    const v = toPerp ? spotUsdc().free : Number(ch?.withdrawable ?? 0);
    inp("transferAmt").value = floorStr(v, 2);
  });
  $("transferForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void action("Transfer", "wallet", async (startEpoch) => {
      const w = requireWallet();
      await refreshAccountMode(w, startEpoch);
      if (isUnified()) throw new Error("Unified account: spot and perp share one balance, no transfer needed.");
      const { str: amt } = parseAmount(inp("transferAmt").value, "Transfer amount", 6);
      const toPerp = sel("transferDir").value === "toPerp";
      if (!confirm(`${netTag()} Transfer ${amt} USDC ${toPerp ? "Spot → Perp" : "Perp → Spot"}?`)) throw new Cancelled("cancelled by user");
      assertSameContext(startEpoch);
      await makeUserExchange(net, w).usdClassTransfer({ amount: amt, toPerp });
      inp("transferAmt").value = "";
      return `Transferred ${amt} USDC ${toPerp ? "to perp" : "to spot"}.`;
    });
  });

  // Agent
  $("agentBox").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "enableAgent") {
      void action("Enable trading", "wallet", async (startEpoch) => {
        const w = requireWallet();
        const n = net;
        const a = await approveNewAgent(n, w);
        // Only bind it if we're still on the same account + network it was approved for.
        if (startEpoch !== epoch || wallet?.address !== a.user || net.name !== a.net) {
          return `Trading key approved for ${shortAddr(a.user)} on ${a.net} (no longer the active account/network).`;
        }
        agent = a;
        agentApproved = true;
        agentCheckedAt = Date.now();
        return `Trading enabled (agent ${shortAddr(a.address)}).`;
      });
    } else if (t.id === "revokeAgent") {
      if (!confirm(`${netTag()} Revoke this tool's trading key on Hyperliquid? (one MetaMask signature)`)) return;
      void action("Revoke trading key", "wallet", async (startEpoch) => {
        const w = requireWallet();
        await revokeAgent(net, w);
        if (startEpoch === epoch) {
          agent = null;
          agentApproved = null;
        }
        return "Trading key revoked and deleted from this browser.";
      });
    }
  });

  // Order form
  document.querySelectorAll<HTMLButtonElement>("#sideSeg button").forEach((b) =>
    b.addEventListener("click", () => setSide(b.dataset.side as "long" | "short")),
  );
  sel("orderType").addEventListener("change", () => {
    inp("limitPx").classList.toggle("hidden", sel("orderType").value !== "limit");
    if (sel("orderType").value === "limit" && !inp("limitPx").value) {
      const a = findAsset(inp("coin").value);
      if (a) inp("limitPx").value = String(a.midPx || a.markPx);
    }
    renderPreview();
  });
  inp("coin").addEventListener("change", () => void syncLeverage());
  inp("coin").addEventListener("input", () => {
    if (findAsset(inp("coin").value)) void syncLeverage(); // exact match typed → load its setting right away
  });
  const markLevEdited = () => {
    const a = findAsset(inp("coin").value);
    // Only record a hand-set value once the form actually holds THIS coin's loaded setting.
    if (a && wallet && levSyncedCoin === a.name) {
      levOverrides.set(levKey(a.name), { leverage: inp("leverage").value, mode: sel("marginMode").value });
    }
  };
  inp("leverage").addEventListener("input", markLevEdited);
  sel("marginMode").addEventListener("change", markLevEdited);
  for (const id of ["coin", "size", "leverage", "limitPx", "slippage"]) inp(id).addEventListener("input", renderPreview);
  for (const id of ["sizeUnit", "marginMode"]) sel(id).addEventListener("change", renderPreview);
  inp("reduceOnly").addEventListener("change", renderPreview);
  $("orderForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void action("Order", "agent", async (startEpoch) => {
      // Make sure leverage fields reflect this coin's current setting before reading the form.
      const a = findAsset(inp("coin").value);
      if (a) {
        await syncLeverage();
        const ov = levOverrides.get(levKey(a.name));
        if (ov) {
          // Belt and braces: the form must hold exactly this coin's hand-set values.
          inp("leverage").value = ov.leverage;
          sel("marginMode").value = ov.mode;
        } else if (levSyncedCoin !== a.name) {
          throw new Error(`Couldn't load your current ${a.name} leverage setting — check the connection and try again.`);
        }
      }
      return submitOrder(startEpoch);
    });
  });

  // Positions / orders table actions (event delegation; tables re-render on refresh)
  for (const id of ["positions", "orders"]) {
    $(id).addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
      if (!b) return;
      const coin = b.dataset.coin!;
      switch (b.dataset.act) {
        case "add":
          prefill(coin, "add");
          break;
        case "reduce":
          prefill(coin, "reduce");
          break;
        case "close":
          void action(`Reduce ${coin}`, "agent", (ep) => closePercent(coin, Number(b.dataset.pct), ep));
          break;
        case "cancel":
          void action(`Cancel ${coin}`, "agent", (ep) => cancelOrder(coin, Number(b.dataset.oid), ep));
          break;
      }
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

{
  const purged = purgeLegacyPersistedKeys(); // before anything else: old versions stored plaintext keys
  if (purged) console.info(`Removed ${purged} legacy persisted trading key(s).`);
}
bind();
renderAll();
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 5000);
log(`Ready (${net.name}). Connect MetaMask to begin.`);
