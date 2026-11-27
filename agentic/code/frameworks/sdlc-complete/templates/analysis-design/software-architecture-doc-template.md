# Software Architecture Document Template

---
template_id: software-architecture-doc
version: 3.0.0
reasoning_required: true
---

## Purpose

Describe the architectural baseline, including views, decisions, and rationale that guide implementation and evolution. This template incorporates patterns from the carbonyl-fleet pass 2 and adds full traceability matrices, trait/interface inventories, concrete data model guidance, and cross-cutting concern subsections to support security review, testability assessment, and requirements coverage verification.

## Reasoning

> Complete this section BEFORE writing the detailed document. Per @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/reasoning-sections.md

1. **Problem Analysis**: What is the core architectural challenge?
   > [Describe the system context, scale, complexity factors driving architecture decisions. What does success look like architecturally?]

2. **Constraint Identification**: What are the key constraints?
   > [Technical: performance, compatibility, platform targets; Business: timeline, budget, compliance requirements; Organizational: team skills, existing infrastructure]

3. **Alternative Consideration**: What architectural approaches were evaluated?
   > [List major patterns considered: microservices vs monolith, event-driven vs request-response, sync vs async data access. Note which were ruled out and why.]

4. **Decision Rationale**: Why this architecture?
   > [Explain why chosen approach best balances constraints and requirements. Reference specific NFRs or UC drivers where applicable.]

5. **Risk Assessment**: What architectural risks exist?
   > [Identify scalability, security, maintainability risks and planned mitigations. Flag any decisions that carry deferred risk.]

## Ownership & Collaboration

- Document Owner: Software Architect
- Contributor Roles: System Analyst, Designer, Test Architect, Security Architect
- Automation Inputs: Approved requirements set (use cases, user stories, NFRs), non-functional drivers, platform constraints, threat model
- Automation Outputs: `software-architecture.md` including all views, traceability matrices, and open questions log

## Completion Checklist

- Executive summary written and reviewed by a non-architect stakeholder
- Architectural goals and constraints explicitly stated and linked to source requirements
- C4 Level 1 (Context) diagram present and reviewed
- C4 Level 2 (Container) diagram present with all external integrations shown
- C4 Level 3 (Component) diagram present for all primary containers; trait/interface inventory complete
- Data model section includes struct/class definitions, schema definitions, and storage key patterns
- At least 3 key sequence diagrams covering the highest-risk or most complex flows
- API surface table complete for all interfaces (REST, gRPC, SDK, MCP, CLI as applicable)
- Deployment view covers all target environments (dev, staging, production)
- All 6 cross-cutting concern subsections addressed or explicitly marked N/A with rationale
- Technology choices table includes version, purpose, and license for every dependency
- UC → Architecture traceability matrix complete with no uncovered use cases
- US → Architecture traceability matrix complete with no uncovered user stories
- NFR → Architecture traceability matrix complete with no uncovered NFRs
- Appendix B (Open Architectural Questions) lists all unresolved decisions with owner and target phase
- Appendix C (Review Incorporation Log) updated after each review cycle

## Document Sections

### 1. Executive Summary

Provide a 3–5 paragraph narrative that a non-architect stakeholder can read to understand what is being built, why the architecture was chosen, and what the critical risks are.

- State the system's purpose and the business problem it solves.
- Name the primary architectural style (e.g., event-driven microservices, layered monolith, hexagonal) and the top reason it was chosen.
- Call out the 2–3 most consequential architectural decisions made in this document.
- Summarize the top architectural risks and their mitigation status.
- Do not assume familiarity with the technical domain; any informed reader should be able to orient from this section alone.

### 2. Architectural Goals and Constraints

Enumerate the drivers that shaped architectural decisions. Reviewers use this section to evaluate whether design choices are justified.

