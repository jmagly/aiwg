# GDPR Compliance Add-On

**Category**: Compliance
**Applies To**: Projects processing EU personal data
**Regulatory Framework**: EU General Data Protection Regulation (GDPR)
**Mandatory For**: EU operations, EU customer data
**Version**: 1.0

## Overview

The GDPR add-on extends the core SDLC with requirements, templates, and gate criteria to ensure compliance with the EU General Data Protection Regulation (Regulation 2016/679).

**Apply this add-on if:**
- You process personal data of EU residents
- You operate services in the EU
- You target EU customers
- You have EU employees

**Do NOT apply if:**
- No EU personal data is processed
- Operations are entirely outside EU jurisdiction
- Only anonymous/aggregated EU data (verify with legal counsel)

## What This Add-On Provides

### 1. GDPR Requirements
- Privacy principles (lawfulness, fairness, transparency, purpose limitation, data minimization, accuracy, storage limitation, integrity/confidentiality, accountability)
- Lawful basis for processing (6 bases: consent, contract, legal obligation, vital interests, public task, legitimate interests)
- Data subject rights (access, rectification, erasure, restriction, portability, objection, automated decision-making)
- Privacy by design and by default
- Data Protection Impact Assessments (DPIAs)
- Breach notification (72-hour rule)
- Cross-border data transfers (adequacy decisions, SCCs, BCRs)

###  2. Templates (10 templates)

Located in `templates/`:

**Privacy Assessments:**
- `privacy-impact-assessment-template.md` - DPIA for high-risk processing
- `dpia-trigger-assessment-checklist.md` - When DPIA is required

**Legal Basis & Consent:**
- `lawful-basis-assessment-template.md` - Selecting GDPR Article 6 basis
- `consent-management-template.md` - Consent capture, storage, withdrawal

**Data Subject Rights:**
- `data-subject-rights-workflow-template.md` - DSR workflows (30-day SLA)
- `data-retention-deletion-policy-template.md` - Retention schedules, deletion

**Cross-Border Transfers:**
- `cross-border-transfer-assessment-template.md` - SCCs, TIAs, adequacy

**Privacy by Design:**
- `privacy-by-design-checklist.md` - GDPR Article 25 compliance

**Data Processing:**
- `data-processing-agreement-template.md` - Processor obligations (Art. 28)

**Breach Response:**
- `breach-notification-plan-template.md` - 72-hour notification procedures

### 3. Gate Criteria Additions

**Inception Gate:**
- [ ] GDPR applicability assessed (processing EU data?)
- [ ] DPIA trigger assessment completed
- [ ] Lawful basis identified for each processing activity
- [ ] Data protection roles assigned (DPO if required)

**Elaboration Gate:**
- [ ] DPIA completed (if required)
- [ ] Privacy by design incorporated into architecture
- [ ] Data minimization validated
- [ ] Cross-border transfer mechanisms identified (if applicable)
- [ ] Data subject rights workflows defined

**Construction Gate:**
- [ ] Consent management implemented (if consent is lawful basis)
- [ ] Data subject rights endpoints implemented
- [ ] Data retention policies configured
- [ ] Privacy settings default to most protective
- [ ] Breach detection mechanisms in place

**Transition Gate:**
- [ ] Data Processing Agreements signed with processors
- [ ] Breach notification plan tested
- [ ] Privacy policy published and accessible
- [ ] Cookie consent (if applicable) functional
- [ ] Records of processing activities documented

## Integration with Core SDLC

### Project Intake
**Add to `project-intake-template.md`:**

```markdown
## GDPR Compliance Assessment

**Does this project process EU personal data?**
- [ ] Yes → **APPLY GDPR ADD-ON** (`add-ons/compliance/gdpr/`)
- [ ] No → Skip GDPR add-on
- [ ] Unsure → Consult legal/privacy counsel

**If YES, complete:**
- [ ] Identify types of personal data processed
- [ ] Identify data subjects (customers, employees, etc.)
- [ ] Identify processing purposes
- [ ] Assign Data Protection Officer (if required)
```

### Architecture Template
**Add to `software-architecture-doc-template.md`:**

```markdown
## Privacy by Design (GDPR Add-On)

**If GDPR applies, complete `./templates/privacy-by-design-checklist.md`**

**Key Architectural Decisions for Privacy:**
- Data minimization: What data is NOT collected?
- Purpose limitation: How is data use restricted?
- Storage limitation: What are retention periods?
- Security measures: Encryption, access controls, monitoring
- Data subject rights: How are DSRs handled technically?
```

