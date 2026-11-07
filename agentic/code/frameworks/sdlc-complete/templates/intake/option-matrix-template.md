# Option Matrix (Project Context & Intent)

**Purpose**: Capture what this project IS - its nature, audience, constraints, and intent - to determine appropriate SDLC framework application (templates, commands, agents, rigor levels).

## Instructions

This matrix captures the project's reality and stakeholder intent. It drives decisions about:
- Which **templates** are relevant (skip irrelevant artifacts)
- Which **commands** apply (skip enterprise workflows for personal projects)
- Which **agents** are needed (focused team vs full complement)
- What **process rigor** makes sense (documentation depth, gate formality)

**How to use**:
1. **Describe project reality** - What IS this project (audience, scale, deployment, complexity)?
2. **Capture constraints** - Resources, timeline, regulatory environment, technical context
3. **Understand priorities** - What matters most for success (speed, cost, quality, reliability)?
4. **Document intent** - Why this intake, what decisions need making, what's uncertain?

**Key Principle**: This is **descriptive** (what IS), not **prescriptive** (what should be). Analysis happens in solution-profile.md and project-intake.md.

---

## Step 1: Project Reality

### What IS This Project?

**Project Description** (in natural language):
```
Describe this project in 2-3 sentences:
- What does it do?
- Who is it for?
- Where does it run?

Examples:
- "Small audience personal blog (10-50 readers/month), static site deployed to GitHub Pages, solo hobby project"
- "Internal business application for inventory tracking, 5 warehouse staff users, deployed on local server, critical to daily operations"
- "B2B SaaS platform for project management, 500+ paying customers (2000+ users), multi-tenant cloud deployment, primary revenue source"
- "Open source developer tool (CLI), 1k+ GitHub stars, distributed via npm/pip, community-supported"
- "Enterprise healthcare system, 50k+ patients, HIPAA-regulated, 24/7 uptime required, hospital critical infrastructure"
```

### Audience & Scale

**Who uses this?** (check all that apply)
- [ ] Just me (personal project)
- [ ] Small team (2-10 people, known individuals)
- [ ] Department (10-100 people, organization-internal)
- [ ] External customers (100-10k users, paying or free)
- [ ] Large scale (10k-100k+ users, public-facing)
- [ ] Other: `_________________`

**Audience Characteristics**:
- Technical sophistication: `[ ] Non-technical | [ ] Mixed | [ ] Technical`
- User risk tolerance: `[ ] Experimental OK | [ ] Expects stability | [ ] Zero-tolerance for issues`
- Support expectations: `[ ] Self-service | [ ] Best-effort email | [ ] SLA commitments | [ ] 24/7 support`

**Usage Scale** (current or projected):
- Active users: `___ (daily/weekly/monthly)`
- Request volume: `___ requests/min or N/A (batch/cron/manual use)`
- Data volume: `___ GB/TB or N/A (stateless/small)`
- Geographic distribution: `[ ] Single location | [ ] Regional | [ ] Multi-region | [ ] Global`

### Deployment & Infrastructure

**Expected Deployment Model** (what will this become?):
- [ ] Client-only (desktop app, mobile app, CLI tool, browser extension)
- [ ] Static site (HTML/CSS/JS, no backend, hosted files)
- [ ] Client-server (SPA + API backend, traditional web app with database)
- [ ] Full-stack application (frontend + backend + database + supporting services)
- [ ] Multi-system (multiple services, microservices, service mesh, distributed)
- [ ] Distributed application (edge computing, P2P, blockchain, federated)
- [ ] Embedded/IoT (device firmware, embedded systems, hardware integration)
- [ ] Hybrid (multiple deployment patterns, e.g., mobile app + cloud backend)
- [ ] Other: `_________________`

**Where does this run?**
- [ ] Local only (laptop, desktop, not deployed)
- [ ] Personal hosting (VPS, shared hosting, home server)
- [ ] Cloud platform (AWS, GCP, Azure, Vercel, Netlify, GitHub Pages)
- [ ] On-premise (company servers, data center)
- [ ] Hybrid (cloud + on-premise, multi-cloud)
- [ ] Edge/CDN (distributed, geographically distributed)
- [ ] Mobile (iOS, Android, native or cross-platform)
- [ ] Desktop (Windows, macOS, Linux executables)
- [ ] Browser (extension, PWA, web app)
- [ ] Other: `_________________`