- **Functional goals**: What system behaviors are non-negotiable? Reference specific use cases by ID.
- **Quality attribute goals**: Which NFRs impose architectural constraints (latency, throughput, availability, security posture, compliance)? State measurable targets (e.g., "p99 latency < 200 ms under 1,000 RPS").
- **Technical constraints**: Platform requirements, language/runtime mandates, required integration points, existing infrastructure the system must coexist with.
- **Business constraints**: Budget, delivery milestones, regulatory requirements, licensing restrictions.
- **Organizational constraints**: Team size, skill profile, operational model (who runs this in production?).
- Format as a table or bulleted list grouped by constraint type. Each constraint should include: constraint statement, source (requirement ID, stakeholder, or regulation), and impact on design.

### 3. System Context (C4 Level 1)

Show what the system is and who and what it interacts with. This is the highest-level view.

- Include a PlantUML C4 Context diagram using the C4-PlantUML library. Commit the `.puml` source file alongside any rendered image.
- Show: the system under design (as a single box), all external users/roles, all external systems, and the nature of each interaction (data flows, API calls, events).
- Annotate each external actor with their role and the communication protocol or channel used.
- Do not show internals at this level — only the boundary.
- Answer the question: "Who uses this system, and what does it depend on?"
- See @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/diagram-generation.md for tool selection guidance.

### 4. Container View (C4 Level 2)

Decompose the system into deployable/runnable units and show how they communicate.

- Include a PlantUML C4 Container diagram. Commit the `.puml` source alongside any rendered image.
- Each container should show: name, technology (e.g., "Go binary", "PostgreSQL 15", "Redis 7"), brief responsibility, and ports/protocols used for communication.
- Show all inter-container communication paths and the protocol for each (HTTP/2, gRPC, AMQP, shared volume, etc.).
- Show which containers are exposed to external actors and which are internal-only.
- For each container, state the deployment unit (Docker image, managed service, serverless function, etc.).
- Answer the question: "What are the major runtime pieces of this system and how do they talk to each other?"

### 5. Component View (C4 Level 3)

Decompose each primary container into its internal components. Repeat this section for each container that has non-trivial internal structure.

- Include a MermaidJS or PlantUML C4 Component diagram per primary container. Commit source alongside any rendered image. Cap at 15 nodes per diagram; split into sub-diagrams if the container is larger.
- For each component, state: name, responsibility, primary collaborators, and the interface(s) it exposes or depends on.
- **Trait/Interface Inventory** (required): List all traits, interfaces, or abstract types that serve as test seams or integration boundaries. For each, provide:
  - Trait/interface name
  - Method signatures (name, parameters, return type)
  - Implementing types (concrete structs, classes, or services)
  - Mockability assessment (easily mockable, requires test double infrastructure, or must use real implementation)
  - Which tests (unit, integration, E2E) are expected to use mocks vs real implementations at this boundary
- Flag any components that have no interface boundary (i.e., cannot be tested in isolation) as architectural concerns.
- Answer the question: "What are the internal building blocks and where are the test and integration seams?"

### 6. Data Model

Define concrete data models. The security reviewer needs this section to assess data-at-rest protection, PII exposure, and encryption requirements. The test architect needs it to generate realistic test fixtures.

- **Struct/Class Definitions**: Provide language-level type definitions for all primary domain entities. Include field names, types, nullability, and validation constraints. Use fenced code blocks with the appropriate language tag.
- **Database Schema**: For relational stores, provide DDL (`CREATE TABLE`) statements or an equivalent schema definition. Include: column names, types, constraints (NOT NULL, UNIQUE, FK), and indexes. For document stores, provide representative document shapes with field descriptions.
- **Storage Key Patterns**: For key-value stores and caches (Redis, DynamoDB, etc.), enumerate key patterns with format strings (e.g., `user:{user_id}:session:{session_id}`), TTL policies, and the data stored at each key.
- **Data Classification**: For each entity or table, indicate the sensitivity level (public, internal, confidential, restricted/PII). This is required input for the security reviewer.
- **Data Flow Summary**: Describe how data moves between stores (e.g., "write to Postgres, async replicate to read replica, cache invalidated on write via Redis pub/sub").
- **Migration Strategy**: If schema changes are expected during construction, describe the migration approach (expand/contract, blue/green, in-place with locks).

