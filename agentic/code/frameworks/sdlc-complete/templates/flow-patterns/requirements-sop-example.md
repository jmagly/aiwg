# Requirements Analysis SOP - Example Flow Command

## Frontmatter Metadata

```yaml
---
type: flow-command
category: phase-transition
trigger: ["transition to elaboration", "start requirements analysis"]
complexity: medium
scope_units: [requirements-draft, stakeholder-review, refinement, approved-baseline]
prerequisites:
  - vision-document
  - intake-form
  - stakeholder-approval
outputs:
  - use-cases
  - nfr-modules
  - requirements-traceability-matrix
related_agents:
  - requirements-specialist
  - technical-designer
  - test-architect
metagpt_pattern: sequential
---
```

## Command Overview

**Purpose**: Expand approved vision into detailed, testable requirements documentation with use cases and non-functional requirement modules.

**When to Use**: After vision document is approved by stakeholders and project has passed inception phase gate.

**Expected Outcome**: Baselined requirements in `.aiwg/requirements/` directory, ready for architecture and design work.

## Standard Operating Procedure

### Prerequisites (Blocking)

**Artifact Prerequisites**:
- [ ] @.aiwg/intake/intake-form.md - Project context, scope, constraints
- [ ] @.aiwg/intake/vision-document.md - Approved business vision and goals
- [ ] @.aiwg/intake/stakeholder-requests.md - Initial stakeholder input

**State Prerequisites**:
- [ ] Inception phase gate approved
- [ ] Stakeholder sign-off obtained for vision document
- [ ] Project team assigned and notified

**Validation**: Before proceeding, verify all prerequisites exist and vision document has approval signature.

### Workflow Steps

**Step 1: Requirements Specialist - Requirements Elicitation**

**Input Artifacts**:
- @.aiwg/intake/vision-document.md
- @.aiwg/intake/intake-form.md (for constraints and scope)
- @.aiwg/intake/stakeholder-requests.md (for user needs)

**Action Sequence**:
1. Load and validate input artifacts:
   - Check vision document has "Approved" status
   - Verify product goals are clear (3-5 defined goals)
   - Confirm target users/personas identified
2. Perform competitive analysis:
   - Research 3-5 similar products/systems
   - Document strengths, weaknesses, differentiators
   - Generate competitive quadrant chart (if applicable)
