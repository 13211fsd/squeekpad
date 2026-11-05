# SqueekPad — testnet launchpad for the Squeekchain community

Launch a coin, trade it on a bonding curve, and watch it graduate to Uniswap V2 — on Sepolia, next to Squeekchain.

- **Bonding curve in Sepolia ETH.** Every coin has a fixed 1B supply. 800M are sold on a constant-product curve (virtual reserves 0.1 ETH / 1.073B tokens).
- **Graduation.** When the 800M are sold (≈0.29 ETH raised), the raised ETH and the remaining 200M tokens are added to a Uniswap V2 pair on Sepolia and the LP tokens are sent to `0x…dEaD`. The buyer who completes the curve is refunded any excess.
- **Squeek holders trade free.** The contract checks the Squeek NFT collection (`0xc4c7982657f00509548f3a3a41db7fa439a6856b`, from `api.squeekchain.com/v1/economy/state`) onchain: holders pay 0%, everyone else pays 1% to the coin's creator, claimable any time.
- **No sniping, no off-curve games.** The creator can buy in the launch transaction. Until graduation, tokens can only move to/from the pad, so nobody can seed the Uniswap pair early.
- **Ownerless.** No admin, no pause, no fee switch, no withdraw.
- **Coin images, onchain.** Creators pick an image; the site crops it to 160×160 WebP (≤24KB) and `SqueekPadImages` stores it in an event log. Only the coin's creator can set or change it.
- **Live wheel.** The header shows whether Squeektoshi is on his wheel right now (`/v1/status`).
- **No backend.** The site reads everything from Sepolia logs and contract views. Static files only.

Testnet only. Coins launched here have no value.

## Layout

```
contracts/SqueekPad.sol      SqueekPad + SqueekPadToken
contracts/test/MockSqueek.sol test helpers
test/pad.test.js             15 contract tests (ganache + real Uniswap V2 bytecode)
test/e2e.js                  UI end-to-end test (headless Chrome + injected wallet)
site/                        the static website (index.html, app.js, deploy.html, config.js)
scripts/                     compile + export ABIs to site/
```

## Build & test

```bash
npm install
npm test                       # compile + contract tests
node scripts/export-site.js    # refresh site/contracts.js after changing the contract
```

## Deploy

1. Serve `site/` anywhere static (GitHub Pages, Cloudflare Pages, Netlify).
2. Open `deploy.html`, connect a wallet with a little Sepolia ETH, press **Deploy**.
3. Paste the printed `PAD` address and `PAD_BLOCK` into `site/config.js` and redeploy the site.

Sepolia addresses used: Uniswap V2 factory `0xF62c03E08ada871A0bEb309762E260a7a6a880E6`, WETH `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`.

## Contract interface

| Function | What it does |
| --- | --- |
| `launch(name, symbol, description, minOut)` payable | Deploys a coin; any ETH sent is the creator's first buy |
| `buy(token, minOut)` payable | Buy on the curve; excess refunded at graduation |
| `sell(token, amount, minEthOut)` | Sell back to the curve (no approve needed) |
| `claimFees()` | Creator withdraws accumulated fees |
| `quoteBuy / quoteSell / feeBpsFor` | Views used by the site |

Events: `Launched`, `Trade`, `Graduated`, `FeesClaimed`.

## Squeekchain Genesis verification

<!-- Paste the repository line from your Genesis profile below this comment -->


MIT licensed. Fan-made for the Squeekchain community; not affiliated with the Squeekchain team.
