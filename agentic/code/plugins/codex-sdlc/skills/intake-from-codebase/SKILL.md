---
namespace: aiwg
name: intake-from-codebase
platforms: [all]
description: Scan existing codebase and generate intake documents by analyzing code, dependencies, and infrastructure. Accepts optional guidance text to tailor analysis.
commandHint:
  argumentHint: <codebase-directory> [--interactive] [--output .aiwg/intake/] [--guidance "context"]
  allowedTools: Read, Write, Glob, Grep, Bash, TodoWrite
  model: haiku
  category: sdlc-management
  modelRole: efficiency
  modelTier: economy
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# Intake From Codebase

You are an experienced Software Architect and Reverse Engineer specializing in analyzing existing codebases, understanding system architecture, and documenting undocumented systems.

## Kernel Delegation

> As of ADR-021, `intake-from-codebase` delegates core ingest mechanics to the semantic memory kernel.

**Delegation pattern**:
1. `intake-from-codebase` retains its public name and codebase-scan heuristics
2. Document generation delegates to `memory-ingest --consumer sdlc-complete`
3. SDLC-specific layers remain in this wrapper:
   - Codebase scanning and analysis heuristics
   - SDLC page templates (requirements, architecture, etc.)
   - Provenance tracking (via `ingestRequires: ["provenance"]`)
4. No change to `intake-start` downstream

**What changed**: The ingest pipeline (source processing, page creation, index update, log append) is now handled by `memory-ingest`. This skill adds the codebase-specific scanning and SDLC template layers on top.

**Backward compatibility**: No UX changes. Existing invocations work identically.

@agentic/code/addons/semantic-memory/skills/memory-ingest/SKILL.md

## Your Task

When invoked with `/intake-from-codebase <codebase-directory> [--interactive] [--output .aiwg/intake/] [--guidance "text"]`:

1. **Scan** the codebase directory to understand the system
2. **Analyze** code structure, dependencies, infrastructure, and patterns
3. **Infer** project characteristics from evidence found
4. **Apply guidance** from user prompt (if provided) to focus analysis or clarify context
5. **Ask** clarifying questions (if --interactive) for ambiguous areas
6. **Generate** complete intake forms documenting the existing system

## Parameters

- **`<codebase-directory>`** (required): Path to codebase root (absolute or relative)
- **`--interactive`** (optional): Enable interactive questioning mode (max 10 questions)
- **`--output <path>`** (optional): Output directory for intake files (default: `.aiwg/intake/`)
- **`--guidance "text"`** (optional): User-provided context to guide analysis

### Guidance Parameter Usage

The `--guidance` parameter accepts free-form text to help tailor the analysis. Use it for:

**Business Context**:
```bash
/intake-from-codebase . --guidance "B2B SaaS for healthcare, HIPAA compliance critical, 50k users"
```

**Analysis Focus**:
```bash
/intake-from-codebase . --guidance "Focus on security posture and compliance gaps for SOC2 audit"
```

**Profile Hints**:
```bash
/intake-from-codebase . --guidance "Prototype moving to MVP, need to establish baseline before adding team members"
```

**Pain Points**:
```bash
/intake-from-codebase . --guidance "Performance issues at scale, considering migration from monolith to microservices"
```

**Combination**:
```bash
/intake-from-codebase . --interactive --guidance "Fintech app, PCI-DSS required, preparing for Series A fundraising"
```

**How guidance influences analysis**:
- **Prioritizes** specific areas (security, compliance, scale, performance)
- **Infers** missing information based on context (e.g., "healthcare" → check HIPAA patterns)
- **Adjusts** profile recommendations (e.g., "compliance critical" → favor Production/Enterprise)
- **Tailors** questions (if --interactive, asks about guidance-specific topics)
- **Documents** in "Why This Intake Now?" section (captures user intent)

## Objective

Generate comprehensive intake documents for an existing codebase that may have little or no documentation, enabling teams to:
- Document brownfield projects for SDLC process adoption
- Understand inherited or acquired codebases
- Establish baseline for refactoring or modernization efforts
- Create historical project intake for compliance/audit

## Codebase Analysis Workflow

### Step 0: Process Guidance (If Provided)

If user provided `--guidance "text"`, parse and apply throughout analysis.

**Extract from guidance**:
- **Business domain** (healthcare, fintech, e-commerce, enterprise, consumer)
- **Compliance requirements** (HIPAA, PCI-DSS, GDPR, SOX, FedRAMP)
- **Scale indicators** (user count, transaction volume, geographic distribution)
- **Current phase** (prototype, MVP, production, enterprise)
- **Pain points** (performance, security, technical debt, team scaling)
- **Intent** (compliance prep, audit, handoff, modernization, fundraising)

**Apply guidance to**:
1. **Analysis prioritization**: Focus on areas mentioned in guidance
2. **Profile recommendation**: Weight criteria based on guidance (e.g., "HIPAA" → increase Quality weight)
3. **Interactive questions**: Ask about guidance-specific gaps (if --interactive)
4. **Documentation**: Reference guidance in "Why This Intake Now?" section

**Example guidance processing**:

Input: `--guidance "B2B SaaS for healthcare, HIPAA compliance critical, 50k users, preparing for SOC2 audit"`

Extracted:
- Domain: Healthcare (B2B SaaS)
- Compliance: HIPAA (critical), SOC2 (in progress)
- Scale: 50k users (Production profile likely)
- Intent: Audit preparation

Applied:
- Prioritize: Security analysis (HIPAA/SOC2 controls), compliance indicators, audit logging
- Profile weights: Quality 0.4, Reliability 0.3 (compliance-driven)
- Questions (if --interactive): "What HIPAA controls are currently implemented?", "When is SOC2 audit scheduled?"
- Documentation: Capture in "Why This Intake Now?" → "SOC2 audit preparation for healthcare SaaS (HIPAA-compliant)"

### Step 1: Initial Reconnaissance

Scan the codebase directory to understand basic characteristics.

**Commands**:
```bash
# Directory structure
ls -la
find . -type f | head -50

# Count files by extension
find . -type f | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20

# Check for common markers
ls README.md CONTRIBUTING.md LICENSE package.json requirements.txt Dockerfile docker-compose.yml .git
```

**Extract**:
- **Project name**: From git remote, package.json/package name, README title, directory name
- **Primary languages**: File extensions (`.js`, `.py`, `.java`, `.go`, etc.)
- **Framework indicators**: package.json, requirements.txt, pom.xml, go.mod, Gemfile
- **Infrastructure**: Dockerfile, docker-compose.yml, kubernetes/, terraform/, .github/workflows/

**Output**: Initial reconnaissance summary
```markdown
## Initial Reconnaissance

**Project Name**: {extracted from git/package.json/directory}
**Primary Languages**: {JavaScript (45%), Python (30%), Shell (15%), YAML (10%)}
**Tech Stack Indicators**:
- Frontend: React 18.2.0, Next.js 13.4
- Backend: Node.js 18, Express 4.18
- Database: PostgreSQL (docker-compose.yml)
- Deployment: Docker, GitHub Actions CI/CD

**Repository**: {git remote URL if available}
**Last Commit**: {git log -1 --format="%ai %s"}
**Lines of Code**: {cloc summary if available}
```

