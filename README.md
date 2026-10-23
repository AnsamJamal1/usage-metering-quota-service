# Usage Metering and Quota Service

A backend service that other applications call to track usage and decide whether their users may perform an action. Every request is checked against **two plans at once**: the calling account's plan (limits shared by all of its users) and the individual user's plan.

Stack: TypeScript (Node.js 20), Fastify, PostgreSQL 16 with raw SQL (`pg`), Vitest, autocannon.

## Contents

- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Authentication and API keys](#authentication-and-api-keys)
- [Predefined plans](#predefined-plans)
- [Rules and how consumption is decided](#rules-and-how-consumption-is-decided)
- [Changing plans](#changing-plans)
- [Retries and idempotency](#retries-and-idempotency)
- [API reference](#api-reference)
- [Walkthrough with curl](#walkthrough-with-curl)
- [Example client](#example-client)
- [Database design](#database-design)
- [Concurrency and design decisions](#concurrency-and-design-decisions)
- [Product assumptions](#product-assumptions)
- [Tests](#tests)
- [Performance testing](#performance-testing)
- [Known limitations](#known-limitations)
- [Project layout](#project-layout)

## Quick start

Requirements: Docker Desktop (or Docker Engine with the Compose plugin). Nothing else is needed to run the full stack.

```sh
git clone https://github.com/AnsamJamal1/usage-metering-quota-service.git
cd usage-metering-quota-service
docker compose up --build
```

On startup the service applies the database migrations and seeds the predefined plans automatically. Wait for these log lines:

```text
migration applied: 001_init.sql
Server listening at http://0.0.0.0:3000
Example Client running on port 3001
```

| URL | What it is |
| --- | --- |
| <http://localhost:3001> | Example client (web page) |
| <http://localhost:3000> | Metering API |
| <http://localhost:3000/health> | Health check (also checks the database) |

Ports used on the host: `3000` (API), `3001` (client), `5432` (PostgreSQL). If one is taken, stop the other program or change the mapping in `docker-compose.yml`.

Stop the stack:

```sh
docker compose down        # keeps the database volume
docker compose down -v     # also deletes all data
```

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/quota` | PostgreSQL connection string (set to the `db` service inside Compose) |
| `PG_POOL_MAX` | `20` | Maximum database connections in the pool |
| `ADMIN_KEY` | unset | If set, `POST /v1/accounts` requires the header `X-Admin-Key: <value>` |
| `API_URL` (client) | `http://localhost:3000` | Where the example client finds the API |

A sample file is in `service/.env.example`. Defaults work for `docker compose up` with no configuration.

### Running without Docker for the service (development)

```sh
docker compose up -d db        # only PostgreSQL
cd service
npm install
npm run dev                    # API on http://localhost:3000
```

In another terminal:

```sh
cd client
npm install
node server.js                 # client on http://localhost:3001
```

## Concepts

| Concept | Meaning |
| --- | --- |
| **Account** | An application or company calling the service. It has an API key and an **account plan** whose limits are shared by all its users. |
| **User** | A user of that application, registered under one account. It has a **user plan** with individual limits. Users are identified by an `externalId` chosen by the calling application (unique within the account). |
| **Plan** | A named set of rules (monthly allowance, maximum units per request) with a scope: `account` or `user`. |
| **Units** | The single resource being metered (for example document-processing credits). Always a positive whole number. |

An account plan and a user plan always apply together. Giving a user a larger allowance never increases the account's shared allowance. Several users can share the same plan definition and still keep separate usage totals.

## Authentication and API keys

- Create an account with `POST /v1/accounts`. The response contains the account and its **API key** (prefix `qk_`).
- **The key is shown only once.** Only a SHA-256 hash is stored, so a leaked database does not leak usable keys. A lost key cannot be recovered (see [limitations](#known-limitations)).
- Send the key on every other request in the `X-API-Key` header.
- The account is always taken **from the key**, never from the request body or URL. Every query is scoped by that account id, so an account cannot read or change another account's users, plans, usage or history. Looking up a user that belongs to another account returns `404`, the same as a user that does not exist.
- A missing key returns `401 missing_api_key`; an unknown key returns `401 invalid_api_key`.
- Account creation is open by default (suitable for local use and the demo). Set `ADMIN_KEY` to require `X-Admin-Key` for it.

```sh
curl -s -X POST http://localhost:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme"}'
```

```json
{
  "account": { "id": "…", "name": "Acme", "planId": "00000000-0000-4000-8000-000000000001", "createdAt": "…" },
  "apiKey": "qk_…"
}
```

New accounts start on the **Starter** plan unless a predefined account `planId` is given.

## Predefined plans

Seeded at startup with fixed ids, read-only, and visible to every account. Seeding is idempotent.

| Scope | Plan | Id | Monthly allowance | Max per request |
| --- | --- | --- | ---: | ---: |
| account | Starter (default) | `00000000-0000-4000-8000-000000000001` | 10,000 | 100 |
| account | Pro | `00000000-0000-4000-8000-000000000002` | 100,000 | 1,000 |
| user | Basic (default) | `00000000-0000-4000-8000-000000000003` | 1,000 | 20 |
| user | Premium | `00000000-0000-4000-8000-000000000004` | 10,000 | 200 |

**Custom plans.** An account can create its own plans (`scope` `account` or `user`), edit them, and assign them to itself or to its users. Custom plans are private to the account that created them. A limit set to `null` means "unlimited".

## Rules and how consumption is decided

Two rule types exist, on both account plans and user plans:

| Rule | Meaning |
| --- | --- |
| `monthly_allowance` | Total units available in a UTC calendar month. |
| `max_per_request` | Largest amount that may be consumed in one request. |

A consume request is **accepted only if all four checks pass**: account per-request, user per-request, account monthly, user monthly. The full amount is accepted or the request is rejected; there is no partial acceptance, and **a rejection consumes nothing**.

Example: account plan 10,000 per month and 100 per request, user plan 1,000 per month and 20 per request.

- 25 units: rejected by the **user** per-request limit, even though both monthly allowances have room.
- 10 units: accepted when both have room; it adds 10 to the user's usage and 10 to the account's shared usage.
- The account has only 5 units left: a 10-unit request is rejected by the **account** monthly allowance, even if the user has plenty left.

### Decision explanation

Every response says whether the request was accepted. A rejection carries a `reason` naming the rule and which level owns it. If several rules would reject the request, the reason reported is the first violated rule in this fixed order:

1. account `max_per_request`
2. user `max_per_request`
3. account `monthly_allowance`
4. user `monthly_allowance`

Per-request rules come first because they do not depend on usage, so the caller learns that the request can never succeed as sent.

```json
{
  "requestId": "r4",
  "units": 50,
  "accepted": false,
  "reason": { "level": "account", "rule": "monthly_allowance", "limit": 100 },
  "remaining": { "account": 40, "user": 9950 },
  "replayed": false
}
```

`remaining` is the monthly allowance left after the decision (`null` means unlimited). It never goes below zero.

### Usage periods

- Usage belongs to the **UTC calendar month** in which the request is processed.
- Each month has its own counters, so a new month starts at zero at both levels automatically, with no scheduled job.
- Earlier months stay queryable through `?month=YYYY-MM`.

## Changing plans

- A plan change applies to **new requests** once the update has succeeded. Plans are read from the database inside each consume transaction; there is **no plan cache**, so no redeploy or invalidation is needed.
- Updating a custom plan affects every account or user currently assigned to it.
- Switching an account or user to another plan **keeps the units already consumed** this month. It does not grant a fresh allowance.
- If a monthly allowance is lowered below existing usage, `remaining` is reported as `0` and further consumption at that level is rejected until the allowance is raised or the next month begins.
- Past request history is never rewritten. Each history row stores the plan ids and a snapshot of the limits and usage used for that decision.

## Retries and idempotency

Every consume request carries a caller-chosen `requestId`, unique within the account.

- Retrying the **same** `requestId` with the same user and units returns the original decision with `"replayed": true` and **does not consume units again**. This holds for rejected decisions too.
- Reusing a `requestId` with a **different** user or units returns `409 idempotency_conflict`.
- Concurrent duplicates are safe: requests of one account are serialized by a row lock (see below), so the duplicate check cannot race, and a unique constraint on `(account_id, request_id)` backs it up.
- On a replay, `remaining` is computed from the snapshot stored at decision time, so it reflects the original decision rather than the current balance. Use `GET /v1/usage` for current balances.
- To try a rejected action again after changing a plan, send a **new** `requestId`.

## API reference

Base URL `http://localhost:3000`. All routes except `/health` and `POST /v1/accounts` need the `X-API-Key` header. Bodies are JSON.

### Errors

All errors share one shape:

```json
{ "error": { "code": "invalid_api_key", "message": "The API key is not valid", "details": null } }
```

| Status | Codes |
| --- | --- |
| 400 | `validation_error` (with `details`), `invalid_plan`, `invalid_month` |
| 401 | `missing_api_key`, `invalid_api_key`, `invalid_admin_key` |
| 404 | `user_not_found`, `plan_not_found`, `not_found` |
| 409 | `idempotency_conflict`, `user_exists` |
| 500 | `internal_error` (no internal details are exposed) |

A quota rejection is **not** an HTTP error: it returns `200` with `"accepted": false`, because it is a valid business decision. Callers must check `accepted`.

### Accounts

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/accounts` | Create an account. Body `{ "name", "planId"? }`. Returns `201` with the API key (once). |
| `GET` | `/v1/account` | The authenticated account and its current plan with limits. |
| `PUT` | `/v1/account/plan` | Assign a plan. Body `{ "planId" }`. Must be a predefined or own account-scope plan. |

### Plans

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/plans` | Predefined plans plus the account's own plans (JSON array). |
| `POST` | `/v1/plans` | Create a custom plan. Body `{ "name", "scope", "monthlyAllowance", "maxPerRequest" }`. Both limits are required; use `null` for unlimited. Plan names are unique per account and scope (`409` otherwise). |
| `PATCH` | `/v1/plans/:id` | Update `name`, `monthlyAllowance` and/or `maxPerRequest` of an own custom plan. Predefined plans cannot be modified. |

### Users

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/users` | Register a user. Body `{ "externalId", "planId"? }` (default plan Basic). `409 user_exists` if the id is taken in this account. |
| `GET` | `/v1/users` | All users of the account with their plans and limits. |
| `GET` | `/v1/users/:externalId` | One user with plan and limits. |
| `PUT` | `/v1/users/:externalId/plan` | Assign a plan. Body `{ "planId" }`. Must be a predefined or own user-scope plan. |

### Consume, usage and history

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/consume` | Consume units. Body `{ "userId", "units", "requestId" }` where `userId` is the user's `externalId`. |
| `GET` | `/v1/usage?month=YYYY-MM` | Consumed and remaining units for the account and each user. `month` defaults to the current UTC month. |
| `GET` | `/v1/usage/users/:externalId?month=YYYY-MM` | Same for one user. |
| `GET` | `/v1/requests` | Paginated request history, newest first. Query: `limit` (1–100, default 20), `offset` (default 0), `month=YYYY-MM`, `userId` (an `externalId`), `status` (`accepted` or `rejected`). Returns `{ total, limit, offset, data }`. |

`units` must be a positive whole number and `requestId` a non-empty string of at most 255 characters. In history rows, `userId` is the internal user id.

## Walkthrough with curl

This reproduces every behavior the brief asks for against a running stack (`docker compose up --build`). It uses Bash (Git Bash on Windows works) and Node.js only to read JSON fields.

```sh
API=http://localhost:3000/v1
JSON="Content-Type: application/json"
j() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1"; }
consume() { curl -s -X POST $API/consume -H "$H" -H "$JSON" \
  -d "{\"userId\":\"$1\",\"units\":$2,\"requestId\":\"$3\"}"; echo; }

# 1. Account with a small custom account plan: 100 per month, 50 per request
KEY=$(curl -s -X POST $API/accounts -H "$JSON" -d '{"name":"Acme"}' | j .apiKey)
H="X-API-Key: $KEY"
TINY=$(curl -s -X POST $API/plans -H "$H" -H "$JSON" \
  -d '{"name":"Tiny","scope":"account","monthlyAllowance":100,"maxPerRequest":50}' | j .id)
curl -s -X PUT $API/account/plan -H "$H" -H "$JSON" -d "{\"planId\":\"$TINY\"}"; echo

# 2. Two users with different plans: alice = Basic (1000/20), bob = Premium (10000/200)
curl -s -X POST $API/users -H "$H" -H "$JSON" -d '{"externalId":"alice"}'; echo
curl -s -X POST $API/users -H "$H" -H "$JSON" \
  -d '{"externalId":"bob","planId":"00000000-0000-4000-8000-000000000004"}'; echo
```

**Accepted action**

```sh
consume alice 10 r1
# {"requestId":"r1","units":10,"accepted":true,"reason":null,"remaining":{"account":90,"user":990},"replayed":false}
```

**Rejection caused by a user limit** (25 > Basic's 20 per request; the account allows it)

```sh
consume alice 25 r2
# {"requestId":"r2","units":25,"accepted":false,"reason":{"level":"user","rule":"max_per_request","limit":20},"remaining":{"account":90,"user":990},"replayed":false}
```

**Rejection caused by the shared account limit** (bob has plenty left, the account does not)

```sh
consume bob 50 r3
# accepted: remaining account 40, user 9950
consume bob 50 r4
# {"requestId":"r4","units":50,"accepted":false,"reason":{"level":"account","rule":"monthly_allowance","limit":100},"remaining":{"account":40,"user":9950},"replayed":false}
```

**Safe retry** (same `requestId`, nothing is consumed again)

```sh
consume alice 10 r1
# {"requestId":"r1","units":10,"accepted":true,"reason":null,"remaining":{"account":90,"user":990},"replayed":true}
```

**Change a plan: same call, different outcome.** Raise the custom account plan's allowance, then repeat the request that was rejected, with a new `requestId`:

```sh
curl -s -X PATCH $API/plans/$TINY -H "$H" -H "$JSON" -d '{"monthlyAllowance":1000}'; echo
consume bob 50 r5
# accepted: remaining account 890, user 9900
```

**Switch a user's plan.** Move alice to Premium and the request that failed her per-request limit now succeeds; her usage so far is kept:

```sh
curl -s -X PUT $API/users/alice/plan -H "$H" -H "$JSON" \
  -d '{"planId":"00000000-0000-4000-8000-000000000004"}'; echo
consume alice 25 r6
# accepted: remaining account 865, user 9965
```

**Usage and history**

```sh
curl -s "$API/usage" -H "$H"                              # current month, account and users
curl -s "$API/usage?month=2026-09" -H "$H"                # a previous month
curl -s "$API/requests?limit=5&status=rejected" -H "$H"   # paginated history
```

## Example client

A small web application (`client/`, Express) that plays the role of a business application. It calls the service with an account's API key **from its own server**, so the key never reaches the browser, and it simulates a document-processing action.

1. Open <http://localhost:3001>.
2. **Initialize Account & Users** creates a demo account on a small custom plan and registers a user.
3. The consume buttons send `POST /v1/consume` for the demo user and print the decision (`accepted`, `reason`, `remaining`).
4. **Refresh Usage** shows consumed and remaining units from `GET /v1/usage`.
5. **Upgrade Account Plan to Pro** switches the account's plan through the API; repeating the same button afterwards behaves differently without any client change.

The complete scenario required by the brief (two users on different plans, a user-limit rejection, a shared-account-limit rejection, and a plan change that alters the outcome) is reproducible step by step in the [curl walkthrough](#walkthrough-with-curl).

## Database design

| Table | Purpose |
| --- | --- |
| `accounts` | Account name, `api_key_hash` (unique), current `plan_id`. |
| `plans` | Predefined plans (`account_id` NULL, `is_predefined` true) and custom plans (owned by an account). `monthly_allowance` and `max_per_request` are nullable (unlimited). A check constraint enforces `is_predefined = (account_id IS NULL)`. Names are unique per account and scope. |
| `users` | `(account_id, external_id)` unique, current `plan_id`. |
| `account_usage` | `(account_id, period)` primary key, `consumed`. One row per account per month. |
| `user_usage` | `(user_id, period)` primary key, `consumed`. One row per user per month. |
| `requests` | Ledger of every decision: units, period, status, rejecting level and rule, the account and user plan ids, and a JSON `snapshot` of limits and usage at decision time. Unique on `(account_id, request_id)`. |
| `schema_migrations` | Applied migration files. |

Choices worth noting:

- **Counters per month** instead of resetting one counter: a month rollover needs no job, and earlier months stay queryable.
- **Two counter tables** keep the account total and each user's total readable in constant time. They are updated in the same transaction as the ledger row, so they cannot drift from it.
- **Ledger with snapshot** keeps history meaningful after plans change.
- Check constraints (`consumed >= 0`, `units > 0`, allowed statuses) act as a last line of defense behind the application code.
- Migrations are ordered SQL files applied at startup inside transactions, guarded by an advisory lock so several instances starting together cannot collide. Seeding uses `ON CONFLICT DO NOTHING`.

## Concurrency and design decisions

Each consume request runs in one database transaction:

1. Look up the user within the authenticated account (`404` if absent).
2. `INSERT … ON CONFLICT DO UPDATE` on the account's counter row for the current month. This creates the row if needed **and takes its row lock** in one statement. All other requests of the same account now wait.
3. Check the ledger for an existing `requestId` (replay or `409`). This is race-free because of the lock in step 2.
4. Lock the user's counter row the same way. The lock order is always **account, then user**, so deadlocks cannot happen.
5. Read the current account and user plans (no cache).
6. Evaluate the four rules with a pure function (`service/src/rules/evaluate.ts`).
7. If accepted, increase both counters. Always write the ledger row. Commit.

Why this design:

- **Correctness first.** Checking and incrementing under a row lock makes it impossible for concurrent requests to exceed an allowance. The account row is the natural serialization point because every request must satisfy the shared account limit.
- **No plan cache.** Plans are read inside the transaction, so a plan change is seen by the very next request.
- **Pure rule evaluation.** `evaluate` has no I/O, which makes it easy to test and to extend with new rule types.
- **Raw SQL with `pg`.** Locking behavior is explicit and visible in the code.
- The trade-off is that requests for the **same account are processed one at a time**, so one very busy account is limited by transaction latency. Different accounts run fully in parallel. See [performance testing](#performance-testing).

## Product assumptions

The brief leaves these open; each choice below is applied consistently.

1. **Quota rejections return HTTP 200** with `accepted: false`. HTTP errors are reserved for invalid input, authentication and conflicts.
2. **Rejected requests are recorded** in the history and are idempotent like accepted ones (a retry returns the same rejection). A new attempt needs a new `requestId`.
3. **`requestId` is unique per account**, not globally.
4. **Users are identified by a caller-supplied `externalId`**, unique within the account. The same id may exist in different accounts. The consume field is named `userId` and carries this value.
5. **`null` means unlimited** for either rule.
6. **Account creation is open** unless `ADMIN_KEY` is set, because the brief does not define who may create accounts.
7. **Predefined plans are global and read-only.** Custom plans are private to the creating account; only an account's own plans (or predefined ones of the right scope) can be assigned to it or its users.
8. **The month is taken when the request is processed**, in UTC, using the server clock.
9. **Plan names** are unique per account and scope.
10. **Order of reported reasons** is fixed (account per-request, user per-request, account monthly, user monthly); other violated rules are not listed.
11. **No partial consumption**: a request is accepted in full or not at all.
12. **Plans cannot be deleted** (out of the required scope).

## Tests

The suite has 36 tests in 7 files. It covers API key validation, account isolation (accounts, plans, users), predefined and custom plans, the four rules and their precedence, consumption with both counters, rejection consuming nothing, idempotent replay and `409` conflicts, concurrent consumption not exceeding a limit, plan changes (larger plan keeps usage, allowance reduced below usage gives zero remaining and rejects, history preserved, restoring the allowance), usage and history with pagination and past months, and migrations/seed idempotency.

The tests need a running PostgreSQL on `localhost:5432` with a database named `quota_test` (separate from the development database `quota`). Migrations and seeding run automatically before the tests.

```sh
docker compose up -d db
docker compose exec db psql -U postgres -c "CREATE DATABASE quota_test"   # once
cd service
npm install
npm test
```

If you started the stack with a different database container, make sure only one PostgreSQL is bound to port 5432.

## Performance testing

The load test lives in `perf/` and uses [autocannon](https://github.com/mcollina/autocannon).

Requirements: Node.js 20 and the stack running (`docker compose up --build`).

```sh
cd perf
npm install
node load-test.js
```

The script creates a fresh account with a very large allowance and a user, then sends `POST /v1/consume` with 50 concurrent connections for 10 seconds, and prints requests per second, p99 latency, total requests and errors.

> **Results to fill in after running the corrected test** (each request must use its own `requestId`, and the totals must be verified against the database afterwards):
>
> | Scenario | Connections | Requests/s | p50 | p99 | non-2xx | Counters match ledger |
> | --- | ---: | ---: | ---: | ---: | ---: | --- |
> | One hot account, one user | 50 | _ | _ | _ | _ | _ |
> | Many accounts and users | 50 | _ | _ | _ | _ | _ |
> | Requests rejected at the limit | 50 | _ | _ | _ | _ | _ |
>
> Machine used: _ (CPU, RAM, Docker Desktop on Windows/macOS/Linux).

What the test is meant to show and what to look for:

- **Correctness under load.** After a run, the sum of accepted units in `requests` must equal `account_usage.consumed` and the sum of `user_usage.consumed` for the month, and no allowance may be exceeded.
- **The bottleneck.** Requests of one account are serialized by its counter row lock, so a single hot account is bounded by transaction latency, while many accounts scale with the connection pool. This is a deliberate trade-off for exact enforcement of the shared allowance.
- **Tuning.** The main levers are the pool size (`PG_POOL_MAX`), keeping the transaction short and the number of round trips low, and indexes on the lookup paths.

## Known limitations

- **Hot account bound.** All requests of one account are serialized by the account counter row lock. Throughput for a single very busy account is limited by transaction latency. Possible improvements: fewer round trips per transaction (a single SQL function), or reserving blocks of units, at the cost of more complexity.
- **Single service instance** with one database. The locking is database-based, so several instances would still be correct, but horizontal scaling and failover were not tested.
- **API keys cannot be rotated or recovered**; a lost key means creating a new account.
- **No rate limiting** and no authentication for account creation unless `ADMIN_KEY` is set.
- **`units` has no explicit upper bound.** Extremely large values (beyond the database `bigint` range) produce an internal error instead of a validation error.
- **History uses offset pagination**, which gets slower on very deep pages, and history rows expose the internal user id rather than the `externalId`.
- **`GET /v1/users` and `GET /v1/plans` are not paginated.**
- **Replayed responses** report `remaining` as of the original decision.
- **Naming is not uniform**: users are created with `externalId` but referenced as `userId` in `/v1/consume`.
- **Plans cannot be deleted**, and there are no roles or end-user login (both outside the required scope).
- **Attempting to modify a predefined plan returns `404 plan_not_found`**, not `403`, because the update lookup only matches plans owned by the account.
- The month boundary relies on the server clock; there is no automated test that moves the clock across a month change (past months are tested by inserting usage rows directly).

## Project layout

```text
.
├── docker-compose.yml        # db + service + client
├── client/                   # example application (Express + static page)
├── perf/                     # load test (autocannon)
└── service/
    ├── Dockerfile
    ├── migrations/001_init.sql
    ├── src/
    │   ├── index.ts          # startup: migrate, seed, listen
    │   ├── app.ts            # Fastify app, error handling, route registration
    │   ├── auth.ts           # X-API-Key middleware
    │   ├── apiKey.ts         # key generation and hashing
    │   ├── db.ts             # pool and transaction helper
    │   ├── migrate.ts, seed.ts
    │   ├── rules/evaluate.ts # pure rule evaluation
    │   ├── services/consume.ts   # the consume transaction
    │   └── routes/           # accounts, plans, users, consume, usage
    └── tests/                # Vitest suites
```