### 7. Key Sequence Diagrams

Illustrate the 3–5 most critical or complex runtime flows using Mermaid `sequenceDiagram` blocks. Commit source in the document; do not use external image links.

- **Selection criteria**: Choose flows that involve the most components, carry the highest risk, or have been the subject of architectural debate. Typical candidates: primary user journey, authentication/authorization flow, a failure/retry path, an async event-processing path.
- For each diagram:
  - Give it a title and a one-sentence statement of what architectural question it answers.
  - Show all participant systems/components (use short labels matching Section 4/5 names).
  - Show synchronous calls (solid arrow), async messages (dashed arrow), and responses where relevant.
  - Include error paths or compensating actions if the flow has meaningful failure modes.
  - Keep diagrams to ≤20 participants and ≤30 interactions; split into sub-diagrams if larger.
- Example flows to consider: user login and token issuance, data write with cache invalidation, background job scheduling and retry, cross-service event propagation, graceful shutdown sequence.

### 8. API Surface

Provide a complete inventory of all external-facing interfaces. The traceability reviewer uses this section to verify that every use case has a reachable API entry point.

- Create one table per interface type. Supported interface types: REST, gRPC, SDK (library API), MCP (Model Context Protocol), CLI, WebSocket, message queue topic/queue names.
- **For REST interfaces**, each row covers: HTTP method, path, brief description, request body schema (or "N/A"), response schema, authentication requirement, and applicable rate limit.
- **For gRPC interfaces**, each row covers: service name, RPC method name, request message type, response message type, streaming mode (unary/server/client/bidirectional), and authentication requirement.
- **For SDK/library interfaces**, each row covers: package, function/method name, parameter types, return type, and usage notes.
- **For MCP interfaces**, each row covers: tool name, input schema, output schema, and the agent capability it exposes.
- **For CLI interfaces**, each row covers: command, subcommand, flags/arguments, and description.
- Include a column for the UC or US IDs that each endpoint satisfies. This links to the traceability matrices in Sections 12–13.
- Flag any endpoints that are internal-only (not exposed outside the container) to avoid confusion with the external surface.

### 9. Deployment View

Describe how the system is deployed across all target environments.

- **Environment Matrix**: Table with rows = environments (dev, CI, staging, production, DR) and columns = containers from Section 4. Each cell indicates the deployment artifact (Docker image tag pattern, managed service tier, or "not deployed").
- **Infrastructure as Code**: Reference the IaC files (Terraform modules, Helm charts, Kubernetes manifests, Compose files) that define each environment. Include file paths relative to the repository root.
- **Container/Image Configuration**: For each Docker image: base image and version, build args that vary by environment, non-secret environment variables, and mount points.
- **Kubernetes / Orchestration**: If using Kubernetes, include: namespace layout, resource requests/limits per workload, HPA/KEDA configuration, service types (ClusterIP, LoadBalancer, Ingress), and any StatefulSet or DaemonSet usage.
- **Networking**: Describe the network topology — VPC layout, subnet assignment, ingress/egress rules, private vs public exposure per service.
- **Secrets Management**: State where secrets live (Vault, AWS Secrets Manager, K8s Secrets, env file) and how they are injected at runtime. Do not include actual secret values.
- **Scaling Model**: For each container, state the scaling axis (horizontal, vertical, or fixed), trigger (CPU%, queue depth, cron), and expected steady-state and peak replica counts.

### 9a. Process Architecture (12-Factor Methodology)

Document the runtime process model. Each subsection maps to a 12-factor principle and must be addressed or explicitly marked "N/A" with an ADR justifying the deviation.

**Why this section exists**: Architecture-level process decisions determine whether the system can scale horizontally, deploy without downtime, and recover from crashes. Leaving these implicit leads to late-stage surprises.

Reference: `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/stateless-processes.md`, `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/disposable-processes.md`, `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/logs-as-event-streams.md`.

#### 9a.1 Process Types (Factor VIII — Concurrency)

List each process archetype the system runs. Process archetypes are distinct scaling units, not distinct deployments.