**Infrastructure Complexity**:
- Deployment type: `[ ] Static site | [ ] Single server | [ ] Multi-tier | [ ] Microservices | [ ] Serverless | [ ] Container orchestration`
- Data persistence: `[ ] None (stateless) | [ ] Client-side only | [ ] File system | [ ] Single database | [ ] Multiple data stores | [ ] Distributed database`
- External dependencies: `___ third-party services (0 = none, 1-3 = few, 4-10 = moderate, 10+ = many)`
- Network topology: `[ ] Standalone | [ ] Client-server | [ ] Multi-tier | [ ] Peer-to-peer | [ ] Mesh | [ ] Hybrid`

### Technical Complexity

**Codebase Characteristics**:
- Size: `[ ] <1k LoC | [ ] 1k-10k LoC | [ ] 10k-100k LoC | [ ] 100k+ LoC`
- Languages: `___ (primary), ___ (secondary if applicable)`
- Architecture: `[ ] Single script/notebook | [ ] Simple app | [ ] Modular | [ ] Multi-service | [ ] Complex distributed`
- Team familiarity: `[ ] Greenfield (starting fresh) | [ ] Brownfield (existing code, partial understanding) | [ ] Legacy (inherited, limited understanding)`

**Technical Risk Factors** (check all that apply):
- [ ] Performance-sensitive (latency, throughput critical)
- [ ] Security-sensitive (PII, payments, authentication)
- [ ] Data integrity-critical (financial, medical, legal records)
- [ ] High concurrency (many simultaneous users/processes)
- [ ] Complex business logic (many edge cases, domain rules)
- [ ] Integration-heavy (many external systems, APIs, protocols)
- [ ] None (straightforward technical requirements)

---

## Step 2: Constraints & Context

### Resources

**Team**:
- Size: `___ developers, ___ designers, ___ other roles`
- Experience: `[ ] Junior (learning) | [ ] Mid (independent) | [ ] Senior (leads) | [ ] Mixed`
- Availability: `[ ] Full-time | [ ] Part-time | [ ] Volunteer/hobby | [ ] Contracting`

**Budget**:
- Development: `[ ] Unconstrained | [ ] Moderate | [ ] Tight | [ ] Zero (volunteer/personal)`
- Infrastructure: `$ ___ /month or [ ] Free tier only | [ ] Cost-conscious | [ ] Scalable budget`
- **Operator commitments**: `{supplied date/window, source, fixed/flexible; or none supplied}`. Never infer delivery dates or durations.
- Scope units: `{named deliverables, owners, prerequisites, review passes, and acceptance gates}`

### Regulatory & Compliance

**Data Sensitivity** (check all that apply):
- [ ] Public data only (no privacy concerns)
- [ ] User-provided content (email, profile, preferences)
- [ ] Personally Identifiable Information (PII: name, address, phone)
- [ ] Payment information (credit cards, financial accounts)
- [ ] Protected Health Information (PHI: medical records)
- [ ] Sensitive business data (trade secrets, confidential)
- [ ] Other: `_________________`

**Regulatory Requirements** (check all that apply):
- [ ] None (no specific regulations)
- [ ] GDPR (EU users, data privacy)
- [ ] CCPA (California users, data privacy)
- [ ] HIPAA (US healthcare)
- [ ] PCI-DSS (payment card processing)
- [ ] SOX (US financial reporting)
- [ ] FedRAMP (US government cloud)
- [ ] ISO27001 (information security management)
- [ ] SOC2 (service organization controls)
- [ ] Other: `_________________`

**Contractual Obligations** (check all that apply):
- [ ] None (no contracts)
- [ ] SLA commitments (uptime, response time guarantees)
- [ ] Security requirements (penetration testing, audits)
- [ ] Compliance certifications (SOC2, ISO27001, etc.)
- [ ] Data residency (data must stay in specific regions)
- [ ] Right to audit (customers can audit code/infrastructure)
- [ ] Other: `_________________`

### Technical Context

**Current State** (for existing projects):
- Current stage: `[ ] Concept | [ ] Prototype | [ ] Early users | [ ] Established | [ ] Mature | [ ] Legacy`
- Test coverage: `___% or [ ] None | [ ] Manual only | [ ] Automated (partial) | [ ] Comprehensive`
- Documentation: `[ ] None | [ ] README only | [ ] Basic (setup/usage) | [ ] Comprehensive (architecture, APIs, runbooks)`
- Deployment automation: `[ ] Manual | [ ] Scripted | [ ] CI/CD (basic) | [ ] CI/CD (full pipeline)`