3. Extract user stories from vision:
   - Minimum 5 user stories in "As a [role], I want [feature], so that [benefit]" format
   - Prioritize using MoSCoW method (Must, Should, Could, Won't)
   - Link each story to product goals
4. Identify non-functional requirement categories:
   - Review vision for performance, security, scalability needs
   - List NFR categories requiring detailed modules
   - Flag compliance/regulatory requirements
5. Generate Product Requirements Document (PRD) according to schema

**Output Artifact**:
- @.aiwg/requirements/product-requirements-document.md
- Schema: ProductRequirementsDocument (see Output Schema section)

**Available Tools**:
- Web search for competitive analysis
- Document templates from @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/

**Constraints**:
- MUST NOT specify technical implementation details (defer to Technical Designer)
- MUST include traceability to vision document
- MUST hand off to Use Case Analyst after PRD baseline

**Quality Gates** (must pass before proceeding):
- [ ] PRD follows ProductRequirementsDocument schema
- [ ] All required sections populated (no "TBD" markers)
- [ ] Traceability links to vision document valid
- [ ] Minimum 5 user stories documented
- [ ] At least 3 NFR categories identified

---

**Step 2: Requirements Specialist - Use Case Development**

**Subscription Trigger**: PRD from Step 1 validated and published

**Input Artifacts**:
- @.aiwg/requirements/product-requirements-document.md
- @.aiwg/intake/vision-document.md (for reference)

**Pre-Acceptance Validation**:
1. Verify Step 1 PRD quality gates passed
2. Check for blocking issues:
   - [ ] User stories clearly defined
   - [ ] Product goals linked to stories
   - [ ] NFR categories identified
3. If validation fails:
   - Publish issue to @.aiwg/working/requirements-issues.md
   - Block use case development until resolved

**Action Sequence**:
1. Expand user stories into detailed use cases:
   - Assign unique UC-### identifiers (UC-001, UC-002, etc.)
   - Define primary actors and stakeholders
   - Document preconditions, postconditions, triggers
2. For each use case, document:
   - Main success scenario (numbered steps)
   - Alternate flows (branching paths)
   - Exception flows (error handling)
   - Special requirements (NFRs specific to this UC)
3. Create use case briefs for simple scenarios
4. Create full use case specifications for complex scenarios
5. Establish traceability matrix linking:
   - User stories → Use cases
   - Use cases → Product goals
   - Use cases → NFR categories

**Output Artifacts**:
- @.aiwg/requirements/use-cases/UC-###-[name].md (one per use case)
- @.aiwg/requirements/requirements-traceability-matrix.md

**Quality Gates**:
- [ ] Each use case has unique ID
- [ ] Main flow documented with numbered steps
- [ ] Preconditions and postconditions defined
- [ ] Traceability to user stories established
- [ ] Minimum 3 use cases created

---

**Step 3: Requirements Specialist - NFR Module Creation**

**Subscription Trigger**: Use cases from Step 2 baselined

**Input Artifacts**:
- @.aiwg/requirements/product-requirements-document.md
- @.aiwg/requirements/use-cases/*.md (all use cases)

**Action Sequence**:
1. For each NFR category identified in PRD:
   - Create dedicated NFR module document
   - Document specific requirements with measurable criteria
   - Link to affected use cases
2. Common NFR categories:
   - Security: Authentication, authorization, encryption, compliance
   - Performance: Response times, throughput, scalability
   - Reliability: Uptime, error rates, fault tolerance
   - Usability: Accessibility, user experience standards
   - Maintainability: Code standards, documentation requirements
3. Define acceptance criteria for each NFR:
   - Measurable: "95% uptime" not "high availability"
   - Testable: Specific test conditions
   - Traceable: Links to use cases affected
4. Flag regulatory/compliance requirements requiring validation

**Output Artifacts**:
- @.aiwg/requirements/nfr-modules/security.md
- @.aiwg/requirements/nfr-modules/performance.md
- @.aiwg/requirements/nfr-modules/[category].md (one per NFR category)

**Quality Gates**:
- [ ] At least 3 NFR modules created
- [ ] All NFRs have measurable criteria
- [ ] Traceability to use cases established
- [ ] Compliance requirements flagged

---

**Step 4: Requirements Specialist - Requirements Baseline**

**Subscription Trigger**: All NFR modules from Step 3 completed

**Action Sequence**:
1. Aggregate all requirements artifacts
2. Validate completeness:
   - PRD complete with no "anything_unclear" sections
   - All user stories linked to use cases
   - All use cases have NFRs identified
   - Traceability matrix complete
3. Generate requirements summary report
4. Publish baseline to designated directory
5. Notify downstream agents (Technical Designer, Test Architect)

**Output**:
- Baseline manifest: @.aiwg/requirements/requirements-baseline-v1.md
- Notification to Technical Designer (subscribes to requirements baseline)
- Notification to Test Architect (subscribes to requirements baseline)

**Quality Gates**:
- [ ] All artifacts follow schemas
- [ ] Traceability complete (no broken @-mentions)
- [ ] Token efficiency within target (< 150 tokens/section)
- [ ] No blocking issues in working directory

### Exit Criteria (Gate Approval)

**Artifact Completeness**:
- [ ] PRD published and validated
- [ ] Minimum 3 use cases documented
- [ ] Minimum 3 NFR modules created
- [ ] Requirements traceability matrix complete
- [ ] Baseline manifest generated

**Quality Validation**:
- [ ] All outputs follow specified schemas
- [ ] No "TBD" or "anything_unclear" markers
- [ ] All @-mentions resolve to existing files
- [ ] Measurable acceptance criteria defined

**Handoff Readiness**:
- [ ] Technical Designer notified (subscribed to requirements/)
- [ ] Test Architect notified (subscribed to requirements/)
- [ ] Elaboration phase gate documentation updated
- [ ] Stakeholder review scheduled

## Output Schemas

### Schema: ProductRequirementsDocument

**Purpose**: Structured document capturing business requirements, competitive analysis, user needs, and NFR categories

**File Location**: @.aiwg/requirements/product-requirements-document.md

**Required Sections**:

```markdown
# Product Requirements Document (PRD)

## 1. Original Requirements
**Purpose**: Capture raw user input and vision statement
**Format**: Prose from vision document
**Validation Rules**:
- MUST link to @.aiwg/intake/vision-document.md
- MUST preserve original language (no interpretation yet)

**Example**:
"Build a web-based task management application for distributed teams..."

## 2. Product Goals
**Purpose**: Define 3-5 measurable business objectives
**Format**: List
**Validation Rules**:
- MUST have 3-5 goals (no more, no fewer)
- MUST be specific and measurable
- MUST NOT include technical implementation details

**Example**:
- Increase team productivity by 20% through better task visibility
- Reduce project communication overhead by centralizing updates
- Support teams up to 50 members with sub-5s response times

## 3. User Stories
**Purpose**: Capture user needs in testable format
**Format**: List in "As a [role], I want [feature], so that [benefit]" format
**Validation Rules**:
- MUST have minimum 5 user stories
- MUST follow standard format
- MUST link to product goals
- MUST prioritize using MoSCoW (Must/Should/Could/Won't)

**Example**:
- (Must) As a project manager, I want to create tasks, so that I can delegate work
- (Should) As a team member, I want to filter tasks by priority, so that I focus on what matters

## 4. Competitive Analysis
**Purpose**: Document competitor landscape and differentiators
**Format**: List of competitors with strengths/weaknesses
**Validation Rules**:
- MUST include 3-5 competitors
- MUST identify our differentiators

**Example**:
- Asana: Strong features but complex UI (Our advantage: simplicity)
- Trello: Simple but lacks advanced features (Our advantage: depth without complexity)

## 5. Requirement Analysis
**Purpose**: Synthesize requirements and identify gaps
**Format**: Prose analysis
**Validation Rules**:
- MUST identify requirement dependencies
- MUST flag ambiguities needing clarification

## 6. Requirement Pool
**Purpose**: Categorized list of all functional requirements
**Format**: Table with columns: Requirement | Priority | Category
**Validation Rules**:
- MUST include all functional requirements
- MUST assign P0 (critical) / P1 (high) / P2 (nice-to-have)

**Example**:
| Requirement | Priority | Category |
|-------------|----------|----------|
| User authentication | P0 | Security |
| Task creation | P0 | Core Feature |
| Email notifications | P1 | Integration |

## 7. Non-Functional Requirement Categories
**Purpose**: Identify NFR areas requiring detailed modules
**Format**: List of categories with brief justification
**Validation Rules**:
- MUST identify at least 3 NFR categories
- MUST justify why each is critical

**Example**:
- Security: Handles sensitive business data, requires authentication/authorization
- Performance: Real-time collaboration demands sub-5s response times
- Scalability: Must support teams up to 50 members

## 8. Anything Unclear
**Purpose**: Document open questions requiring stakeholder clarification
**Format**: List of questions
**Validation Rules**:
- MUST be empty before baseline approval
- Used during drafting to track gaps

**Example** (during drafting):
- Should we support single sign-on (SSO)?
- What is maximum attachment size for tasks?

## References
**Required @-mentions**:
- @.aiwg/intake/vision-document.md - Source vision
- @.aiwg/intake/intake-form.md - Project constraints
- @.aiwg/requirements/use-cases/*.md - Derived use cases (after Step 2)
```

**Quality Gates**:
- [ ] All 8 sections present
- [ ] "Anything Unclear" section is empty (all questions resolved)
- [ ] Minimum 5 user stories
- [ ] 3-5 product goals
- [ ] 3-5 competitors analyzed
- [ ] At least 3 NFR categories identified

---

### Schema: UseCaseSpecification

**Purpose**: Detailed interaction flow between actors and system

**File Location**: @.aiwg/requirements/use-cases/UC-###-[name].md

**Required Sections**:

```markdown
# UC-### - [Use Case Name]

## 1. Use-Case Identifier and Name
**Format**: UC-### followed by descriptive name
**Example**: UC-001 - User Login

## 2. Primary Actor(s)
**Format**: List of actors initiating this use case
**Example**:
- Registered User
- System Administrator (for admin login variant)

## 3. Preconditions
**Format**: List of conditions that must be true before execution
**Example**:
- User has valid account credentials
- System is online and accessible
- User is not already authenticated

## 4. Trigger
**Format**: Event that starts this use case
**Example**: User navigates to login page

## 5. Main Success Scenario
**Format**: Numbered steps showing primary path
**Validation**: Each step must reference an actor
**Example**:
1. User enters email address
2. User enters password
3. User clicks "Login" button
4. System validates credentials
5. System creates session token
6. System redirects user to dashboard

## 6. Alternate Flows
**Format**: Branching paths with conditions
**Example**:
- 3a. User clicks "Forgot Password" → Navigate to password reset flow
- 5a. Credentials invalid → Display error, allow retry (max 3 attempts)

## 7. Exception Flows
**Format**: Error handling and rollback procedures
**Example**:
- 4a. Database connection fails → Display "Service temporarily unavailable", log error
- 5a. Account locked (3 failed attempts) → Display lockout message, send unlock email

## 8. Postconditions
**Format**: Outcomes on successful completion
**Example**:
- User is authenticated with active session
- User session logged to audit trail
- Dashboard displays with user's tasks loaded

## 9. Special Requirements
**Format**: NFRs specific to this use case
**Validation**: MUST link to NFR modules
**Example**:
- @.aiwg/requirements/nfr-modules/security.md#password-encryption - Passwords must be hashed with bcrypt
- @.aiwg/requirements/nfr-modules/performance.md#login-response - Login must complete in < 2 seconds

## References
**Required @-mentions**:
- @.aiwg/requirements/product-requirements-document.md - Source user story
- @.aiwg/requirements/nfr-modules/*.md - Related NFRs
- @.aiwg/architecture/software-architecture-doc.md - Architecture (after design phase)
```

**Quality Gates**:
- [ ] Unique UC-### identifier
- [ ] Main success scenario has numbered steps
- [ ] At least 1 alternate flow documented
- [ ] Preconditions and postconditions defined
- [ ] Special requirements link to NFR modules

---

### Schema: NFRModule

**Purpose**: Detailed non-functional requirements for a specific category

**File Location**: @.aiwg/requirements/nfr-modules/[category].md

**Required Sections**:

```markdown
# NFR Module: [Category Name]

## 1. Category Overview
**Purpose**: Why this NFR category is critical
**Example**:
Security is critical because the application handles sensitive business data
and must comply with GDPR regulations.

## 2. Specific Requirements

### REQ-SEC-001: [Requirement Name]
**Description**: [Detailed requirement]
**Measurable Criteria**: [How to verify compliance]
**Affected Use Cases**: [List of UC-### impacted]
**Priority**: [P0 | P1 | P2]

**Example**:
### REQ-SEC-001: Password Encryption
**Description**: All user passwords must be encrypted using bcrypt with salt
**Measurable Criteria**:
- bcrypt algorithm with cost factor >= 10
- No plaintext passwords in database
- Salt unique per user
**Affected Use Cases**:
- UC-001 (User Login)
- UC-005 (Password Reset)
- UC-012 (Account Creation)
**Priority**: P0 (critical)

[Continue for each requirement in category]

## 3. Testing Strategy
**Format**: How these NFRs will be validated
**Example**:
- Unit tests: Verify password hashing implementation
- Integration tests: Confirm no plaintext in database
- Penetration testing: Attempt credential extraction

## 4. Compliance Notes
**Format**: Regulatory/standard requirements
**Example**:
- GDPR Article 32: "appropriate technical measures" for data security
- NIST 800-63B: Password storage guidelines

## References
**Required @-mentions**:
- @.aiwg/requirements/use-cases/*.md - Affected use cases
- @.aiwg/requirements/product-requirements-document.md - Source PRD
- @.aiwg/testing/test-strategy.md - Testing approach (after test planning)
```

**Quality Gates**:
- [ ] Category overview justifies criticality
- [ ] At least 3 specific requirements documented
- [ ] All requirements have measurable criteria
- [ ] Affected use cases identified
- [ ] Testing strategy defined

## Subscription Rules

### Requirements Specialist Subscription

**Activates When**:
- Receives artifact type: vision-document (approval status)
- From directory: @.aiwg/intake/vision-document.md
- Published by: Product Owner / Stakeholders

**Filters**:
- ONLY processes vision documents with "Approved" status
- IGNORES drafts or documents marked "In Review"

**Publishes**:
- Artifact types: ProductRequirementsDocument, UseCaseSpecification, NFRModule
- To directories:
  - @.aiwg/requirements/product-requirements-document.md
  - @.aiwg/requirements/use-cases/
  - @.aiwg/requirements/nfr-modules/
- Notifies: Technical Designer, Test Architect

---

### Technical Designer Subscription

**Activates When**:
- Receives artifact type: requirements-baseline
- From directory: @.aiwg/requirements/
- Published by: Requirements Specialist

**Filters**:
- Requires complete baseline (PRD + use cases + NFR modules)
- Verifies traceability matrix exists

**Publishes** (downstream):
- Software Architecture Document
- Architecture Decision Records (ADRs)

---

### Test Architect Subscription

**Activates When**:
- Receives artifact types: UseCaseSpecification, NFRModule
- From directories: @.aiwg/requirements/use-cases/, @.aiwg/requirements/nfr-modules/
- Published by: Requirements Specialist

**Filters**:
- Focuses on acceptance criteria and testability
- Identifies use cases requiring detailed test plans

**Publishes** (downstream):
- Master Test Plan
- Test Case Specifications

## Handoff Checklist

Before marking this flow as complete, verify:

**Artifact Publication**:
- [ ] PRD in @.aiwg/requirements/product-requirements-document.md
- [ ] Use cases in @.aiwg/requirements/use-cases/ (minimum 3)
- [ ] NFR modules in @.aiwg/requirements/nfr-modules/ (minimum 3)
- [ ] Traceability matrix in @.aiwg/requirements/requirements-traceability-matrix.md
- [ ] No artifacts left in @.aiwg/working/ (cleanup done)

**Traceability Validation**:
- [ ] PRD → Use Cases links valid
- [ ] Use Cases → NFR Modules links valid
- [ ] Traceability matrix complete (no broken @-mentions)
- [ ] Vision document → PRD → Use Cases chain established

**Quality Assurance**:
- [ ] All artifacts follow schemas
- [ ] No "TBD" or "anything_unclear" markers
- [ ] Measurable acceptance criteria for all NFRs
- [ ] Minimum quality gates passed

**Downstream Notification**:
- [ ] Technical Designer subscribed to requirements baseline
- [ ] Test Architect subscribed to use cases and NFRs
- [ ] Phase gate documentation updated
- [ ] Stakeholder review scheduled

**Token Efficiency**:
- [ ] Average < 150 tokens per major section
- [ ] @-mentions used instead of content duplication
- [ ] Numbered steps used instead of verbose prose

## Post-Completion

After this flow completes successfully:

### 1. Workspace Health Check

Run: `/project-status` or ask "check workspace health"

Verifies:
- Requirements baseline properly published
- No stale drafts in .aiwg/working/
- Traceability links valid

### 2. Common Follow-up Actions

**Immediate Next Steps**:
- Schedule stakeholder review of requirements
- Transition to Elaboration phase (architecture and design)
- Invoke: "transition to elaboration" or `/flow-inception-to-elaboration`

**If issues found**:
- Refine unclear requirements with stakeholders
- Resolve traceability gaps
- Update baseline and notify subscribers

### 3. Prerequisite Gates

**Before Architecture Work**:
- Stakeholder review: requirements draft available; stakeholder comments recorded
- Requirement refinements: comments resolved and traceability checks pass
- Baseline approval: designated approver accepts the refined requirements

**Completion Gate**: Approved baseline and resolved traceability gaps before architecture work; requirements analyst owns refinement and stakeholders own approval.

## Usage Notes

**Token Efficiency in Practice**:

This example demonstrates efficiency patterns:
- **PRD Section 2 (Product Goals)**: List format = 15 tokens vs. prose = 40+ tokens
- **Use Case Main Flow**: Numbered steps = 8 tokens/step vs. paragraphs = 25+ tokens/step
- **NFR Requirements**: Structured template = 30 tokens vs. free-form = 80+ tokens

**Hallucination Prevention**:

Requirements Specialist constraints prevent:
- Technical implementation decisions (deferred to Technical Designer)
- Code/pseudocode in requirements (deferred to Developer)
- Test implementation details (deferred to Test Engineer)

**Quality Validation**:

Handoff validation ensures:
- Technical Designer receives complete, validated requirements
- Test Architect has testable acceptance criteria
- No ambiguity in downstream work

## Metrics Tracking

Track these metrics to validate effectiveness:

| Metric | Target | Rationale |
|--------|--------|-----------|
| Use Cases per PRD | 3-8 | Enough coverage, not overwhelming |
| NFR Modules | 3-5 | Core categories without over-specification |
| Token Efficiency | < 150 tokens/section | MetaGPT baseline |
| Human Corrections | < 1.5 per artifact | MetaGPT baseline |
| Traceability Coverage | 95%+ | All requirements linked |
| Rework Rate | < 10% | Requirements stable after baseline |

## References

- @.aiwg/research/docs/sop-encoding-guide.md - SOP encoding principles
- @$AIWG_ROOT/docs/references/REF-013-metagpt-multi-agent-framework.md - MetaGPT research
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-spec-template.md - Use case template
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/vision-template.md - Vision document template
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/requirements-specialist.md - Agent definition

## Metadata

**Created**: 2026-01-25
**Last Updated**: 2026-01-25
**Pattern Source**: MetaGPT REF-013 (ICLR 2024)
**Issue**: #99 - MetaGPT SOP Templates
**Example Status**: Reference Implementation

---

**Template Version**: 1.0.0
**License**: CC-BY-4.0
**Part of**: AIWG SDLC Framework - Flow Patterns Collection
