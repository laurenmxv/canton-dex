# Canton DEX: complete TypeScript backend replacement

Replace all DEX-owned backend logic and supporting Java tooling with TypeScript on Node.js. Preserve the current product, public API and user journeys. Use fresh MVP state; no data migration, backfill, compatibility bridge or parallel application deployment is required. This document is a plan, not an implementation or a test-pass report.

## 1. Binding scope and protected boundaries

| Surface | Required outcome |
| --- | --- |
| DEX backend | Move **all** implemented behavior to TS: routes, validation, authentication, authorization, domain rules, SQL stores, Canton adapters, signatures, background jobs, recovery, bootstrap, administrative commands and tests. No Java helper, sidecar or fallback remains. |
| DEX public API | Preserve every method/path, request and response type, field name, enum, status, error code, content type, query/default, null/optional distinction, pagination rule and authorization behavior. Preserve health URLs too. **No API redesign.** |
| `contracts/` | Strictly immutable: no Daml source, tests, package pins, SDK config, vendored DAR or manifest changes. Build and test a copied source tree outside this directory when generated outputs are needed. |
| `frontend/` | No functional edits, dependency changes, lockfile changes, type changes, mock changes or test changes. The sole approved exception is removing obsolete comments that mention the old backend implementation; preserve the behavior those comments describe. |
| `client/` | Remains unchanged by default. Only an indispensable internal/build adaptation is allowed, with a written technical reason and proof that exports, public types, wire format and frontend consumption remain identical. Convenience, shared schemas or regenerated types are not reasons to change it. |
| User stories | Preserve all existing story requirements and all currently implemented behavior. Track every story to code and acceptance evidence; keep partial/future stories visible rather than deleting or weakening them. |
| Quickstart | The user-designated `../cn-quickstart` becomes a bare Node/TS-ready backend scaffold. Do not port its Java example or add DEX business logic to it. |
| Identity and ledger | Keep Keycloak, Canton, Splice and current contract packages. All Node application calls to Canton use JSON Ledger API v2 over HTTP. |
| Delivery | Update containers, Compose, Make, scripts, CI, documentation, generated artifacts and the consumed LocalNet bundle. The finished application and its supporting backend tools run without a JDK. |

“Remove Java” means eliminating the project-owned application stack, source, generated bindings, tests, Gradle/Maven wiring and obsolete documentation/comments. Canton, Keycloak, Splice and the isolated Daml SDK tools retain their upstream JVM internals. Necessary infrastructure settings such as Keycloak JDBC configuration and Canton console APIs are not residual application code. Do not rewrite those products, change contracts, or rewrite Git history to make a text search return zero matches.

The working tree, including current uncommitted settlement/client/frontend work, is the starting point. Do not reset it or use HEAD alone as the compatibility baseline. No implementation, publication or service reset is part of this planning task.

## 2. Baseline and compatibility contract

Before changing implementation:

1. Record the source revision and working-tree diff, plus content/path manifests of `contracts/`, `frontend/` and `client/`, including new files and existing deletions. Capture the same baseline for the Quickstart worktree. Preserve unrelated work.
2. Inventory the current **50 business routes**, available health endpoints and their public types from `client/src/types/`, `client/src/modules/`, HTTP handlers, model records and error handling. Before changing Compose or deleting the old runtime, capture executable golden HTTP request/response/error fixtures from the baseline into `backend/test/compatibility/`, including roles and validation edge cases. Normalize only unstable identities/time values with shape-aware rules; separately assert timestamp syntax/precision, decimal notation/trailing zeros and all stable fields. This frozen fixture set is the comparison oracle; no permanent old-backend profile is needed.
3. Run the existing backend unit/SQL/integration suites and existing client/frontend/Daml checks on isolated disposable state. Record existing failures and documentation gaps explicitly; do not silently remove assertions or call a skipped test a pass.
4. Create a traceability register: **user story → existing behavior/endpoint → old test/scenario → TS test → result/evidence**. Include backend-only jobs, CLI commands, bootstrap and infrastructure checks.
5. Freeze the public contract. New backend runtime schemas and optional generated OpenAPI must describe that contract, not redefine it. Compile-time compatibility tests may import the unchanged client types. Do not generate files into `client/` or `frontend/`.