**Technical Debt** (for existing projects):
- Severity: `[ ] None (new/clean) | [ ] Minor (some rough edges) | [ ] Moderate (refactor needed) | [ ] Significant (limits progress)`
- Type: `[ ] Code quality | [ ] Architecture | [ ] Dependencies (outdated) | [ ] Performance | [ ] Security | [ ] Tests | [ ] Documentation`
- Priority: `[ ] Can wait | [ ] Should address | [ ] Must address | [ ] Blocking`

---

## Step 3: Priorities & Trade-offs

### What Matters Most?

**Rank these priorities** (1 = most important, 4 = least important):
- `___` Speed to delivery (launch fast, iterate quickly)
- `___` Cost efficiency (minimize time/money spent)
- `___` Quality & security (build it right, avoid issues)
- `___` Reliability & scale (handle growth, stay available)

**Priority Weights** (must sum to 1.0, derived from ranking):

| Criterion | Weight | Rationale |
|-----------|--------|-----------|
| **Delivery speed** | `0.00` | Why this weight? (time-to-market pressure, learning goals, competitive urgency) |
| **Cost efficiency** | `0.00` | Why this weight? (budget constraints, resource limitations, opportunity cost) |
| **Quality/security** | `0.00` | Why this weight? (user trust, data sensitivity, regulatory requirements, reputation) |
| **Reliability/scale** | `0.00` | Why this weight? (user base size, uptime needs, performance expectations, growth plans) |
| **TOTAL** | **1.00** | ← Must sum to 1.0 |

### Trade-off Context

**What are you optimizing for?** (in your own words)
```
Example answers:
- "Operator supplied a fundraising deadline in 4 weeks (source: founder); launch scope is the investor demo, quality can be improved post-launch"
- "Learning project to understand framework X, speed matters less than building it right"
- "Business-critical tool, users can't work without it, reliability trumps new features"
- "Open source reputation project, code quality and documentation critical, timeline flexible"
```

**What are you willing to sacrifice?** (be explicit)
```
Example answers:
- "Launch with manual deployment, add CI/CD later"
- "Skip comprehensive tests initially, add coverage post-MVP"
- "Use simple architecture even if less scalable, optimize when we have users"
- "Spend extra time on documentation upfront, slower development but better maintainability"
```

**What is non-negotiable?** (constraints that override trade-offs)
```
Example answers:
- "HIPAA compliance required - no shortcuts on security/audit logging"
- "Zero downtime requirement - must have high availability architecture"
- "Must work offline - network reliability is poor in target environment"
- "Open source from day one - community transparency is core value"
```

---

## Step 4: Intent & Decision Context

### Why This Intake Now?

**What triggered this intake?** (check all that apply)
- [ ] Starting new project (need to plan approach)
- [ ] Documenting existing project (never had formal intake)
- [ ] Preparing for scale/growth (need more structure)
- [ ] Compliance requirement (audit, certification, customer demand)
- [ ] Team expansion (onboarding new members, need clarity)
- [ ] Technical pivot (major refactor, platform change)
- [ ] Handoff/transition (new maintainer, acquisition, open-sourcing)
- [ ] Funding/business milestone (investor due diligence, enterprise sales)
- [ ] Other: `_________________`

**What decisions need making?** (be specific)
```
Example answers:
- "Should we invest in automated testing now, or ship fast and add tests later?"
- "Do we need formal architecture documentation, or is code + README enough?"
- "Which compliance certifications are worth pursuing given our target customers?"
- "Should we hire a DevOps person, or can we DIY with current team?"
```

**What's uncertain or controversial?** (surface disagreements)
```
Example answers:
- "Team split on microservices vs monolith - need data to decide"
- "CTO wants comprehensive tests, CEO wants faster shipping - need to balance"
- "Unsure if we need dedicated security engineer, or if developers can handle it"
- "Customer requests enterprise features (SSO, SAML), but we're small team - is it worth it?"
```

**Success criteria for this intake process**:
```
What would make this intake valuable?

Example answers:
- "Clear framework recommendation (which templates/commands/agents to use)"
- "Shared understanding between founders on quality vs. speed trade-offs"
- "Roadmap for evolving process as we grow (MVP now, Production later)"
- "Documentation to show investors we have structured approach"
```

