# Aegis Solana Terminal

Risk-first research and paper-trading terminal for Solana memecoins after Pump.fun migration.

## Development

1. Copy `.env.example` to `.env.local`.
2. Start PostgreSQL and Redis: `docker compose up -d postgres redis`.
3. Apply schema: `npm run db:migrate`.
4. Start the app: `npm run dev`.
5. Start the background worker in another terminal: `npm run worker`.

Without `DATABASE_URL`, the dashboard continues with mock candidates and the CA API performs read-only RPC inspection. With `DATABASE_URL`, every CA assessment is stored transactionally in `tokens`, `risk_assessments`, and `audit_logs`.

Candidates are added manually by submitting a mint address (CA) on the dashboard; there is no automatic discovery of new migrations yet.

## Watchlist

- **Pin, note and tag** tokens from the dashboard or the token detail page; filter the watchlist by tag.
- **Archive** a token to stop its background market and holder refresh jobs. Tokens with an open position cannot be archived. Restoring an archived token re-submits its CA, which re-verifies it and reschedules its jobs.
- **Auto-trade is opt-in per token.** The worker only enters positions for tokens that are `eligible` *and* have auto-trade enabled. Existing tokens default to auto-trade off after migration `0008`; exits for already-open positions are unaffected.
- **Price alerts** per token: price above/below a USD threshold and absolute 1h change. They are evaluated on every market refresh (5 minutes) and delivered through the configured webhook/Telegram destinations, at most once per hour per alert type.

## Trigger orders (shadow)

Conditional orders priced in **market cap (USD)**, created from a token's detail page and listed at `/orders`. They are simulated: the engine only runs while the worker is in `TRADING_MODE=shadow` and never sends transactions.

| Type | Fires when | Action |
|---|---|---|
| Limit buy | mcap ≤ target | Buy the configured SOL amount |
| Take profit | mcap ≥ target | Sell N% of the position |
| Stop loss | mcap ≤ target | Sell N% of the position |
| Trailing stop | mcap falls the configured % from its peak since creation | Sell N% of the position |
| TP + SL (OCO) | Either side fires | The filled side cancels the other |

- Market cap = price × on-chain supply (`tokens.supply_raw`, refreshed on every market refresh so burns are reflected). Input accepts `750k`, `2.5M`, `1.2B`.
- Detection uses the shared 5-second Jupiter price loop; each fired order is re-validated with an exact Jupiter quote. Limits fill only at their price or better (implied by the quote × SOL/USD). Stops fill at market but are refused when price impact exceeds the order's maximum, so a stop can stay unfilled in a thin market.
- Orders that would fire immediately are rejected at creation. Orders can expire; sell orders are cancelled when their position closes.
- Limit buys are allowed on tokens that have not passed the hard gates, with an explicit warning. Shadow open-position, exposure and daily-loss limits still apply.
- Positions opened by a limit buy are `manual`: automated exits (risk exit, stop loss, take profit, time stop, fast exits) never touch them; only your own trigger orders do. Partial sells release cost basis proportionally and accumulate realized PnL.
- One open shadow position per token.

## Manual trading from a browser wallet

Buy and sell from your own wallet (Phantom, Solflare, Backpack… detected through Wallet Standard) on a token's detail page. **This uses real funds.** The app never sees a private key: it builds the Jupiter swap for your address and your wallet signs and broadcasts it.