### Step 2: Architecture Analysis

Analyze codebase structure to understand architecture patterns.

**Commands**:
```bash
# Directory structure (key paths)
tree -L 3 -d

# Component/module identification
ls src/ lib/ app/ pkg/ cmd/
ls -la src/*/

# API/Interface discovery
grep -r "app\." --include="*.js" | head -20
grep -r "router\." --include="*.py" | head -20
grep -r "@RestController\|@RequestMapping" --include="*.java" | head -20

# Database/data layer
ls models/ entities/ migrations/ schema/
grep -r "CREATE TABLE\|mongoose.model\|sqlalchemy" | head -20
```

**Infer**:
- **Architecture Style**: Monolith, Microservices, Serverless, MVC, Layered
  - Single repo with src/ → Monolith
  - Multiple services/ or apps/ → Microservices
  - Functions/ or lambda/ → Serverless
- **Component Boundaries**: Frontend, Backend, API, Services, Workers, CLI
- **Data Persistence**: SQL (PostgreSQL, MySQL), NoSQL (MongoDB, Redis), ORM indicators
- **Integration Points**: External API calls, message queues, event buses

**Output**: Architecture summary
```markdown
## Architecture Summary

**Style**: {Modular Monolith | Microservices | Layered | Event-Driven}

**Components**:
- Frontend: React SPA in src/client/ (TypeScript)
- Backend API: Express REST API in src/server/ (Node.js)
- Database: PostgreSQL with Prisma ORM (schema/prisma/)
- Background Jobs: Bull queue (src/workers/)

**Integration Points**:
- Stripe API for payments (src/services/payment/)
- SendGrid for email (src/services/email/)
- AWS S3 for file storage (src/services/storage/)

**Data Models**: {count} entities (User, Order, Product, Payment, etc.)
```

### Step 3: Dependencies and Infrastructure Analysis

Analyze dependencies, deployment, and operational characteristics.

**Commands**:
```bash
# Node.js dependencies
cat package.json | jq '.dependencies, .devDependencies'
npm ls --depth=0

# Python dependencies
cat requirements.txt Pipfile

# Docker/deployment
cat Dockerfile docker-compose.yml
ls -la .github/workflows/ .gitlab-ci.yml .circleci/

# Environment variables (identify sensitive data handling)
grep -r "process.env\|os.getenv\|System.getenv" --include="*.{js,py,java}" | wc -l
ls .env .env.example .env.template
```

**Infer**:
- **Third-Party Services**: Payment (Stripe, PayPal), Email (SendGrid, Mailgun), Analytics (Segment, Google Analytics), Monitoring (Sentry, Datadog)
- **Security Patterns**: Authentication libs (passport, jwt), encryption, secrets management
- **Testing Strategy**: Test frameworks (Jest, Pytest, JUnit), coverage tools, CI test jobs
- **Deployment**: Containerized (Docker), Cloud provider (AWS, GCP, Azure), CI/CD maturity
- **Compliance Indicators**: GDPR (consent, data deletion), PCI-DSS (payment tokenization), HIPAA (audit logs)

**Output**: Dependencies and infrastructure summary
```markdown
## Dependencies & Infrastructure

**Key Dependencies**:
- Authentication: Passport.js + JWT
- Payments: Stripe SDK 12.0.0
- Email: SendGrid 7.7.0
- Testing: Jest 29.5, React Testing Library

**Security**:
- Authentication: JWT with refresh tokens
- Secrets: Environment variables (.env pattern)
- Data protection: bcrypt for passwords, encryption at rest (detected: crypto module usage)

**CI/CD**:
- Platform: GitHub Actions
- Pipeline: lint → test → build → deploy
- Deployment Target: AWS ECS (Dockerfile present)

**Monitoring/Observability**:
- Error Tracking: Sentry integration detected
- Logging: Winston logger with structured JSON
- Metrics: Basic (no APM detected)
```

### Step 4: Scale and Usage Analysis

Analyze code for scale indicators and current usage patterns.

**Commands**:
```bash
# Database queries (scale patterns)
grep -r "SELECT.*FROM\|.find(\|.aggregate(" --include="*.{js,py,sql}" | wc -l

# Caching indicators
grep -r "redis\|memcached\|cache" --include="*.{js,py}" | wc -l

# Rate limiting/throttling
grep -r "rate.*limit\|throttle" --include="*.{js,py}" | wc -l

# Async/queue patterns
grep -r "async\|await\|queue\|job\|worker" --include="*.{js,py}" | wc -l

# API endpoints (count)
grep -r "app\.get\|app\.post\|@app.route" --include="*.{js,py}" | wc -l
```

**Infer**:
- **Current Scale Capacity**:
  - No caching, simple queries → <1k users
  - Redis caching, connection pooling → 1k-10k users
  - Load balancing, queue workers, sharding → 10k-100k users
- **Performance Optimization**: Caching, indexing, pagination, lazy loading
- **Concurrency Model**: Sync, async, event-driven, worker pools

**Output**: Scale and performance summary
```markdown
## Scale & Performance

**Current Capacity Estimate**: 1k-5k concurrent users
**Evidence**:
- Redis caching implemented (10 instances)
- Database connection pooling (max 20 connections)
- No horizontal scaling detected (single instance)
- Basic rate limiting (100 req/min per IP)

**Performance Patterns**:
- Caching: Redis for session and API responses
- Async: Extensive async/await usage (Node.js)
- Background Jobs: Bull queue for email, reports
- Database: Indexed queries, pagination for lists

**Optimization Opportunities**:
- Add CDN for static assets
- Implement query result caching
- Consider read replicas for database
```

### Step 5: Security and Compliance Analysis

Analyze security posture and compliance indicators.

**Commands**:
```bash
# Authentication patterns
grep -r "passport\|jwt\|oauth\|auth0" --include="*.js" | wc -l

# Data privacy patterns
grep -r "gdpr\|privacy\|consent\|deletion\|right.*forget" --include="*.{js,py,md}" | wc -l

# Sensitive data handling
grep -r "password\|secret\|credit.*card\|ssn\|api.*key" --include="*.js" | wc -l

# Security headers
grep -r "helmet\|cors\|csp\|hsts" --include="*.js" | wc -l

# Audit logging
grep -r "audit.*log\|log.*audit\|event.*log" --include="*.{js,py}" | wc -l
```

**Infer**:
- **Security Posture**: Minimal, Baseline, Strong, Enterprise
  - Basic auth only → Minimal
  - Auth + HTTPS + secrets mgmt → Baseline
  - SAST, DAST, threat modeling → Strong
  - SOC2/ISO27001 controls → Enterprise
- **Data Classification**: Public, Internal, Confidential, Restricted
- **Compliance**: GDPR (EU users), HIPAA (health data), PCI-DSS (payments), SOX (financial)

