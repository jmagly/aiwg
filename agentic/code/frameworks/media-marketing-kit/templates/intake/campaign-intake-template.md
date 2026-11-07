# Campaign Intake Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Document Control

| Field | Value |
|-------|-------|
| **Template Version** | 1.0.0 |
| **Last Updated** | 2025-01-28 |
| **Owner** | Intake Coordinator |
| **Status** | DRAFT |
| **Campaign ID** | [Auto-generated or manual] |

---

## YAML Frontmatter

```yaml
campaign:
  id: "[CAMPAIGN-ID]"
  name: "[Campaign Name]"
  type: "[Brand Awareness | Lead Generation | Product Launch | Event Promotion | Seasonal | Other]"
  status: "INTAKE"

intake:
  submitted_by: "[Name]"
  submission_date: "[YYYY-MM-DD]"
  requester_email: "[email@domain.com]"
  department: "[Marketing | Sales | Product | Other]"

priority:
  level: "[Critical | High | Medium | Low]"
  business_driver: "[Revenue | Brand | Compliance | Competitive | Other]"

timeline:
  source: "[Operator-supplied commitment reference, or unset]"
  scope_units: "[Deliverables, owners, passes, and completion gates]"
  requested_start: "[YYYY-MM-DD]"
  requested_launch: "[YYYY-MM-DD]"
  requested_end: "[YYYY-MM-DD]"
  flexibility: "[Fixed | Flexible | Date-Driven]"
```

---

## 1. Campaign Overview

### 1.1 Campaign Name and Type

**Campaign Name**: [Official campaign name]

**Campaign Type**: [Select one or more]

- [ ] Brand Awareness
- [ ] Lead Generation
- [ ] Product Launch
- [ ] Event Promotion
- [ ] Seasonal/Holiday
- [ ] Customer Retention
- [ ] Thought Leadership
- [ ] Partnership/Co-marketing
- [ ] Other: [Specify]

**Campaign Tagline/Theme**: [Brief thematic statement or tagline]

### 1.2 Campaign Objectives

**Primary Objective**: [What is the single most important goal?]

**Secondary Objectives**: [List 2-3 supporting goals]

1. [Objective 1]
2. [Objective 2]
3. [Objective 3]

**Business Context**: [Why are we running this campaign now? What business need does it address?]

```text
[Describe the business context, market conditions, competitive landscape,
or strategic initiatives that make this campaign necessary/timely]
```

### 1.3 Campaign Description

**Executive Summary**: [2-3 sentence campaign overview for executives]

```text
[Concise summary suitable for leadership briefings]
```

**Detailed Description**: [Comprehensive campaign description]

```text
[Provide full context including:
- What the campaign will communicate
- How it fits into broader marketing strategy
- Key creative or strategic themes
- Integration with other initiatives]
```

---

## 2. Scope and Gates

### 2.1 Delivery Gates

| Milestone | Completion Gate | Owner | Status |
|-----------|------|-------|--------|
| Campaign Brief Approval | [Acceptance checks for Campaign Brief Approval pass] | [Name] | [ ] |
| Creative Development Start | [Acceptance checks for Creative Development Start pass] | [Name] | [ ] |
| Content Production Complete | [Acceptance checks for Content Production Complete pass] | [Name] | [ ] |
| Internal Review Complete | [Acceptance checks for Internal Review Complete pass] | [Name] | [ ] |
| Final Approval | [Acceptance checks for Final Approval pass] | [Name] | [ ] |
| Campaign Launch | [Acceptance checks for Campaign Launch pass] | [Name] | [ ] |
| Campaign End | [Acceptance checks for Campaign End pass] | [Name] | [ ] |
| Post-Campaign Analysis Due | [Acceptance checks for Post-Campaign Analysis Due pass] | [Name] | [ ] |

### 2.2 Campaign Phases

**Phase 1: Pre-Launch** [Required input verified; deliverable accepted]

- [ ] [Activity]
- [ ] [Activity]
- [ ] [Activity]

**Phase 2: Launch** [Required input verified; deliverable accepted]

- [ ] [Activity]
- [ ] [Activity]
- [ ] [Activity]

**Phase 3: Active Campaign** [Required input verified; deliverable accepted]

- [ ] [Activity]
- [ ] [Activity]
- [ ] [Activity]

**Phase 4: Post-Campaign** [Required input verified; deliverable accepted]

- [ ] [Activity]
- [ ] [Activity]
- [ ] [Activity]

### 2.3 Critical Dependencies

**Date-Driven Constraints**: [Events, seasons, product releases, etc.]

```text
[Describe any fixed dates that cannot move (trade shows, holidays,
product launches, fiscal periods, etc.)]
```

**Timeline Flexibility**: [Which dates are negotiable vs. fixed]

---

## 3. Target Audience

### 3.1 Primary Audience

**Audience Segment**: [Primary target audience name/description]

**Quick Profile**:

- **Demographics**: [Age, location, income, education, job title/role]
- **Psychographics**: [Values, interests, lifestyle]
- **Behavioral**: [Buying behavior, content consumption, channel preferences]

