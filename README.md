# HL Control

A minimal, local Hyperliquid control panel: connect MetaMask, **deposit**, **withdraw**, move USDC **spot ⇄ perp**,
and **open / increase / reduce / close** perp positions. No charts.

Built on the [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) TypeScript SDK and [viem](https://viem.sh).
Useful when the official web app's front-end misbehaves for you: it talks to the same Hyperliquid API directly.

> [!WARNING]
> **Use at your own risk. This software moves real money.** It is provided "as is", without warranty of any kind
> (see [LICENSE](LICENSE)). You are responsible for every transaction you confirm.
> Try it on **Testnet** first, then with a **small amount** on mainnet.
>
> **Not affiliated with, endorsed by, or supported by Hyperliquid.**

## Stay safe

- **Only run it locally from this source code** (`npm run dev` → `http://127.0.0.1:5791`). Do not use a copy hosted
  on any website — anyone can fork this repo and publish a modified version that steals funds.
- **This app never asks for your seed phrase or private key.** If something that looks like it does, it's a scam.
- **Read every MetaMask prompt.** Deposits are a USDC `transfer` to the Hyperliquid bridge
  `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` on Arbitrum One; everything else is a signature (no gas).
- Prefer cloning a tagged commit you (or someone you trust) have read, and check `package-lock.json` hasn't changed
  unexpectedly before `npm install`.

## Status

- **Reviewed by AI models, not audited by a human.** The code went through several review rounds by two AI models
  (Claude Fable and GPT-6 Astra); all findings rated critical / high / medium were fixed. Some low-severity issues are
  known and intentionally left open (e.g. Close may refuse in a very fast market and ask you to resubmit; a failed price
  lookup can be reported as "outcome unknown" although nothing was sent).
- **Deposits use Hyperliquid's legacy Bridge2**, which their docs mark as deprecated in favour of CCTP. It still
  credits deposits at the time of writing, and the app checks the bridge's on-chain `paused()` flag first — but if
  Hyperliquid switches it off, deposit through their app instead.
- **Provided as-is.** Hyperliquid's API changes over time; this repo may not keep up. Issues and PRs are welcome but
  there's no guarantee of maintenance.

## Run

```bash
npm install
npm run dev          # http://127.0.0.1:5791
# or a production build:
npm run build && npm run preview
```

Open the URL in the browser where MetaMask is installed. Use the **Testnet** selector first to try things safely.

## How it works

| Action | Mechanism | Who signs |
| --- | --- | --- |
| Deposit | ERC-20 `transfer` of native USDC on **Arbitrum** to Hyperliquid Bridge2. Credits the **sending** address in ~1 min. **Minimum 5 USDC — smaller deposits are lost forever** (the app blocks them). | MetaMask (Arbitrum tx, needs a little ETH for gas) |
| Withdraw | `withdraw3` to your own connected address on Arbitrum. $1 fee, ~3–5 min. | MetaMask (EIP-712 signature, no gas) |
| Spot ⇄ Perp | `usdClassTransfer`. Not needed if your account mode is *unifiedAccount* / *portfolioMargin*. | MetaMask (EIP-712) |
| Enable trading | Generates a local **agent key** and approves it via `approveAgent` (named `hlcontrol`, valid 24 h, kept in this tab only). Requires a funded account. | MetaMask (EIP-712) |
| Orders / leverage / cancel | Market = IOC limit at the **live** mid ± slippage (aborted if the price moves > ½ slippage while you confirm); Limit = GTC. Reduce/Close are reduce-only. Leverage is updated first if you changed it (also with a 20 s expiry); values you type are remembered per coin/account and never carried to another coin. Orders carry a 20 s `expiresAfter`. Sell bounds round **up** to the tick, buy bounds round down. | Agent key (no popups) |

### Why an agent key?
Hyperliquid order signatures use EIP-712 domain chainId `1337`, which MetaMask refuses to sign while you're on
another network — a common cause of front-end errors. Like the official app, this tool approves a separate
"API wallet" once with MetaMask. The agent can place/cancel orders and change leverage (and a few account-internal
actions such as moving funds between your own spot/perp balances), but it **cannot withdraw or send funds to another address**.
It can still trade your account badly if stolen, so treat it as sensitive.

**Where the agent key lives:** only in this browser tab (`sessionStorage`), approved on Hyperliquid for 24 h. Close the
tab and the key is gone; other tabs or pages on the same origin can't read it. A new tab needs one more MetaMask signature
(which also replaces the previous tab's key, since there is one `hlcontrol` slot per account). Keys persisted by older
versions of this tool in `localStorage` are deleted automatically.
**Revoke** replaces it on Hyperliquid with a throwaway key that expires in 2 minutes and deletes the local copy.
Because it's named `hlcontrol`, it does not replace the official frontend's agent.

## Notes / limits
- Main perp dex only (no HIP-3 builder dexes, no spot trading). Spot orders are hidden from the open-orders table.
- Deposits from chains other than Arbitrum, or of tokens other than native USDC (`0xaf88…5831`), are not supported.
- The legacy Bridge2 is labeled "deprecated" in Hyperliquid's docs in favour of CCTP but still processes deposits
  (verified on-chain at time of writing). If Hyperliquid ever disables it, deposit via their app/CCTP instead.
- Minimum order value is $10 (except reduce-only).
- Before depositing, the app checks the bridge's on-chain `paused()` flag; a deposit is tracked until it confirms
  (speed-up/cancel in MetaMask is handled; the confirmed tx must contain the USDC transfer to the bridge). A deposit
  intent is saved *before* MetaMask is asked to send, so even if no tx hash comes back (reload, RPC failure) new deposits
  stay blocked until it resolves. If it's still unresolved after 10 min,
  do **not** resend — check Arbiscan, then use "I checked Arbiscan — clear".
- Data refreshes every 5 s while the tab is visible (≈310 of the 1200/min per-IP weight budget).
- If a request times out you'll see **OUTCOME UNKNOWN** — check positions/balances before retrying.
- Use `.` as the decimal separator; commas are rejected on purpose (so `95,000` can never become `95`).
- Unified / portfolio-margin accounts: balances are shown from spot USDC and spot⇄perp transfer is disabled.

## License

[MIT](LICENSE) — no warranty.