**Output**: Security and compliance summary
```markdown
## Security & Compliance

**Security Posture**: Baseline
**Evidence**:
- Authentication: JWT with refresh tokens, bcrypt passwords
- Authorization: Role-based access control (3 roles: user, admin, superadmin)
- Data Protection: Encryption at rest (detected), TLS in transit
- Secrets Management: Environment variables, no hardcoded secrets detected
- Security Headers: Helmet.js for HTTP headers, CORS configured

**Data Classification**: Confidential
**Sensitive Data Detected**:
- PII: User profiles with email, name, address
- Payment: Credit card tokens (Stripe tokenization)
- No PHI or health data detected

**Compliance Indicators**:
- GDPR: Consent management, data deletion endpoints present
- PCI-DSS: Stripe handles card data (compliant tokenization)
- No HIPAA or SOX requirements detected
```

### Step 6: Team and Process Indicators

Analyze repository for team size, process maturity, and operational patterns.

**Commands**:
```bash
# Git commit history
git log --format="%an" | sort | uniq -c | sort -rn | head -10
git log --since="1 year ago" --format="%ai" | wc -l

# Contributors
git shortlog -sn | head -10

# Branch strategy
git branch -a | grep -E "main|master|develop|release|hotfix"

# Documentation
find . -name "*.md" | wc -l
ls docs/ README.md CONTRIBUTING.md

# Testing coverage
grep -r "test\|spec" --include="*.{js,py}" | wc -l
```

**Infer**:
- **Team Size**:
  - 1-2 active committers → Small team (1-3 devs)
  - 3-5 active committers → Medium team (4-8 devs)
  - >10 active committers → Large team (>10 devs)
- **Development Velocity**: Commits per week
- **Process Maturity**: Feature branches, PR reviews, semantic versioning, changelog
- **Documentation Quality**: README, API docs, runbooks, architecture docs

**Output**: Team and process summary
```markdown
## Team & Process

**Team Size Estimate**: Small (2-3 developers)
**Evidence**:
- 3 active contributors in last 6 months
- 47 commits in last quarter (1.5 commits/day avg)

**Branch Strategy**: GitHub Flow (main + feature branches)
**Process Indicators**:
- Pull Requests: Required for main branch
- Code Reviews: 1 approver required (detected from .github/)
- Testing: 68% test coverage (reported in CI)
- Versioning: Semantic versioning (package.json)

**Documentation**:
- README: Comprehensive (setup, usage, deployment)
- API Docs: OpenAPI spec present (docs/api.yaml)
- Contributing Guide: Present
- Runbooks: Missing (operational gap)
```

### Step 7: Interactive Clarification (Optional)

Ask targeted questions to clarify ambiguous or missing information.

**Question Categories** (max 10 questions):

1. **Business Context** (if unclear from codebase):
   - "What problem does this system solve? Who are the primary users?"
   - "What are the key business metrics or success criteria?"

2. **Current State** (if deployment unclear):
   - "Is this system currently in production? If so, how many active users?"
   - "What's the production environment? (AWS, GCP, Azure, on-prem?)"

3. **Pain Points** (to inform improvement opportunities):
   - "What are the biggest challenges with this system today?"
   - "Are there known performance issues or areas needing modernization?"

4. **Future Direction** (to frame intake context):
   - "Why are you creating intake documents now? (compliance, handoff, modernization?)"
   - "Any planned changes or refactoring in the roadmap?"

5. **Missing Information** (gaps from analysis):
   - "I couldn't detect monitoring/observability tools. What do you use?"
   - "Didn't find explicit compliance documentation. Any regulatory requirements?"

**Adaptive Logic**:
- Skip questions if codebase provides clear evidence
- Prioritize business context questions (most valuable, least inferable)
- Only ask technical questions if major gaps exist

**Example Interactive Flow**:
```
Analyzing codebase at ./my-api-project...

✓ Detected: Node.js + Express + PostgreSQL + React
✓ Architecture: Modular monolith with 4 main components
✓ Scale indicators: Caching, connection pooling (1k-5k users estimated)
✓ Security: JWT auth, Stripe payments, GDPR patterns detected

I have a few questions to complete the intake documents:

Question 1/10: What business problem does this API solve? Who are the primary users?

{user responds: "B2B SaaS platform for inventory management. Users are warehouse managers."}

Question 2/10: Is this currently in production? If so, how many active companies/users?

{user responds: "Yes, launched 6 months ago. 12 companies, about 150 users total."}

Question 3/10: I detected GDPR patterns. Are most of your customers in the EU?

{user responds: "8 of 12 companies are EU-based, so yes GDPR is critical."}

Question 4/10: What are the biggest pain points or challenges with the system today?

{user responds: "Performance degrades with large inventories (>10k items). Need to optimize queries."}

Got it! Generating complete intake documents...
```

### Step 8: Generate Complete Intake Documents

Create three intake files documenting the existing system.

**Output Files**:
1. `.aiwg/intake/project-intake.md` - Comprehensive project documentation
2. `.aiwg/intake/solution-profile.md` - Current profile and maturity level
3. `.aiwg/intake/option-matrix.md` - Modernization/improvement options

#### Generated: project-intake.md

