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

## Analysis pipeline

1. **CA submission** (`POST /api/candidates`) — reads mint/freeze authority, enriches market data, verifies the Pump.fun migration transaction on-chain and identifies the creator.
2. **Worker jobs** (BullMQ on Redis):
   - `market-refresh` every 5 minutes.
   - `holder-bundle-analysis` once, then `holder-analysis` every 15 minutes — top holders, direct funders, creator cluster and bundle evidence.
   - `shadow-scan` every 60 seconds — exits first, then entries for eligible tokens.
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

### Live trading — not production-ready

Live execution code exists in `src/lib/live.ts`, but it is **not safe for real funds yet**. Known gaps:

- No reconciliation between wallet balances and database positions.
- Orders stuck in `submitted` after a process crash are not recovered automatically.
- PnL ignores swap fees and priority fees.
- Stop loss is only checked every 60 seconds by `shadow-scan`.
- No automated tests cover the live path.

Live mode only runs when all of these are set:

- `TRADING_MODE=live`
- `LIVE_TRADING_ENABLED=true`
- `SOLANA_RPC_URL`
- One of `SOLANA_PRIVATE_KEY_BASE58`, `SOLANA_PRIVATE_KEY_JSON` or `SOLANA_KEYPAIR_PATH`

Optional tuning: `JUPITER_SWAP_URL`, `JUPITER_API_KEY`, `JUPITER_DYNAMIC_SLIPPAGE`, `LIVE_MAX_PRIORITY_FEE_LAMPORTS` (default 500000), `LIVE_PRIORITY_LEVEL` (default `high`), `LIVE_SEND_MAX_RETRIES` (default 2), `LIVE_SKIP_PREFLIGHT`.

Every swap is simulated with signature verification before sending, and fills are recorded from on-chain balance deltas after confirmation.

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
