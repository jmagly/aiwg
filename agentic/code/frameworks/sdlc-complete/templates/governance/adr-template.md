# Architecture Decision Record (ADR)

## Metadata

- **ADR ID**: ADR-XXX
- **Status**: Proposed | Accepted | Rejected | Superseded by ADR-XXX
- **Date**: YYYY-MM-DD
- **Author(s)**: [Names or roles]
- **Reviewers**: [Architecture Review Board, Tech Lead, etc.]

## Phase 1: Core Decision (ESSENTIAL)

Complete these fields immediately when proposing an architectural decision:

### Title

[Short phrase describing the decision in active voice]

<!-- EXAMPLE: Use PostgreSQL as Primary Database for User Data -->
<!-- ANTI-PATTERN: "Database Selection" (too vague, passive voice) -->

### Status

**Current Status**: [Proposed | Accepted | Rejected | Superseded by ADR-XXX]

<!-- EXAMPLE: Accepted (2026-01-15) -->

**Decision Date**: [When this decision was made]

<!-- EXAMPLE: 2026-01-15 -->

**Supersedes**: [ADR-XXX if this replaces an earlier decision]

<!-- EXAMPLE: Supersedes ADR-012 (MongoDB decision from 2024-03-01) -->

### Context

**Problem**: [What architectural challenge requires a decision?]

<!-- EXAMPLE: The system needs to store structured user data including profiles, preferences, authentication credentials, and relationships between users. Current spreadsheet-based storage cannot scale beyond 1000 users and lacks ACID guarantees needed for financial transactions. -->

**Constraints**: [What limits our options?]

<!-- EXAMPLE:
- Budget: $500/month maximum for database infrastructure
- Team expertise: Strong SQL skills, limited NoSQL experience
- Compliance: Must support GDPR data deletion requests
- Scale: Expected 50K users in first year, 500K within 3 years
- Performance: <100ms query response time for user profile lookups
-->

**Stakeholders**: [Who cares about this decision and why?]

<!-- EXAMPLE:
- Development Team: Daily interaction with database
- Security Team: Data protection and access controls
- Finance Team: Cost management and budget adherence
- Operations Team: Maintenance and monitoring burden
-->

### Source Verification & Claim Tracking

Track factual claims made in the ADR — benchmarks, cost figures, capability assertions — with sources and verification status. Prevents decisions from resting on unverified assumptions.

<!-- EXAMPLE:
| Claim | Source | Verified | Date |
|-------|--------|----------|------|
| PostgreSQL handles 500K users at $200-400/month | AWS RDS pricing calculator | ✅ Yes | 2026-01-10 |
| Team has 3/4 developers with PostgreSQL experience | Team skills survey | ✅ Yes | 2026-01-08 |
| MongoDB multi-document transactions unavailable | MongoDB 4.x docs | ✅ Yes | 2026-01-09 |
| p99 < 100ms achievable at 500 RPS | Load test on staging (report: .aiwg/testing/db-load-v1.md) | ✅ Yes | 2026-01-14 |
| Aurora Serverless cold start up to 30 s | AWS docs + internal spike | ✅ Yes | 2026-01-11 |
-->

| Claim | Source | Verified | Date |
|-------|--------|----------|------|
| [Claim 1] | [Source / citation] | ⬜ No | — |
| [Claim 2] | [Source / citation] | ⬜ No | — |

**Unverified claims** (must be resolved before L2 — Reviewed):
- [ ] [Claim that still needs a source]

## Phase 2: Decision & Alternatives (EXPAND WHEN READY)

<details>
<summary>Click to expand decision rationale and alternatives considered</summary>

### Decision

**What we are deciding to do:**

[Clear statement of the chosen approach]

<!-- EXAMPLE:
We will use PostgreSQL 16+ as the primary database for all structured user data, hosted on AWS RDS with multi-AZ deployment for high availability.

Specific implementation:
- PostgreSQL 16.1 or later
- AWS RDS managed service (db.t4g.medium instances)
- Multi-AZ configuration for HA
- Automated daily backups with 30-day retention
- Connection pooling via PgBouncer
- Primary access via TypeORM or Prisma ORM
-->

**Why this decision:**

[Rationale connecting decision to context]

<!-- EXAMPLE:
PostgreSQL was chosen because:
1. Strong SQL support matches team expertise (3/4 developers have PostgreSQL experience)
2. ACID compliance meets financial transaction requirements
3. JSON/JSONB support provides flexibility for evolving schemas
4. Mature ecosystem with extensive tooling (monitoring, backup, migration tools)
5. Cost-effective at expected scale ($200-400/month for 500K users)
6. Excellent support for relational data modeling (user relationships, permissions)
7. Battle-tested at similar scale by companies in our industry
-->