### Test Plan
**Add to test strategy:**

```markdown
## GDPR Compliance Testing (If Applicable)

**Test data subject rights workflows:**
- [ ] Right of access (download user data)
- [ ] Right to rectification (update user data)
- [ ] Right to erasure (delete user account)
- [ ] Right to restriction (disable processing)
- [ ] Right to portability (export user data)
- [ ] Right to object (opt-out)

**Test consent management:**
- [ ] Consent capture is clear and affirmative
- [ ] Consent withdrawal is as easy as giving consent
- [ ] Consent audit trail is maintained

**Test data retention:**
- [ ] Data is deleted after retention period
- [ ] Deletion is irreversible (not just logical delete)
- [ ] Backups are purged appropriately
```

## Quick Start

### Step 1: Assess Applicability (5 minutes)
Use `agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/dpia-trigger-assessment-checklist.md` to determine if GDPR applies to your project.

### Step 2: Identify Lawful Basis (30 minutes)
Use `agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/lawful-basis-assessment-template.md` to select GDPR Article 6 lawful basis for each processing activity.

### Step 3: Complete DPIA (If Required) (2-4 hours)
If trigger checklist indicates high risk, complete `agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/privacy-impact-assessment-template.md`.

### Step 4: Implement Privacy by Design (Throughout Development)
Use `agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/privacy-by-design-checklist.md` during architecture and construction phases.

### Step 5: Implement Data Subject Rights (Construction)
Use `agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/data-subject-rights-workflow-template.md` to build DSR endpoints.

### Step 6: Prepare for Compliance (Transition)
Complete:
- Data Processing Agreements (`agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/data-processing-agreement-template.md`)
- Breach Notification Plan (`agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/breach-notification-plan-template.md`)
- Data Retention Policy (`agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/data-retention-deletion-policy-template.md`)

## Common Scenarios

### Scenario 1: SaaS Product with EU Customers
**Apply:**
- Lawful basis: Likely "contract" (Art. 6.1.b)
- DPIA: Required if automated profiling or large-scale processing
- Cross-border: If US-based, apply SCCs for EU-US transfers
- DSRs: Must implement all 7 rights
- Breach: 72-hour notification plan required

### Scenario 2: Internal Tool with EU Employee Data
**Apply:**
- Lawful basis: Likely "legitimate interests" (Art. 6.1.f) or "legal obligation" (Art. 6.1.c)
- DPIA: Required if monitoring employees
- Cross-border: If data leaves EU, apply SCCs
- DSRs: Employees have same rights as customers
- Breach: 72-hour notification plan required

### Scenario 3: Marketing Website with EU Visitors
**Apply:**
- Lawful basis: "Consent" for cookies/tracking (Art. 6.1.a)
- DPIA: Unlikely unless extensive profiling
- Consent management: Cookie consent banner required
- DSRs: Visitors can request data deletion
- Breach: Low risk if only behavioral data

## GDPR + Other Regulations

### GDPR + CCPA
- Apply BOTH add-ons
- Most restrictive requirement wins (e.g., GDPR 30-day DSR vs CCPA 45-day)
- Some rights differ (GDPR erasure vs CCPA deletion)

### GDPR + HIPAA
- Apply BOTH add-ons
- HIPAA applies to health data, GDPR to EU personal data
- If EU health data → Both apply
- Higher security standard wins (usually HIPAA)

### GDPR + SOC 2
- Apply BOTH add-ons
- SOC 2 security controls support GDPR security requirements
- GDPR adds privacy-specific requirements (DSRs, consent, DPIAs)

## Resources

- [GDPR Official Text](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- [ICO GDPR Guidance](https://ico.org.uk/for-organisations/gdpr-guidance-and-resources/)
- [EDPB Guidelines](https://edpb.europa.eu/our-work-tools/general-guidance/gdpb-guidelines-recommendations-best-practices_en)
- [CNIL GDPR Guides](https://www.cnil.fr/en/gdpr-developers-guide)

## Version History

- **1.0** (2025-10-15): Initial GDPR add-on with 10 templates

---

**Maintained By**: Privacy Officer
**Last Reviewed**: 2025-10-15
**Next Review**: 2026-04-15 (or when GDPR regulations change)