| Process Type | Purpose | Scaling Axis | Concurrency Limit | Entry Point |
|--------------|---------|--------------|------------------|-------------|
| `web` | HTTP/gRPC request handling | horizontal | N requests per replica | `src/web/server.ts` |
| `worker` | Background jobs from queue | horizontal | N concurrent jobs per replica | `src/worker/consumer.ts` |
| `scheduler` | Time-triggered jobs (cron) | fixed (leader-elected) | 1 instance | `src/scheduler/index.ts` |
| `admin` | One-off admin tasks | on-demand | 1 per invocation | `src/admin/cli.ts` |

For each process type: state the resource profile (CPU/memory), expected replica count at steady state, peak replica count, and the signal that triggers scaling (CPU %, queue depth, request rate).

#### 9a.2 Process State Model (Factor VI — Stateless Processes)

For each process type listed in 9a.1, declare the state model:

| Process Type | State Kind | Storage Location | Durability |
|--------------|-----------|-----------------|-----------|
| `web` | Session | Redis (`sessions:*`) | durable, TTL 24h |
| `web` | User uploads | S3 (`uploads/{user}/`) | durable, lifecycle policy |
| `worker` | Job progress | Postgres (`jobs` table) | durable |
| `scheduler` | Leader election | Redis (`leader:scheduler`) | TTL 30s, re-election on expiry |
| `admin` | Task log | stdout → log aggregator | persisted by environment |

Any process holding state in process memory, on local disk outside `/tmp`, or in a volume mount not declared here requires an ADR per `rules/stateless-processes.md`.

#### 9a.3 Disposability (Factor IX)

Declare startup and shutdown characteristics:

| Process Type | Startup Target | Shutdown Grace | SIGTERM Handler | Crash Recovery |
|--------------|---------------|----------------|----------------|----------------|
| `web` | < 5s to ready | 30s to drain | Yes: stop accepting, finish in-flight, exit | Load balancer replaces |
| `worker` | < 5s | 60s (max job duration) | Yes: return in-flight job to queue | Queue redelivery |
| `scheduler` | < 2s | 5s | Yes: release leader lock | Election timeout (30s) |

Startup time must be measured in CI and tracked as a non-functional requirement — state the measurement approach.

#### 9a.4 Port Binding (Factor VII — Self-Contained Services)

Does each web-facing process bind its own port and export via HTTP/gRPC without relying on an external web server (Apache, IIS, Java EE app server)?

- [ ] Yes — all services self-contained, the environment (k8s, systemd, load balancer) routes to the bound port
- [ ] No — [specify which services depend on external hosting and link to ADR]

For each service that binds a port: state the port number (or env var that controls it), the protocol (HTTP/1.1, HTTP/2, gRPC), and whether it terminates TLS or expects a sidecar/load balancer to terminate.

#### 9a.5 Backing Services — Resource Locator Table (Factor IV)

Every attached resource is accessed via a locator (URL or connection string) loaded from configuration. Swapping a backing service must not require code changes.

| Resource | Env Variable | Format | Used by | Swap Criteria |
|----------|-------------|--------|---------|---------------|
| Primary DB | `DATABASE_URL` | `postgres://...` | web, worker | Failover DNS + secrets rotation |
| Cache | `REDIS_URL` | `redis://...` | web | Replace endpoint, restart pods |
| Queue | `QUEUE_URL` | `amqp://...` or `https://sqs.*` | worker | Provider-managed swap |
| Object Store | `OBJECT_STORE_ENDPOINT` | URL | web, worker | Provider endpoint swap |
| Email | `EMAIL_PROVIDER_API` | URL | worker | Env var change + key rotation |

Do not hardcode backing service addresses. Do not embed credentials in the locator (see `rules/token-security.md`).

#### 9a.6 Logging Architecture (Factor XI)

All processes write logs to stdout (normal) and stderr (warnings/errors) as an unbuffered event stream. Environment (container runtime, systemd, log shipper) handles routing, aggregation, and persistence.

