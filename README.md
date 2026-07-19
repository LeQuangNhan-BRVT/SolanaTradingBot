# Aegis Solana Terminal

Risk-first research and paper-trading terminal for Solana memecoins after migration.

## Development

1. Copy `.env.example` to `.env.local`.
2. Start PostgreSQL: `docker compose up -d postgres`.
3. Apply schema: `npm run db:migrate`.
4. Start the app: `npm run dev`.

Without `DATABASE_URL`, the dashboard continues with mock candidates and the CA API performs read-only RPC inspection. With `DATABASE_URL`, every CA assessment is stored transactionally in `tokens`, `risk_assessments`, and `audit_logs`.

## Database rules

- PostgreSQL is the source of truth for assessments, signals, orders, fills, positions, and audit history.
- Raw token amounts and lamports use exact `numeric` columns; application code must not convert them to floating point.
- Signals and orders have unique idempotency keys.
- Risk assessments are append-only and versioned per token.
- Live trading remains unavailable until migration verification, bundle analysis, reconciliation, and execution safeguards are complete.

## Commands

- `npm run db:generate` — generate SQL after schema changes.
- `npm run db:migrate` — apply pending migrations.
- `npm run db:studio` — inspect local data.
- `npm run typecheck` — run TypeScript checks.
- `npm run build` — create the production build.