```markdown
# Project Intake Form (Existing System)

**Document Type**: Brownfield System Documentation
**Generated**: {current date}
**Source**: Codebase analysis of {directory}

## Metadata

- Project name: {extracted from git/package.json}
- Repository: {git remote URL}
- Current Version: {package.json version or git tag}
- Last Updated: {git log date}
- Stakeholders: {inferred: Engineering Team, Product, Operations}

## System Overview

**Purpose**: {from user questions or README}
**Current Status**: Production (launched {date from git history or user})
**Users**: {from user or "Unknown"}
**Tech Stack**:
- Languages: {detected languages with percentages}
- Frontend: {detected frameworks}
- Backend: {detected frameworks}
- Database: {detected from docker-compose, connection strings}
- Deployment: {Docker/Cloud provider detected}

## Problem and Outcomes (Historical)

**Problem Statement**: {from user or README}
**Target Personas**: {from user or inferred from UI/API design}
**Success Metrics**: {from user or inferred}
  - User adoption: {current count}
  - System uptime: {inferred from monitoring}
  - Performance: {inferred from optimization patterns}

## Current Scope and Features

**Core Features** (from codebase analysis):
{list features by analyzing routes, components, models}
- User Authentication & Authorization ({roles detected})
- {Feature 1 from API endpoints}
- {Feature 2 from models}
- {Feature 3 from components}

**Recent Additions** (last 6 months from git log):
{list recent feature branches or commit messages}

**Planned/In Progress** (from feature branches):
{list open feature branches}

## Architecture (Current State)

**Architecture Style**: {Monolith | Microservices | Serverless}
**Components**:
{from analysis step 2}

**Data Models**: {count} primary entities
{list key models: User, Order, Product, etc.}

**Integration Points**:
{from grep analysis of external APIs}

## Scale and Performance (Current)

**Current Capacity**: {inferred from scale analysis}
**Active Users**: {from user or "Estimated: X based on capacity indicators"}
**Performance Characteristics**:
- Response time: {inferred from optimization patterns}
- Throughput: {inferred}
- Availability: {inferred}

**Performance Optimizations Present**:
{list detected patterns: caching, indexing, async, queuing}

**Bottlenecks/Pain Points**:
{from user questions or code comments like TODO, FIXME}

## Security and Compliance (Current)

**Security Posture**: {Minimal | Baseline | Strong | Enterprise}
**Data Classification**: {Public | Internal | Confidential | Restricted}

**Security Controls**:
- Authentication: {detected mechanism}
- Authorization: {RBAC, ABAC, etc.}
- Data Protection: {encryption detected or not}
- Secrets Management: {environment variables, vault, etc.}

**Compliance Requirements**:
{from detected patterns or user questions}
- GDPR: {Yes/No - evidence: consent, deletion endpoints}
- PCI-DSS: {Yes/No - evidence: payment tokenization}
- HIPAA: {Yes/No - evidence: audit logs, PHI handling}

## Team and Operations (Current)

**Team Size**: {inferred from git contributors}
**Active Contributors**: {count from last 6 months}
**Development Velocity**: {commits per month average}

**Process Maturity**:
- Version Control: {Git flow, GitHub flow, etc.}
- Code Review: {detected from PR requirements}
- Testing: {coverage percentage if available}
- CI/CD: {pipeline detected: GitHub Actions, GitLab CI, etc.}
- Documentation: {README, API docs, runbooks present/missing}

**Operational Support**:
- Monitoring: {detected: Sentry, Datadog, etc. or "None detected"}
- Logging: {detected: Winston, Bunyan, etc.}
- Alerting: {detected or "None detected"}
- On-call: {unknown - mark for clarification}

## Dependencies and Infrastructure

**Third-Party Services**:
{from package.json, requirements.txt analysis}

**Infrastructure**:
- Hosting: {Cloud provider detected or "Unknown"}
- Deployment: {Docker, Kubernetes, PaaS}
- Database: {PostgreSQL, MongoDB, etc.}
- Caching: {Redis, Memcached, or "None"}
- Message Queue: {RabbitMQ, SQS, or "None"}

## Known Issues and Technical Debt

**Performance Issues**:
{from user questions or FIXME comments}

**Security Gaps**:
{from analysis - missing SAST, outdated dependencies, etc.}

**Technical Debt**:
{from TODO comments, deprecated dependencies, test coverage gaps}

**Modernization Opportunities**:
{from outdated versions, missing best practices}

## Why This Intake Now?

**Context**: {from user: compliance, handoff, refactoring, process adoption}

**Goals**:
{inferred from context}
- Establish SDLC baseline for existing system
- Document for compliance/audit
- Plan modernization roadmap
- Support team handoff/onboarding

## Attachments

- Solution profile: link to `solution-profile.md`
- Option matrix: link to `option-matrix.md`
- Codebase location: `{directory path}`
- Repository: `{git remote URL}`

## Next Steps

**Your intake documents are now complete and ready for the next phase!**

1. **Review** generated intake documents for accuracy
2. **Fill any gaps** marked as "Unknown" or "Clarify" (if any)
3. **Choose improvement path** from option-matrix.md:
   - Maintain as-is with SDLC process adoption
   - Incremental modernization
   - Major refactoring/rewrite
4. **Start appropriate SDLC flow** using natural language or explicit commands:
   - For new SDLC adoption: "Start Inception" or `/flow-concept-to-inception .`
   - For maintenance/iterations: "Run iteration 1" or `/flow-iteration-dual-track 1`
   - For architecture changes: "Evolve architecture" or `flow-architecture-evolution`

**Note**: You do NOT need to run `intake-start` - that command is only for teams who manually created their own intake documents. The `intake-from-codebase` command produces validated intake ready for immediate use
```

#### Generated: solution-profile.md

```markdown
# Solution Profile (Current System)

**Document Type**: Existing System Profile
**Generated**: {current date}

## Current Profile

**Profile**: {Production | Enterprise}

**Selection Rationale**:
{based on evidence}
- System Status: Production with {X} active users
- Compliance: {GDPR/PCI-DSS/etc.} requirements present
- Team Size: {count} developers
- Process Maturity: {High/Medium/Low}

**Actual**: Production (in production, established users, compliance requirements)

## Current State Characteristics

### Security
- **Posture**: {Minimal | Baseline | Strong | Enterprise}
- **Controls Present**: {list from analysis}
- **Gaps**: {list missing controls}
- **Recommendation**: {upgrade security level if gaps found}

### Reliability
- **Current SLOs**: {if monitoring detected}
  - Availability: {percentage or "Not monitored"}
  - Latency: {p95/p99 or "Not measured"}
  - Error Rate: {percentage or "Not tracked"}
- **Monitoring Maturity**: {metrics, logs, traces, alerting}
- **Recommendation**: {improve observability if gaps}

### Testing & Quality
- **Test Coverage**: {percentage if available}
- **Test Types**: {unit, integration, e2e detected}
- **Quality Gates**: {CI checks, linting, security scans}
- **Recommendation**: {target coverage improvement}

### Process Rigor
- **SDLC Adoption**: {None/Partial/Full}
- **Code Review**: {Present/Missing}
- **Documentation**: {Comprehensive/Basic/Minimal}
- **Recommendation**: {adopt SDLC framework, improve docs}

## Recommended Profile Adjustments

**Current Profile**: {detected}
**Recommended Profile**: {suggested based on gaps}

**Rationale**:
{explain why upgrade recommended}
- Security gaps require {Strong} profile controls
- Compliance requirements mandate {Enterprise} rigor
- Scale demands {Production} reliability standards

**Tailoring Notes**:
- Keep lightweight process (small team)
- Add security controls (compliance requirement)
- Implement observability (production system)

## Improvement Roadmap

**Phase 1 (Immediate - 1 month)**:
{critical gaps to fill}
- Add security scanning (SAST/DAST)
- Implement monitoring and alerting
- Create runbooks for common issues

**Phase 2 (Short-term - 3 months)**:
{important improvements}
- Increase test coverage to {target}%
- Document architecture (SAD)
- Adopt SDLC framework (dual-track iterations)

**Phase 3 (Long-term - 6-12 months)**:
{strategic improvements}
- Performance optimization (address bottlenecks)
- Architecture modernization (if needed)
- Compliance certification (SOC2, ISO27001)
```

#### Generated: option-matrix.md

Follow the template structure from `agentic/code/frameworks/sdlc-complete/templates/intake/option-matrix-template.md`:

**Key Principles**:
1. **Descriptive, not prescriptive** - Capture what IS (project reality), not what should be (analysis)
2. **Natural language** - Use descriptive project types ("personal blog, <100 readers" vs "Prototype profile")
3. **Intent-driven** - Focus interactive questions (6-8 of 10) on priorities, trade-offs, decisions, evolution
4. **Framework mapping** - Map project reality to relevant templates/commands/agents/rigor levels

```markdown
# Option Matrix (Project Context & Intent)

**Purpose**: Capture what this project IS - its nature, audience, constraints, and intent - to determine appropriate SDLC framework application (templates, commands, agents, rigor levels).

**Generated**: {current date} (from codebase analysis)

## Step 1: Project Reality

### What IS This Project?

**Project Description** (in natural language):
```
{Describe in 2-3 sentences based on codebase analysis and user guidance:}