- **Format**: structured JSON lines, required fields: `ts`, `level`, `svc`, `msg`, `trace_id`, `span_id`, `user_id` (when applicable)
- **Level**: controlled by `LOG_LEVEL` env var (`debug`/`info`/`warn`/`error`), default `info` in production
- **Aggregation destination**: [Loki/Datadog/CloudWatch/ELK] — state where logs land
- **No file-based logging**: applications do not open log files, configure rotation, or depend on syslog
- **Correlation**: every request/job emits a `trace_id` on entry; propagated via `traceparent` header (W3C) across service boundaries

Deviations (security audit logs with mandatory local persistence, regulated environments) require an ADR.

### 10. Cross-Cutting Concerns

Document system-wide concerns that cut across multiple components. Each subsection must be addressed or explicitly marked "N/A" with a one-sentence rationale.

#### 10.1 Authentication and Authorization

- Describe the authentication mechanism(s): session cookies, JWT, API keys, mTLS, OAuth2/OIDC flows. State which containers enforce authentication.
- Describe the authorization model: RBAC, ABAC, ACL, policy-as-code (OPA, Casbin). List the roles or permission scopes defined.
- Explain where authorization decisions are made (API gateway, service layer, data layer) and how they are enforced consistently.
- Describe token issuance, rotation, and revocation. Include token lifetime and refresh strategy.
- Reference the threat model section covering authentication bypass and privilege escalation.

#### 10.2 Cache Architecture (if applicable)

- List all caches in the system (in-process, distributed), their technology, and the data they cache.
- For each cache: describe the caching strategy (cache-aside, read-through, write-through, write-behind), TTL policy, and eviction policy.
- Describe cache invalidation: what events trigger invalidation, how invalidation is propagated across instances, and the consistency model (eventual vs strong).
- Describe cold-start behavior: what happens when the cache is empty (e.g., after a Redis restart) and whether the system can sustain load during cache warm-up.
- State the cache sizing assumptions and the observable metrics used to detect cache pressure.

#### 10.3 Observability (Logging, Metrics, Tracing)

- **Logging**: State the log format (structured JSON preferred), required fields (timestamp, level, service, trace ID, request ID, user ID where applicable), log levels used in production vs debug, and the log aggregation destination.
- **Metrics**: List the key metrics emitted by each service. Include: metric name, type (counter, gauge, histogram), labels, and the alert thresholds or SLO targets associated with each.
- **Distributed Tracing**: Describe the tracing instrumentation (OpenTelemetry, Jaeger, Zipkin), propagation headers used (W3C Trace Context, B3), sampling strategy, and trace collection destination.
- **Dashboards and Alerts**: Reference the dashboard definitions and alert rules (Grafana, Prometheus alerting rules, Datadog monitors). Include file paths or external URLs.
- **SLOs**: State the defined SLOs (availability, latency, error rate) and the error budget policy.

#### 10.4 Configuration Management

