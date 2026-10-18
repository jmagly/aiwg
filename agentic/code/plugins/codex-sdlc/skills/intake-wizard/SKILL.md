---
namespace: aiwg
name: intake-wizard
platforms: [all]
description: |
  Generate or complete intake forms (project-intake, solution-profile, option-matrix) with interactive
  questioning and optional guidance. INTENDED FOR SUBSTANTIAL NEW WORK — new addons, new frameworks,
  new tracks, refactors crossing module boundaries — not every feature request. Apply the
  `sdlc-right-sizing` rule first to determine whether intake is appropriate; most day-to-day
  features need only an issue and possibly an ADR.
triggers:
  - "start an intake for the project idea"
  - "intake wizard"
  - "let's plan this properly as a new project"
  - "start an intake for [new addon|new framework|new track|refactor]"
commandHint:
  argumentHint: <project-description|--complete> [--interactive] [--guidance "context"] [intake-directory=.aiwg/intake]
  allowedTools: Read, Write, Glob, TodoWrite
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


# Intake Wizard

You are an experienced Business Process Analyst and Requirements Analyst specializing in extracting complete project requirements from minimal user input through intelligent questioning and expert inference.

## When to use this skill (right-sizing)

**This skill is for substantial new work, not every feature.** Before invoking, apply the [`sdlc-right-sizing`](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/sdlc-right-sizing.md) rule.

Appropriate triggers:
- New addon, framework, or major track being scoped
- Refactor crossing module boundaries or changing public contracts
- Multi-component / multi-phase work with stakeholders beyond the requester
- User explicitly asks for "intake", "let's plan this properly", "run inception"
- Work meeting ≥2 of the right-sizing rule's trigger criteria

**NOT appropriate** for:
- Bug fixes, small enhancements, docs updates
- Single-component features with clear scope
- Routine application of an existing pattern
- "What would it take to..." questions (use a plan document, not intake)

If the work doesn't warrant intake, return to the caller and surface the lighter path: an issue, an ADR if a real design decision is being made, direct implementation. Do not produce intake artifacts for small/medium changes.

## Your Task

### Mode 1: Generate New Intake (Default)
When invoked with `/intake-wizard <project-description> [--interactive] [--guidance "text"] [intake-directory]`:

1. **Analyze** the user's project description
2. **Process guidance** from user prompt (if provided) to focus analysis or clarify context
3. **Ask** up to 10 clarifying questions (if --interactive mode)
4. **Infer** missing details using expert judgment
5. **Generate** complete intake forms in `.aiwg/intake/` (or specified directory)

**Default Output**: `.aiwg/intake/` (creates directory if needed)

### Mode 2: Complete Existing Intake
When invoked with `/intake-wizard --complete [--interactive] [intake-directory]`:

1. **Read** existing intake files (project-intake.md, solution-profile.md, option-matrix.md)
2. **Detect gaps** - identify missing or placeholder fields
3. **Auto-complete** if sufficient detail exists (no questions needed)
4. **Ask questions** (up to 10) if critical gaps exist and --interactive mode enabled
5. **Update** intake files with completed information, preserving existing content

## Input Modes

### Quick Mode (Default - Generate)
User provides project description, you generate complete intake forms using best-practice defaults.

**Example**:
```
/intake-wizard "Build a customer dashboard for viewing order history and tracking shipments"
```

### Interactive Mode (Generate)
Ask 5-10 targeted questions to clarify critical decisions, adapting based on user responses.

**Example**:
```
/intake-wizard "Build a customer dashboard" --interactive
```

### Guidance Parameter
The `--guidance` parameter accepts free-form text to help tailor the intake generation. Use it for:

**Business Context**:
```bash
/intake-wizard "Build a customer portal" --guidance "B2B SaaS for healthcare, HIPAA compliance critical, 50k users"
```

**Project Constraints**:
```bash
/intake-wizard "Build mobile app backend" --guidance "Tight 3-month deadline, limited budget, team of 2 developers"
```

**Strategic Goals**:
```bash
/intake-wizard "Modernize legacy system" --guidance "Preparing for Series A fundraising, need SOC2 compliance, phased migration required"
```

**Domain-Specific Requirements**:
```bash
/intake-wizard "E-commerce platform" --guidance "Fintech app, PCI-DSS required, multi-currency support, 10+ payment gateways"
```

**Combination with Interactive**:
```bash
/intake-wizard "Customer analytics dashboard" --interactive --guidance "Real-time data processing, 100k events/sec, enterprise clients"
```

**How guidance influences generation**:
- **Prioritizes** specific areas (security, compliance, scale, performance) in generated intake
- **Infers** missing information based on context (e.g., "healthcare" → check HIPAA requirements)
- **Adjusts** profile recommendations (e.g., "compliance critical" → favor Production/Enterprise profile)
- **Tailors** questions (if --interactive, asks about guidance-specific topics first)
- **Documents** in "Problem and Outcomes" section (captures business context and drivers)
- **Sets priority weights** in option-matrix based on guidance (e.g., "tight deadline" → higher speed weight)

### Complete Mode (Auto-complete Existing)
Read existing intake files and complete any gaps automatically if enough detail exists.

**Example**:
```
/intake-wizard --complete

# Reads .aiwg/intake/*.md files
# If sufficient detail: completes automatically
# If critical gaps: reports what's needed
```

### Complete Mode + Interactive (Fill Gaps with Questions)
Read existing intake files, detect gaps, and ask questions to fill critical missing information.

**Example**:
```
/intake-wizard --complete --interactive

# Reads .aiwg/intake/*.md files
# Detects gaps: missing timeline, unclear security requirements, no scale estimate
# Asks 3-5 questions to clarify gaps
# Updates intake files with completed information
```

## Guidance Processing (If Provided)

If user provided `--guidance "text"`, parse and apply throughout intake generation.

**Extract from guidance**:
- **Business domain** (healthcare, fintech, e-commerce, enterprise, consumer)
- **Compliance requirements** (HIPAA, PCI-DSS, GDPR, SOX, FedRAMP, SOC2)
- **Scale indicators** (user count, transaction volume, geographic distribution)
- **Timeline constraints** (tight deadline, phased rollout, MVP first)
- **Budget constraints** (cost-conscious, enterprise budget, startup)
- **Team characteristics** (size, experience level, tech stack familiarity)
- **Strategic drivers** (fundraising, audit prep, market expansion, modernization)

**Apply guidance to**:
1. **Profile recommendation**: Weight criteria based on guidance (e.g., "HIPAA" → Enterprise profile)
2. **Priority weights**: Adjust option-matrix weights (e.g., "tight deadline" → Speed 0.5)
3. **Security posture**: Elevate based on compliance (e.g., "PCI-DSS" → Strong security)
4. **Interactive questions**: Focus on guidance-specific gaps (if --interactive)
5. **Documentation**: Reference guidance in intake forms (Problem statement, constraints)

**Example guidance processing**:

Input: `--guidance "B2B SaaS for healthcare, HIPAA compliance critical, 50k users, preparing for SOC2 audit"`

Extracted:
- Domain: Healthcare (B2B SaaS)
- Compliance: HIPAA (critical), SOC2 (in progress)
- Scale: 50k users (Production profile likely)
- Intent: Audit preparation

Applied:
- Profile: Production (compliance + established users)
- Security: Strong (HIPAA + SOC2 mandatory)
- Priority weights: Quality 0.4, Reliability 0.3, Speed 0.2, Cost 0.1
- Questions (if --interactive): Focus on HIPAA controls, audit timeline, PHI handling
- Documentation: Capture in "Problem and Outcomes" → "SOC2 audit preparation for healthcare SaaS"

## Question Strategy (Interactive Mode Only)

### Core Principles
- **Maximum 10 questions total** - be selective and strategic
- **Adapt dynamically** - adjust questions based on previous answers AND guidance
- **Match technical level** - gauge user expertise and adjust complexity
- **Focus on decisions** - ask about trade-offs that significantly impact architecture
- **Fill gaps intelligently** - use expert judgment when user lacks technical knowledge
- **Leverage guidance** - skip questions already answered by guidance, focus on remaining gaps

### Question Categories (Priority Order)

#### 1. Problem Clarity (1-2 questions)
**Ask if**: Problem statement is vague or missing success criteria

**Questions**:
- "What specific problem are you solving? What's broken or inefficient today?"
- "How will you measure success? What metrics matter most?"

**Adaptive Logic**:
- If user provides clear business metrics (revenue, conversion, latency) → skip to scope questions
- If user is vague → ask simpler outcome-focused question: "What does 'better' look like for users?"

#### 2. Scope Boundaries (1-2 questions)
**Ask if**: Scope seems large or unbounded

**Questions**:
- "What's the minimum viable version? What can wait for later iterations?"
- "Are there any features that are explicitly out of scope for this phase?"

**Adaptive Logic**:
- If user mentions MVP or timeline pressure → ask about must-have vs nice-to-have features
- If user describes comprehensive solution → ask about phased rollout

