# Usage Metering and Quota Service

A backend service for tracking usage and enforcing quotas across accounts and their users. It supports predefined and custom plans, idempotent consumption requests, concurrency-safe quota enforcement, and monthly usage periods based on UTC.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Example flow](#example-flow)
- [Architecture and data model](#architecture-and-data-model)
- [API](#api)
- [Plans and quota behavior](#plans-and-quota-behavior)
- [Concurrency](#concurrency)
- [Load test](#load-test)
- [Tests](#tests)

## Features

- Account- and user-level monthly quotas and per-request limits
- Predefined plans and account-owned custom plans
- API-key authentication
- Idempotent consumption requests
- Transactional quota checks with concurrency control
- Usage summaries and paginated request history
- Docker Compose setup for PostgreSQL, the API, and an example web client

## Quick start

Start PostgreSQL, the API service, and the example client from the repository root:

```sh
docker compose up --build
```

Once the services are running:

- Example client: <http://localhost:3001>
- API base URL: <http://localhost:3000>

Stop the services with `Ctrl+C` or run:

```sh
docker compose down
```

To also remove the database volume and its data:

```sh
docker compose down -v
```

## Example flow

1. Open the example client at <http://localhost:3001>.
2. Select **Initialize Account & Users** to create an account with a low-quota custom plan and a user named `Ansam`.
3. Select **Process 10 Documents**. The request is accepted because both the user and account have quota available.
4. Select **Process 25 Documents**. The request is rejected because it exceeds Ansam's per-request limit.
5. Select **Process 15 Documents** twice. The first request is accepted; the second is rejected because the account's shared monthly allowance has been exceeded.
6. Select **Upgrade Account Plan to Pro** and consume again. The plan change applies immediately.

## Architecture and data model

| Component | Technology |
| --- | --- |
| Language | TypeScript (Node.js 20) |
| API framework | Fastify |
| Database | PostgreSQL 16, accessed with the `pg` driver and raw SQL |
| Tests | Vitest |
| Load testing | autocannon |

Main database tables:

| Table | Purpose |
| --- | --- |
| `accounts` | Account details and hashed API keys |
| `users` | Users belonging to an account, identified by a client-supplied `externalId` |
| `plans` | Predefined global plans and account-owned custom plans |
| `account_usage`, `user_usage` | Monthly aggregate usage counters |
| `requests` | Request ledger with a snapshot of the evaluated quota rules |

## API

Protected endpoints require the `X-API-Key` header. The API key is returned only once when an account is created.

```http
X-API-Key: qk_...
```

### Accounts

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/v1/accounts` | Create an account and return its API key |
| `GET` | `/v1/account` | Get the authenticated account and its active plan |
| `PUT` | `/v1/account/plan` | Change the account's plan |

### Plans and users

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/v1/plans` | List plans available to the account |
| `POST` | `/v1/plans` | Create an account-owned custom plan (`scope`: `account` or `user`) |
| `PATCH` | `/v1/plans/:id` | Update a custom plan; predefined plans are read-only |
| `POST` | `/v1/users` | Register a user under the account |
| `GET` | `/v1/users` | List the account's users |
| `GET` | `/v1/users/:externalId` | Get a user by external ID |
| `PUT` | `/v1/users/:externalId/plan` | Change a user's plan |

### Usage and requests

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/v1/consume` | Consume units for a user |
| `GET` | `/v1/usage` | Get current-month usage for the account and its users |
| `GET` | `/v1/usage/users/:externalId` | Get current-month usage for one user |
| `GET` | `/v1/requests` | Get paginated request history |

The request history endpoint accepts `limit`, `offset`, and `status` query parameters, for example:

```text
/v1/requests?limit=20&offset=0&status=accepted
```

Example consumption request:

```http
POST /v1/consume
Content-Type: application/json
X-API-Key: qk_...
```

```json
{
  "userId": "ansam",
  "units": 10,
  "requestId": "unique-uuid-here"
}
```

## Plans and quota behavior

Predefined plans are read-only:

| Scope | Plan | Monthly allowance | Maximum per request |
| --- | --- | ---: | ---: |
| Account | Starter | 10,000 | 100 |
| Account | Pro | 100,000 | 1,000 |
| User | Basic | 1,000 | 20 |
| User | Premium | 10,000 | 200 |

The service follows these behaviors:

- **Quota rejections return HTTP 200.** A quota rejection is a successful business decision, not an HTTP-level failure. The response includes `accepted: false` and a reason, for example:

  ```json
  {
    "accepted": false,
    "reason": {
      "level": "user",
      "rule": "max_per_request"
    }
  }
  ```

- **Consumption requests require a `requestId`.** Repeating a request with the same ID returns the original result without consuming units again. Reusing the ID with a different payload returns `409 Conflict`.
- **Plan changes take effect immediately.** Plans are read from the database within the transaction; there is no plan cache.
- **Remaining quota never goes below zero.** If an allowance is lowered below current usage, remaining quota is reported as zero and further requests are rejected until the next month.
- **Usage periods follow UTC calendar months.** A period is represented as `YYYY-MM`; usage is assigned to the UTC month in which the request is processed.

## Concurrency

Quota checks and usage increments run inside a single database transaction. The service acquires a row-level lock for the account usage counter before locking the user counter. This consistent lock order helps prevent deadlocks while ensuring concurrent requests cannot over-consume the account quota.

The account counter uses an atomic insert/update pattern to lock the relevant period row:

```sql
INSERT INTO account_usage (account_id, period, consumed)
VALUES ($1, $2, 0)
ON CONFLICT (account_id, period)
DO UPDATE SET consumed = account_usage.consumed
RETURNING consumed;
```

## Load test

A load test was run with 50 concurrent connections for 10 seconds, targeting the same account to exercise row-lock contention:

| Metric | Result |
| --- | ---: |
| Throughput | ~251 requests/second |
| p99 latency | 651 ms |
| Errors | 0 |
| Total requests | 2,513 |

The account counter's row lock is the primary bottleneck in this scenario. This is a deliberate trade-off for strict quota enforcement.

Run the load test while the API is available:

```sh
cd perf
npm install
node load-test.js
```

## Tests

The test suite covers API-key validation, account isolation, rule evaluation, idempotency, concurrency, and plan changes.

Run the tests locally:

```sh
cd service
npm install
npm test
```

The test suite automatically runs database migrations and seeds the test database.