- Enable with `MANUAL_TRADING_ENABLED=true`. The emergency halt also blocks preparing new manual trades.
- Flow: choose buy (SOL amount) or sell (% of the wallet's balance) → the server quotes and builds the transaction → a confirmation dialog shows amounts, minimum received, price impact, slippage, implied market cap and every failing or unknown risk check → your wallet signs and sends → the app records the signature, waits up to ~45s for confirmation and books the fill from the on-chain transaction.
- There is no SOL cap on manual trades; the confirmation dialog is the safeguard.
- Positions are `live` with origin `manual` and the wallet address. Repeated buys average into one position; sells can be partial and release cost basis proportionally. Bot portfolio limits, the daily spend cap and wallet reconciliation only consider the bot's own (`auto`) orders and positions.
- **Recovery.** Because the wallet broadcasts before the app learns the signature, a closed browser can leave an order without one. The recovery job searches the wallet's recent history for a matching swap of that token and direction after the order was prepared; it only fails the order once the transaction's blockhash has expired without a match. A late signature is still accepted.
- **TP/SL for wallet positions are alert-only.** Trigger orders can target a wallet position; when one fires the app sends a webhook/Telegram alert with a link and shows a "Bán ngay" button prefilled with the percentage. Your sell resolves the alert and cancels its OCO sibling.
- The connected wallet is added to the watch-only list automatically (an existing label is kept).
- `NEXT_PUBLIC_SOLANA_RPC_URL` (optional) is the RPC the browser uses for wallet bookkeeping; never put an API-keyed RPC URL in it.

## Watch-only wallets

`/wallets` tracks public wallet addresses only; no private key is requested or stored. For each wallet the app shows:

- SOL balance and SPL/Token-2022 holdings with estimated USD value (DexScreener prices).
- Tokens traded in the most recent 40 transactions: amounts bought/sold and SOL spent/received. SOL figures include priority fees and token-account rent, and only cover the scanned window.
- Recent activity classified as buy, sell, swap, receive or send, with Solscan links.
- A one-click "+ Watchlist" for any held or traded token.

Wallet data is read live from RPC on page load (Helius when `HELIUS_API_KEY` is set) and is not persisted.

## Analysis pipeline

1. **CA submission** (`POST /api/candidates`) — reads mint/freeze authority, enriches market data, verifies the Pump.fun migration transaction on-chain and identifies the creator.
2. **Worker jobs** (BullMQ on Redis):
   - `market-refresh` every 5 minutes.
   - `holder-bundle-analysis` once, then `holder-analysis` every 15 minutes — top holders, direct funders, creator cluster and bundle evidence.
   - `shadow-scan` every 60 seconds — exits first, then entries for eligible tokens with auto-trade enabled.
   - `live-recovery` every 30 seconds and `live-reconcile` every 5 minutes (see Live trading).
   - A 5-second price loop that queues `exit-check` jobs for positions near a threshold.
3. **Risk engine** — six critical hard gates. Any `fail` rejects the token; any `unknown` keeps it in `monitoring`. Only tokens that pass every gate become `eligible`.

| Gate | Requirement |
|---|---|
| Mint authority | Disabled |
| Freeze authority | Disabled |
| Migration age | ≥ 4 hours since verified migration |
| Liquidity | ≥ $50,000 |
| Creator cluster | ≤ 5% of supply |
| Suspected bundle | ≤ 10% of supply |

### Fail-closed data requirements

`HELIUS_API_KEY` is effectively required for any token to become eligible. Creator cluster and bundle analysis depend on Helius transaction history:

- Without the key, or if any funding lookup fails, the creator cluster is stored as unknown (`null`), never as 0%.
- If the creator's funder cannot be traced, the cluster is unknown.
- Bundle history that is missing, paginated beyond the scan limit, or built on an incomplete funding graph is marked `truncated` and the bundle gate stays unknown.

## Trading modes

Set with `TRADING_MODE`:

| Mode | Behaviour |
|---|---|
| `paper` (default) | Research only. The worker performs no entries or exits. |
| `shadow` | Requests Jupiter quotes and stores simulated orders, fills and positions. Never signs or sends transactions. |
| `live` | Signs and sends real Jupiter swaps from a local keypair. See the warning below. |

Entries and exits use the same strategy and portfolio limits in shadow and live mode: signal score, price impact, volume/liquidity ratio, maximum open positions, total exposure, daily loss limit, consecutive losses and re-entry cooldown. Exits are evaluated in priority order: risk exit (token no longer eligible), stop loss, take profit, time stop. Limits are configured in `/settings` or via the `SHADOW_*` variables in `.env.example`. Entries default to paused until explicitly resumed.

### Live trading

Live execution has crash-safety, reconciliation and hard caps, but it has **not been exercised with real funds**. Start with a dedicated hot wallet holding only what you accept to lose, and watch `/live-safety` closely.

Live mode only runs when all of these are set:

- `TRADING_MODE=live`
- `LIVE_TRADING_ENABLED=true`
- `SOLANA_RPC_URL`
- One of `SOLANA_PRIVATE_KEY_BASE58`, `SOLANA_PRIVATE_KEY_JSON` or `SOLANA_KEYPAIR_PATH` (plaintext; an encrypted keystore is planned)

**Order lifecycle.** `quoted` (reserved) → `simulated` (signed and simulated; signature and blockhash expiry persisted *before* broadcast) → `submitted` → `confirmed` or `failed`. Amounts are read from the confirmed transaction: entry cost is the total SOL that left the wallet (swap, network and priority fees, token-account rent) and exit proceeds are net of fees. Every confirmation writes a row to `fills`. Confirmations are idempotent, so the live path and the recovery job can never open a position twice.

**Recovery** (`live-recovery`, every 30s). Pending live orders older than 90s are checked with `getSignatureStatuses`: landed transactions are confirmed from on-chain data, failed ones are closed out, and unseen ones are failed only after their blockhash has expired. A failed sell returns the position to `open` so the exit is retried; a `closing` position without a pending sell order is released.

**Reconciliation** (`live-reconcile`, every 5 minutes, live mode only). Wallet token balances are compared with open live positions. If the wallet holds less than the database expects, entries are paused and a critical alert is sent. Mints with pending orders are skipped.

**Controls.**
- *Pause entries* blocks new buys; exits (risk exit, stop loss, take profit, time stop) keep protecting open positions.
- *Emergency halt* blocks every live send, including exits. Both are re-checked right before each broadcast.

**Hard caps** (env only, not editable from the dashboard): `LIVE_MAX_ENTRY_LAMPORTS` (default 0.1 SOL), `LIVE_DAILY_SPEND_LIMIT_LAMPORTS` (default 0.3 SOL, includes pending buys) and `LIVE_MIN_SOL_RESERVE_LAMPORTS` (default 0.05 SOL left in the wallet after an entry plus fee headroom). An entry larger than the cap is rejected, never resized.

**Fast exits.** The worker polls Jupiter Price API v3 every `PRICE_LOOP_INTERVAL_MS` (default 5000) for open positions in the active mode. When the estimated PnL is within 3 percentage points of the stop loss or take profit, it queues an `exit-check` that decides with an exact Jupiter quote. Prices are only used as a trigger, never for accounting.

Optional tuning: `JUPITER_SWAP_URL`, `JUPITER_QUOTE_URL`, `JUPITER_PRICE_URL`, `JUPITER_API_KEY`, `JUPITER_DYNAMIC_SLIPPAGE`, `LIVE_MAX_PRIORITY_FEE_LAMPORTS` (default 500000), `LIVE_PRIORITY_LEVEL` (default `high`), `LIVE_SEND_MAX_RETRIES` (default 2), `LIVE_SKIP_PREFLIGHT`.

## Database rules

- PostgreSQL is the source of truth for assessments, signals, orders, fills, positions, and audit history.
- Raw token amounts and lamports use exact `numeric` columns; application code must not convert them to floating point.
- Signals and orders have unique idempotency keys.
- Risk assessments are append-only and versioned per token.

## Security

All pages and APIs except `/login`, `/api/auth/login` and `/api/live` require a signed, HTTP-only admin session when `AUTH_REQUIRED=true`. Unsafe requests require an exact same-origin match, and login attempts are rate-limited. Set `AUTH_REQUIRED=true` outside local development.

## Commands

- `npm run dev` — start the dashboard in development mode.
- `npm run worker` — start the BullMQ analysis and trading worker.
- `npm run db:generate` — generate SQL after schema changes.
- `npm run db:migrate` — apply pending migrations.
- `npm run db:studio` — inspect local data.
- `npm run typecheck` — run TypeScript checks.
- `npm test` — run unit tests.
- `npm run test:integration` — run database integration tests (requires PostgreSQL).
- `npm run build` — create the production build.

Production deployment, backups and restore drills are described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