Compatibility includes decimal strings, numeric fields that are currently numbers, stable cursors, timestamp precision and formatting, array ordering, missing versus null values, idempotency and access-denied/not-found privacy. Internal bigint use does not permit changing public numbers to strings. Handle Canton int64 fields losslessly and serialize the existing public representation deliberately, without silent rounding. Configure PostgreSQL NUMERIC/int8 and timestamp decoding explicitly; default JS number/Date conversions must not lose amount or submillisecond precision.

Fastify defaults must not change behavior inherited from the current HTTP stack: body/query coercion, unknown properties, defaults, error envelopes, status codes, CORS and authentication failures need fixture-based checks. Preserve `application/problem+json`, existing codes and descriptions. Capture auth-versus-validation ordering, unknown routes, unsupported methods/content types, malformed/oversized bodies, invalid path values, trailing slashes, HEAD/OPTIONS, CORS preflight and proxy/forwarded-header behavior from the baseline; reproduce observed responses rather than assuming framework defaults. Keep service DNS name, listen port, context path and frontend proxy targets stable. Keep `/actuator/health` and the currently available readiness/liveness routes, including `/actuator/health/readiness` used by Compose; preserve observed status/body/access semantics.

## 3. Architecture and packages

Use one modular Node application and the existing PostgreSQL database model. Keep dependencies explicit and acyclic; business modules expose ledger ports, and only the Canton adapter owns Canton wire/generated types. Keep npm and the existing client/frontend workflow.

| Responsibility | Choice |
| --- | --- |
| Runtime/build | Node 24, strict TypeScript, ESM, `tsc`; `tsx` for development; compiled JS in runtime images |
| HTTP | Fastify with compatible TypeBox/Ajv type provider; `@fastify/swagger` for a build artifact if useful, without adding public routes |
| SQL | Kysely + `pg`, explicit transactions, locks, CAS, constraints and `RETURNING` |
| Database initialization | One base `schema.sql`, preserving the current 26 tables and their semantics; fresh state, no migrations |
| Authentication | Existing Keycloak; `jose` for JWKS/signature/issuer/audience/time validation |
| Canton HTTP | `openapi-fetch` + `openapi-typescript`, with exact JSON decoding where required |
| JSON integer precision | `lossless-json` for relevant Canton payloads before any lossy `JSON.parse` conversion |
| Crypto | `node:crypto` for key parsing, hashes, Ed25519 and secp256k1 |
| Financial arithmetic | Small explicit bigint fixed-point module; exact floor/ceiling and integer square root |
| Concurrency | Non-overlapping async worker loops; `async-mutex` only for existing process-local critical sections |
| Logs/lifecycle | Fastify/Pino, redaction, readiness, bounded requests and graceful shutdown |
| Tests | Vitest, Fastify `inject`, `fast-check`, Testcontainers PostgreSQL, live HTTP/Canton integration |
| CLI | Simple TS entrypoints; `commander` only where argument parsing warrants it |
| Module boundaries | `dependency-cruiser` or equivalent import rules |

Pin compatible, published package versions in the new backend lockfile during implementation. Do not upgrade frontend/client dependencies or move package managers. Use packages for infrastructure concerns; keep DEX authorization, financial calculations and recovery state machines explicit. Define repeated strings and metadata keys once as named constants. No Redis, queue platform, generalized workflow engine or NestJS layer is needed for this replacement.

Suggested backend structure: `src/platform/`, `src/iam/`, `src/onboarding/`, `src/pools/`, `src/tokens/`, `src/swaps/`, `src/liquidity/`, `src/settlements/`, `src/activity/`, `src/canton/`, `src/bootstrap/`, `src/cli/`, and `test/`. Port behaviors, not Java class boilerplate. Existing Python/shell operational utilities may remain; they are not Java backend logic.

## 4. Canton and identity decisions