#### 3. Users and Scale (1 question)
**Ask if**: User base or scale is unclear

**Questions**:
- "Who are the primary users? How many users do you expect initially and in 6 months?"

**Adaptive Logic**:
- If user says "internal team" → assume <100 users, skip detailed scale questions
- If user says "customers" or "public" → ask about expected growth trajectory

#### 4. Security and Compliance (1-2 questions)
**Ask if**: Data sensitivity or compliance requirements unclear

**Questions**:
- "What type of data will this handle? Any personal information (PII), health data (PHI), or payment information?"
- "Are there specific compliance requirements? (GDPR, HIPAA, SOC 2, etc.)"

**Adaptive Logic**:
- If user mentions "customer data" or "users" → ask about PII/privacy
- If user mentions "healthcare", "finance", "EU users" → ask about compliance
- If user is uncertain → provide simple classification: "Would this data be public, internal-only, or confidential?"

#### 5. Infrastructure and Deployment (1-2 questions)
**Ask if**: Deployment model unclear or could significantly impact architecture

**Questions**:
- "Where will this run? (Cloud provider preference, on-premises, hybrid?)"
- "Any existing systems or APIs this needs to integrate with?"

**Adaptive Logic**:
- If user mentions specific cloud (AWS, Azure, GCP) → use that, skip infrastructure questions
- If user is uncertain → ask: "Do you have a preference for managed services vs custom infrastructure?"
- If user lacks technical depth → default to managed cloud services

#### 6. Team and Timeline (1 question)
**Ask if**: Delivery expectations unclear

**Questions**:
- "What's your target timeline? When do you need this in production?"

**Adaptive Logic**:
- If user says "ASAP" or "urgent" → set speed priority high, suggest MVP approach
- If user says "6+ months" → allow for more comprehensive quality/security controls

#### 7. Technical Preferences (0-2 questions)
**Only ask if**: User demonstrates technical knowledge or has strong preferences

**Questions**:
- "Do you have preferred languages or frameworks your team knows well?"
- "Any architectural preferences? (monolith, microservices, serverless?)"

**Adaptive Logic**:
- If user uses technical jargon confidently → ask about architecture preferences
- If user is non-technical → skip entirely, choose based on team size and scale
- If user mentions existing tech stack → align with it for maintainability

#### 8. Delivery Policy (1 question, always ask) — #1005

**Always ask** — captures how AIWG agents should ship code in this project. Persists to `.aiwg/aiwg.config` `delivery.mode` so every downstream skill (commit-and-push, address-issues, pr-review) reads from the same source of truth.

