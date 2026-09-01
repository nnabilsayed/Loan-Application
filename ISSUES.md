# Prioritized issues and scope

## Context

This repository is a small loan application system inherited in an intentionally imperfect state. The main risks are concentrated around partner status events, customer access, and notification delivery.

The target working time is four hours, so this submission focuses on one coherent vertical slice: keeping customer-visible application data and partner-driven status processing trustworthy.

## Prioritized issues

| Priority | Issue | Impact | Decision |
| --- | --- | --- | --- |
| P0 | Customer data isolation | A customer could read another customer's application because the API checked only that an identity header existed, not that the identity owned the application. | Implemented. Customer reads are scoped by application ID and customer ID, with inaccessible applications returning 404. |
| P1 | Duplicate partner events | Partner retries could create duplicate history entries and duplicate notification jobs. | Implemented. Event records and notification jobs are unique per application and event ID, with transaction-safe duplicate handling. |
| P1 | Late or out-of-order events | An older event could overwrite a newer current status and make the customer-visible state incorrect. | Implemented. Events older than or equal to the stored event time are ignored and reported as stale. |
| P1 | Invalid status transitions | A syntactically valid status could still represent an impossible lifecycle change, such as `SUBMITTED` directly to `APPROVED`. | Implemented. The API enforces the documented lifecycle and reports invalid changes without writing state, history, or notifications. |
| P1 | Status, history, and notification consistency | Separate database writes could leave the current status, history, and notification request out of sync after a partial failure. | Implemented as part of event processing. The related writes run in one transaction. |
| P1 | Notification delivery failures | The worker previously marked failed jobs as processed, so temporary provider failures disappeared without retrying. | Implemented. Failed jobs retry with exponential backoff and are dead-lettered after three attempts. |
| P2 | Multiple workers processing the same job | Two workers could read the same pending job before either one marks it complete, causing duplicate provider calls. | Deferred. Requires a job-claiming or lease mechanism and is described in `DESIGN.md`. |
| P2 | Provider-side idempotency | A process may stop after the provider accepts a request but before local completion is recorded. | Partly supported: the stable event ID is already sent as the provider idempotency key. Full provider-side deduplication is deferred and described in `DESIGN.md`. |
| P2 | Operator replay of exhausted jobs | Dead-lettered work should be inspectable and safely replayable by an operator. | Partly implemented: exhausted jobs are persisted with an inspection timestamp and last error. A protected replay operation is deferred and described in `PLAN.md` and `DESIGN.md`. |
| P2 | Partner authentication | An unauthenticated caller could submit status events if the API were exposed directly. | Deferred by design. The exercise states that partner authentication is not implemented; the production trust boundary is described in `DESIGN.md`. |

## Selected scope

The implementation prioritizes:

1. Preventing customer data disclosure.
2. Preserving the integrity of partner-driven application state and history.
3. Enforcing valid application lifecycle transitions.
4. Ensuring one logical partner event produces at most one notification request.
5. Keeping temporary notification failures retryable and making exhausted work visible.

These issues were selected because they directly affect customer-visible correctness, auditability, and reliable communication, and because they form one connected flow from partner event ingestion to customer notification.

## Deliberately deferred work

The remaining issues are important for production but were not fully implemented within the timebox:

- Add an atomic job claim/lease so multiple worker processes cannot process the same job concurrently.
- Enforce idempotency at the real email provider boundary, using the stable event key.
- Add a protected operator workflow to inspect and replay dead-lettered jobs.
- Authenticate and authorize the partner integration at the adapter boundary.

These are documented as production evolution work rather than being addressed with incomplete or unprotected shortcuts in the assessment implementation.

## Verification

Focused tests cover:

- Authorized and unauthorized customer reads.
- Missing customer identity.
- Duplicate partner delivery producing one history entry and one notification job.
- Older events leaving the newer application state unchanged.
- Invalid status transitions leaving the application unchanged.
- Successful notification delivery.
- Retryable notification failure.
- Dead-lettering after the retry limit.

The repository checks pass after the changes:

- Typecheck
- Lint
- 11 automated tests
- Web production build
