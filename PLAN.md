# Implementation plan and known limitations

## Current implementation

The assessment implementation currently provides:

- Customer-scoped application reads.
- A consistent 404 response for missing or inaccessible applications.
- Duplicate partner-event protection using application/event uniqueness constraints.
- Transactional persistence of current status, history, and notification request.
- Out-of-order protection based on the partner event occurrence time.
- Status-transition validation based on the documented application lifecycle.
- Explicit event outcomes for accepted, duplicate, stale, and invalid deliveries.
- Notification retry scheduling with exponential backoff.
- A bounded retry limit and persisted dead-letter state.
- Focused API and worker tests covering these behaviors.

## Known limitations

The following limitations are intentional within the assessment timebox:

1. The customer identity is represented by the caller-controlled `x-customer-id` header rather than a real authenticated session.
2. Partner authentication is not implemented.
3. Worker jobs are not claimed with a lease, so multiple worker processes could still process the same job concurrently.
4. The mock provider accepts an idempotency key but does not simulate provider-side deduplication.
5. Dead-lettered jobs can be inspected in the database, but there is no protected operator replay operation yet.
6. SQLite is used for local development and does not represent the production database or concurrency model.
7. The implementation does not include production metrics, tracing, alerting, or a full audit-access workflow.

## Recommended next steps

### 1. Authenticate the trust boundaries

Replace the customer header with a verified session or token. Authenticate the partner adapter using signed requests, mutual TLS, or an equivalent mechanism. Add authorization tests for both customer and partner access.

### 2. Add worker job claiming

Add a processing state, lease owner, and lease expiry to notification jobs. Claim a job atomically before calling the provider, allow expired leases to be recovered, and ensure graceful shutdown releases or preserves active work safely.

### 3. Enforce provider idempotency

Use a stable application/event key for every provider request and verify that the production provider guarantees exactly-once effects for repeated keys. Add integration tests for a provider timeout after acceptance.

### 4. Build operator recovery controls

Add a protected operator endpoint or internal tool to list dead-lettered jobs, inspect errors and attempts, and replay selected jobs. Replays should reset retry state deliberately, preserve the original idempotency key where appropriate, and create an audit record.

### 5. Move to production persistence and migrations

Adopt a managed relational database and versioned migrations. Introduce schema changes backward-compatibly, verify data before adding constraints, and document rollback procedures.

### 6. Add operational visibility

Add structured correlation IDs, event and notification metrics, queue-age monitoring, provider failure alerts, authorization-failure alerts, and traces spanning the API, database transaction, worker, and provider.

## Suggested delivery sequence

```text
Authenticated boundaries
        ↓
Atomic worker claiming and leases
        ↓
Provider idempotency verification
        ↓
Operator replay and audit trail
        ↓
Managed database, migrations, and observability
```

This order addresses unauthorized access and duplicate side effects first, then improves recovery and operational confidence before adding broader infrastructure.
