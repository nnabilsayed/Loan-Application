# Tools and verification

## Tools used

### OpenAI Codex

OpenAI Codex was used as an AI coding assistant to:

- Read and summarize the assessment brief and domain rules.
- Inspect the repository structure, implementation, schema, and existing tests.
- Identify and prioritize the explicitly stated reliability and security risks.
- Propose implementation approaches before making changes.
- Apply focused code, schema, test, and documentation changes.
- Explain the resulting behavior and remaining tradeoffs.

The exact model configuration is controlled by the Codex environment. AI-generated suggestions were treated as proposals and were checked against the repository's domain contract and executable behavior before being retained.

### Repository and local development tools

- Git and the public GitHub assessment repository were used to obtain and inspect the source.
- PowerShell was used for local setup, database commands, HTTP requests, and runtime checks.
- Node.js `22.23.2` was used to match the repository engine requirement.
- pnpm `9.15.4` was used to match the repository package-manager requirement.
- Prisma was used to generate the client and apply the local SQLite schema.
- Vitest was used for focused API and worker tests.
- TypeScript compiler was used for typechecking.
- ESLint was used for linting.
- Next.js production build was used to verify the web application still builds.

## AI-assisted workflow

The work followed this sequence:

1. Read `README.md` and `docs/DOMAIN.md` before changing code.
2. Mapped the API, worker, web application, shared contracts, and database schema.
3. Confirmed which concerns were explicitly stated by the assessment.
4. Selected a coherent scope instead of attempting to fix every possible production issue.
5. Discussed each implementation approach before applying it.
6. Applied small, reviewable changes to the relevant files.
7. Added focused tests for each implemented behavior.
8. Ran automated checks and manual local HTTP checks.
9. Recorded deferred work in `ISSUES.md`, `DESIGN.md`, and `PLAN.md`.

## Verification performed

The following checks passed after the implementation changes:

```text
pnpm db:generate
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

The test suite contains 11 passing tests covering:

- Authorized customer reads
- Unauthorized customer reads
- Missing customer identity
- Successful partner events
- Duplicate partner delivery
- Older/out-of-order partner events
- Invalid status transitions
- Successful notification delivery
- Retryable notification failure
- Dead-lettering after the retry limit

Manual runtime checks also confirmed:

- `GET /health` returns HTTP 200.
- The customer application page returns HTTP 200.
- The API, web application, and worker start together with `npm run dev` when the required local runtime is active.

All data used by the repository and verification is synthetic, as required by the assessment.
