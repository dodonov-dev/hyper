import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  erc20Abi,
  getAddress,
  http,
  parseUnits,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { MIN_DEPOSIT_USDC, type NetworkConfig } from "./config";

// ---------------------------------------------------------------------------
// EIP-6963 wallet discovery: prefer MetaMask even when other extensions
// (Rabby, Phantom, Coinbase…) fight over window.ethereum.
// ---------------------------------------------------------------------------

interface ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

const discovered: ProviderDetail[] = [];
window.addEventListener("eip6963:announceProvider", (e: Event) => {
  const detail = (e as CustomEvent<ProviderDetail>).detail;
  if (detail?.info?.uuid && !discovered.some((d) => d.info.uuid === detail.info.uuid)) discovered.push(detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

export function findProvider(): { provider: EIP1193Provider; name: string } | null {
  const mm = discovered.find((d) => d.info.rdns === "io.metamask");
  if (mm) return { provider: mm.provider, name: mm.info.name };
  if (discovered[0]) return { provider: discovered[0].provider, name: discovered[0].info.name };
  const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (injected) return { provider: injected, name: "Injected wallet" };
  return null;
}

const makeWalletClient = (provider: EIP1193Provider, address: `0x${string}`) =>
  createWalletClient({ account: address, transport: custom(provider) });

export interface Wallet {
  provider: EIP1193Provider;
  name: string;
  address: `0x${string}`;
  client: ReturnType<typeof makeWalletClient>;
}

export async function connectWallet(): Promise<Wallet> {
  // Give late EIP-6963 announcements a moment.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 150));
  const found = findProvider();
  if (!found) throw new Error("No browser wallet found. Install / unlock MetaMask and reload the page.");
  const accounts = (await found.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("Wallet returned no accounts.");
  const address = getAddress(accounts[0]);
  const client = makeWalletClient(found.provider, address);
  return { provider: found.provider, name: found.name, address, client };
}

/** Rebuild the wallet for a new account on the SAME provider (used on accountsChanged; no rediscovery / prompt). */
export function walletForAccount(prev: Wallet, account: string): Wallet {
  const address = getAddress(account);
  return { provider: prev.provider, name: prev.name, address, client: makeWalletClient(prev.provider, address) };
}

export function arbClient(net: NetworkConfig): PublicClient {
  return createPublicClient({ chain: net.chain, transport: http(net.rpcUrl) });
}

export async function getUsdcBalance(net: NetworkConfig, owner: `0x${string}`): Promise<bigint> {
  return arbClient(net).readContract({
    address: net.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export async function getWalletChainId(w: Wallet): Promise<number> {
  return w.client.getChainId();
}

/** Switch the wallet to the deposit chain (adding it to MetaMask if missing). */
export async function ensureChain(w: Wallet, net: NetworkConfig): Promise<void> {
  if ((await w.client.getChainId()) === net.chain.id) return;
  try {
    await w.client.switchChain({ id: net.chain.id });
  } catch (e) {
    const code = (e as { code?: number; cause?: { code?: number } }).code ?? (e as { cause?: { code?: number } }).cause?.code;
    if (code === 4902) {
      await w.client.addChain({ chain: net.chain });
      await w.client.switchChain({ id: net.chain.id });
    } else {
      throw e;
    }
  }
  if ((await w.client.getChainId()) !== net.chain.id) {
    throw new Error(`Wallet is not on ${net.chain.name}. Switch network in MetaMask and retry.`);
  }
}

/**
 * Deposit = plain ERC-20 transfer of native USDC on Arbitrum to Bridge2.
 * The bridge credits the SENDER address on Hyperliquid, typically < 1 minute.
 * Returns as soon as the wallet has broadcast the tx; use waitForDeposit() for the receipt.
 */
export async function depositUsdc(
  w: Wallet,
  net: NetworkConfig,
  amountStr: string,
  /** Called right before the wallet is asked to send — persist a deposit intent here. */
  onBeforeSend: () => void,
  onSubmitted: (hash: `0x${string}`) => void,
): Promise<`0x${string}`> {
  const amount = parseUnits(amountStr, 6);
  if (amount < parseUnits(String(MIN_DEPOSIT_USDC), 6)) {
    throw new Error(`Minimum deposit is ${MIN_DEPOSIT_USDC} USDC — smaller deposits are lost forever.`);
  }
  const pub = arbClient(net);
  const bal = await getUsdcBalance(net, w.address);
  if (bal < amount) throw new Error("Insufficient USDC on Arbitrum.");

  // Pre-flight: refuse if the bridge reports itself paused (a plain transfer can't be refused by the contract).
  const paused = await pub.readContract({ address: net.bridge, abi: bridgeAbi, functionName: "paused" });
  if (paused) throw new Error("The Hyperliquid bridge is currently PAUSED. Do not deposit now.");

  await ensureChain(w, net);
  onBeforeSend();
  const hash = await w.client.writeContract({
    account: w.address,
    chain: net.chain,
    address: net.usdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [net.bridge, amount],
  });
  onSubmitted(hash);
  return hash;
}

export interface PendingDeposit {
  /** null = the wallet was asked to send but we never got a hash back (outcome unknown). */
  hash: `0x${string}` | null;
  from: `0x${string}`;
  amount: string; // base units (6 decimals), as string for JSON
  sentAt: number;
}

export class DepositUnresolved extends Error {}

/**
 * Wait for a deposit tx and verify it really moved `amount` USDC from the user to the bridge.
 * - Handles speed-up (repriced) / cancel / replacement in MetaMask: the final receipt must contain the expected
 *   USDC Transfer(from → bridge, amount) log, otherwise it's reported as NOT a deposit.
 * - Transient RPC errors are retried. If still unresolved after ~10 min → DepositUnresolved (caller keeps it pending).
 */
export async function waitForDeposit(net: NetworkConfig, p: PendingDeposit & { hash: `0x${string}` }): Promise<`0x${string}`> {
  const pub = arbClient(net);
  const deadline = Date.now() + 600_000;
  let replacedBy: string | null = null;
  while (Date.now() < deadline) {
    try {
      const receipt = await pub.waitForTransactionReceipt({
        hash: p.hash,
        timeout: Math.max(10_000, deadline - Date.now()),
        onReplaced: (r) => {
          replacedBy = `${r.reason} by ${r.transaction.hash}`;
        },
      });
      const hash = receipt.transactionHash;
      if (receipt.status !== "success") throw new Error(`Deposit transaction reverted (${hash}). No funds were sent.`);
      const ok = receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== net.usdc.toLowerCase()) return false;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          return (
            ev.eventName === "Transfer" &&
            ev.args.from.toLowerCase() === p.from.toLowerCase() &&
            ev.args.to.toLowerCase() === net.bridge.toLowerCase() &&
            ev.args.value === BigInt(p.amount)
          );
        } catch {
          return false;
        }
      });
      if (!ok) {
        throw new Error(
          `The deposit tx was ${replacedBy ?? "replaced"} — the confirmed tx ${hash} does NOT contain the USDC transfer to the bridge. ` +
            `No deposit was made by it.`,
        );
      }
      return hash;
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "WaitForTransactionReceiptTimeoutError") break;
      // Definite outcomes bubble up; transient RPC/network errors are retried.
      if (e instanceof Error && /reverted|does NOT contain/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new DepositUnresolved(
    `Deposit tx ${p.hash} is still unconfirmed after 10 min. It may still confirm — do NOT send it again. ` +
      `Check ${net.explorerTx(p.hash)}; the app keeps it marked as pending until resolved.`,
  );
}

const bridgeAbi = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;