---

## Step 5: Framework Application

### Relevant SDLC Components

Based on project reality (Step 1) and priorities (Step 3), which framework components are relevant?

**Templates** (check applicable):
- [ ] Intake (project-intake, solution-profile, option-matrix) - **Always include**
- [ ] Requirements (user-stories, use-cases, NFRs) - Include if: `{complex domain, multiple stakeholders}`
- [ ] Architecture (SAD, ADRs, API contracts) - Include if: `{multi-service, technical complexity, team >3}`
- [ ] Test (test-strategy, test-plan, test-cases) - Include if: `{quality-critical, >1 developer, regulated}`
- [ ] Security (threat-model, security-requirements) - Include if: `{PII, payments, compliance, external users}`
- [ ] Deployment (deployment-plan, runbook, ORR) - Include if: `{production deployment, >10 users, SLA}`
- [ ] Governance (decision-log, CCB-minutes, RACI) - Include if: `{team >5, stakeholders >3, compliance}`

**Commands** (check applicable):
- [ ] Intake commands (intake-wizard, intake-from-codebase, intake-start) - **Always include**
- [ ] Flow commands (iteration, discovery, delivery) - Include if: `{ongoing development, team >2}`
- [ ] Quality gates (security-gate, gate-check, traceability) - Include if: `{regulated, team >3, enterprise customers}`
- [ ] Specialized (build-poc, pr-review, troubleshooting-guide) - Include if: `{specific needs emerge}`

**Agents** (check applicable):
- [ ] Core SDLC agents (requirements-analyst, architect, code-reviewer, test-engineer, devops) - Include if: `{team >1, structured process}`
- [ ] Security specialists (security-gatekeeper, security-auditor) - Include if: `{PII, compliance, external users}`
- [ ] Operations specialists (incident-responder, reliability-engineer) - Include if: `{production, SLA, >100 users}`
- [ ] Enterprise specialists (legal-liaison, compliance-validator, privacy-officer) - Include if: `{regulated, contracts, large org}`

**Process Rigor Level**:
- [ ] Minimal (README, lightweight notes, ad-hoc) - For: `{solo, learning, <10 users, prototype}`
- [ ] Moderate (user stories, basic architecture, test plan, runbook) - For: `{small team, <1k users, established}`
- [ ] Full (comprehensive docs, traceability, gates) - For: `{large team, >1k users, regulated, mission-critical}`
- [ ] Enterprise (audit trails, compliance evidence, change control) - For: `{regulated, contracts, >10k users}`

### Rationale for Framework Choices

**Why this subset of framework?**
```
Explain which components are relevant and why:

Example:
"Personal blog (solo, <100 readers) needs minimal rigor:
- Intake only (understand what we're building)
- Skip requirements (single user, clear vision)
- Skip architecture docs (simple static site)
- Skip tests (low risk, easy to manually verify)
- Skip security templates (no PII, no login)
- Skip deployment templates (GitHub Pages, simple workflow)

Relevant: intake-wizard, writing-validator agent (content quality), static site templates"
```

**What we're skipping and why**:
```
Be explicit about unused framework components:

Example:
"Skipping enterprise templates because:
- No regulatory requirements (just a blog)
- No team coordination needs (solo developer)
- No compliance obligations (no customer data)
- No operational complexity (static site, no backend)

Will revisit if: blog becomes commercial, adds user accounts, grows team"
```

---

## Step 6: Evolution & Adaptation

### Expected Changes

**How might this project evolve?**
- [ ] No planned changes (stable scope and scale)
- [ ] User base growth (when: `___`, trigger: `___`)
- [ ] Feature expansion (when: `___`, trigger: `___`)
- [ ] Team expansion (when: `___`, trigger: `___`)
- [ ] Commercial/monetization (when: `___`, trigger: `___`)
- [ ] Compliance requirements (when: `___`, trigger: `___`)
- [ ] Technical pivot (when: `___`, trigger: `___`)

**Adaptation Triggers** (when to revisit framework application):
```
What events would require more structure?

Examples:
- "Add requirements docs when 2nd developer joins (need shared understanding)"
- "Add security templates when we handle payments (PCI-DSS compliance)"
- "Add deployment runbook when we exceed 1k users (operational complexity)"
- "Add governance templates when team exceeds 5 people (coordination overhead)"
```

