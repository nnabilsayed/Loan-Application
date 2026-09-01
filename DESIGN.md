# Production design

## Goals

The production system should keep customer-visible loan state trustworthy, process partner events safely despite retries and network reordering, and deliver status notifications reliably without exposing customer data.

The current exercise uses SQLite, a caller-controlled `x-customer-id` header, and a mock email provider. Those are local-test substitutions, not production trust or infrastructure boundaries.

## Proposed system boundaries

```text
Partner system
    │ authenticated event request
    ▼
Integration adapter / API
    │ validate, authorize, deduplicate, order
    ▼
Relational database + transactional outbox
    │
    ├── customer application read API
    │       └── authenticated customer session
    │
    └── notification queue
            ▼
        Notification workers
            │ provider idempotency key
            ▼
        Email provider
```

The partner integration and customer-facing API should be separate logical trust boundaries, even if they are initially deployed together. Partner credentials must never be supplied by a customer browser.

## Partner event processing

The partner sends an event containing an application ID, stable event ID, status, partner occurrence time, and optional reason.

The adapter should:

1. Authenticate the partner request.
2. Validate the payload and timestamp.
3. Resolve the application within the partner's permitted scope.
4. Check the event inbox or unique event key for a previous delivery.
5. Compare the event occurrence time with the latest accepted event.
6. Validate that the requested status is an allowed transition from the current status.
7. Atomically persist the accepted state change, immutable history, and notification outbox record.
8. Return an outcome that distinguishes accepted, duplicate, stale, invalid, and unknown events.

The application lifecycle should be represented explicitly as a state machine:

| Current status | Allowed next statuses |
| --- | --- |
| `SUBMITTED` | `IN_REVIEW` |
| `IN_REVIEW` | `OFFERED`, `DECLINED` |
| `OFFERED` | `APPROVED`, `DECLINED` |
| `APPROVED` | `DISBURSED` |
| `DECLINED` | none |
| `DISBURSED` | none |

An invalid transition should not update current state, append history, or enqueue a notification. The adapter should return a distinguishable client error while preserving the current application state.

The event key should be unique within the partner/application scope. A duplicate delivery should be acknowledged safely without creating another history record or notification request. If two deliveries race, the database uniqueness constraint is the final protection after the application-level lookup.

Ordering should use the partner's occurrence timestamp, not HTTP arrival time. Events older than the latest accepted event should not change current state or create customer notifications. If the partner can provide a monotonic sequence number, it should be stored and preferred as the ordering value; timestamps alone can be ambiguous when clocks are inaccurate or events share a timestamp.

## Atomic state and notification changes

The application update, status history append, and notification request must be one database transaction. A transactional outbox is the preferred production pattern:

```text
database transaction:
  update current application state
  append immutable status history
  insert notification outbox record
```

The notification worker reads committed outbox records asynchronously. This prevents a state change from being visible without its corresponding notification request and avoids sending an email before the state change commits.

The history should be append-only to application code and protected by database permissions. Corrections should be represented as new audit events rather than editing old evidence.

## Notification delivery

Workers should claim jobs before processing them. A production job record should include a state such as `PENDING`, `PROCESSING`, `SUCCEEDED`, and `DEAD_LETTERED`, together with:

- attempt count;
- next attempt time;
- last error;
- lease owner and lease expiry;
- provider idempotency key;
- timestamps for processing and completion.

Claiming should be atomic. A worker obtains a short lease, processes the job, and renews or completes it. An expired lease makes the job available to another worker. This prevents two healthy workers from processing the same job while still recovering jobs from crashed workers.

Failures should use bounded exponential backoff with jitter. After the retry limit, the job should be dead-lettered and excluded from normal polling. Operators should be able to inspect the payload, error, attempts, and timestamps, then explicitly replay a job with authorization and an audit record.

The stable event/application key should be passed to the email provider as its idempotency key. The provider must guarantee that repeated requests with the same key do not send multiple emails. This protects the interval after the provider accepts a message but before the worker records success locally.

## Customer authorization and sensitive data

In production, `x-customer-id` must be replaced by a trusted identity from an authenticated session or token. The API must derive the customer identity from verified credentials rather than accepting an arbitrary caller-controlled value.

Every customer application query must be scoped by both application ID and authenticated customer ID. Missing, unknown, and unauthorized application IDs should produce the same externally visible response to prevent resource enumeration.

Customer email, phone number, and application details are sensitive. The system should:

- minimize which fields are returned to each caller;
- encrypt data in transit and at rest;
- redact contact details and payloads from logs;
- restrict database and operator access by role;
- audit access to customer records;
- define retention and deletion policies.

Partner credentials should use a managed secret store, key rotation, request signing or mutual TLS where appropriate, replay protection, and network restrictions. Partner authentication failures should be observable without exposing secrets.

## Auditability

The status history should record the accepted status, partner event ID, partner occurrence time, recording time, source, and reason. It should not be edited in place.

The system should retain rejected-event metadata separately when operational investigation requires it, while avoiding unnecessary customer-sensitive payload storage. Every operator replay, manual correction, and dead-letter action should record who performed it, when, why, and what changed.

## Observability

The API and workers should emit structured logs with correlation IDs. Logs should include application ID and event ID where safe, but not raw customer contact details or secrets.

Useful metrics and alerts include:

- accepted, duplicate, stale, invalid, and rejected event counts;
- event-processing latency;
- transaction and database errors;
- pending, processing, succeeded, and dead-lettered notification counts;
- retry rate and provider failure rate;
- job age and lease expiry rate;
- customer authorization failures;
- API error rate and latency.

Distributed traces should connect the partner request, database transaction, outbox record, worker attempt, and provider request using the correlation ID and stable event key.

## Deployment and database changes

Production should use a managed relational database with migrations applied as a controlled release step. Schema changes should be backward-compatible when possible:

1. Add nullable columns or new tables.
2. Deploy code that can read both old and new shapes.
3. Backfill data in controlled batches.
4. Add constraints after the data is verified.
5. Remove old fields only in a later release.

The assessment's SQLite `db push` workflow is suitable for local synthetic data but should not be the production migration process.

Deployments should use health checks, graceful worker shutdown, and separate scaling for the API and workers. Rollbacks must account for both application code and schema compatibility. A failed deployment should be reversible without losing committed application history or notification records.

## Tradeoffs and postponed work

The assessment implementation keeps the system small and local. The following production work is intentionally not fully implemented here:

- a durable queue or managed outbox publisher;
- database-backed worker leases and atomic job claiming;
- real provider-side idempotency guarantees;
- a protected operator replay API and operator interface;
- partner authentication and key rotation;
- managed relational database deployment and migration tooling;
- full tracing, metrics, alerting, retention, and compliance controls.

These should be introduced according to operational scale and risk. The first production investment should be authenticated boundaries and durable, observable event/notification processing; additional infrastructure should follow demonstrated throughput and reliability needs.