### Alternatives Considered

List all viable alternatives and why they were not chosen:

#### Alternative 1: [Name]

**Description**: [Brief overview of this option]

<!-- EXAMPLE:
#### Alternative 1: MongoDB (NoSQL Document Store)

**Description**: Use MongoDB Atlas as primary database, storing user data as JSON documents with flexible schemas.
-->

**Pros**:
- [Advantage 1]
- [Advantage 2]

<!-- EXAMPLE:
**Pros**:
- Flexible schema evolution without migrations
- Horizontal scaling easier for very large datasets
- Strong developer experience with Node.js ecosystem
-->

**Cons**:
- [Disadvantage 1]
- [Disadvantage 2]

<!-- EXAMPLE:
**Cons**:
- Team has limited MongoDB experience (training required)
- No ACID transactions across collections (critical for our use case)
- More expensive at our expected scale ($600-800/month)
- Requires more complex application logic for relationship management
-->

**Why Not Chosen**: [Specific reason this was rejected]

<!-- EXAMPLE:
**Why Not Chosen**: Lack of multi-document ACID transactions is a dealbreaker for financial operations. Team requires transaction-model training and a validated data-access prototype before adoption. Cost 50% higher than PostgreSQL alternative.
-->

#### Alternative 2: [Name]

<!-- EXAMPLE:
#### Alternative 2: MySQL 8.0

**Description**: Use MySQL 8.0 on AWS RDS as primary database.

**Pros**:
- Mature, well-documented, widely adopted
- Similar cost profile to PostgreSQL
- Good performance for read-heavy workloads

**Cons**:
- JSON support less mature than PostgreSQL
- Fewer advanced features (window functions, CTEs less capable)
- Licensing concerns (Oracle ownership)

**Why Not Chosen**: PostgreSQL offers better JSON support and more advanced SQL features that will benefit future development. No significant advantage over PostgreSQL for our use case.
-->

#### Alternative 3: [Name]

<!-- EXAMPLE:
#### Alternative 3: Serverless (Aurora Serverless, PlanetScale)

**Description**: Use serverless database with auto-scaling capabilities.

**Pros**:
- Automatic scaling based on load
- Pay only for actual usage
- Zero administration overhead

**Cons**:
- Cold start latency unacceptable for interactive application
- More expensive at steady-state load
- Less operational control for optimization

**Why Not Chosen**: Cold start latency (up to 30 seconds) conflicts with <100ms response time requirement. Cost modeling shows 2-3x higher expense at expected steady load.
-->

</details>

## Phase 3: Impact & Implementation (ADVANCED)

<details>
<summary>Click to expand consequences, risks, and implementation details</summary>

### Consequences

#### Positive Outcomes

What benefits does this decision bring?

<!-- EXAMPLE:
- Team productivity high due to existing PostgreSQL expertise
- ACID guarantees eliminate entire class of data consistency bugs
- Strong JSON support enables flexible user preferences without schema changes
- Mature tooling ecosystem reduces operational burden
- Battle-tested at scale by similar companies (Reddit, Instagram, Notion)
-->

- [Positive consequence 1]
- [Positive consequence 2]

#### Negative Outcomes

What trade-offs or costs does this decision impose?

<!-- EXAMPLE:
- Horizontal scaling more complex than with NoSQL (requires sharding strategy)
- Write-heavy workloads may require optimization (connection pooling, caching)
- RDS vendor lock-in makes provider migration costly
- Schema migrations require careful planning and downtime coordination
-->

- [Negative consequence 1]
- [Negative consequence 2]

#### Operational Impacts

How does this affect day-to-day operations?

<!-- EXAMPLE:
- DevOps team needs to monitor RDS metrics (connections, IOPS, replication lag)
- Backup/restore procedures must be documented and tested quarterly
- Schema migration workflow must be added to CI/CD pipeline
- On-call engineers require PostgreSQL troubleshooting training
-->

- [Operational impact 1]
- [Operational impact 2]

### Risks

**Technical Risks**:

<!-- EXAMPLE:
- Risk: PostgreSQL connection pool exhaustion under load
- Probability: Medium
- Impact: High (application downtime)
- Mitigation: Implement PgBouncer connection pooling, monitor connection usage, set up alerts at 80% threshold
-->

- [Technical risk 1]
- [Technical risk 2]

**Business Risks**:

