# Colo Colo Sydney — Function App

TypeScript Azure Functions v4 backend for the staff dashboard. Shared service methods enforce roles, project scope, validation, optimistic concurrency, command idempotency and record history. Production uses Cosmos DB for NoSQL and private Blob Storage.

## Local development (no cloud services)

Use Node.js 24 (or 22.12+) and npm:

```sh
npm ci
npm run dev
```

The local server binds to `127.0.0.1:7071`, writes `.data/club.json` and `.data/files`, and grants a clearly labelled local administrator session. It cannot connect to Cosmos. The first run seeds a few example projects/tasks; stock quantities start unknown/empty. Set `SEED_DEMO=false` for a new empty local store. No Azure Functions Core Tools or Azurite is needed for this mode.

`local.settings.example.json` documents settings; an optional ignored `local.settings.json` can be copied from it. Never deploy its development authentication or storage settings. Production rejects them.

```sh
npm test
npm run build
```

For a real Functions host, install Azure Functions Core Tools v4 and run `npm start` after building and configuring host storage/identity. `src/local.ts` is a development adapter; the deployed trigger is `src/functions/http.ts`.

## Azure settings

See [the setup guide in the dashboard repo](../colo-committee-dash/docs/AZURE_SETUP.md) and [azure.appsettings.example.json](azure.appsettings.example.json).

Existing database: `phd-helper`. Existing container: `colo-inventory`, partition key `/id`.
Additional containers: `colo-work`, `colo-contacts`, `colo-content`, `colo-automation`, `colo-access`, all `/id`.
Private binary storage: Blob container `colo-files`.

Set `BLOB_STORAGE_CONNECTION_STRING` and `BLOB_CONTAINER_FILES` for connection-string authentication. `BLOB_ACCOUNT_URL` is optional when a connection string is supplied; it supports managed identity when no connection string is set. The earlier `BLOB_CONNECTION_STRING` name remains supported as a fallback. Keep connection strings in Function App settings or secret references, never frontend settings.

The application never provisions resources. Obtain the owner's cost approval before cloud resource or throughput changes.

## API contract

All routes are prefixed `/api`. All except health and preflight require a verified staff JWT in production.

| Method / route | Purpose |
|---|---|
| `GET /health` | Process liveness only; not a Cosmos/Blob readiness check |
| `GET /me` | Current identity, roles and operating mode |
| `GET /people` | Active staff names/IDs for assignment; no identity subjects |
| `GET /records/{kind}?cursor=…` | Permission-filtered page of up to 100 records |
| `GET /records/{kind}/{id}` | One accessible record |
| `POST /records/{kind}` | Create with strict data schema |
| `PUT /records/{kind}/{id}` | Replace editable data, `If-Match: <version>` |
| `POST /records/{kind}/{id}/{action}` | Domain command with `If-Match` and unique `Idempotency-Key` |
| `POST /files/{kind}/{id}` | Raw file body, allowed Content-Type, `X-File-Name`, `If-Match` |
| `GET /files/{kind}/{id}/{fileId}` | Authorized private attachment download |
| `POST /assistant/review` | Manual deterministic proposal generation; no model calls |

Kinds and schemas: [src/model.ts](src/model.ts). Commands and approval rules: [src/service.ts](src/service.ts). HTTP adapter: [src/api.ts](src/api.ts). The frontend sends only editable fields, not the whole stored document.

Conflict responses use 409; validation 400; missing `If-Match` 428; unauthenticated 401; forbidden area 403; inaccessible records 404. On conflict, refresh and review the new values. On an uncertain command response, retry with the same idempotency key and payload. Generic create is not retry-idempotent; check the list before resubmitting after an uncertain response. Records are retained; there is no destructive delete route.