**Audience Size**: [Estimated reach/addressable market]

**Reference Profile**: [Link to detailed audience profile document if available]

### 3.2 Secondary Audiences

**Audience 2**: [Name/description]

- Quick profile: [Brief description]
- Priority: [High | Medium | Low]

**Audience 3**: [Name/description]

- Quick profile: [Brief description]
- Priority: [High | Medium | Low]

### 3.3 Audience Insights

**Pain Points**: [What challenges does this audience face?]

1. [Pain point 1]
2. [Pain point 2]
3. [Pain point 3]

**Motivations**: [What drives their decisions?]

1. [Motivation 1]
2. [Motivation 2]
3. [Motivation 3]

**Objections**: [What might prevent conversion?]

1. [Objection 1]
2. [Objection 2]
3. [Objection 3]

---

## 4. Budget and Resources

### 4.1 Budget Overview

**Total Campaign Budget**: $[Amount]

**Budget Breakdown**:

| Category | Allocated | Notes |
|----------|-----------|-------|
| Media/Advertising | $[Amount] | [Channels, platforms] |
| Content Production | $[Amount] | [Video, design, copy] |
| Technology/Tools | $[Amount] | [Platforms, software, licenses] |
| Agency/Vendor Fees | $[Amount] | [External partners] |
| Influencer/Partnership | $[Amount] | [Partnerships, sponsorships] |
| Events/Experiences | $[Amount] | [Physical or virtual events] |
| Contingency (10-20%) | $[Amount] | [Reserve for unknowns] |
| **TOTAL** | **$[Amount]** | |

**Budget Authority**: [Who approves budget changes?]

**Budget Constraints**: [Any limitations or guardrails]

```text
[Describe any budget restrictions, approval thresholds, or fiscal considerations]
```

### 4.2 Resource Requirements

**Internal Team**:

| Role | Name | Allocation | Responsibility |
|------|------|------------|----------------|
| Campaign Manager | [Name] | [%/hours] | [Overall coordination] |
| Content Lead | [Name] | [%/hours] | [Content strategy, creation] |
| Design Lead | [Name] | [%/hours] | [Creative direction, assets] |
| Media Buyer | [Name] | [%/hours] | [Ad placement, optimization] |
| Analytics Lead | [Name] | [%/hours] | [Measurement, reporting] |
| [Other Role] | [Name] | [%/hours] | [Responsibility] |

**External Partners**:

| Partner | Service | Budget | Contact |
|---------|---------|--------|---------|
| [Agency/Vendor] | [Service type] | $[Amount] | [Contact name, email] |
| [Agency/Vendor] | [Service type] | $[Amount] | [Contact name, email] |

**Technology/Platforms**:

- [ ] [Platform 1] - [Purpose]
- [ ] [Platform 2] - [Purpose]
- [ ] [Platform 3] - [Purpose]

---

## 5. Success Metrics

### 5.1 Primary KPIs

**KPI 1**: [Metric name]

- **Target**: [Specific goal with number]
- **Measurement Method**: [How will we measure?]
- **Reporting Frequency**: [Daily | Weekly | Monthly]

**KPI 2**: [Metric name]

- **Target**: [Specific goal with number]
- **Measurement Method**: [How will we measure?]
- **Reporting Frequency**: [Daily | Weekly | Monthly]

**KPI 3**: [Metric name]

- **Target**: [Specific goal with number]
- **Measurement Method**: [How will we measure?]
- **Reporting Frequency**: [Daily | Weekly | Monthly]

### 5.2 Secondary Metrics

| Metric | Target | Baseline | Measurement |
|--------|--------|----------|-------------|
| [Metric] | [Goal] | [Current] | [Method] |
| [Metric] | [Goal] | [Current] | [Method] |
| [Metric] | [Goal] | [Current] | [Method] |
| [Metric] | [Goal] | [Current] | [Method] |

### 5.3 Success Criteria

**Campaign Success Defined As**: [What constitutes success?]

```text
[Describe the combination of metrics, outcomes, or achievements that
would make this campaign a success]
```

**ROI Expectations**: [Expected return on investment]

- **Revenue Target**: $[Amount] (if applicable)
- **Cost per Acquisition**: $[Amount]
- **Expected ROI**: [X]%

---

## 6. Stakeholders and Governance

### 6.1 Stakeholder Map

| Name | Role | Involvement Level | Approval Authority |
|------|------|-------------------|-------------------|
| [Name] | Executive Sponsor | [High | Medium | Low] | [Yes | No | Final] |
| [Name] | Campaign Owner | [High | Medium | Low] | [Yes | No | Final] |
| [Name] | Creative Reviewer | [High | Medium | Low] | [Yes | No | Final] |
| [Name] | Legal/Compliance | [High | Medium | Low] | [Yes | No | Final] |
| [Name] | Brand Guardian | [High | Medium | Low] | [Yes | No | Final] |
| [Name] | [Other] | [High | Medium | Low] | [Yes | No | Final] |

### 6.2 Approval Process

**Approval Workflow**:

1. [Step 1: Who approves what]
2. [Step 2: Who approves what]
3. [Step 3: Who approves what]
4. [Step 4: Final sign-off]

**Approval SLA**: [How long for each approval stage?]

**Escalation Path**: [Who to escalate to if approvals are delayed?]

### 6.3 Communication Plan

**Stakeholder Updates**:

- **Frequency**: [Weekly | Bi-weekly | Monthly]
- **Format**: [Email | Meeting | Dashboard]
- **Owner**: [Name]

**Status Reporting**:

- **Channel**: [Slack | Email | Project Management Tool]
- **Cadence**: [Daily | Weekly | As-needed]

---

## 7. Channel Strategy (High-Level)

### 7.1 Primary Channels

**Channel 1**: [Channel name]

- **Purpose**: [Awareness | Consideration | Conversion]
- **Budget Allocation**: $[Amount] or [%]
- **Expected Reach**: [Estimated impressions/reach]

**Channel 2**: [Channel name]

- **Purpose**: [Awareness | Consideration | Conversion]
- **Budget Allocation**: $[Amount] or [%]
- **Expected Reach**: [Estimated impressions/reach]

**Channel 3**: [Channel name]

- **Purpose**: [Awareness | Consideration | Conversion]
- **Budget Allocation**: $[Amount] or [%]
- **Expected Reach**: [Estimated impressions/reach]

### 7.2 Channel Mix Rationale

**Why These Channels**: [Brief explanation of channel selection]

```text
[Explain why these channels are appropriate for the audience, objectives,
and budget]
```

---

## 8. Constraints and Risks

### 8.1 Known Constraints

**Budget Constraints**:

- [Constraint description]

**Timeline Constraints**:

- [Constraint description]

**Resource Constraints**:

- [Constraint description]

**Technology Constraints**:

- [Constraint description]

**Regulatory/Compliance Constraints**:

- [Constraint description]

### 8.2 Identified Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| [Risk description] | [High/Med/Low] | [High/Med/Low] | [Mitigation strategy] |
| [Risk description] | [High/Med/Low] | [High/Med/Low] | [Mitigation strategy] |
| [Risk description] | [High/Med/Low] | [High/Med/Low] | [Mitigation strategy] |

---

## 9. Integration and Dependencies

### 9.1 Integration with Other Campaigns

**Related Campaigns**: [List any campaigns this integrates with]

- [Campaign name] - [Relationship/dependency]
- [Campaign name] - [Relationship/dependency]

### 9.2 External Dependencies

**Product/Service Dependencies**: [Product launches, feature releases, etc.]

**Partner Dependencies**: [Partner campaigns, co-marketing, etc.]

**Technology Dependencies**: [Platform launches, integrations, etc.]

**Event Dependencies**: [Trade shows, conferences, holidays, etc.]

---

## 10. Intake Checklist

### 10.1 Required Information

- [ ] Campaign objectives clearly defined
- [ ] Target audience identified
- [ ] Budget confirmed and allocated
- [ ] Timeline established with key dates
- [ ] Success metrics defined with targets
- [ ] Stakeholders identified with approval process
- [ ] Primary channels selected
- [ ] Constraints and risks documented

### 10.2 Supporting Documents

- [ ] Brand brief (attach or reference)
- [ ] Audience profiles (attach or reference)
- [ ] Competitive analysis (if available)
- [ ] Previous campaign results (if relevant)
- [ ] Creative examples or inspiration (if available)

### 10.3 Next Steps

**Upon Approval**:

1. [Action item 1]
2. [Action item 2]
3. [Action item 3]

**Assigned To**: [Name]

**Due Date**: [YYYY-MM-DD]

---

## Agent Notes

### For Intake Coordinator

- **Completeness Check**: Verify all required sections are filled with sufficient detail
- **Stakeholder Validation**: Confirm all stakeholders are identified and available
- **Budget Verification**: Ensure budget is approved and allocated in financial systems
- **Gate Readiness**: Validate prerequisites, role coverage, and acceptance checks; escalate conflicts with supplied commitments
- **Risk Assessment**: Identify any red flags that need escalation before proceeding

### For Campaign Strategist

- **Objective Clarity**: Ensure objectives are SMART (Specific, Measurable, Achievable, Relevant, Time-bound)
- **Audience Alignment**: Verify channel strategy aligns with audience preferences
- **KPI Appropriateness**: Confirm metrics align with objectives and are measurable
- **Integration Opportunities**: Identify potential synergies with other campaigns

### For Brand Manager

- **Brand Consistency**: Verify campaign aligns with brand positioning and guidelines
- **Messaging Review**: Ensure campaign description reflects approved brand messaging
- **Tone Appropriateness**: Confirm campaign tone matches audience and brand voice

### For Legal/Compliance

- **Regulatory Review**: Flag any regulatory or compliance considerations early
- **Claim Validation**: Verify any product claims or competitive comparisons are substantiated
- **Approval Requirements**: Identify required legal/compliance approvals before launch

---

## Template Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-01-28 | MMK Framework Team | Initial template creation |

---

**END OF TEMPLATE**