<!-- EXAMPLE:
- Risk: AWS RDS pricing increases significantly
- Probability: Low
- Impact: Medium (budget overrun)
- Mitigation: Monitor cost trends, evaluate multi-cloud strategy if pricing exceeds $500/month
-->

- [Business risk 1]
- [Business risk 2]

**Security Risks**:

<!-- EXAMPLE:
- Risk: Misconfigured security groups expose database publicly
- Probability: Low
- Impact: Critical (data breach)
- Mitigation: Infrastructure-as-code with peer review, automated security scanning, quarterly audits
-->

- [Security risk 1]
- [Security risk 2]

### Implementation Notes

**Migration Path**:

<!-- EXAMPLE:
1. Provision PostgreSQL RDS instance in dev environment (gate: dev instance accessible)
2. Define initial schema and migration strategy (gate: schema reviewed)
3. Implement data access layer with ORM (gate: data-access tests pass)
4. Migrate existing data from spreadsheets (gate: migrated records reconciled)
5. Deploy to staging and run load tests (gate: staging load tests pass)
6. Production cutover with blue-green deployment (gate: cutover checks pass)
-->

**Implementation Gates**:

<!-- EXAMPLE:
- Decision approval → provision development instance (platform owner)
- Schema review → implement and test data access (database owner)
- Data reconciliation → staging load tests (test engineer)
- Passing staging checks → production cutover (deployment owner)
- Verified cutover → retrospective and follow-up scope (decision owner)
-->

**Dependencies**:

<!-- EXAMPLE:
- AWS account with RDS provisioning permissions
- ORM library selection (TypeORM vs Prisma) - ADR-XXX
- Monitoring integration (CloudWatch vs Datadog) - pending
- Backup strategy approval from Security team
-->

**Success Criteria**:

<!-- EXAMPLE:
- All user data successfully migrated from spreadsheets
- Query response time <100ms at p95
- Zero data loss or corruption during migration
- Data-access acceptance tests pass after migration
- Incident count stable or decreased vs. previous solution
-->

### Related Decisions

**Upstream Decisions** (decisions that led to this one):

<!-- EXAMPLE:
- ADR-005: Monolithic architecture vs. microservices
- ADR-008: AWS as primary cloud provider
-->

**Downstream Decisions** (decisions that depend on this one):

<!-- EXAMPLE:
- ADR-XXX: ORM selection (pending)
- ADR-XXX: Caching strategy (pending)
- ADR-XXX: Backup and disaster recovery (pending)
-->

**Related Decisions** (decisions in same problem space):

<!-- EXAMPLE:
- ADR-015: Redis for session storage
- ADR-018: S3 for file uploads
-->

### Implementation Sketch

Concrete code or configuration demonstrating the decision in practice. Keeps the ADR grounded and exposes integration complexity early.

<!-- EXAMPLE:
```typescript
// Connection pool configuration (PgBouncer + TypeORM)
const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: 5432,
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  poolSize: 20,
  connectTimeoutMS: 5000,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
});

// Example schema migration
export class CreateUsersTable1700000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(new Table({
      name: 'users',
      columns: [
        { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
        { name: 'email', type: 'varchar(255)', isUnique: true, isNullable: false },
        { name: 'created_at', type: 'timestamptz', default: 'now()' },
      ],
    }));
  }
}
```
-->

```
[Paste representative code, config, or schema here]
```

**Key integration points**:
- [Where this touches existing code]
- [External APIs or protocols involved]

**Known sharp edges**:
- [Gotcha 1 — e.g. N+1 queries if ORM lazy-loads associations]
- [Gotcha 2 — e.g. migration lock on large tables]

### Concurrency and Shared State Model

Describes how the decision handles concurrent access, shared mutable state, and race conditions.

<!-- EXAMPLE:
**Concurrency model**: PostgreSQL row-level locking + optimistic concurrency via `version` column.

**Shared state**:
- `users` table: read-heavy, cache-friendly — Redis L2 cache with 60 s TTL
- `sessions` table: write-heavy, no caching — direct DB write per request
- `transactions` table: serialized via `SELECT FOR UPDATE` within explicit transaction

**Race conditions addressed**:
- Double-spend: prevented by `SELECT FOR UPDATE` + unique constraint on `(user_id, idempotency_key)`
- Concurrent profile updates: last-writer-wins with `updated_at` optimistic check

**Not addressed** (acceptable trade-offs):
- Read-your-writes across replicas: clients routed to primary for 5 s after write
-->

**Concurrency model**: [e.g. optimistic locking, pessimistic locking, actor model, event sourcing]