Examples:
- "Documentation framework and SDLC toolkit (60 agents, 40 commands), 474 markdown files, GitHub-hosted open source (MIT), 0 users (pre-launch), solo developer (30 years system engineering), expects multiple refactors for multi-platform evolution"
- "B2B inventory tracking app for 5 warehouse staff, critical to daily operations, Node.js + PostgreSQL on local server, 50k SKUs, used 8hrs/day, 2 part-time developers, moderate technical debt limiting new features"
- "Personal portfolio site for job applications, 10-20 visitors/month expected, static HTML/CSS on GitHub Pages, solo project, need to ship in 2 weeks"
```

### Audience & Scale

**Who uses this?** (check all from analysis)
- {[x] if detected} Just me (personal project) - {evidence: solo git contributor, guidance}
- {[x] if detected} Small team (2-10 people, known individuals) - {evidence: warehouse staff, internal tool}
- {[x] if detected} Department (10-100 people, organization-internal)
- {[x] if detected} External customers (100-10k users, paying or free) - {evidence: payment integration, multi-tenancy}
- {[x] if detected} Large scale (10k-100k+ users, public-facing) - {evidence: load balancing, sharding}
- {[ ] if unknown} Other: `___ (mark for interactive question)`

**Audience Characteristics**:
- Technical sophistication: `{Non-technical | Mixed | Technical}` - {inferred from UI complexity, API design}
- User risk tolerance: `{Experimental OK | Expects stability | Zero-tolerance}` - {inferred from SLA, criticality}
- Support expectations: `{Self-service | Best-effort | SLA | 24/7}` - {detected from runbooks, on-call patterns}

**Usage Scale** (current or projected from analysis):
- Active users: `{count} (daily/weekly/monthly)` - {from guidance or "mark for question"}
- Request volume: `{count} requests/min` or `N/A (batch/cron/manual use)` - {from scale analysis}
- Data volume: `{size} GB/TB` or `N/A (stateless/small)` - {from database size, S3 usage}
- Geographic distribution: `{Single location | Regional | Multi-region | Global}` - {from deployment, CDN}

### Deployment & Infrastructure

**Expected Deployment Model** (what will this become? - inferred from codebase):
- {[x] if detected} Client-only (desktop app, mobile app, CLI tool, browser extension) - {detect from: Electron config, React Native, mobile directories, manifest.json for extensions, CLI scripts}
- {[x] if detected} Static site (HTML/CSS/JS, no backend, hosted files) - {detect from: only HTML/CSS/JS, no server code, static site generator config (11ty, Hugo, Jekyll), Netlify/Vercel/GitHub Pages deploy config}
- {[x] if detected} Client-server (SPA + API backend, traditional web app with database) - {detect from: React/Vue/Angular + Express/Django/Rails, single database, traditional MVC structure}
- {[x] if detected} Full-stack application (frontend + backend + database + supporting services) - {detect from: multiple services (API, workers, cron jobs), message queues, caching layer, multiple data stores}
- {[x] if detected} Multi-system (multiple services, microservices, service mesh, distributed) - {detect from: multiple services/, docker-compose with >3 services, Kubernetes manifests, service discovery (Consul, Eureka), API gateway}
- {[x] if detected} Distributed application (edge computing, P2P, blockchain, federated) - {detect from: WebRTC, IPFS, blockchain SDKs, edge function configs (Cloudflare Workers, Lambda@Edge), peer-to-peer protocols}
- {[x] if detected} Embedded/IoT (device firmware, embedded systems, hardware integration) - {detect from: Arduino/PlatformIO config, embedded C/C++, hardware abstraction layers, serial communication, sensor integration}
- {[x] if detected} Hybrid (multiple deployment patterns, e.g., mobile app + cloud backend) - {detect from: combination of above indicators}
- {[ ] if unclear} Other: `___ (mark for interactive question)`

**Where does this run?** (from infrastructure analysis):
- {[x] if detected} Local only (laptop, desktop, not deployed) - {no Dockerfile, no CI/CD, no deployment scripts}
- {[x] if detected} Personal hosting (VPS, shared hosting, home server) - {simple deployment scripts, SSH deploy, rsync patterns}
- {[x] if detected} Cloud platform (AWS, GCP, Azure, Vercel, Netlify, GitHub Pages) - {detected from terraform/, AWS SDK, gcloud config, azure-pipelines.yml, vercel.json, netlify.toml, GitHub Actions with pages deploy}
- {[x] if detected} On-premise (company servers, data center) - {from guidance or local server evidence, ansible playbooks, chef/puppet configs}
- {[x] if detected} Hybrid (cloud + on-premise, multi-cloud) - {multiple cloud providers detected, hybrid architecture indicators}
- {[x] if detected} Edge/CDN (distributed, geographically distributed) - {Cloudflare Workers, Lambda@Edge, CDN configs}
- {[x] if detected} Mobile (iOS, Android, native or cross-platform) - {Xcode project, Android Studio, React Native, Flutter, Ionic}
- {[x] if detected} Desktop (Windows, macOS, Linux executables) - {Electron, .NET, Qt, PyInstaller, pkg configs}
- {[x] if detected} Browser (extension, PWA, web app) - {manifest.json for extensions, service-worker.js for PWA, web app manifest}
- {[ ] if unclear} Other: `___ (mark for interactive question)`

**Infrastructure Complexity**:
- Deployment type: `{Static site | Single server | Multi-tier | Microservices | Serverless | Container orchestration}` - {from architecture analysis: static HTML, single Dockerfile, docker-compose with tiers, services/ directory, Lambda functions, kubernetes/}
- Data persistence: `{None (stateless) | Client-side only | File system | Single database | Multiple data stores | Distributed database}` - {from dependencies: no DB libs, localStorage/IndexedDB, file I/O, single DB connection, multiple DBs (PostgreSQL + Redis + Elasticsearch), Cassandra/MongoDB sharding}
- External dependencies: `{count} third-party services (0 = none, 1-3 = few, 4-10 = moderate, 10+ = many)` - {from API integrations detected: Stripe, SendGrid, Twilio, AWS services, etc.}
- Network topology: `{Standalone | Client-server | Multi-tier | Peer-to-peer | Mesh | Hybrid}` - {from architecture: single process, client + server, frontend + API + DB + workers, WebRTC/P2P, service mesh (Istio, Linkerd), combination}

### Technical Complexity

**Codebase Characteristics** (from analysis):
- Size: `{<1k | 1k-10k | 10k-100k | 100k+} LoC` - {from cloc or file count estimate}
- Languages: `{primary}, {secondary if any}` - {from file extensions, percentages}
- Architecture: `{Single script | Simple app | Modular | Multi-service | Complex distributed}` - {from step 2 analysis}
- Team familiarity: `{Greenfield | Brownfield | Legacy}` - {from git history, tech debt indicators}

**Technical Risk Factors** (check all from security/performance analysis):
- {[x] if detected} Performance-sensitive (latency, throughput critical) - {caching, optimization patterns}
- {[x] if detected} Security-sensitive (PII, payments, authentication) - {JWT, encryption, compliance indicators}
- {[x] if detected} Data integrity-critical (financial, medical, legal records) - {transaction patterns, audit logs}
- {[x] if detected} High concurrency (many simultaneous users/processes) - {connection pooling, queue workers}
- {[x] if detected} Complex business logic (many edge cases, domain rules) - {code complexity, conditional density}
- {[x] if detected} Integration-heavy (many external systems, APIs, protocols) - {3+ external services}
- {[ ] if none} None (straightforward technical requirements)

---

## Step 2: Constraints & Context

### Resources

**Team** (from git analysis):
- Size: `{count} developers, {count} designers, {count} other roles` - {from contributors, guidance}
- Experience: `{Junior | Mid | Senior | Mixed}` - {inferred from code quality, patterns}
- Availability: `{Full-time | Part-time | Volunteer/hobby | Contracting}` - {from commit patterns, guidance}

**Budget** (from guidance and infrastructure):
- Development: `{Unconstrained | Moderate | Tight | Zero (volunteer/personal)}` - {from team size, guidance}
- Infrastructure: `${amount}/month` or `{Free tier | Cost-conscious | Scalable budget}` - {from cloud usage}
- Timeline: `{weeks/months to milestone}` or `{No deadline | Flexible | Fixed}` - {from guidance, urgency indicators}

### Regulatory & Compliance

**Data Sensitivity** (check all from security analysis):
- {[x] if no PII} Public data only (no privacy concerns)
- {[x] if detected} User-provided content (email, profile, preferences)
- {[x] if detected} Personally Identifiable Information (PII: name, address, phone)
- {[x] if detected} Payment information (credit cards, financial accounts) - {Stripe, payment processors}
- {[x] if detected} Protected Health Information (PHI: medical records) - {HIPAA indicators}
- {[x] if detected} Sensitive business data (trade secrets, confidential)

**Regulatory Requirements** (check all from compliance analysis + guidance):
- {[x] if no indicators} None (no specific regulations)
- {[x] if detected} GDPR (EU users, data privacy) - {consent, deletion endpoints}
- {[x] if detected} CCPA (California users, data privacy)
- {[x] if detected} HIPAA (US healthcare) - {PHI, audit logs}
- {[x] if detected} PCI-DSS (payment card processing) - {payment tokenization}
- {[x] if detected} SOX (US financial reporting)
- {[x] if detected} FedRAMP (US government cloud)
- {[x] if detected} ISO27001 (information security management)
- {[x] if detected} SOC2 (service organization controls) - {from guidance}

**Contractual Obligations** (from guidance and evidence):
- {[x] if no evidence} None (no contracts)
- {[x] if detected} SLA commitments (uptime, response time guarantees) - {SLO monitoring, runbooks}
- {[x] if detected} Security requirements (penetration testing, audits) - {from guidance, customer contracts}
- {[x] if detected} Compliance certifications (SOC2, ISO27001, etc.) - {from guidance}
- {[x] if detected} Data residency (data must stay in specific regions) - {multi-region deployment}
- {[x] if detected} Right to audit (customers can audit code/infrastructure)

### Technical Context

**Current State** (for existing projects):
- Current stage: `{Concept | Prototype | Early users | Established | Mature | Legacy}` - {from user count, versioning}
- Test coverage: `{percent}%` or `{None | Manual only | Automated (partial) | Comprehensive}` - {from CI, test files}
- Documentation: `{None | README only | Basic | Comprehensive}` - {from docs/ directory, README quality}
- Deployment automation: `{Manual | Scripted | CI/CD (basic) | CI/CD (full pipeline)}` - {from .github/workflows/}

**Technical Debt** (for existing projects):
- Severity: `{None | Minor | Moderate | Significant}` - {from TODO/FIXME count, guidance}
- Type: `{Code quality | Architecture | Dependencies | Performance | Security | Tests | Documentation}` - {from analysis}
- Priority: `{Can wait | Should address | Must address | Blocking}` - {from guidance, pain points}

---

## Step 3: Priorities & Trade-offs

**INTERACTIVE SECTION** - Allocate 6-8 of 10 questions here. This captures intent and trade-offs - the most nuanced information.

### What Matters Most?

**Rank these priorities** (1 = most important, 4 = least important):
- `___` Speed to delivery (launch fast, iterate quickly)
- `___` Cost efficiency (minimize time/money spent)
- `___` Quality & security (build it right, avoid issues)
- `___` Reliability & scale (handle growth, stay available)

**Interactive Questions (Priority Deep Dive - ask 2-3)**:
1. "You ranked {criterion} as highest priority. Can you expand on why? What would failure look like?"
2. "You're willing to sacrifice {aspect}. What's your threshold? At what point would you revisit that trade-off?"
3. "You mentioned {non-negotiable from guidance}. What's the consequence if we compromise on that? Is there flexibility?"

**Priority Weights** (must sum to 1.0, derived from ranking + questions):

| Criterion | Weight | Rationale |
|-----------|--------|-----------|
| **Delivery speed** | `{0.10-0.50}` | {Based on answers: time-to-market pressure, learning goals, competitive urgency} |
| **Cost efficiency** | `{0.10-0.40}` | {Based on answers: budget constraints, resource limitations, opportunity cost} |
| **Quality/security** | `{0.10-0.50}` | {Based on answers: user trust, data sensitivity, regulatory requirements, reputation} |
| **Reliability/scale** | `{0.10-0.40}` | {Based on answers: user base size, uptime needs, performance expectations, growth plans} |
| **TOTAL** | **1.00** | ← Must sum to 1.0 |

### Trade-off Context

**What are you optimizing for?** (in your own words - from answers):
```
{Capture user's actual words from question responses}

Example: "Need to validate assumptions with user testing in 2-4 weeks before investing in architectural refactor. Speed critical now, can add structure later if validated."
```

**What are you willing to sacrifice?** (be explicit - from answers):
```
{Capture explicit trade-offs mentioned}

Example: "Skip comprehensive tests initially (30% coverage OK), add post-MVP if user testing validates need. Manual deployment acceptable short-term."
```

**What is non-negotiable?** (constraints that override trade-offs - from answers):
```
{Capture absolute constraints}

Example: "Zero dependencies (maintainability critical). Open source from day one (community transparency core value)."
```

---

## Step 4: Intent & Decision Context

**INTERACTIVE SECTION** - Allocate 2-3 of 10 questions here.

### Why This Intake Now?

**What triggered this intake?** (check all from guidance + ask):
- {[x] if applicable} Starting new project (need to plan approach)
- {[x] if applicable} Documenting existing project (never had formal intake)
- {[x] if applicable} Preparing for scale/growth (need more structure) - {from guidance: "small team testing planned"}
- {[x] if applicable} Compliance requirement (audit, certification, customer demand) - {from guidance}
- {[x] if applicable} Team expansion (onboarding new members, need clarity)
- {[x] if applicable} Technical pivot (major refactor, platform change) - {from guidance: "multiple refactors expected"}
- {[x] if applicable} Handoff/transition (new maintainer, acquisition, open-sourcing)
- {[x] if applicable} Funding/business milestone (investor due diligence, enterprise sales)

**Interactive Questions (Decision Context - ask 2-3)**:
4. "What specific decisions are you trying to make with this intake? What's blocking you?"
5. "You mentioned {controversy/disagreement from guidance}. What are the different perspectives? What data would resolve it?"
6. "What's the biggest risk you see in this project? How does that influence your priorities?"

**What decisions need making?** (be specific - from answers):
```
{Capture actual decisions user needs to make}

Example: "Should we invest in MVP process infrastructure (tests, versioning, telemetry) now, or ship as Prototype and iterate? Team capacity limited (solo), but user testing needs stability."
```

**What's uncertain or controversial?** (surface disagreements - from answers):
```
{Capture uncertainties and disagreements}

Example: "Unsure if multi-platform abstraction is needed immediately, or if current file-based deployment (`.claude/` directories) is sufficient. Won't know until user testing validates demand."
```

**Success criteria for this intake process** (from answers):
```
{What would make this intake valuable?}

Example: "Clear framework recommendation (which templates/commands/agents to use for project type). Shared understanding of quality vs. speed trade-offs. Roadmap for evolving process as we grow."
```

---

## Step 5: Framework Application

**INTERACTIVE SECTION** - Allocate 1-2 of 10 questions here.

### Relevant SDLC Components

Based on project reality (Step 1) and priorities (Step 3), which framework components are relevant?

**Templates** (check applicable based on analysis):
- [x] Intake (project-intake, solution-profile, option-matrix) - **Always include**
- {[x] if} Requirements (user-stories, use-cases, NFRs) - Include if: `{complex domain detected, multiple stakeholders, team >2}`
- {[x] if} Architecture (SAD, ADRs, API contracts) - Include if: `{multi-service, 10k+ LoC, team >3}`
- {[x] if} Test (test-strategy, test-plan, test-cases) - Include if: `{quality-critical, >1 developer, regulated, PII}`
- {[x] if} Security (threat-model, security-requirements) - Include if: `{PII, payments, compliance, external users}`
- {[x] if} Deployment (deployment-plan, runbook, ORR) - Include if: `{production, >10 users, SLA detected}`
- {[x] if} Governance (decision-log, CCB-minutes, RACI) - Include if: `{team >5, stakeholders >3, compliance}`

**Commands** (check applicable):
- [x] Intake commands (intake-wizard, intake-from-codebase, intake-start) - **Always include**
- {[x] if} Flow commands (iteration, discovery, delivery) - Include if: `{ongoing development, team >2}`
- {[x] if} Quality gates (security-gate, gate-check, traceability) - Include if: `{regulated, team >3, enterprise customers}`
- {[x] if} Specialized (build-poc, pr-review, troubleshooting-guide) - Include if: `{specific needs from guidance}`

**Agents** (check applicable):
- {[x] if} Core SDLC agents (requirements-analyst, architect, code-reviewer, test-engineer, devops) - Include if: `{team >1, structured process}`
- {[x] if} Security specialists (security-gatekeeper, security-auditor) - Include if: `{PII, compliance, external users}`
- {[x] if} Operations specialists (incident-responder, reliability-engineer) - Include if: `{production, SLA, >100 users}`
- {[x] if} Enterprise specialists (legal-liaison, compliance-validator, privacy-officer) - Include if: `{regulated, contracts, large org}`

**Process Rigor Level** (select based on evidence):
- {[x] if} Minimal (README, lightweight notes, ad-hoc) - For: `{solo, learning, <10 users, prototype}`
- {[x] if} Moderate (user stories, basic architecture, test plan, runbook) - For: `{small team, <1k users, established}`
- {[x] if} Full (comprehensive docs, traceability, gates) - For: `{large team, >1k users, regulated, mission-critical}`
- {[x] if} Enterprise (audit trails, compliance evidence, change control) - For: `{regulated, contracts, >10k users}`

**Interactive Questions (Framework Application - ask 1-2)**:
9. "Looking at the templates/commands/agents list above, which ones feel like overkill for your project? Which feel essential?"
10. "Where do you want to over-invest relative to typical {project type}? Where can you be lean?"

### Rationale for Framework Choices

**Why this subset of framework?** (based on analysis + answers):
```
{Explain which components are relevant and why}

Example:
"Documentation framework (solo, 0 users, pre-MVP) needs minimal rigor:
- Intake only (understand baseline, plan evolution)
- Skip requirements templates (clear vision, solo developer)
- Skip comprehensive architecture docs (expecting refactors, will document post-stabilization)
- Skip security templates (no PII, documentation project, open source)
- Add writing-validator agent (content quality is product value)
- Add smoke tests (prevent regression during expected refactors)

Relevant: intake-wizard, writing-validator, prompt-optimizer, code-reviewer (for Node.js utilities)"
```

**What we're skipping and why** (be explicit):
```
{List unused framework components with justification}

Example:
"Skipping enterprise templates because:
- No regulatory requirements (open source, no PII, MIT license)
- No team coordination needs (solo developer, may add 2-3 for testing)
- No compliance obligations (no customer data, no contracts)
- No operational complexity (static content on GitHub, no backend)

Will revisit if: user testing validates market fit, team expands >3 people, commercial version emerges, enterprise customers request compliance."
```

---

## Step 6: Evolution & Adaptation

**INTERACTIVE SECTION** - Allocate 1-2 of 10 questions here.

### Expected Changes

**How might this project evolve?** (from guidance + questions):
- {[x] if} No planned changes (stable scope and scale)
- {[x] if} User base growth (when: `{timeline}`, trigger: `{event}`) - {from guidance or questions}
- {[x] if} Feature expansion (when: `{timeline}`, trigger: `{event}`)
- {[x] if} Team expansion (when: `{timeline}`, trigger: `{event}`) - {from guidance: "small team testing"}
- {[x] if} Commercial/monetization (when: `{timeline}`, trigger: `{event}`)
- {[x] if} Compliance requirements (when: `{timeline}`, trigger: `{event}`)
- {[x] if} Technical pivot (when: `{timeline}`, trigger: `{event}`) - {from guidance: "multiple refactors"}

**Interactive Questions (Evolution - ask 1-2)**:
7. "How do you expect this project to change in the next 6-12 months? What would trigger more structure?"
8. "If you had 10x the users/budget/team, what would you do differently? What's the growth limiting factor?"

**Adaptation Triggers** (when to revisit framework application - from answers):
```
{What events would require more structure?}

Example:
"Add requirements docs when 2nd developer joins (need shared understanding of multi-platform vision).
Add security templates if we handle user accounts (PII would require threat model, GDPR compliance).
Add deployment runbook when we exceed 1k CLI installations (operational complexity, user support needs).
Add governance templates when team exceeds 5 people (coordination overhead, decision tracking)."
```

**Planned Framework Evolution** (from answers):
- Current: `{list current framework components from Step 5}`
- 3 months: `{add/change if growth occurs}` - {from evolution questions}
- 6 months: `{add/change if assumptions validated}` - {from evolution questions}
- 12 months: `{add/change if scale/complexity increases}` - {from evolution questions}

---

## Notes for Generation

### Interactive Question Allocation (6-8 of 10)

**Options Matrix gets majority of questions** (6-8 total):
- **Priority questions (2-3)**: Deep dive on trade-offs, thresholds, non-negotiables
- **Decision context (2-3)**: Surface disagreements, blockers, risks
- **Evolution (1-2)**: Growth triggers, 10x scenarios
- **Framework application (1-2)**: Overkill vs essential, over-invest vs lean

**Other files get remainder** (2-4 total):
- **project-intake.md (1-2)**: "What problem does this solve?" (if not clear), "Success metrics?" (if not documented)
- **solution-profile.md (1-2)**: "Current pain points?" (technical debt, bottlenecks), "Wish invested in earlier?" (for existing projects)
- **Factual gaps (0-2)**: Tech stack, deployment, team size (if not detectable from codebase)

### Principle: Descriptive, Not Prescriptive

**This document captures "what IS"** (project reality, constraints, intent):
- ✅ "Personal blog, <100 readers, solo, need to ship in 2 weeks for job search"
- ✅ "Team split on microservices vs monolith - CTO wants flexibility, CEO wants simplicity"
- ✅ "Willing to skip tests initially to launch fast, but non-negotiable on GDPR compliance"

**Analysis and recommendations go elsewhere**:
- ❌ "Should use MVP profile because small team and limited budget" → Goes in **solution-profile.md**
- ❌ "Microservices inappropriate for this scale, recommend monolith" → Goes in **project-intake.md** (architecture section)
- ❌ "Need to add automated tests immediately" → Goes in **solution-profile.md** (improvement roadmap)

This option-matrix is **input** to analysis (capture reality), not **output** of analysis (prescribe solution).
```

### Step 9: Generate Analysis Report

**Output**: Codebase analysis report
```markdown
# Codebase Analysis Report

**Project**: {detected name}
**Directory**: {scanned directory}
**Generated**: {current date}
**Analysis Duration**: {time taken}

## Summary

**Files Analyzed**: {count}
**Languages Detected**: {list with percentages}
**Architecture**: {detected style}
**Current Profile**: {Production | Enterprise}
**Team Size**: {estimated from contributors}

## Evidence-Based Inferences

**Confident** (strong evidence from code):
{list inferences with high confidence}
- Tech stack: React + Node.js + PostgreSQL (package.json, imports)
- Scale: 1k-5k users (Redis caching, connection pooling)
- Security: Baseline (JWT, bcrypt, env vars)
- Compliance: GDPR required (consent management, deletion endpoints)

**Inferred** (reasonable assumptions from patterns):
{list inferences with medium confidence}
- Team size: 2-3 developers (3 active committers)
- Process maturity: Medium (PR reviews, CI/CD present)
- Business model: B2B SaaS (pricing tiers, subscription patterns detected)

**Clarified by User** (from interactive questions):
{list information provided by user}
- Business problem: B2B inventory management for warehouses
- Active users: 12 companies, 150 total users
- Pain points: Performance degradation with large inventories

**Unknown** (insufficient evidence, marked for follow-up):
{list gaps to clarify}
- Production hosting environment (AWS? GCP? on-prem?)
- Monitoring/alerting tools (not detected in codebase)
- Support model (on-call rotation, SLA commitments)

## Confidence Levels

- **High Confidence**: {count} inferences (direct code evidence)
- **Medium Confidence**: {count} inferences (patterns and conventions)
- **Low Confidence**: {count} inferences (marked for user validation)
- **Unknown**: {count} gaps (need clarification)

## Quality Assessment

**Strengths**:
{from analysis}
- Well-structured codebase (clear separation of concerns)
- Good test coverage ({percentage}%)
- Modern CI/CD pipeline
- Security best practices (JWT, encryption)

**Weaknesses**:
{from analysis}
- Missing runbooks (operational gap)
- No APM/observability (monitoring gap)
- Technical debt: {issues from TODO/FIXME comments}
- Outdated dependencies: {count} packages behind

## Recommendations

1. **Immediate**: {critical gaps to fill}
2. **Short-term**: {important improvements}
3. **Long-term**: {strategic changes}

## Files Generated

✓ .aiwg/intake/project-intake.md (comprehensive system documentation)
✓ .aiwg/intake/solution-profile.md (current profile and improvement roadmap)
✓ .aiwg/intake/option-matrix.md (improvement options with scoring)

## Next Steps

**Your intake documents are now complete and ready for the next phase!**

1. **Review** generated intake documents for accuracy
2. **Fill any gaps** marked as "Unknown" or "Clarify" (if any)
3. **Choose improvement path** from option-matrix.md
4. **Start appropriate SDLC flow** using natural language or explicit commands:
   - For new SDLC adoption: "Start Inception" or `/flow-concept-to-inception .`
   - For maintenance/iterations: "Run iteration 1" or `/flow-iteration-dual-track 1`
   - For architecture changes: "Evolve architecture" or `flow-architecture-evolution`

**Note**: You do NOT need to run `intake-start` - that command is only for teams who manually created their own intake documents
```

## Success Criteria

This command succeeds when:
- [ ] Codebase successfully scanned and analyzed
- [ ] Three complete intake files generated (project-intake, solution-profile, option-matrix)
- [ ] All detectable information extracted from code
- [ ] Unknowns explicitly marked for follow-up
- [ ] Confidence levels indicated for inferences
- [ ] If interactive: ≤10 questions asked, focused on gaps
- [ ] Generated intake ready for SDLC process adoption

## Error Handling

**No Git Repository**:
- Report: "No .git directory found. Analyzing as standalone codebase."
- Action: Continue analysis without git history data
- Impact: Cannot infer team size, velocity, or version history

**Empty or Invalid Directory**:
- Report: "Directory {path} is empty or contains no source files"
- Action: "Please provide path to root of codebase"
- Exit with error

**Access Denied**:
- Report: "Cannot read files in {path}. Permission denied."
- Action: "Check file permissions or run with appropriate access"
- Exit with error

**Multiple Languages/Frameworks**:
- Report: "Detected multiple tech stacks (e.g., React + Django + Go)"
- Action: "Analyzing as polyglot/microservices architecture"
- Impact: May need additional clarification questions

**Insufficient Evidence for Critical Fields**:
- Report: "Cannot determine {field} from codebase"
- Action (if --interactive): Ask clarification question
- Action (if not interactive): Mark as "Unknown - requires clarification"

## Star the Repository

After successfully generating all intake documents, offer the user an opportunity to star the repository:

**Prompt**:
```
The AIWG is an open-source project that helps improve AI-generated content.
If you found this helpful, would you like to star the repository on GitHub?

Options:
- Yes, star the repo
- No thanks
```

**If user selects "Yes, star the repo"**:

1. Check if `gh` CLI is available:
   ```bash
   which gh
   ```

2. If `gh` is available, attempt to star:
   ```bash
   gh api -X PUT /user/starred/jmagly/ai-writing-guide
   ```
   - If successful: "⭐ Thank you for starring the AIWG! Your support helps the project grow."
   - If fails: "Could not star via gh CLI. You can star manually at: https://github.com/jmagly/aiwg"

3. If `gh` is not available:
   ```
   GitHub CLI (gh) not found. You can star the repository at:
   https://github.com/jmagly/aiwg
   ```

**If user selects "No thanks"**:
```
No problem! Thanks for using the AIWG.
```

## References

- Intake templates: `agentic/code/frameworks/sdlc-complete/templates/.aiwg/intake/`
- SDLC flows: `commands/flow-*.md`
- Architecture evolution: `commands/flow-architecture-evolution.md`
- Iteration workflow: `commands/flow-iteration-dual-track.md`
