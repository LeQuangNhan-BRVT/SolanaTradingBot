# Production deployment

## 1. Configure secrets

Copy `.env.production.example` to `.env.production`, replace the PostgreSQL password, admin password, session secret, RPC URL and API keys. Use at least 12 characters for `ADMIN_PASSWORD` and at least 32 random characters for `SESSION_SECRET`. Set `APP_ORIGIN` to the exact public HTTPS origin when using a reverse proxy; this also enables the Secure flag on the session cookie. The real `.env.production` file is ignored by Git and Docker build context.

Keep `WEB_BIND_ADDRESS=127.0.0.1` unless the dashboard is protected by an authenticated HTTPS reverse proxy. PostgreSQL and Redis are only attached to the internal Docker network and expose no host ports.

All dashboard pages and APIs except `/login`, `/api/auth/login`, and `/api/live` require a signed, HTTP-only admin session. Unsafe requests also require an exact same-origin match. Login attempts are rate-limited through Redis.

## 2. Validate and start

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet
docker compose --env-file .env.production -f docker-compose.prod.yml build
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

The one-shot `migrate` service must complete successfully before web and worker start. Visit `/api/live` for public process liveness. After logging in, use `/api/health` or the Health page for database, Redis, worker and data-freshness readiness.

Entries default to paused when the settings row does not exist. Review `/settings`, then explicitly resume entries from the dashboard.

## 3. Back up PostgreSQL

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml --profile tools run --rm backup
```

Backups are written to `./backups` in PostgreSQL custom format. Copy them to encrypted off-machine storage and define a retention policy.

## 4. Restore drill

Restore only into a new or intentionally emptied database. Verify the target before running:

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres pg_restore --clean --if-exists -U aegis -d aegis /backups/FILE.dump
```

Test restoration periodically on an isolated Compose project; a backup that has never been restored is not considered verified.

## 5. Upgrade

Pause entries first, take a backup, build the new image, and apply the stack:

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml build
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

Confirm that `migrate` exited with code 0 and both web and worker are healthy before resuming entries.