**Shared mutable state**:
- [Resource 1 — access pattern and protection mechanism]
- [Resource 2]

**Race conditions and mitigations**:
- [Scenario 1 → mitigation]
- [Scenario 2 → mitigation]

**Explicitly out of scope**: [What concurrency scenarios this decision does not address and why]

### Testing Strategy

How to verify this decision is correctly implemented and remains correct over time.

<!-- EXAMPLE:
**Unit tests**: Mock DataSource, test repository methods against in-memory fixtures.
- File: `src/users/users.repository.spec.ts`
- Coverage target: 90% branch coverage on all query methods

**Integration tests**: Real PostgreSQL via Docker Compose (`docker-compose.test.yml`).
- Run with: `npm run test:integration`
- Tests: CRUD lifecycle, concurrent insert idempotency, migration forward/rollback

**Contract tests**: Verify ORM-generated SQL against pg_stat_statements baseline on schema change.

**Performance tests**: k6 load test at 500 RPS, p99 < 100 ms.
- Baseline captured: `tests/perf/baselines/db-v1.json`
- Regression threshold: +20% on p95

**Chaos tests**: Kill primary RDS instance, verify automatic failover within 60 s (quarterly drill).
-->

**Unit tests**: [What to mock, where test files live, coverage target]

**Integration tests**: [Real dependencies required, how to run, key scenarios]

**Contract/compatibility tests**: [API contracts, schema compatibility, migration smoke tests]

**Performance tests**: [Load profile, thresholds, baseline location]

**Regression guard**: [What signals a regression in this decision — metric, CI check, or alert]

### Definition of Done

Multi-level quality gates that must pass before this ADR is considered complete at each stage.

| Level | Gate | Criteria |
|-------|------|----------|
| **L1 — Proposed** | ADR drafted | Phase 1 complete, status = Proposed, at least one alternative considered |
| **L2 — Reviewed** | Architecture review | Phase 2 complete, all reviewers signed off, no unresolved comments |
| **L3 — Accepted** | Decision accepted | Status = Accepted, implementation sketch present, risks documented |
| **L4 — Implemented** | Code shipped | Implementation matches sketch, unit + integration tests pass, CI green |
| **L5 — Verified** | Live validation | Performance/contract tests pass in staging, no regressions after 2-week soak |

**Current level**: [L1 | L2 | L3 | L4 | L5]

**Blocking items for next level**:
- [ ] [Item 1]
- [ ] [Item 2]

</details>

## References

Wire @-mentions for traceability:

- @.aiwg/requirements/use-cases/UC-XXX.md - Driving requirement
- @.aiwg/architecture/software-architecture-doc.md - Architecture context
- @$AIWG_ROOT/src/path/to/implementation.ts - Implementation (when applicable)
- @.aiwg/requirements/nfr-modules/performance.md - Performance requirements
- @.aiwg/requirements/nfr-modules/security.md - Security requirements

**External References**:

<!-- EXAMPLE:
- PostgreSQL Documentation: https://www.postgresql.org/docs/16/
- AWS RDS Best Practices: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html
- Comparison Study: "PostgreSQL vs MySQL Performance Benchmarks" (internal wiki)
-->

## Review & Approval

**Review Process**:

<!-- EXAMPLE:
- Draft circulated to architecture review board (2026-01-10)
- Feedback period (2026-01-10 to 2026-01-14)
- Architecture review meeting (2026-01-15)
- Decision approved with unanimous consent
-->

**Reviewers**:

<!-- EXAMPLE:
- [ ] Tech Lead (Jane Smith) - Approved 2026-01-15
- [ ] Security Lead (Bob Jones) - Approved with conditions 2026-01-15
- [ ] DevOps Lead (Alice Chen) - Approved 2026-01-15
- [ ] CTO (Sam Wilson) - Approved 2026-01-15
-->

**Approval Conditions** (if any):

<!-- EXAMPLE:
- Security team requires quarterly penetration testing (agreed)
- DevOps requires disaster recovery drill within 60 days (agreed)
-->

## Agent Notes

- ADRs document **decisions**, not requirements or design details
- Focus on **why** this decision was made, not just **what** was decided
- Include enough context that future readers understand the forces at play
- Document alternatives considered to prevent re-litigating settled decisions
- Update status to "Superseded by ADR-XXX" if decision is later reversed
- Progressive disclosure: Focus on Phase 1 during initial proposal, expand Phases 2-3 before approval

## Related Templates

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/software-architecture-doc-template.md - Overall architecture
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/governance/decision-matrix-template.md - Multi-criteria decision analysis
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/risk-card.md - Risk tracking