**Planned Framework Evolution**:
- Current: `{list current framework components}`
- When user-growth trigger is met: `{add/change if growth occurs}`
- When assumptions are validated: `{add/change if assumptions validated}`
- When scale/complexity trigger is met: `{add/change if scale/complexity increases}`

---

## Example: Filled Option Matrix

### Example 1: Personal Portfolio Site

**Project Description**: "Personal portfolio site showcasing design work, 10-20 visitors/month, static HTML/CSS deployed to GitHub Pages, solo project for job applications"

**Audience & Scale**:
- Just me (personal project) ✓
- Non-technical audience (hiring managers)
- <100 monthly visitors
- Single region (US)

**Deployment**: GitHub Pages (free, static)
**Complexity**: <1k LoC, simple static site, greenfield
**Team**: Solo, part-time (evenings/weekends)
**Budget**: $0 (free hosting)

**Priorities** (weights):
- Speed: 0.50 (need portfolio for job search ASAP)
- Cost: 0.30 (no budget, must be free)
- Quality: 0.15 (design matters, but functional is enough)
- Reliability: 0.05 (occasional downtime OK, not business-critical)

**Intent**: "Starting new project, operator-supplied job application deadline in 2 weeks (source: applicant); scope: published portfolio and verified links, can iterate on design later"

**Framework Application**:
- Templates: Intake only (skip requirements, architecture, tests, security, deployment)
- Commands: intake-wizard
- Agents: writing-validator (content quality for portfolio descriptions)
- Rigor: Minimal (README, comments in code)

**Rationale**: "Solo portfolio site needs lightweight process. Intake captures vision, but comprehensive docs would be over-engineering. Can always add structure later if site becomes business (e.g., freelance clients)."

### Example 2: Internal Business Application

**Project Description**: "Inventory tracking app for 5 warehouse staff, critical to daily operations, deployed on local server, handles 50k product SKUs, used 8 hours/day by operations team"

**Audience & Scale**:
- Small team (5 known users, same organization)
- Mixed technical sophistication (staff use daily, but not technical)
- Zero tolerance for issues (blocks work if down)
- Business hours support (9-5 email)
- 5 active users, 100-500 transactions/day
- Single location (US warehouse)

**Deployment**: On-premise (local server in warehouse)
**Complexity**: 10k-100k LoC (existing brownfield), Node.js + PostgreSQL, moderate technical debt
**Team**: 2 developers (part-time, 20hrs/week), 1 operations manager (requirements)
**Budget**: $500/month (server maintenance), refactor scope: baseline, critical-path tests, incremental migration