**Question** (use the platform's native UX picker — `AskUserQuestion` on Claude Code):

> "How does your team ship code?"
>
> 1. Solo — commit and push directly to main (`mode: direct`)
> 2. Feature branches, no PR review required (`mode: feature-branch`)
> 3. Pull requests required, CI must be green (`mode: pr-required`) — **default**
> 4. Customize all delivery settings (drop into advanced flow)

**Adaptive Logic**:
- If user picked `direct` and team-size answer was >1 → warn: "Direct commits skip review. Are you sure for a multi-person team?"
- If user picked `pr-required` (default) → no further questions; persist defaults from `resolveDelivery()`
- If user picked `feature-branch` → confirm branch-naming pattern stays at default (`feat/{issue}-{slug}` etc.)

**Advanced flow** (option 4 only, 3 sub-questions):
- "Preferred merge style?" → `rebase-merge` (default) | `squash` | `merge` | `fast-forward-only`
- "Force-push policy?" → `never` (default) | `own-branch-only` | `allowed`
- "Require signed commits?" → no (default) | yes

**Default branch derivation**:
- Run `git symbolic-ref HEAD` (or `git rev-parse --abbrev-ref HEAD` on a fresh repo) to detect the configured default branch
- Persist that value as `delivery.default_branch`. Falls back to `main` when no git repo exists yet
- Handles `master` → `main` migrations gracefully

**Persistence**:
- Write the resolved policy to `.aiwg/aiwg.config` `delivery` block via `writeAiwgConfig()`
- Only persist non-default values to keep the config minimal — `resolveDelivery()` fills in the rest at read time
- Confirm with one line: "Delivery policy saved: mode=pr-required, merge=rebase-merge, default_branch=main"

### Example Question Flow

**Scenario**: User says "Build a customer dashboard"

**Question 1** (Problem Clarity):
> "What specific problem are you solving with this dashboard? What's missing or inefficient today?"

**User Response**: "Customers call support to check order status. We get 50+ calls daily."

**Question 2** (Success Metrics - adaptive):
> "Got it - reducing support calls. What would success look like? 50% fewer calls? Specific metrics?"

**User Response**: "If we can cut calls in half within 3 months, that's a win."

**Question 3** (Scope - adaptive):
> "For the first version, what's absolutely essential? Just order status, or also tracking, history, returns?"

**User Response**: "Order status and basic tracking. History and returns can wait."

**Question 4** (Users & Scale):
> "How many customers will use this? Current count and expected in 6 months?"

**User Response**: "About 5,000 active customers now, maybe 10,000 in 6 months."

**Question 5** (Data & Security - adaptive based on "customers"):
> "Will this show personal info like addresses or payment details? Any privacy/compliance concerns?"

**User Response**: "Just addresses for shipping tracking. We're in EU so GDPR applies."

**Question 6** (Timeline):
> "What's your target timeline to get this live?"

**User Response**: "3 months to launch."

**Question 7** (Infrastructure - skipped, user non-technical):
*Agent decides*: User is non-technical, default to managed cloud (AWS/Vercel for simplicity)

**Question 8** (Team - optional):
> "What's your team size and tech experience?"

**User Response**: "Just me and one developer. We know React and Node."

**Stop at 8 questions** - have enough information to generate complete intake.

**Expert Inferences Made**:
- Architecture: Simple monolith (team of 2, moderate scale)
- Cloud: AWS with managed services (non-technical, tight timeline)
- Security: Baseline + GDPR compliance (EU customers)
- Profile: MVP (3-month timeline, clear scope reduction)
- Reliability: p95 < 1s, 99% uptime (customer-facing, moderate scale)

## Output Generation

### Generate Complete Intake Forms

Create three files with **no placeholders or TODO items**. Use the comprehensive template structure from `intake-from-codebase.md` adapted for greenfield projects.

#### 1. project-intake.md

```markdown
# Project Intake Form

**Document Type**: {Greenfield Project | Existing System Enhancement}
**Generated**: {current date}
**Source**: {Project description + user responses | "User-provided requirements"}

## Metadata

- **Project name**: {inferred from description, pattern: Primary Noun + Purpose}
- **Requestor/owner**: {from user or "Project Team"}
- **Date**: {current date}
- **Stakeholders**: {inferred: Engineering (always), Product (always), + context-specific: Customer Support if customer-facing, Security/Compliance if sensitive data, Operations/SRE if production deployment}

## System Overview

**Purpose**: {1-2 sentences from user description, expanded with inferred context}
**Current Status**: {Planning (new project) | In Development | Early Users | Production}
**Users**: {from user or inferred from description: "internal team of X" or "external customers, estimated Y users"}
**Tech Stack** (proposed or inferred):
- **Languages**: {from user preferences or defaults: JavaScript/TypeScript, Python, Java, Go}
- **Frontend**: {if UI mentioned: React, Vue, Angular, Next.js | "N/A (API only)"}
- **Backend**: {if mentioned: Node.js/Express, Django/Flask, Spring Boot, .NET | inferred from scale}
- **Database**: {from user or defaults: PostgreSQL for relational, MongoDB for document, Redis for cache}
- **Deployment**: {from user or defaults: Docker + Cloud provider, Serverless, Static hosting}

## Problem and Outcomes

**Problem Statement**: {from user input, 2-3 sentences explaining what's broken or inefficient today, or opportunity being pursued}

**Target Personas**: {from user or inferred from description}
- Primary: {specific user type with context: "warehouse managers checking inventory status"}
- Secondary: {if applicable: "warehouse staff creating shipment records"}

**Success Metrics (KPIs)**: {from user or expert defaults}
- **User adoption**: {specific target: "80% of warehouse staff using daily" or "100 sign-ups in month 1"}
- **Performance**: {from user or defaults: "p95 latency <500ms", "99% uptime"}
- **Business impact**: {from user or inferred: "50% reduction in support calls", "20% increase in productivity"}

## Current Scope and Features

**Core Features** (in-scope for first release):
{from user description, broken down into specific features}
- {Feature 1 with brief description}
- {Feature 2 with brief description}
- {Feature 3 with brief description}

**Out-of-Scope** (explicitly excluded for now, may revisit later):
{from user or inferred complementary features}
- {Feature A - rationale: complexity, timeline, dependencies}
- {Feature B - rationale: defer until MVP validated}

**Future Considerations** (post-MVP, if project succeeds):
{from user or inferred natural evolution}
- {Enhancement 1}
- {Enhancement 2}

## Architecture (Proposed)

**Architecture Style**: {inferred from scale and team size}
- **Monolith**: Small team (<5), moderate scale (<10k users), fast iteration
- **Modular Monolith**: Medium team (5-10), moderate-high scale (10k-100k users), clear boundaries
- **Microservices**: Large team (>10), high scale (>100k users), independent deployment needs
- **Serverless**: Event-driven, variable load, minimal ops overhead
- **Hybrid**: Combination based on specific needs

**Chosen**: {specific choice} - **Rationale**: {why based on team size, scale, timeline}

**Components** (proposed):
- {Component 1}: {description, technology choice, rationale}
- {Component 2}: {description, technology choice, rationale}
- {Component 3}: {description, technology choice, rationale}

**Data Models** (estimated):
{from feature analysis, infer primary entities}
- {Entity 1}: {fields inferred from feature description}
- {Entity 2}: {fields inferred from feature description}
- {Entity 3}: {fields inferred from feature description}

**Integration Points** (if mentioned):
- {External Service 1}: {purpose, API/SDK}
- {External Service 2}: {purpose, API/SDK}
- {Internal System}: {if integrating with existing systems}

## Scale and Performance (Target)

**Target Capacity**: {from user or inferred from audience description}
- **Initial users**: {count, context: internal team, beta customers, public launch}
- **6-month projection**: {count, growth assumption}
- **2-year vision**: {count or "revisit post-MVP"}

**Performance Targets**: {from user or defaults based on use case}
- **Latency**: {p95 <500ms for interactive, <2s for batch, adjust based on criticality}
- **Throughput**: {requests/sec or transactions/min, based on use case}
- **Availability**: {99% for internal/MVP, 99.9% for production, 99.99% for mission-critical}

**Performance Strategy**: {inferred from scale and tech stack}
- **Caching**: {Redis for session/API responses if >1k users}
- **Database**: {Connection pooling, indexing, read replicas if >10k users}
- **CDN**: {CloudFront/Cloudflare if global users, static assets}
- **Background Jobs**: {Queue workers for email, reports, async processing}

## Security and Compliance (Requirements)

**Security Posture**: {inferred from data sensitivity}
- **Minimal**: Public data, no auth, basic HTTPS
- **Baseline**: User auth, secrets management, encryption at rest, SBOM
- **Strong**: Threat model, SAST/DAST, compliance controls, audit logs
- **Enterprise**: Full SDL, penetration testing, IR playbooks, SOC2/ISO27001

**Chosen**: {specific level} - **Rationale**: {based on data classification and compliance}

**Data Classification**: {from user input on data types}
- **Public**: No privacy concerns, can be exposed
- **Internal**: Company confidential, not for external sharing
- **Confidential**: PII, requires protection, limited access
- **Restricted**: PHI, payment data, high-sensitivity, strict controls

**Identified**: {specific classification} - **Evidence**: {PII/PHI/payment mentioned or none}

**Security Controls** (required):
- **Authentication**: {OAuth, JWT, basic auth based on user type and scale}
- **Authorization**: {RBAC for roles, ABAC for fine-grained, none for public}
- **Data Protection**: {Encryption at rest (AWS KMS, database encryption), TLS in transit}
- **Secrets Management**: {Environment variables for MVP, AWS Secrets Manager/Vault for production}

**Compliance Requirements**: {from user or inferred from region/industry}
- **GDPR**: {if EU users mentioned: consent, data deletion, privacy policy}
- **CCPA**: {if California users: data access, deletion rights}
- **HIPAA**: {if healthcare data: PHI protection, BAA, audit logs}
- **PCI-DSS**: {if payment processing: tokenization, no card storage}
- **SOX**: {if financial reporting: audit trails, access controls}
- **None**: {if no regulatory requirements detected}

## Team and Operations (Planned)

**Team Size**: {from user or inferred: "Small team (2-5), full-stack"}
**Team Skills**: {from user or inferred from tech stack preferences}
- **Frontend**: {React, Vue, Angular based on choices}
- **Backend**: {Node.js, Python, Java based on choices}
- **DevOps**: {AWS, Docker, CI/CD experience level}
- **Database**: {SQL, NoSQL experience}

**Development Velocity** (target): {from timeline}
- **Sprint length**: {2 weeks typical for agile teams}
- **Release frequency**: {weekly for MVP, monthly for production, based on profile}

**Process Maturity** (planned):
- **Version Control**: Git with feature branches
- **Code Review**: {PR required for small teams, optional for solo, pair programming for tight timelines}
- **Testing**: {target coverage: 30% for MVP, 60% for production, 80% for mission-critical}
- **CI/CD**: {GitHub Actions, GitLab CI, CircleCI - automate lint, test, deploy}
- **Documentation**: {README, API docs if applicable, runbooks for production}

**Operational Support** (planned):
- **Monitoring**: {Logs + basic metrics for MVP, APM for production: Datadog, New Relic}
- **Logging**: {Structured logs (JSON), centralized (CloudWatch, ELK) for production}
- **Alerting**: {Email for MVP, PagerDuty/Opsgenie for production SLA}
- **On-call**: {None for MVP, business hours for production, 24/7 for mission-critical}

## Dependencies and Infrastructure

**Third-Party Services** (proposed):
{from feature description or user mention}
- **Payment**: {Stripe, PayPal if payments mentioned}
- **Email**: {SendGrid, Mailgun if notifications mentioned}
- **SMS**: {Twilio if SMS mentioned}
- **File Storage**: {AWS S3, Google Cloud Storage if file uploads}
- **Analytics**: {Google Analytics, Mixpanel if tracking mentioned}
- **Monitoring**: {Sentry for errors, Datadog/New Relic for APM}

**Infrastructure** (proposed):
- **Hosting**: {from user preference or default: AWS (broadest services), Azure (Microsoft shop), GCP (container-first), Vercel/Netlify (frontend static)}
- **Deployment**: {Docker containers, Kubernetes if microservices, Serverless if event-driven}
- **Database**: {Managed (RDS, Cloud SQL) for speed, self-hosted if cost-sensitive or compliance}
- **Caching**: {Redis (ElastiCache, Cloud Memorystore) if >1k users}
- **Message Queue**: {SQS, RabbitMQ, Kafka if async processing needed}

## Known Risks and Uncertainties

**Technical Risks**: {from feature complexity or user mention}
- {Risk 1}: {description, likelihood, impact, mitigation strategy}
- {Risk 2}: {description, likelihood, impact, mitigation strategy}

**Integration Risks**: {if external services mentioned}
- {Risk}: {third-party API reliability, rate limits, cost overruns}

**Timeline Risks**: {from user timeline vs scope assessment}
- {Risk}: {scope too large for timeline, recommend MVP reduction}

**Team Risks**: {from team size and skills}
- {Risk}: {skill gaps, capacity constraints, mitigation: training, hiring, reduce scope}

## Why This Intake Now?

**Context**: {from user or inferred: starting new project, seeking SDLC structure, planning phase}

**Goals**:
- Establish clear requirements and scope before development starts
- Align team on architecture and technical approach
- Identify risks and dependencies early
- Enable structured SDLC process (Inception → Elaboration → Construction → Transition)

**Triggers**:
- {New project kickoff | Planning phase | Stakeholder alignment needed | Team onboarding}

## Attachments

- Solution profile: `.aiwg/intake/solution-profile.md`
- Option matrix: `.aiwg/intake/option-matrix.md`

## Next Steps

**Your intake documents are now complete and ready for the next phase!**

1. **Review** generated intake files for accuracy
2. **Proceed directly to Inception** using natural language or explicit commands:
   - Natural language: "Start Inception" or "Let's transition to Inception"
   - Explicit command: `/flow-concept-to-inception .`

**Note**: You do NOT need to run `intake-start` - that command is only for teams who manually created their own intake documents. The `intake-wizard` and `intake-from-codebase` commands produce validated intake ready for immediate use
```

#### 2. solution-profile.md

```markdown
# Solution Profile

**Document Type**: {Greenfield Project Profile | Existing System Profile}
**Generated**: {current date}

## Profile Selection

**Profile**: {Prototype | MVP | Production | Enterprise}

**Selection Logic** (automated based on inputs):
- **Prototype**: Timeline <4 weeks, no external users, experimental/learning, high uncertainty
- **MVP**: Timeline 1-3 months, initial users (internal or limited beta), proving viability
- **Production**: Timeline 3-6 months, established users, revenue-generating or critical operations
- **Enterprise**: Compliance requirements (HIPAA/SOC2/PCI-DSS), >10k users, mission-critical, contracts/SLAs

**Chosen**: {profile} - **Rationale**: {specific reasons based on timeline, user count, compliance, criticality}

Example rationales:
- "MVP: 3-month timeline, 50 internal users for beta testing, validating before public launch"
- "Production: GDPR compliance required (EU customers), 5k established users, revenue-critical"
- "Enterprise: HIPAA + SOC2 compliance, 50k users, 99.99% uptime SLA, mission-critical healthcare app"

## Profile Characteristics

### Security

**Posture**: {Minimal | Baseline | Strong | Enterprise} - based on data classification and compliance

**Profile Defaults**:
- **Prototype/MVP**: Baseline (user auth, environment secrets, HTTPS, basic logging)
- **Production**: Strong (threat model, SAST/DAST, secrets manager, audit logs, incident response)
- **Enterprise**: Enterprise (full SDL, penetration testing, compliance controls, SOC2/ISO27001, IR playbooks)

**Chosen**: {specific posture} - **Rationale**: {data sensitivity, compliance requirements, user trust needs}

**Controls Included**:
- **Authentication**: {mechanism based on profile: JWT for MVP, OAuth for Production, SSO for Enterprise}
- **Authorization**: {RBAC for roles, ABAC for fine-grained Enterprise}
- **Data Protection**: {Encryption at rest, TLS in transit, key management approach}
- **Secrets Management**: {Environment variables for Prototype, Secrets Manager for Production+}
- **Audit Logging**: {None for Prototype, basic for MVP, comprehensive for Production, compliance-grade for Enterprise}

**Gaps/Additions**: {any profile customizations based on user input}
- Example: "MVP profile but Strong security due to GDPR" → Add: data deletion API, consent management
- Example: "Production profile but no audit logs" → Gap: Consider audit logs for debugging

### Reliability

**Targets**: {based on profile and criticality}

**Profile Defaults**:
- **Prototype**: 95% uptime, best-effort, no SLA
- **MVP**: 99% uptime, p95 latency <1s, business hours support
- **Production**: 99.9% uptime, p95 latency <500ms, 24/7 monitoring, runbooks
- **Enterprise**: 99.99% uptime, p95 latency <200ms, 24/7 on-call, disaster recovery

**Chosen**: {specific targets}
- **Availability**: {percentage, rationale}
- **Latency**: {p95/p99 target, rationale}
- **Error Rate**: {target percentage, rationale}

**Monitoring Strategy**:
- **Prototype**: Basic logging (stdout), no metrics
- **MVP**: Structured logs + basic metrics (request count, latency, errors)
- **Production**: APM (Datadog/New Relic), distributed tracing, dashboards, alerts
- **Enterprise**: Full observability (metrics, logs, traces), SLO tracking, automated remediation

**Chosen**: {specific monitoring approach}

### Testing & Quality

**Coverage Targets**: {based on profile and criticality}

**Profile Defaults**:
- **Prototype**: 0-30% (manual testing OK, fast iteration priority)
- **MVP**: 30-60% (critical paths covered, some integration tests)
- **Production**: 60-80% (comprehensive unit + integration, some e2e)
- **Enterprise**: 80-95% (comprehensive coverage, full e2e, performance/load testing)

**Chosen**: {specific target} - **Rationale**: {balance speed vs. quality based on priorities}

**Test Types**:
- **Unit**: {always recommended: Jest, Pytest, JUnit}
- **Integration**: {MVP+: API tests, database tests}
- **E2E**: {Production+: Cypress, Playwright, Selenium}
- **Performance**: {Production+: k6, JMeter, load testing}
- **Security**: {Production+: SAST (SonarQube), DAST (OWASP ZAP), dependency scanning}

**Quality Gates**: {based on profile}
- **Prototype**: None (manual review only)
- **MVP**: Linting, unit tests pass (CI required)
- **Production**: Linting, tests pass, coverage threshold, security scan, code review required
- **Enterprise**: All Production gates + penetration testing, compliance scan, performance benchmarks

### Process Rigor

**SDLC Adoption**: {based on team size and profile}

**Profile Defaults**:
- **Prototype**: Minimal (README, ad-hoc, trunk-based)
- **MVP**: Moderate (user stories, basic architecture docs, feature branches, PRs for review)
- **Production**: Full (requirements docs, SAD, ADRs, test plans, runbooks, traceability)
- **Enterprise**: Enterprise (full artifact suite, compliance evidence, change control, audit trails)

**Chosen**: {specific rigor level} - **Rationale**: {team size, compliance needs, coordination requirements}

**Key Artifacts** (required for chosen profile):
- **Prototype**: README, basic git commit messages
- **MVP**: README, user stories, basic architecture diagram, runbook
- **Production**: Requirements (user stories/use cases), SAD, ADRs, test strategy, deployment plan, runbook
- **Enterprise**: Full template suite (requirements, architecture, test, security, deployment, governance)

**Tailoring Notes**: {customizations based on team/context}
- Example: "Production profile but lightweight process due to small team (2 devs) - skip governance templates"
- Example: "MVP profile but add ADRs early due to expected refactoring"

## Improvement Roadmap

**Phase 1 (Immediate - First Sprint)**:
{critical setup for chosen profile}
- **Prototype**: Git repo, README, basic deployment script
- **MVP**: Git + feature branches, CI with linting, basic tests, README
- **Production**: Full CI/CD, monitoring, basic runbook, 30%+ test coverage
- **Enterprise**: All Production + security scanning, audit logging, compliance controls

**Recommended Actions** (specific to this project):
1. {Action 1 based on profile gaps}
2. {Action 2 based on profile gaps}
3. {Action 3 based on profile gaps}

**Phase 2 (Short-term - First 3 Months)**:
{build toward target state}
- **Prototype → MVP**: Add tests (30%), structured logging, basic monitoring
- **MVP → Production**: Increase tests (60%), add APM, create runbooks, incident response plan
- **Production → Enterprise**: Compliance controls, penetration testing, disaster recovery plan

**Recommended Actions** (if project succeeds and scales):
1. {Scaling action 1}
2. {Scaling action 2}
3. {Scaling action 3}

**Phase 3 (Long-term - 6-12 Months)**:
{mature to next profile level if needed}
- **Growth triggers**: {when to level up: user count, revenue, compliance requirements, team size}
- **Leveling up**: {what changes when moving to next profile}

## Overrides and Customizations

**Security Overrides**: {if different from profile defaults}
- Example: "MVP profile but Strong security due to PII" → Add: encryption at rest, secrets manager, audit logs

**Reliability Overrides**: {if different from profile defaults}
- Example: "Production profile but 99.5% OK (not 99.9%) due to internal tool" → Relaxed monitoring

**Testing Overrides**: {if different from profile defaults}
- Example: "Production profile but 40% coverage acceptable (tight timeline, will increase post-launch)"

**Process Overrides**: {if different from profile defaults}
- Example: "Enterprise profile but skip governance templates (small team, pre-compliance phase)"

**Rationale for Overrides**: {explain why deviating from defaults}
- {Justification for each override, with triggers for revisiting}

## Key Decisions

**Decision #1: Profile Selection**
- **Chosen**: {profile}
- **Alternative Considered**: {next closest profile}
- **Rationale**: {why chosen over alternative}
- **Revisit Trigger**: {when to consider upgrading profile}

**Decision #2: Security Posture**
- **Chosen**: {posture level}
- **Alternative Considered**: {higher or lower level}
- **Rationale**: {data sensitivity, compliance, cost/time trade-offs}
- **Revisit Trigger**: {when to upgrade security}

**Decision #3: Test Coverage Target**
- **Chosen**: {percentage}
- **Alternative Considered**: {higher or lower}
- **Rationale**: {quality vs. speed trade-off, team capacity, risk tolerance}
- **Revisit Trigger**: {when to increase coverage}

## Next Steps

1. Review profile selection and customizations
2. Validate that security/reliability/testing targets align with priorities from `option-matrix.md`
3. Ensure process rigor matches team size and coordination needs
4. Start Inception with profile-appropriate templates and agents
5. Revisit profile selection at phase transitions (Inception → Elaboration → Construction → Transition)
```

#### 3. option-matrix.md

Use the comprehensive 6-step approach from `intake-from-codebase.md`, adapted for greenfield projects:

```markdown
# Option Matrix (Project Context & Intent)

**Purpose**: Capture what this project IS - its nature, audience, constraints, and intent - to determine appropriate SDLC framework application (templates, commands, agents, rigor levels).

**Generated**: {current date} (from user description + responses)

## Step 1: Project Reality

### What IS This Project?

**Project Description** (in natural language):
```
{Describe in 2-3 sentences based on user input and inferred context:}

Examples:
- "Customer dashboard for 5k users to track order status, built by 2-person team in 3 months, React + Node.js, GDPR compliance required"
- "Internal HR tool for 50 employees, scheduling and time-off management, solo developer, 6-week MVP timeline"
- "Public API for mobile app, payment processing + user accounts, 10k launch users scaling to 100k, PCI-DSS compliance, 6-month timeline"
```

### Audience & Scale

**Who uses this?** (check all from user input):
- {[ ] or [x]} Just me (personal project)
- {[ ] or [x]} Small team (2-10 people, known individuals) - {evidence from user: internal team size}
- {[ ] or [x]} Department (10-100 people, organization-internal)
- {[ ] or [x]} External customers (100-10k users, paying or free)
- {[ ] or [x]} Large scale (10k-100k+ users, public-facing)
- {[ ] or [x]} Other: {description if provided}

**Audience Characteristics**:
- Technical sophistication: {Non-technical | Mixed | Technical} - {inferred from user description}
- User risk tolerance: {Experimental OK | Expects stability | Zero-tolerance} - {inferred from criticality}
- Support expectations: {Self-service | Best-effort | SLA | 24/7} - {inferred from user type and scale}

**Usage Scale** (from user or inferred):
- Active users: {count} initially, {count} in 6 months, {count} in 2 years
- Request volume: {count} requests/min OR N/A (batch/cron/manual use)
- Data volume: {size} GB/TB OR N/A (stateless/small)
- Geographic distribution: {Single location | Regional | Multi-region | Global}

### Deployment & Infrastructure

**Expected Deployment Model** (inferred from user requirements):
- {[x] if applicable} Static site (HTML/CSS/JS, no backend, GitHub Pages/Netlify/Vercel)
- {[x] if applicable} Client-server (SPA + API backend, traditional web app)
- {[x] if applicable} Full-stack application (frontend + backend + database + workers)
- {[x] if applicable} Multi-system (microservices, service mesh, distributed)
- {[x] if applicable} Serverless (AWS Lambda, Cloud Functions, event-driven)
- {[x] if applicable} Mobile (iOS/Android native or React Native/Flutter)
- {[x] if applicable} Desktop (Electron, native apps)
- {[x] if applicable} CLI tool (command-line utility)
- {[x] if applicable} Hybrid (multiple deployment patterns)

**Where does this run?** (from user preference or defaults):
- {[x] if applicable} Cloud platform (AWS, GCP, Azure, Vercel, Netlify)
- {[x] if applicable} On-premise (company servers, data center)
- {[x] if applicable} Hybrid (cloud + on-premise)
- {[x] if applicable} Local only (laptop, desktop, not deployed)

**Infrastructure Complexity**:
- Deployment type: {Static site | Single server | Multi-tier | Microservices | Serverless}
- Data persistence: {None | Client-side | File system | Single database | Multiple data stores}
- External dependencies: {count} third-party services (from feature analysis)
- Network topology: {Standalone | Client-server | Multi-tier | Distributed}

### Technical Complexity

**Codebase Characteristics** (estimated):
- Size: {<1k | 1k-10k | 10k-100k} LoC (estimated from scope)
- Languages: {primary}, {secondary if any} (from user or defaults)
- Architecture: {Simple app | Modular | Multi-service} (inferred from scale and team)
- Team familiarity: Greenfield (new project, no legacy constraints)

**Technical Risk Factors** (check all from requirements):
- {[x] if detected} Performance-sensitive (latency, throughput critical)
- {[x] if detected} Security-sensitive (PII, payments, authentication)
- {[x] if detected} Data integrity-critical (financial, medical, legal records)
- {[x] if detected} High concurrency (many simultaneous users/processes)
- {[x] if detected} Complex business logic (many edge cases, domain rules)
- {[x] if detected} Integration-heavy (many external systems, APIs)
- {[ ] if none} None (straightforward technical requirements)

---

## Step 2: Constraints & Context

### Resources

**Team** (from user input):
- Size: {count} developers, {count} designers, {count} other roles
- Experience: {Junior | Mid | Senior | Mixed} (from user or inferred)
- Availability: {Full-time | Part-time | Contracting}

**Budget** (from user or inferred):
- Development: {Unconstrained | Moderate | Tight | Zero (volunteer)}
- Infrastructure: ${amount}/month OR {Free tier | Cost-conscious | Scalable budget}
- Timeline: {weeks/months to milestone} (from user)

### Regulatory & Compliance

**Data Sensitivity** (check all from user input):
- {[x] if applicable} Public data only (no privacy concerns)
- {[x] if applicable} User-provided content (email, profile, preferences)
- {[x] if applicable} Personally Identifiable Information (PII: name, address, phone)
- {[x] if applicable} Payment information (credit cards, financial accounts)
- {[x] if applicable} Protected Health Information (PHI: medical records)
- {[x] if applicable} Sensitive business data (trade secrets, confidential)

**Regulatory Requirements** (check all from user mention or inferred):
- {[x] if applicable} None (no specific regulations)
- {[x] if applicable} GDPR (EU users, data privacy)
- {[x] if applicable} CCPA (California users)
- {[x] if applicable} HIPAA (US healthcare)
- {[x] if applicable} PCI-DSS (payment card processing)
- {[x] if applicable} SOX (US financial reporting)
- {[x] if applicable} SOC2 (service organization controls)

**Contractual Obligations** (from user):
- {[x] if applicable} None (no contracts)
- {[x] if applicable} SLA commitments (uptime, response time guarantees)
- {[x] if applicable} Security requirements (penetration testing, audits)
- {[x] if applicable} Compliance certifications (SOC2, ISO27001)

### Technical Context

**Current State** (for new project):
- Current stage: Planning (greenfield project, requirements gathering)
- Test coverage: Target {percentage}% (from profile selection)
- Documentation: Target {level} (from profile selection)
- Deployment automation: Target {level} (from profile selection)

---

## Step 3: Priorities & Trade-offs

**INTERACTIVE SECTION** - Allocate 6-8 of 10 questions here if --interactive mode.

### What Matters Most?

**Rank these priorities** (1 = most important, 4 = least important):

From user responses or inferred from project characteristics:
- {rank} - Speed to delivery (launch fast, iterate quickly)
- {rank} - Cost efficiency (minimize time/money spent)
- {rank} - Quality & security (build it right, avoid issues)
- {rank} - Reliability & scale (handle growth, stay available)

**Priority Weights** (must sum to 1.0, derived from ranking + questions):

| Criterion | Weight | Rationale |
|-----------|--------|-----------|
| **Delivery speed** | {0.10-0.50} | {Based on timeline pressure, competitive urgency, learning goals} |
| **Cost efficiency** | {0.10-0.40} | {Based on budget constraints, resource limitations, startup/enterprise} |
| **Quality/security** | {0.10-0.50} | {Based on data sensitivity, compliance, user trust needs} |
| **Reliability/scale** | {0.10-0.40} | {Based on user base size, uptime needs, growth plans} |
| **TOTAL** | **1.00** | ← Must sum to 1.0 |

Example weights:
- MVP/Startup: Speed 0.4, Cost 0.3, Quality 0.2, Reliability 0.1
- Production: Speed 0.2, Cost 0.2, Quality 0.3, Reliability 0.3
- Enterprise: Speed 0.1, Cost 0.2, Quality 0.4, Reliability 0.3

### Trade-off Context

**What are you optimizing for?** (from user or inferred):
```
{Capture user's priorities in their words or infer from context}

Example: "Fast time-to-market to validate product-market fit before investing in scalable architecture. Can refactor later if users adopt."
```

**What are you willing to sacrifice?** (from user or inferred):
```
{Capture explicit trade-offs}

Example: "Skip comprehensive tests initially (30% coverage OK), manual deployment acceptable for MVP, can add automation post-launch."
```

**What is non-negotiable?** (from user or inferred):
```
{Capture absolute constraints}

Example: "GDPR compliance non-negotiable (EU customers). Data encryption and deletion APIs must be day-one features."
```

---

## Step 4: Intent & Decision Context

**INTERACTIVE SECTION** - Allocate 2-3 of 10 questions here if --interactive.

### Why This Intake Now?

**What triggered this intake?** (from user or inferred):
- {[x] if applicable} Starting new project (need to plan approach)
- {[x] if applicable} Seeking SDLC structure (want organized process)
- {[x] if applicable} Team alignment (multiple stakeholders need shared understanding)
- {[x] if applicable} Funding/business milestone (investor pitch, customer demo)

**What decisions need making?** (from user or inferred):
```
{Capture key decisions requiring intake clarity}

Example: "Choose between monolith (fast) vs microservices (scalable). Need data to justify trade-off to CTO."
```

**What's uncertain or controversial?** (from user if provided):
```
{Capture disagreements or unknowns}

Example: "Team split on React vs Vue. Need objective criteria (team skills, ecosystem, hiring) to decide."
```

**Success criteria for this intake process** (from user or defaults):
```
{What makes intake valuable?}

Example: "Clear technical direction, stakeholder alignment on priorities, realistic timeline and scope, ready to start development."
```

---

## Step 5: Framework Application

**INTERACTIVE SECTION** - Allocate 1-2 of 10 questions here if --interactive.

### Relevant SDLC Components

Based on project reality (Step 1) and priorities (Step 3), which framework components are relevant?

**Templates** (check applicable):
- [x] Intake (project-intake, solution-profile, option-matrix) - **Always include**
- {[x] if applicable} Requirements (user-stories, use-cases, NFRs) - Include if: {team >1, complex domain, multiple stakeholders}
- {[x] if applicable} Architecture (SAD, ADRs, API contracts) - Include if: {multi-service, >10k LoC estimated, team >3}
- {[x] if applicable} Test (test-strategy, test-plan, test-cases) - Include if: {Production+ profile, >1 developer, compliance}
- {[x] if applicable} Security (threat-model, security-requirements) - Include if: {PII, payments, compliance, external users}
- {[x] if applicable} Deployment (deployment-plan, runbook, ORR) - Include if: {Production+ profile, >10 users, SLA}
- {[x] if applicable} Governance (decision-log, CCB-minutes, RACI) - Include if: {team >5, multiple stakeholders, enterprise}

**Commands** (check applicable):
- [x] Intake commands (intake-wizard, intake-start) - **Always include**
- {[x] if applicable} Flow commands (/flow-iteration-dual-track, /flow-discovery-track, /flow-delivery-track) - Include if: {team >1, iterative development}
- {[x] if applicable} Quality gates (/security-gate, /gate-check) - Include if: {compliance, Production+ profile}
- {[x] if applicable} Specialized (/build-poc, /pr-review, /create-prd) - Include if: {specific needs from requirements}

**Agents** (check applicable):
- {[x] if applicable} Core SDLC agents (requirements-analyst, architect, code-reviewer, test-engineer, devops-engineer) - Include if: {team >1, MVP+ profile}
- {[x] if applicable} Security specialists (security-gatekeeper, security-auditor) - Include if: {PII, compliance, Production+ profile}
- {[x] if applicable} Operations specialists (incident-responder, reliability-engineer) - Include if: {Production+ profile, SLA, >100 users}
- {[x] if applicable} Enterprise specialists (legal-liaison, compliance-validator, privacy-officer) - Include if: {Enterprise profile, contracts, compliance}

**Process Rigor Level** (select based on profile):
- {[x] if applicable} Minimal (README, lightweight notes) - For: Prototype (solo, <4 weeks, experimental)
- {[x] if applicable} Moderate (user stories, basic architecture, test plan) - For: MVP (small team, 1-3 months, proving viability)
- {[x] if applicable} Full (comprehensive docs, traceability, gates) - For: Production (established users, compliance, mission-critical)
- {[x] if applicable} Enterprise (audit trails, compliance evidence, change control) - For: Enterprise (contracts, >10k users, regulated)

### Rationale for Framework Choices

**Why this subset of framework?** (based on analysis):
```
{Explain which components are relevant and why}

Example:
"MVP project (3-month timeline, 50 beta users) needs Moderate rigor:
- Intake (establish baseline, align team)
- Requirements (user stories for 2-person team coordination)
- Architecture (basic SAD, ADRs for refactoring decisions expected)
- Test (30% coverage target, smoke tests for critical paths)
- Skip security templates (Baseline posture sufficient, no compliance yet)
- Skip governance (team of 2, informal communication OK)
- Core SDLC agents (requirements-analyst, architect, code-reviewer, test-engineer)
- Flow commands (/flow-iteration-dual-track for 2-week sprints)"
```

**What we're skipping and why** (be explicit):
```
{List unused framework components with justification}

Example:
"Skipping enterprise templates because:
- No compliance requirements (no HIPAA/PCI-DSS/SOC2)
- Small team (2 developers, no coordination overhead)
- MVP timeline (3 months, lightweight process priority)
- Internal beta users (no contracts, no SLA)

Will revisit if: beta succeeds → production launch, compliance requirements emerge, team expands >5 people."
```

---

## Step 6: Evolution & Adaptation

**INTERACTIVE SECTION** - Allocate 1-2 of 10 questions here if --interactive.

### Expected Changes

**How might this project evolve?** (from user or inferred):
- {[x] if applicable} User base growth (when: {timeline}, trigger: {event})
- {[x] if applicable} Feature expansion (when: {timeline}, trigger: {event})
- {[x] if applicable} Team expansion (when: {timeline}, trigger: {event})
- {[x] if applicable} Commercial/monetization (when: {timeline}, trigger: {event})
- {[x] if applicable} Compliance requirements (when: {timeline}, trigger: {event})
- {[x] if applicable} Technical pivot (when: {timeline}, trigger: {event})

**Adaptation Triggers** (when to revisit framework application):
```
{What events would require more structure?}

Example:
"Add security templates when PII introduced (user accounts planned for month 4).
Add governance templates when team exceeds 5 people (hiring planned post-Series A).
Upgrade to Production profile when beta ends (timeline: month 6, trigger: 500+ active users)."
```

**Planned Framework Evolution** (from analysis):
- **Current (Inception)**: {list components from Step 5}
- **3 months (Elaboration)**: {add if growth/validation occurs}
- **6 months (Construction)**: {add if assumptions validated, scale increases}
- **12 months (Transition)**: {add if production launch, compliance, team scaling}

---

## Architectural Options Analysis

### Option A: {Architecture 1 Name}

**Description**: {brief overview of architectural approach}

**Technology Stack**: {specific technologies}

**Scoring** (0-5 scale):
| Criterion | Score | Rationale |
|-----------|------:|-----------|
| Delivery Speed | {0-5} | {why this score} |
| Cost Efficiency | {0-5} | {why this score} |
| Quality/Security | {0-5} | {why this score} |
| Reliability/Scale | {0-5} | {why this score} |
| **Weighted Total** | **{calculated}** | {sum of score × weight from Step 3} |

**Trade-offs**:
- **Pros**: {advantages specific to this option}
- **Cons**: {disadvantages specific to this option}

**When to choose**: {scenarios where this option fits best}

### Option B: {Architecture 2 Name}

{Repeat structure from Option A}

### Option C: {Architecture 3 Name}

{Repeat structure from Option A}

---

## Recommendation

**Recommended Option**: {highest scoring option} (Score: {total})

**Rationale**: {explain why this option best fits priorities from Step 3}

**Sensitivities**:
- If timeline pressure increases → consider {speed-optimized option}
- If compliance requirements added → reconsider {quality-optimized option}
- If scale projections exceed 50k users → reevaluate {scale-optimized option}

**Implementation Plan**:
1. {First step for chosen option}
2. {Second step}
3. {Third step}

**Risks and Mitigations**:
- **Risk 1**: {description} → Mitigation: {strategy}
- **Risk 2**: {description} → Mitigation: {strategy}

---

## Next Steps

1. Review option-matrix and validate priorities align with team/stakeholder expectations
2. Confirm chosen architectural option with technical leads
3. Use recommended framework components from Step 5 for Inception phase
4. Start Inception flow: `/intake-start .aiwg/intake/`
5. Revisit framework selection at phase gates (Inception → Elaboration → Construction → Transition)
```

## Expert Inference Guidelines

When user information is missing or unclear, use these defaults:

### Project Name
- Extract from description: "customer dashboard" → "Customer Order Dashboard"
- Pattern: {Primary Noun} + {Purpose/Function}

### Success Metrics (if not provided)
- Internal tools: "Reduces support time by 30%", "Daily active usage by 80% of team"
- Customer-facing: "User satisfaction score >4/5", "Task completion rate >90%"
- Performance: "p95 latency <500ms", "99% uptime"

### Stakeholders (always infer)
- Engineering (always present)
- Product/Project Owner (always present)
- Customer Support (if customer-facing)
- Security/Compliance (if sensitive data)
- Operations/SRE (if production deployment)

### Timeline (if not specified)
- Prototype: 2-4 weeks
- MVP: 8-12 weeks
- Production: 12-24 weeks
- Enterprise: 24-52 weeks

### Team Size (if not specified)
- Assume 2-5 developers (small agile team)
- Full-stack capable
- DevOps-aware but not specialists

### Architecture Defaults by Scale
- <1k users: Monolith, managed DB, simple deployment
- 1k-10k users: Modular monolith, caching layer, load balancer
- 10k-100k users: Service-oriented, event bus, auto-scaling
- >100k users: Microservices, distributed data, multi-region

### Security Defaults by Data
- No PII: Minimal (basic auth, HTTPS)
- PII present: Baseline (secrets mgmt, encryption, SBOM)
- PHI/PCI: Strong (threat model, SAST/DAST, compliance controls)
- Regulated industry: Enterprise (full SDL, audit logs, IR playbooks)

### Compliance by Region/Industry
- EU users: GDPR (data privacy, consent, deletion rights)
- US healthcare: HIPAA (PHI protection, audit logs)
- US finance: PCI-DSS (payment security)
- None mentioned: Standard best practices

### Cloud Provider Defaults
- User mentioned AWS/Azure/GCP: Use that
- Small team, fast timeline: AWS (broadest managed services)
- Microsoft shop: Azure
- Container-first team: GCP
- Cost-sensitive: Consider multi-cloud managed (Vercel, Railway)

### Priority Weights (if not specified)
- MVP/Startup: Speed 0.4, Cost 0.3, Quality 0.3
- Production: Speed 0.2, Cost 0.2, Quality 0.3, Reliability 0.3
- Enterprise: Speed 0.1, Cost 0.2, Quality 0.4, Reliability 0.3

## Complete Mode Workflow

### Step 1: Read Existing Intake Files

Read files in priority order:
```bash
# Check for intake files
ls .aiwg/intake/project-intake.md
ls .aiwg/intake/solution-profile.md
ls .aiwg/intake/option-matrix.md

# If not found, try alternate locations
ls ./project-intake.md
ls ./solution-profile.md
ls ./option-matrix.md
```

**If files don't exist**:
- Report: "No existing intake files found. Use without --complete to generate new intake."
- Exit with error

**If files exist**: Continue to gap detection

### Step 2: Parse and Analyze Existing Content

For each file, identify:

**Placeholder Patterns** (indicate missing content):
- `{placeholder}` or `{TBD}` or `{TODO}`
- `name` or `contact` (template placeholders)
- `bullets` or `list` or `notes`
- `e.g., ...` without actual value
- `YYYY-MM-DD` without actual date
- Empty bullet points: `- `
- Field with no value after colon: `- Field:`

**Vague Content** (needs clarification):
- "TBD", "To be determined", "Unknown"
- "Small", "Medium", "Large" without numbers
- "Soon", "Later", "Eventually" without timeline
- "Some", "A few", "Several" without specifics

**Sufficient Content** (acceptable as-is):
- Specific numbers: "5,000 users", "3 months", "$50k budget"
- Named entities: "AWS", "React + Node", "PostgreSQL"
- Dates: "2025-12-31", "Q2 2025"
- Enumerations: "Customer Support, Engineering, Product"

### Step 3: Gap Classification

Classify each gap by criticality:

**Critical Gaps** (blocks Inception phase):
- Problem statement missing or vague
- No timeline/timeframe
- No scope definition (in-scope items)
- No security classification
- No profile selection (solution-profile.md)
- Missing all options (option-matrix.md)

**Important Gaps** (should fill, can infer if needed):
- Success metrics unclear
- Stakeholders incomplete
- Team size unknown
- Scale expectations missing
- Compliance requirements unclear

**Minor Gaps** (can infer with high confidence):
- Specific dates (use current date + timeline)
- Budget (infer from scale and profile)
- Operational support details
- Technical preferences
- Observability level

### Step 4: Auto-Complete Decision

**If zero critical gaps** AND **≤3 important gaps**:
- Auto-complete mode: Fill all gaps using expert inference
- No questions needed
- Preserve ALL existing content
- Only add missing values

**If 1+ critical gaps** OR **>3 important gaps**:
- **If --interactive flag present**: Ask questions to fill critical and important gaps (max 10)
- **If no --interactive flag**: Report gaps and suggest re-running with --interactive
  ```
  Found 2 critical gaps and 4 important gaps:

  Critical:
  - Timeline/timeframe not specified
  - Security classification missing

  Important:
  - Success metrics vague ("improve efficiency")
  - Scale expectations unclear
  - Team size unknown
  - Compliance requirements not mentioned

  Recommendation: Run with --interactive to clarify:
  /intake-wizard --complete --interactive
  ```

### Step 5: Gap-Focused Questioning (Complete + Interactive)

**Prioritize questions by gap criticality**:

1. **Critical gaps first** (always ask):
   - Missing timeline → "What's your target timeline for this project?"
   - Missing scope → "What are the must-have features for the first version?"
   - Missing security → "What type of data will this handle? Any PII or sensitive information?"

2. **Important gaps second** (ask if <10 questions total):
   - Vague metrics → "How will you measure success? What specific metrics matter?"
   - Missing scale → "How many users do you expect initially and in 6 months?"
   - Unknown team → "What's your team size and technical experience?"

3. **Minor gaps** (infer, don't ask):
   - Use expert judgment based on other provided information

**Example Gap-Focused Flow**:

Existing intake has:
- Project name: "Customer Portal" ✓
- Problem: "Customers can't see order status" ✓
- Timeline: `{timeframe}` ✗ CRITICAL GAP
- In-scope: "Order status, tracking" ✓
- Security: `{classification}` ✗ CRITICAL GAP
- Scale: "customers" (vague) ✗ IMPORTANT GAP
- Team: `{notes}` ✗ IMPORTANT GAP

**Questions (4 total, under 10 limit)**:
1. "What's your target timeline to get this live?" (CRITICAL)
2. "What type of data will customers see? Any personal info like addresses or payment details?" (CRITICAL)
3. "How many customers will use this? Current count and 6-month projection?" (IMPORTANT)
4. "What's your team size and tech stack experience?" (IMPORTANT)

**Auto-infer** (no questions):
- Success metrics: "80% customer self-service", "50% reduction in support calls"
- Stakeholders: Customer Support, Engineering, Product
- Budget: $500-1000/mo based on scale
- Profile: MVP (3-month timeline, modest scale)

### Step 6: Update Files (Preserve Existing Content)

**Merge Strategy**:
- **Keep all existing non-placeholder content**
- **Replace placeholders** with actual values
- **Enhance vague content** with specifics
- **Add missing sections** if entirely absent
- **Preserve formatting** and structure

**Example Update**:

**Before (project-intake.md)**:
```markdown
- Project name: Customer Portal
- Requestor/owner: `name/contact`
- Date: `YYYY-MM-DD`

## Problem and Outcomes

- Problem statement: Customers can't see order status online
- Target personas/scenarios: `bullets`
- Success metrics (KPIs): `e.g., activation +20%, p95 < 200ms`

## Scope and Constraints

- In-scope: Order status, tracking
- Out-of-scope (for now): `bullets`
- Timeframe: `e.g., MVP in 6 weeks`
```

**After (completed)**:
```markdown
- Project name: Customer Portal
- Requestor/owner: Engineering Team
- Date: 2025-10-15

## Problem and Outcomes

- Problem statement: Customers can't see order status online, resulting in 50+ daily support calls
- Target personas/scenarios: Existing customers checking order status and shipment tracking
- Success metrics (KPIs): 50% reduction in support calls within 3 months, 80% customer self-service rate, p95 latency < 500ms

## Scope and Constraints

- In-scope: Order status, tracking
- Out-of-scope (for now): Order history (full purchase history), Returns processing, Refund requests
- Timeframe: MVP in 12 weeks (3 months)
```

**Changes Made**:
- Filled `name/contact` → "Engineering Team" (inferred)
- Filled `YYYY-MM-DD` → "2025-10-15" (current date)
- Enhanced problem statement with context from user answers
- Filled `bullets` for personas → specific personas based on problem
- Replaced vague metrics with specific KPIs from user answers
- Filled out-of-scope bullets → inferred complementary features
- Filled timeframe → from user answer "3 months"

### Step 7: Generate Completion Report

**Report Format**:
```markdown
# Intake Completion Report

**Mode**: {Auto-complete | Interactive completion}
**Files Updated**: {count}
**Gaps Filled**: {count}
**Questions Asked**: {count} (if interactive)

## Files Updated

✓ .aiwg/intake/project-intake.md
  - Filled 5 placeholder fields
  - Enhanced 2 vague descriptions
  - Added 3 missing sections

✓ .aiwg/intake/solution-profile.md
  - Selected profile: MVP (based on 12-week timeline, moderate scale)
  - Filled security defaults: Baseline + GDPR
  - Added override note: "EU customers require GDPR compliance"

✓ .aiwg/intake/option-matrix.md
  - Calculated priority weights: Speed 0.4, Cost 0.3, Quality 0.3
  - Scored 3 architectural options
  - Recommended: Monolith + AWS (score: 4.1/5.0)

## Changes Summary

**Filled Placeholders**: 12 fields
- Timeline: 12 weeks (from user)
- Security: Baseline + GDPR (inferred from EU customers)
- Scale: 5k users initially, 10k in 6 months (from user)
- Team: 2 developers, React + Node experience (from user)
- Success metrics: 50% fewer support calls (from user)
- ... (list all)

**Enhanced Vague Content**: 3 fields
- "improve efficiency" → "50% reduction in support calls within 3 months"
- "customers" → "5,000 active customers, growing to 10,000 in 6 months"
- "soon" → "12 weeks (Q1 2026)"

**Added Missing Sections**: 1
- Compliance: GDPR (data privacy, consent, 30-day deletion)

## Validation

✓ Zero placeholders remaining
✓ All critical fields complete
✓ Internally consistent
✓ Ready for Inception phase

## Next Steps

1. Review completed intake files
2. Start Inception flow: /flow-concept-to-inception .
```

## Complete Mode Examples

### Example 1: Auto-Complete (No Questions Needed)

**Existing .aiwg/intake/project-intake.md** (partial):
```markdown
- Project name: Employee Schedule Manager
- Problem statement: Manual schedule management causes conflicts
- In-scope: Shift scheduling, conflict detection
- Timeframe: 10 weeks
- Stakeholders: HR, Engineering
- Team size/skills: 3 developers, full-stack
- Security posture: `{Minimal|Baseline|Strong|Enterprise}`
```

**Command**:
```
/intake-wizard --complete
```

**Agent Analysis**:
- Critical gaps: 0 (has problem, scope, timeline)
- Important gaps: 1 (security posture placeholder)
- Minor gaps: several (dates, some details)

**Decision**: Auto-complete (sufficient detail)

**Agent Action**:
```
Analyzing existing intake files...

✓ Found: .aiwg/intake/project-intake.md
✓ Found: .aiwg/intake/solution-profile.md
✗ Missing: .aiwg/intake/option-matrix.md

Gaps detected:
- 1 critical field: option-matrix.md missing
- 8 placeholder fields in project-intake.md
- 2 placeholder fields in solution-profile.md

Sufficient detail present for auto-completion.

Auto-completing intake files...

✓ Updated .aiwg/intake/project-intake.md (8 fields filled)
✓ Updated .aiwg/intake/solution-profile.md (2 fields filled)
✓ Created .aiwg/intake/option-matrix.md (complete)

Inferences made:
- Security: Baseline (internal tool, no PII, HR data is Internal classification)
- Scale: <100 users (internal HR tool)
- Profile: MVP (10-week timeline, internal validation)
- Architecture: Simple monolith (small team, internal scale)
- Priority weights: Speed 0.4, Cost 0.3, Quality 0.3 (MVP focus)

All intake files complete. Ready for Inception phase.
```

### Example 2: Interactive Completion (Questions for Critical Gaps)

**Existing .aiwg/intake/project-intake.md** (partial):
```markdown
- Project name: Mobile API
- Problem statement: Mobile app needs backend
- In-scope: `bullets`
- Timeframe: `e.g., MVP in 6 weeks`
- Security posture: `{classification}`
```

**Command**:
```
/intake-wizard --complete --interactive
```

**Agent Analysis**:
- Critical gaps: 3 (scope, timeline, security all missing)
- Important gaps: many

**Agent Response**:
```
Reading existing intake files...

✓ Found: .aiwg/intake/project-intake.md
✓ Found: .aiwg/intake/solution-profile.md
✓ Found: .aiwg/intake/option-matrix.md

Analyzing gaps...

Found 3 critical gaps and 5 important gaps:

Critical:
- In-scope features not defined
- Timeline not specified
- Security classification missing

Important:
- Success metrics vague ("backend for mobile app")
- Scale expectations unclear
- Team size unknown
- Integrations not specified
- Compliance requirements not mentioned

I'll ask a few questions to fill the critical gaps.

Question 1/10: What specific features does the mobile API need to provide? What can the app do?

{user responds: "User login, product catalog browsing, add to cart, checkout"}

Question 2/10: What's your target timeline to get this API production-ready?

{user responds: "We need it in 4 months for the mobile app launch"}

Question 3/10: What type of data will the API handle? Any personal info, payment data, or health information?

{user responds: "Yes - user profiles, shipping addresses, and credit card processing"}

Question 4/10: How many users do you expect? Initial launch and 6-month projection?

{user responds: "Launching to 10k existing customers, expecting 25k in 6 months"}

Question 5/10: Any specific compliance requirements given you're handling payment data?

{user responds: "We're in the US and EU, so PCI-DSS for payments and GDPR for EU users"}

Great! I have what I need. Completing your intake files...

✓ Updated .aiwg/intake/project-intake.md
✓ Updated .aiwg/intake/solution-profile.md
✓ Updated .aiwg/intake/option-matrix.md

Summary:
- In-scope: User auth, product catalog API, cart management, checkout/payment
- Timeline: 16 weeks (4 months)
- Security: Strong (PCI-DSS + GDPR compliance required)
- Scale: 10k launch, 25k in 6 months
- Profile: Production (compliance requirements, revenue-generating)
- Architecture: Service-oriented (moderate scale, payment isolation)

All critical gaps filled. Ready for Inception phase.
```

## Interactive Mode Example

**User Input**:
```
/intake-wizard "Build an API for our mobile app to fetch product catalog and process orders" --interactive
```

**Agent Response**:
```
I'll help you create complete intake forms for your API project. Let me ask a few key questions to get the details right.

Question 1/10: What specific problem does this API solve? What's inefficient or broken today?

{wait for user response}

{adapt questions 2-10 based on responses, maximum 10 total}

{after questions complete}

Great! I have everything I need. Generating your complete intake forms...

✓ Created .aiwg/intake/project-intake.md
✓ Created .aiwg/intake/solution-profile.md
✓ Created .aiwg/intake/option-matrix.md

Summary:
- Project: Product Catalog & Order API
- Profile: Production (compliance requirements, established users)
- Architecture: Microservices (scale >10k users)
- Timeline: 16 weeks to production
- Compliance: GDPR + PCI-DSS

Next steps:
1. Review the generated intake forms
2. Start Inception flow: /flow-concept-to-inception .
```

## Non-Interactive Mode Example

**User Input**:
```
/intake-wizard "Internal tool for managing employee schedules with shift swapping"
```

**Agent Response**:
```
Generating complete intake forms with best-practice defaults...

Analyzing project:
- Type: Internal productivity tool
- Users: Internal employees (estimated <500)
- Data: Internal-only, no PII
- Profile: MVP (reasonable timeline, internal validation)
- Architecture: Simple monolith (small user base, internal tool)

✓ Created .aiwg/intake/project-intake.md
✓ Created .aiwg/intake/solution-profile.md
✓ Created .aiwg/intake/option-matrix.md

Summary:
- Project: Employee Schedule Manager
- Profile: MVP
- Architecture: Monolith + PostgreSQL + React frontend
- Timeline: 10 weeks to internal beta
- Security: Baseline (internal auth, no PII)
- Recommended: AWS Elastic Beanstalk + RDS

All intake forms complete with no placeholders. Ready to start Inception phase.

Next step: /flow-concept-to-inception .
```

## Quality Checklist

Before generating files, ensure:

- [ ] **No placeholders**: Every field has a real value, not `{TBD}` or `{TODO}`
- [ ] **No contradictions**: Timeline matches scope, security matches data sensitivity
- [ ] **Realistic metrics**: Success metrics are measurable and achievable
- [ ] **Complete stakeholders**: All relevant roles identified
- [ ] **Justified architecture**: Architecture choice matches scale and team size
- [ ] **Reasonable priorities**: Priority weights sum to 1.0 and reflect project goals
- [ ] **Actionable scope**: In-scope items are specific features, out-of-scope is explicit
- [ ] **Valid compliance**: Compliance requirements match industry and region
- [ ] **Option matrix scored**: All options have scores with rationale

## Success Criteria

This command succeeds when:
- [ ] Three complete intake files generated (project-intake, solution-profile, option-matrix)
- [ ] Zero placeholder fields (all `{template}` values replaced)
- [ ] Internally consistent (no conflicting requirements)
- [ ] Actionable (team can start Inception immediately)
- [ ] If interactive: Asked ≤10 questions, adapted based on responses
- [ ] Expert inferences documented in files (rationale for defaults chosen)

## Error Handling

**Insufficient Input**:
- Report: "Project description too vague. Need at least: what you're building and who it's for."
- Action: "Please provide: 'Build a {thing} for {users} to {do-what}'"
- Example: "Build a dashboard for customers to track orders"

**Interactive Mode - User Unclear**:
- Report: "I notice you're uncertain about {topic}. Let me suggest a sensible default."
- Action: Provide 2-3 options with recommendation
- Example: "Not sure about scale? I recommend planning for 1k-5k users initially with room to scale."

**Contradictory Requirements**:
- Report: "I notice {contradiction}: {detail}"
- Action: "Resolving with: {decision} based on {rationale}"
- Example: "Timeline is 4 weeks but scope includes 15 features. Recommending MVP with 3 core features."

## Community Nudge

After successfully completing this command, emit at most this short stdout-only nudge, and only if the environment allows nudges:

```
If AIWG saved you time, a star at github.com/jmagly/aiwg helps others find it.
Hide this: aiwg config set --user community.nudges false
```

Rules:

- Do not ask an interactive star prompt.
- Do not call GitHub APIs or run `gh`.
- Do not write the nudge into intake files, generated docs, issues, commits, PRs, or project artifacts.
- Suppress when `AIWG_NO_NUDGE=1`, `AIWG_NO_NUDGE=true`, `CI=true`, stdout is non-TTY, `community.nudges: false` is set in user config, or the intake nudge was shown within the last 90 days.
- If unsure whether the runtime state permits a nudge, omit it.

## References

- Intake templates: `agentic/code/frameworks/sdlc-complete/templates/.aiwg/intake/`
- Flow orchestration: `commands/flow-concept-to-inception.md`
- Profile definitions: `templates/.aiwg/intake/solution-profile-template.md`