- Describe how configuration is loaded: environment variables, config files, remote config store (Consul, etcd, AWS AppConfig). State the precedence order when multiple sources exist.
- List all configuration parameters that vary by environment. For each: parameter name, type, example values, and whether it is a secret (if yes, refer to Section 9 secrets management — do not list values here).
- Record the `feature-flag-fit` decision and accepted card links; flags remain optional. [AIWG guidance]
- Describe flag provider, evaluation location, evaluation context model, default value and hooks ([OpenFeature](https://openfeature.dev/docs/reference/concepts)). Document PII minimization and server-side evaluation for sensitive decisions ([Unleash](https://docs.getunleash.io/guides/feature-flag-best-practices.md)).
- Choose one decision point, inside the component or injected as a decision; document the unit-of-work consistency boundary ([Hodgson](https://martinfowler.com/articles/feature-toggles.html), [component guidance](https://launchdarkly.com/docs/guides/flags/improving-code.md)). Distinguish deploy-time settings from runtime/per-request decisions; link rollout, tests and removal tasks.
- Describe configuration validation: is the configuration validated at startup? What happens on invalid configuration (fail-fast vs warn-and-continue)?
- Document any configuration drift detection: tooling or processes that detect when running configuration diverges from declared configuration.

#### 10.5 Rate Limiting / Throttling (if applicable)

- State where rate limiting is enforced (API gateway, service middleware, client-side backoff).
- For each interface in Section 8 that has rate limits: describe the limit (requests per second/minute/hour), the limit scope (per IP, per API key, per user, global), and the response behavior when the limit is exceeded (HTTP 429 with Retry-After header, circuit breaker, queue-and-drain).
- Describe the rate limit storage backend (Redis, in-memory, Nginx limit_req) and the algorithm (token bucket, leaky bucket, fixed window, sliding window).
- Describe the plan for legitimate burst traffic: is there a burst allowance, and how is it configured?
- If rate limiting is not applicable, state why (e.g., internal-only service, all clients are trusted internal services).

#### 10.6 Error Handling Strategy

- Describe the error taxonomy: what error categories exist (validation, authentication, authorization, not found, conflict, internal, transient)? How are they represented in API responses (error codes, HTTP status codes, error message format)?
- Describe the retry strategy for transient failures: which operations are retried, maximum retry count, backoff algorithm (exponential with jitter preferred), and the conditions that short-circuit retries.
- Describe the circuit breaker pattern if used: which dependencies have circuit breakers, the failure threshold, open/half-open/closed transition rules, and fallback behavior when the circuit is open.
- Describe how errors are surfaced to end users vs logged internally: what information is safe to return in error responses and what must be redacted.
- Describe the dead-letter queue or equivalent mechanism for messages or jobs that cannot be processed after exhausting retries.

### 11. Technology Choices

Enumerate all significant technologies, frameworks, libraries, and external services. The security reviewer and compliance team use this section to assess dependency risk and licensing constraints.

Provide a table with the following columns:

| Dependency | Version | Category | Purpose | License | Notes |
|------------|---------|----------|---------|---------|-------|
| [name] | [semver or range] | [runtime / build / dev / infra] | [one-line purpose] | [SPDX identifier] | [any constraints or risks] |

- Include: languages and runtimes, frameworks, libraries with significant footprint, databases, message brokers, caches, infrastructure tools, and external SaaS dependencies.
- Flag any dependency that is: end-of-life or approaching EOL, under a license incompatible with the project's distribution model, or without a clear maintenance path (single maintainer, abandoned).
- For each infrastructure-as-a-service or managed service dependency, note the vendor lock-in assessment and the mitigation plan if the service becomes unavailable.
- Keep this table synchronized with `go.mod`, `package.json`, `requirements.txt`, or equivalent lock files. Automated drift detection is preferred.

### 12. UC → Architecture Traceability

Matrix mapping each use case to the architectural components and sections that satisfy it. The traceability reviewer uses this matrix to verify no use case is architecturally unaddressed.

**Format**: Table with rows = use case IDs (from `.aiwg/requirements/use-cases/`) and columns = SAD sections or component names. Each cell indicates the relationship: "implements", "contributes to", "depends on", or blank (no relationship).

| UC ID | UC Title | Section 3 (Context) | Section 4 (Containers) | Section 5 (Components) | Section 8 (API Surface) | Satisfying Component(s) | Notes |
|-------|----------|---------------------|----------------------|----------------------|------------------------|------------------------|-------|
| UC-001 | [title] | [Y/N] | [container name] | [component name] | [endpoint] | [component] | |

- Every use case in the approved requirements set must have at least one row.
- Flag any use case with no satisfying component as an architectural gap requiring resolution before Construction.
- Update this matrix whenever use cases are added, modified, or deprecated.

### 13. US → Architecture Traceability

Matrix mapping each user story to the architectural components and API endpoints that implement it. Supplement the UC matrix with story-level granularity for Construction-phase planning.

**Format**: Table with rows = user story IDs (from `.aiwg/requirements/user-stories/`) and columns = implementing containers, components, and API endpoints.

| US ID | US Title | Epic / UC | Implementing Container | Implementing Component | API Endpoint(s) | Notes |
|-------|----------|-----------|----------------------|----------------------|----------------|-------|
| US-001 | [title] | [UC-XXX] | [container] | [component] | [method path] | |

- Every user story in the approved set must have at least one row.
- Stories that cross multiple containers should have one row per container with the relevant component and endpoint.
- Flag any story with no implementing component as an unresolved gap.

### 14. NFR → Architecture Traceability

Matrix mapping each non-functional requirement to the architectural tactics, components, and configuration that satisfy it.

**Format**: Table with rows = NFR IDs (from `.aiwg/requirements/nfrs/`) and columns = satisfying SAD section, component/service, and tactic applied.

| NFR ID | Category | Requirement Statement | Target | Satisfying Section | Satisfying Component | Tactic / Mechanism | Verification Method |
|--------|----------|-----------------------|--------|--------------------|---------------------|--------------------|---------------------|
| NFR-001 | Performance | p99 latency < 200 ms | Section 10.2 | Cache layer | Read-through cache + connection pooling | Load test in CI |

- Categories: Performance, Availability, Security, Scalability, Maintainability, Compliance, Operability, Portability.
- Every NFR must have a verification method: load test, penetration test, static analysis, audit log review, etc.
- Flag any NFR with no architectural tactic as an unresolved gap — it signals the NFR is aspirational, not designed for.

---

## Appendices

### Appendix A: Glossary

Define domain-specific terms, acronyms, and abbreviations used in this document. Readers outside the immediate team should be able to use this glossary to understand the architecture without prior domain knowledge.

| Term | Definition |
|------|-----------|
| [term] | [definition] |

### Appendix B: Open Architectural Questions

Track all unresolved architectural decisions. Each entry must have an owner and a target phase for resolution. An unresolved question in this appendix is a tracked risk; a question with no entry is an unknown unknown.

| # | Question | Context / Impact | Owner | Target Phase | Status |
|---|----------|-----------------|-------|-------------|--------|
| 1 | [question] | [why it matters, what is blocked on the answer] | [name] | [Elaboration/Construction/Transition] | [Open/In Review/Resolved] |

- Do not delete resolved questions — update their status to "Resolved" and add a one-line resolution summary.
- Review this appendix at every phase gate. Unresolved questions in Construction should be escalated.

### Appendix C: Review Incorporation Log

Record feedback received during architecture reviews and how it was incorporated. Supports audit trails and documents the rationale for changes between document versions.

| Review Date | Reviewer | Role | Feedback Summary | Resolution | SAD Section(s) Updated |
|-------------|----------|------|-----------------|------------|----------------------|
| [date] | [name] | [Security Architect / Test Architect / etc.] | [summary of feedback] | [accepted / rejected with rationale / deferred] | [section numbers] |

---

## Agent Notes

- Complete the traceability matrices in Sections 12–14 before the document is considered architecturally complete. A SAD with diagrams but no traceability provides no coverage assurance.
- The security reviewer depends on Section 6 (Data Model) for data-at-rest classification and on Section 10.1 for authentication/authorization assessment. Both must be present before the security review gate.
- The test architect depends on the trait/interface inventory in Section 5 to plan mock boundaries and integration test scope. An incomplete inventory leads to under-specified test strategy.
- The traceability reviewer depends on Section 8 (API Surface) to verify UC and US coverage. Every use case and user story must have a reachable API entry point or be explicitly marked as internal-only with a rationale.
- When adding diagrams, always commit the source (`.puml`, `.mmd`) alongside any rendered image. Rendered images without source cannot be updated during review cycles.
- Synchronize with Supplementary Specification to ensure quality attributes in Section 14 (NFR traceability) remain aligned with the latest NFR set.
- Update Appendix B (Open Architectural Questions) continuously throughout Elaboration and Construction. Never let open questions go untracked.
- Record all review feedback in Appendix C immediately after each review session — do not reconstruct from memory after the fact.
- Keep the Technology Choices table (Section 11) synchronized with lock files. Drift between the SAD and actual dependencies is a compliance and security risk.
- When a new use case or user story is approved, update Sections 12 and 13 before closing the requirements change — do not defer traceability updates.