**Priorities** (weights):
- Reliability: 0.40 (staff can't work if app is down)
- Quality: 0.30 (data integrity critical for inventory)
- Cost: 0.20 (budget-conscious, but uptime worth investment)
- Speed: 0.10 (stable users, features can wait for quality)

**Regulatory**: None (internal tool, no PII, inventory data only)

**Intent**: "Documenting existing brownfield system to prepare for refactor. App works but has technical debt limiting new features. Need to establish baseline, plan modernization, onboard new developer."

**What's uncertain**: "Should we refactor incrementally or rewrite? Current app is tangled but functional. Team split on approach."

**Framework Application**:
- Templates: Intake, basic requirements (user stories), lightweight architecture (component diagram), test plan (critical paths), runbook (deployment, backup)
- Commands: intake-from-codebase, flow-iteration-dual-track, build-poc (test refactor approaches)
- Agents: code-reviewer, test-engineer, database-optimizer (performance critical)
- Rigor: Moderate (structured docs for 2-person team, but not enterprise-level)

**Rationale**: "Small internal app with established users needs moderate structure. Operations depend on reliability, so tests and runbook are critical. Skip enterprise templates (no compliance, no contracts). Lightweight architecture docs help new developer onboard."

### Example 3: B2B SaaS Platform

**Project Description**: "Project management SaaS for software teams, 500 paying customers (2000+ users), multi-tenant cloud (AWS), $500k ARR, primary revenue source, growing 20% MoM"

**Audience & Scale**:
- External customers (B2B, paying)
- Technical users (software developers, project managers)
- Expects stability (paying customers, SLA commitments)
- SLA: 99.5% uptime, <1hr response for P1 issues
- 2000+ active users, 10k+ requests/min
- Multi-region (US, EU)

**Deployment**: AWS (ECS, RDS, S3), multi-tier, microservices (5 services)
**Complexity**: 100k+ LoC, TypeScript + Python + PostgreSQL, integration-heavy (GitHub, Slack, Jira APIs)
**Team**: 10 developers, 2 DevOps, 1 security, 1 designer, 2 product managers
**Budget**: $50k/month infrastructure, well-funded (Series A), aggressive growth targets

**Priorities** (weights):
- Reliability: 0.35 (SLA commitments, customer trust)
- Quality: 0.30 (paying customers, security critical)
- Speed: 0.20 (competitive market, need features)
- Cost: 0.15 (funded, but cost-conscious for profitability)

**Regulatory**: GDPR (EU customers), SOC2 Type II (enterprise sales requirement)
**Contractual**: SLA (99.5% uptime), annual penetration testing, customer audits

**Intent**: "Preparing for SOC2 audit (enterprise customer requirement), need to formalize SDLC process, demonstrate controls for auditor, establish baseline for scaling team (hiring 5 more engineers)"

**What's uncertain**: "Which framework components are SOC2-relevant? What level of documentation do auditors expect? Can we lightweight some areas while over-investing in audit-critical controls?"

**Framework Application**:
- Templates: Full suite (intake, requirements, architecture, test, security, deployment, governance)
- Commands: All SDLC flows, security-gate, gate-check, traceability
- Agents: Full complement (40+ agents covering all roles)
- Rigor: Full (comprehensive docs, traceability, gates) - but tailored for SOC2

**Rationale**: "Production SaaS with enterprise customers and SOC2 requirement needs comprehensive framework. All templates relevant for audit trail. Focus on security (threat model, pen tests) and governance (change control, incident response). Can lightweight some areas (prototypes skip full process), but core product needs full rigor."

**Tailoring**: "Over-invest in security and governance (SOC2 critical), maintain full traceability (audit requirement), but allow experimental projects (internal tools, spikes) to use lighter process (skip governance for non-customer-facing work)."

---

## Notes for Intake Process

### Interactive Questions (6-8 of 10 allocated here)

The option matrix captures **intent and trade-offs** - the most nuanced, least observable information. Interactive questions should focus on:

**Priority questions (ask 2-3)**:
1. "You ranked {criterion} as highest priority. Can you expand on why? What would failure look like?"
2. "You're willing to sacrifice {aspect}. What's your threshold? At what point would you revisit that trade-off?"
3. "You mentioned {non-negotiable constraint}. What's the consequence if we compromise on that? Is there flexibility?"

**Decision context questions (ask 2-3)**:
4. "What specific decisions are you trying to make with this intake? What's blocking you?"
5. "You mentioned {controversy/disagreement}. What are the different perspectives? What data would resolve it?"
6. "What's the biggest risk you see in this project? How does that influence your priorities?"

**Evolution questions (ask 1-2)**:
7. "How do you expect this project to change when the next growth or capability trigger occurs? What would trigger more structure?"
8. "If you had 10x the users/budget/team, what would you do differently? What's the growth limiting factor?"

**Framework application questions (ask 1-2)**:
9. "Looking at the templates/commands/agents list, which ones feel like overkill? Which feel essential?"
10. "Where do you want to over-invest relative to typical {project type}? Where can you be lean?"

### Other Files Get 2-4 Questions

**project-intake.md** (1-2 questions max):
- "What problem does this solve? Who benefits?" (if not clear from README/description)
- "What are your success metrics?" (if not documented anywhere)

**solution-profile.md** (1-2 questions max):
- "What are your current pain points?" (technical debt, bottlenecks, operational issues)
- "What do you wish you had invested in earlier?" (for existing projects)

Remaining questions are for **clarifying factual gaps** (tech stack, deployment, team size if not detectable from codebase).

### Principle: Capture Intent, Not Prescribe Solutions

**Good option matrix content** (captures what IS and intent):
- "Personal blog, <100 readers, solo, operator-supplied job-search deadline in 2 weeks (source: applicant); scope: portfolio and verified links"
- "Team split on microservices vs monolith - CTO wants flexibility, CEO wants simplicity"
- "Willing to skip tests initially to launch fast, but non-negotiable on GDPR compliance"

**Bad option matrix content** (prescriptive analysis):
- "Should use MVP profile because small team and limited budget"
- "Microservices inappropriate for this scale, recommend monolith"
- "Need to add automated tests immediately"

Analysis and recommendations go in **solution-profile.md** and **project-intake.md**, not here.