The transport choice is settled: the JSON option in the official [Ledger API quick reference](https://docs.canton.network/sdks-tools/api-reference/ledger-api#quick-reference), through HTTP. Follow VaultKit's small reusable HTTP-client pattern. No Node gRPC dependency, fallback, proxy service or transport-comparison phase.

This transport rule concerns application-to-ledger calls. Keycloak admin REST remains HTTP, and existing Canton console initialization remains inside LocalNet infrastructure; it is not a Node fallback or privileged application sidecar. Do not add future Scan/registry/treasury integrations to this rewrite.

The adapter covers existing command submission, external-party topology generation/allocation, interactive prepare/execute, active contracts and interface views, bounded updates/checkpoints, packages/vetting, users/rights and identity setup used by bootstrap. Preserve disclosed contract blobs, original prepared/topology Base64 bytes, signer/synchronizer checks, hashing-scheme V3 and microsecond deadlines. Inspect copies when necessary; relay original opaque bytes.

Generate backend-only types against the deployed participant's verified API and unchanged DARs. Earlier inspection found inconsistent version metadata in the tagged OpenAPI file and a generated dependency on unpublished `@daml/types@3.5.7`. Resolve these inside backend generation/build wiring using verified published-compatible tooling or narrowly typed adapter schemas. Do not change contract SDK/package pins or introduce a runtime package that does not exist.

Keep request-scoped caller tokens separate from cached service credentials. Never persist caller access tokens. Database roles remain authoritative; first-login defaults and role separation stay unchanged. Preserve the current **60-second JWT clock tolerance**, including expiry/not-before behavior and the account-reset utility's drain window. DVO, operator, issuer and trader permissions remain separate; retaining Keycloak does not change wallet key custody.

## 5. Complete behavior inventory

| Module | Business routes | Required behavior |
| --- | ---: | --- |
| IAM/onboarding/public pool list | 9 | Profiles, DB roles, KYC metadata and simulated documents, approval/rejection, external-party registration, wallet signatures, attestations, pool access, conflict and uncertainty handling |
| Pools | 7 | Instruments/options, proposal validation, creation/withdrawal/status, catalog/detail, DVO accept/reject CLI, ledger reconciliation |
| Tokens | 4 | Balances, registry, faucet prepare/submit/status, one-time grants and uncertain-result recovery |
| Swaps/activity | 7 | Exact quotes, prepared/signed requests, status, expired cancellation/recovery, ownership and paginated activity |
| Liquidity | 13 | Empty-pool initialization, proportional deposits, LP receipt allocations, withdrawals, signed minima, position values, status and partial recovery |
| Settlement | 10 | Independent family policies, preview, batch/single dispatch, retry, defer/return, stable history, monitoring, automatic processing and reconciliation |

Additional obligations:

- Port all 97 handwritten main source files by behavior and all 57 test/helper files by test intent. Counts are inventory checks, not a required TS file count.
- Preserve the durable operator-command journal: commit command identity and dispatch state before network submission; keep original deduplication offsets and payload on retry; distinguish definite rejection from unknown results.
- Preserve SQL row locks, CAS and partial unique constraints, including one active settlement per pool. Keep transactions short. Initially run one application replica; async calls still require explicit exclusion where synchronized sections protected workflows.
- Preserve onboarding attempt isolation across awaited ledger calls. Stale results must not overwrite a newer attempt. Use the existing preparation identity or an internal attempt/version guard if required; no public DTO change.
- Preserve all six periodic reconciliation/automatic-processing loops and token reconciliation on demand. Loops must not overlap themselves, stop cleanly and continue reconciliation when automatic settlement is disabled.
- Preserve independent swap/deposit/withdrawal policy versions, batch sizes and automatic modes; per-family FIFO, family rotation, full automatic swap batches, valid liquidity prefixes, singleton initialization, exact preview selection, eligible single-request execution, linked retries and return-to-tail behavior.
- Preserve fixed-point units, amount bounds, LP minimum, integer square root, rounding directions and informational fee precision. Test against existing contract outcomes. Any newly discovered discrepancy is recorded separately; do not silently bundle a product/math redesign into the replacement.
- Require complete ledger reads for active contracts, holdings, allocations, pools, bootstrap and recovery, not just history. Use explicit party/template/interface filters and verified result limits on the pinned participant. An incomplete or ambiguous response must never become a lower balance, missing contract, duplicate fixture or terminal failure. Retrieve all required results through supported HTTP filtering/ranges and completion evidence; do not invent ACS pagination. Add a deliberately small-limit integration case proving complete correct results or an explicit retriable read failure without state mutation. Preserve partial-allocation recovery and ledger-backed confirmation.
- Preserve bootstrap uploads/vetting, package-generation guard, Keycloak configuration, users/rights/identity providers, independent identities, token catalogs/factories/disclosures, pools, access, delegation and fixtures. Re-running bootstrap must neither duplicate state nor refill funded pools.
- Port the DVO decision command with the existing interface: `./scripts/decide-pool.sh accept PROPOSAL_UUID INITIAL_RATIO` and `reject PROPOSAL_UUID`. Keep DVO credentials/authority outside the operator HTTP API.

## 6. Quickstart and the actual LocalNet dependency

There are two checkouts, with different roles:

- **Requested scaffold target: `../cn-quickstart`.** It already has extensive user modifications and deletions. Preserve that working state and replace its remaining small Spring scaffold with the Node/TS skeleton.
- **Existing bundle provenance: `../cn-quickstart-fork`.** Its clean commit `cee8ccdd3d70f9bd3b37fdc55953fc801ff5f033` produced the current DEX bundle. It provides the existing packaging implementation; it is not a second backend to rewrite by assumption.

DEX does not mount either sibling live. Its current chain is `docker/artifacts/cn-localnet-v0.1.0.tar.gz` → `make prepare-localnet` → `.deps/cn-localnet` → `compose.yaml` include. Updating only a sibling or only `.deps` cannot deliver the change.

### Bare Node/TS scaffold

In the requested Quickstart checkout:

1. Remove remaining application Java sources, generated outputs, Spring configs, Gradle wrappers/build files/plugins/caches and Java-oriented app Docker/build/check instructions. Do not restore previously deleted upstream examples.
2. Provide `quickstart/backend/package.json`, lockfile, strict TS config, minimal server entrypoint, Node Dockerfile and `dev`, `build`, `start`, `typecheck`, `test` scripts. “Bare” allows startup, shutdown and health plumbing needed to run the container; **no business routes, demo authentication implementation, stores, ledger workflow or DEX code**. Keep `/actuator/health` returning `status: "UP"` only when a real PostgreSQL check succeeds: the existing Quickstart frontend calls it through `/api/actuator/health` and displays database readiness.
3. Replace Java/Gradle assumptions in `quickstart/Makefile`, Compose backend service, health script, resource options, environment examples, scaffold validators/tests and documentation. Preserve runnable Compose configurations, Keycloak and LocalNet services. Remove JVM flags and JAR mounts from application services.
4. Keep Quickstart frontend and contract content functionally unchanged; apply only the same approved obsolete-comment cleanup to its frontend if needed. Where a scaffold check currently asserts a Spring-specific behavior, make it check the new empty scaffold's startup/readiness. The frozen DEX API belongs to DEX, not to the discarded Quickstart demo.
5. Verify clean `npm ci`, build/typecheck and container readiness without host Java or Gradle for the scaffold. Its app image contains Node only.

### Infrastructure producer and consumer

1. The current bundle already contains no application Java or Gradle, so emptying the scaffold alone does not require repackaging. The chosen bundle update is needed to enable the application participant HTTP Ledger API in the shared `infra/participant.conf` and expose it to the internal Compose network. Preserve existing authorization, onboarding limit, package isolation, traffic setup and readiness. Canton may keep its native gRPC/admin services internally; Node does not use them.
2. Reuse the existing reproducible `scripts/package-localnet.py` producer, preserving its manifest, checksums, file permissions and extracted-Compose equivalence checks. It reads committed files, not the working tree. Assemble an isolated release snapshot from the verified current bundle source plus the intended infrastructure/packaging changes from the requested checkout; record that exact commit as provenance. Do not commit all of the dirty Quickstart checkout, restore its deletions, or accidentally bundle unrelated user work. Keep scaffold changes and the infrastructure release diff separately reviewable; no application edits to the clean `cn-quickstart-fork` checkout are implied.
3. Build a new versioned LocalNet bundle from that exact source, record provenance/checksum and verify every bind mount resolves within the extraction. Diff extracted old/new bundles and resolved Compose models; allow only the intended HTTP configuration/exposure, packaging documentation and generated provenance/checksum changes. Keep it infrastructure-only; the Quickstart and DEX applications are not bundled into LocalNet.
4. Replace the DEX vendored archive, update `docker/artifacts/README.md` and the Makefile pin/preparation logic. Ensure the preparation marker cannot keep serving an old extraction after an archive update. Verify the archive checksum during preparation.
5. Test from a fresh extraction using only the DEX checkout, with no sibling mounts or dependence on local untracked files. Verify both the resolved Compose model and actual HTTP-ledger connectivity. Building a bundle alone is not runtime validation.

No release/tag/push is performed by this planning task. Public publication is separate from locally producing and consuming a verified artifact.

## 7. DEX tooling and total application cleanup

| Area | Required change |
| --- | --- |
| Backend source/tests | Replace `backend/src/main/java/**` and `backend/src/test/java/**`; remove all generated Java bindings/classes/JARs and obsolete Java reports |
| Build/resources | Remove `backend/build.gradle.kts`, `settings.gradle.kts`, `gradle.properties`, wrappers and `backend/gradle/`; replace Spring configuration; move the base SQL without losing constraints |
| Compose | Replace `x-java`, Gradle commands/cache declarations, JDBC application URLs and Java image/workdirs for `backend`, `contract-bootstrap`, `backend-tests` with Node equivalents |
| Contract tools | Separate the DPM/SDK builder from app runtime/bootstrap/tests; run contract build/tests on a copied immutable source tree. The external Daml tool image may contain its required JDK. Node bootstrap consumes the resulting DAR artifacts and never launches DPM or a JVM itself |
| Entrypoints | Preserve `make docker-run`, `make status`, `make test`, `make test-backend`, stop/reset behavior and the DVO decision script while changing their implementation |
| Configuration | Replace application `SPRING_DATASOURCE_*`/Gradle environment wiring with Node configuration; retain needed issuer/audience, URLs, service identity and fixture separation |
| CI | Update `.github/workflows/backend.yaml`, Daml builder wiring and integration runner; keep the existing separate client/frontend workflows and manual integration trigger unless independently changed |
| Operations | Preserve reset/account-reset behavior, readiness dependencies, token drain semantics, test recovery files, volume/cache safety and bounded shutdown |
| Docs/comments | Update `AGENTS.md`, README, backend spec, tooling docs and obsolete comments. Preserve functional user-story/flow requirements. Remove the specifically authorized obsolete frontend comments without touching executable code |
| Local leftovers | Remove only obsolete project-owned Java build outputs/caches. Do not delete global caches, shared images, unrelated sibling work or database volumes for cosmetic cleanup |

The Node `contract-bootstrap` service is the sole schema initializer and applies the base schema transactionally before the API starts. Backend/test processes validate the schema rather than racing to create it; tests use their own isolated databases where needed. Reject incompatible nonempty application state with a clear instruction to use the existing `make docker-reset` workflow. Never perform an implicit destructive reset or add migration/backfill logic. Test initialization, repeated bootstrap, incompatible state and concurrent service startup.

The final scan covers files, dependencies, scripts, image stages, CI, docs and packaged artifacts. Every remaining JVM-related match must belong to necessary third-party ledger/identity/Daml infrastructure, not a hidden app dependency. Cleanup does not mean deleting system Java or rewriting commit history.

## 8. User-story and integration acceptance matrix

All current stories remain in `docs/user-stories.md`. New parity tests live under `backend/test/` or external test tooling, not in protected contract/frontend directories.

| Story/workflow | Existing test intent to port | Required acceptance and added coverage |
| --- | --- | --- |
| Request onboarding / onboard users | `IamIT`, `OnboardingIT`, `SnapOnboardingIT`, `OnboardingUncertaintyIT` | Keycloak login, DB roles, approval/rejection, both wallet key formats, ownership, existing-party conflict, retries and stale-attempt races |
| Request / track pool creation | `PoolCreationIT`, `PoolStoreIT`, workflow/approval tests | DVO accept/reject, operator withdrawal, concurrent pair reservation, status reconciliation, CLI idempotency and authority separation |
| Discover pools | Onboarding/pool IT and client fixtures | Same trader visibility/access and operator detail through unchanged HTTP routes |
| Request swap / recover stuck swap | `SwapIT`, store/workflow/adapter tests | Quotes, signed minima/deadlines, duplicate submissions, settlement, ownership and expired allocation recovery |
| Run settlements | Swap/liquidity IT, settlement store/workflow tests | All three families, FIFO/fairness, one active run, independent policies, real multi-request deposit/withdrawal batches and singleton initialization |
| Preview / defer / return / retry / selected request | Settlement SQL/unit tests | Add full HTTP→Canton tests for exact preview selection, stale rejection, singleton selection, deferral preserving funds, return ordering, retry linkage and resulting history |
| Initial/proportional liquidity | `LiquidityIT`, math/workflow tests | Add actual empty-pool initialization through public endpoints; DVO ratio, permanent LP minimum, proportional deposits, signed minimum output |
| Position / withdrawal | `LiquidityIT` | LP available balance, share/redemption values, signed limits, burn/payout and supported final withdrawal behavior |
| Recover expired liquidity allocations | Liquidity integration/workflow tests | Preserve partial deposit recovery; add expired/partial LP-withdrawal recovery and restart recovery with ledger evidence |
| Activity/history | Liquidity IT, stable history SQL tests | HTTP pagination/cursors/filters, ownership, stable ordering, expected and settled amounts across all operation types |
| Venue monitoring | Swap/liquidity IT | Preserve current queue/batch monitoring and its authorization |
| Bootstrap and faucet | Schema/environment/store/fixture tests | Current identities/rights/fixtures, one-time faucet, package guard, uncertainty and second-run no-refill behavior |
| Restart and unknown results | `RestartIT`, `RestartSwaps`, `StoredSubmissionIT` | Real backend stop/start, unknown command recovery, expired deduplication window and no duplicate financial effects |

Two documented areas are only partially implemented today: treasury/traffic/CC-reward management beyond current monitoring, and general DVO grant/revoke management beyond existing bootstrap/approval grants. Preserve their requirements and existing portions, record their baseline status, and do not claim this replacement completes those future features. Do not downgrade stories to hide a regression.

### Preserve the integration runner

Keep `./scripts/test-backend.sh schema|environment|iam|onboarding|pools|swaps|liquidity|restart|all` and `make test-backend`. Replace the Java harness with TS and retain every assertion's intent, including store tests not gated by the scenario selector.

The restart harness must keep `prepare`, `mark-uncertain`, `verify`, `restore`, the actual container stop/start, a recovery file with mode `0600`, cleanup/policy restoration on failure, and verification after the current 30-second deduplication window. Do not replace this with a mocked process restart. Fail on unknown selectors, zero executed tests or an all-skipped suite.

Suggested additional integration suites are `api-contract`, `settlement-controls`, `liquidity-initial`, `liquidity-batches`, `liquidity-recovery` and `activity-pagination`. Register them in `all`; ensure existing scenario entrypoints still cover their corresponding behaviors. A generated secp256k1 key test does not replace a real MetaMask Flask acceptance run.

## 9. Implementation sequence and exits

| Stage | Work | Exit condition |
| --- | --- | --- |
| 0. Freeze evidence | Baseline manifests, routes/types/errors, stories/tests, current suite results | Complete compatibility/traceability inventory, protected-tree checks and known pre-existing gaps recorded |
| 1. Node-ready environment | Bare Quickstart scaffold, HTTP participant config, reproducible bundle, DEX Node build/runtime/test images | Scaffold ready, clean artifact-only DEX Compose resolution, actual participant HTTP reachable, no application JVM |
| 2. Foundation and first user journey | SQL/schema, auth, API codecs/errors, test harness, HTTP Canton adapter, bootstrap essentials and onboarding | Existing client drives complete onboarding through Node; schema/environment/IAM/onboarding parity suites pass |
| 3. Pools, tokens and complete bootstrap | Pool workflows, DVO CLI, token registry/faucet, fixtures and all bootstrap side effects | Pool/DVO/faucet acceptance passes; bootstrap twice creates no duplicate state or reserve refill |
| 4. Swaps and liquidity | Exact math, signatures, requests/status/recovery, positions and activity | Current and added swap/liquidity/initialization tests pass against unchanged contracts |
| 5. Settlement and durability | All queues/policies/previews/actions/history, concurrency and background loops | Unit/SQL plus full HTTP/ledger controls, family batches, lost-response and restart scenarios pass |
| 6. Final removal and delivery | Delete remaining Java/Gradle, finish tooling/docs/comment cleanup, execute complete acceptance | All completion gates below pass against the final Node-only application tree |

Build and port the harness early enough to test every stage. Keep old source only as a development reference until the corresponding behavior is proven; remove it before delivery. There is no permanent dual-backend architecture or data conversion step. Parallel owners may cover platform/auth, Canton/bootstrap, onboarding/pools/tokens, swaps/liquidity and settlement/recovery after the existing API and internal ports are frozen; one integrator controls shared codecs/schema and test fixtures.

## 10. Completion gates

The replacement is complete only when all gates have evidence:

1. **Scope:** all backend modules, jobs, bootstrap, administrative commands and tests run in TS; no application Java sources, Gradle wrappers, Java generators, JVM app images or Java fallback remains in DEX or the requested Quickstart scaffold.
2. **Protected content:** `contracts/` matches its starting manifest exactly; frontend differs only by approved comment removals, confirmed by a comment-only/token-equivalence check and diff review. Client matches its baseline, or has a documented indispensable adaptation with unchanged public declarations and behavior. Preserve all pre-existing user changes.
3. **API:** all 50 existing business routes plus existing health surfaces pass method/path/type/serialization/auth/error compatibility checks. No changed client exports or DTO types; no new required fields or API endpoints.
4. **Stories:** every implemented story and backend-only workflow has passing linked acceptance evidence. Partial/future requirements remain accurately documented; no failing or omitted scenario is relabeled as out of scope to obtain a pass.
5. **Node checks:** backend clean install, lint/format checks, typecheck, build, unit/property tests and real PostgreSQL locking/CAS tests pass. Map every old test intent to its new coverage; test counts alone are insufficient.
6. **Full integration:** fresh isolated `make docker-run` → `make status` → `make test-backend` succeeds, including all scenarios and a real stop/start recovery cycle. Run the added settlement/LP/recovery/API tests against Canton. Zero empty or silently skipped required scenarios.
7. **Unchanged consumers/contracts:** existing client tests/typecheck/build, frontend tests/typecheck/build and existing Daml tests pass without weakening tests or modifying protected code. Run contract tooling from the copied source tree.
8. **Real user journey:** the unchanged frontend and client work with Keycloak and MetaMask Flask through onboarding, pool access, faucet, swap, LP deposit/withdrawal/recovery and operator settlement. Verify DVO CLI separately. Record evidence; mocks are not this gate.
9. **Packaging/operations:** clean checkout plus vendored artifact works without siblings; archive provenance/checksum and extraction are correct; second bootstrap is safe; health/shutdown/reset utilities work; app images and runtime do not require Java. Contract tooling remains isolated.
10. **Final review:** scan tracked/untracked deliverables, generated outputs, docs, CI and resolved Compose for obsolete application dependencies; review the complete diff, story matrix and results. Report any unresolved gate as incomplete rather than claiming the replacement is finished.

Planned Node commands are `npm ci --prefix backend`, `npm run typecheck --prefix backend`, `npm run build --prefix backend` and `npm test --prefix backend`, alongside the preserved Make/script entrypoints. Build the unchanged client before dependent type compatibility checks. Preserve the current integration CI activation policy; passing local/static checks does not imply live integration or browser acceptance.

## 11. Review evidence

This plan incorporates static source audits and two read-only `claude-train` discussion rounds plus a final scope/acceptance review. The last review added executable baseline fixtures, framework-level compatibility, complete ledger-read checks, schema-initialization ownership and a bounded LocalNet artifact diff. The follow-up review checked current uncommitted changes, all route groups, user stories, integration selectors, restart recovery, JVM/tooling footprints and the Quickstart artifact lineage. No application replacement, full suite run or environment reset occurred during planning.

Earlier isolated generation established that current DARs can produce TS bindings; source inspection supports the HTTP adapter direction. These findings do not substitute for the implementation gates above. The retained local Claude discussion is historical: the binding scope and decisions in this plan supersede alternatives mentioned there.

## Appendix: frozen business route inventory

Extracted from the current working-tree route declarations. Preserve the client request/response types, validation and errors associated with each route; the table is not permission to change payloads. Health surfaces are additional to these 50 routes.

| Module | Method | Existing path |
| --- | --- | --- |
| Api | GET | `/v1/me` |
| Api | GET | `/v1/pools` |
| Api | GET | `/v1/onboardings/mine` |
| Api | POST | `/v1/onboardings` |
| Api | GET | `/v1/onboardings/{onboardingId}` |
| Api | GET | `/v1/admin/onboardings` |
| Api | POST | `/v1/admin/onboardings/{onboardingId}/review` |
| Api | POST | `/v1/onboardings/{onboardingId}/party/prepare` |
| Api | POST | `/v1/onboardings/{onboardingId}/party/submit` |
| Pool | GET | `/v1/admin/pool-proposals/options` |
| Pool | GET | `/v1/admin/pool-proposals` |
| Pool | POST | `/v1/admin/pool-proposals` |
| Pool | GET | `/v1/admin/pool-proposals/{proposalId}` |
| Pool | POST | `/v1/admin/pool-proposals/{proposalId}/withdraw` |
| Pool | GET | `/v1/admin/pools` |
| Pool | GET | `/v1/pools/{poolId}` |
| Token | GET | `/v1/balances` |
| Token | GET | `/v1/dev/faucet` |
| Token | POST | `/v1/dev/faucet/prepare` |
| Token | POST | `/v1/dev/faucet/submit` |
| Swap | POST | `/v1/swaps/quote` |
| Swap | POST | `/v1/swaps/prepare` |
| Swap | POST | `/v1/swaps/submit` |
| Swap | GET | `/v1/swaps/{swapId}` |
| Swap | POST | `/v1/swaps/{swapId}/cancel/prepare` |
| Swap | POST | `/v1/swaps/{swapId}/cancel/submit` |
| Swap | GET | `/v1/activity` |
| Liquidity | POST | `/v1/lp/deposit/quote` |
| Liquidity | POST | `/v1/lp/deposit/prepare` |
| Liquidity | POST | `/v1/lp/deposit/submit` |
| Liquidity | GET | `/v1/lp/deposit/{depositId}` |
| Liquidity | POST | `/v1/lp/deposit/{depositId}/cancel/prepare` |
| Liquidity | POST | `/v1/lp/deposit/{depositId}/cancel/submit` |
| Liquidity | POST | `/v1/lp/withdraw/quote` |
| Liquidity | POST | `/v1/lp/withdraw/prepare` |
| Liquidity | POST | `/v1/lp/withdraw/submit` |
| Liquidity | GET | `/v1/lp/withdraw/{withdrawalId}` |
| Liquidity | POST | `/v1/lp/withdraw/{withdrawalId}/cancel/prepare` |
| Liquidity | POST | `/v1/lp/withdraw/{withdrawalId}/cancel/submit` |
| Liquidity | GET | `/v1/lp/positions` |
| Settlement | GET | `/v1/admin/settlement-requests` |
| Settlement | GET | `/v1/admin/settlements` |
| Settlement | GET | `/v1/admin/settlements/{settlementId}` |
| Settlement | POST | `/v1/admin/pools/{poolId}/settlements` |
| Settlement | GET | `/v1/admin/pools/{poolId}/settlement-preview` |
| Settlement | PUT | `/v1/admin/pools/{poolId}/settlement-requests/{type}/{requestId}/deferred` |
| Settlement | GET | `/v1/admin/pools/{poolId}/settlement-history` |
| Settlement | GET | `/v1/admin/pools/{poolId}/settlement-policy/{type}` |
| Settlement | PUT | `/v1/admin/pools/{poolId}/settlement-policy/{type}` |
| Settlement | GET | `/v1/admin/monitoring` |
