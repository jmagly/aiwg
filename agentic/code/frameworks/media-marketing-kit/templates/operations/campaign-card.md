# Campaign Card

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- **ID**: `CAM-{project}-{number}` (e.g., CAM-Q1LAUNCH-001)
- **Type**: Campaign Tracking Card
- **Status**: Draft | Planning | In-Progress | Review | Live | Complete | Archived
- **Owner**: Campaign Manager / Marketing Lead
- **Contributors**: Content Team, Creative Team, Media Buyers, Analytics
- **Reviewers**: VP Marketing, Brand Manager, Legal/Compliance
- **Team**: Marketing Operations
- **Stakeholders**: Executive Sponsor, Sales Leadership, Product Team
- **Created**: YYYY-MM-DD
- **Last Updated**: YYYY-MM-DD
- **Launch Date**: YYYY-MM-DD
- **End Date**: YYYY-MM-DD
- **Priority**: Critical | High | Medium | Low
- **Campaign Type**: Brand Awareness | Lead Generation | Product Launch | Event Promotion | Seasonal | Customer Retention
- **Related**:
  - Strategy: `STR-{id}`
  - Creative Brief: `CRE-{id}`
  - Content Cards: `CNT-{id1}`, `CNT-{id2}`, `CNT-{id3}`
  - Asset Cards: `AST-{id1}`, `AST-{id2}`
  - Reports: `RPT-{id}`
  - Budget: `BDG-{id}`
  - Brand Guidelines: `BRD-{id}`

## Marketing-Specific Metadata

- **KPIs**: [Target metrics: impressions, clicks, conversions, MQLs, SQLs, engagement rate, etc.]
- **Budget**: $[total] (breakdown: paid media $[X], content $[Y], creative $[Z], agency $[W])
- **Scope Units**: [Deliverables, responsible roles, review passes, prerequisites, and completion gates]
- **Channels**: [Primary channels: social, email, paid search, display, content, events, PR, partnerships]
- **Audience**: [Primary target segment/persona]
- **Brand Compliance**: Pending | Approved | Rejected | Exempt
- **Legal Review**: Pending | Approved | Conditional | Exempt
- **Performance**: [Actual metrics vs targets - populated post-launch]

## Campaign Overview

### Campaign Statement

**Campaign Name**: [Official campaign name]

**Tagline/Theme**: [Campaign theme or tagline]

**Purpose**: [Primary business objective - what this campaign aims to achieve]

**Target Outcome**: [Specific measurable outcome - e.g., "Generate 500 MQLs from enterprise segment"]

### Business Context

**Problem/Opportunity**: [What business need or market opportunity drives this campaign?]

**Strategic Alignment**: [How this campaign supports company strategy, roadmap, or quarterly goals]

**Market Context**: [Competitive landscape, market trends, seasonal timing, or external drivers]

**Expected Impact**: [Revenue impact, market share, brand awareness, customer acquisition/retention]

## Target Audience

### Primary Audience

**Segment**: [Primary target audience name/description]

**Profile**:

- **Demographics**: [Age, location, income, job title/role, company size, industry]
- **Psychographics**: [Values, interests, pain points, motivations]
- **Behavioral**: [Buying behavior, content preferences, channel habits]

**Audience Size**: [Estimated addressable market or database size]

**Persona Reference**: [Link to detailed audience/persona document: AUD-{id}]

### Secondary Audiences

**Audience 2**: [Name/description]

- Priority: High | Medium | Low
- Size: [Estimated reach]

**Audience 3**: [Name/description]

- Priority: High | Medium | Low
- Size: [Estimated reach]

### Audience Insights

**Key Pain Points**:

1. [Pain point 1]
2. [Pain point 2]
3. [Pain point 3]

**Motivations**:

1. [Motivation 1]
2. [Motivation 2]
3. [Motivation 3]

**Objections**:

1. [Objection 1 and how campaign addresses it]
2. [Objection 2 and how campaign addresses it]
3. [Objection 3 and how campaign addresses it]

## Campaign Strategy

### Value Proposition

**Core Message**: [Primary value proposition or campaign message]

**Supporting Messages**:

1. [Supporting message 1]
2. [Supporting message 2]
3. [Supporting message 3]

**Call to Action**: [Primary CTA - what action do we want audience to take?]

**Offer**: [If applicable - discount, trial, content asset, event registration, etc.]

### Channel Strategy

| Channel | Purpose | Budget | Target Reach | Owner | Status |
|---------|---------|--------|--------------|-------|--------|
| Paid Social | Awareness | $[amount] | [impressions] | [name] | [ ] |
| Paid Search | Conversion | $[amount] | [clicks] | [name] | [ ] |
| Email | Nurture | $[amount] | [sends] | [name] | [ ] |
| Content/SEO | Organic | $[amount] | [sessions] | [name] | [ ] |
| Events | Engagement | $[amount] | [attendees] | [name] | [ ] |
| PR/Media | Awareness | $[amount] | [coverage] | [name] | [ ] |

**Channel Mix Rationale**: [Why these channels for this audience and objective]

### Creative Direction

**Creative Concept**: [High-level creative approach or theme]

**Visual Style**: [Photography, illustration, video style, color palette reference]

**Tone/Voice**: [Brand voice adaptation for this campaign - professional, casual, urgent, inspiring, etc.]

**Creative Assets Required**:

- [ ] [Asset 1] - AST-{id} - [Owner] - [Due date]
- [ ] [Asset 2] - AST-{id} - [Owner] - [Due date]
- [ ] [Asset 3] - AST-{id} - [Owner] - [Due date]

**Creative Brief**: [Link to creative brief: CRE-{id}]

## Content Plan

### Content Inventory

| Content ID | Title/Description | Type | Channel | Owner | Due Date | Status |
|------------|-------------------|------|---------|-------|----------|--------|
| CNT-{id} | [Title] | Blog | Website | [name] | [date] | [ ] |
| CNT-{id} | [Title] | Video | YouTube/Social | [name] | [date] | [ ] |
| CNT-{id} | [Title] | Email | Email | [name] | [date] | [ ] |
| CNT-{id} | [Title] | Social | LinkedIn/Twitter | [name] | [date] | [ ] |
| CNT-{id} | [Title] | Whitepaper | Gated | [name] | [date] | [ ] |

**Content Calendar**: [Link to detailed content calendar or project plan]

**Content Strategy**: [How content supports campaign funnel - awareness, consideration, conversion]

## Scope and Gates

### Campaign Phases

**Phase 1: Planning & Development** [Entry: campaign intake accepted]

- [ ] Campaign strategy approved
- [ ] Budget allocated and approved
- [ ] Creative brief finalized
- [ ] Content plan approved
- [ ] Media plan confirmed
- [ ] Technology/platforms configured

**Phase 2: Content & Asset Production** [Entry: preceding phase checks pass]

- [ ] Creative assets developed (AST-{ids})
- [ ] Content pieces written/produced (CNT-{ids})
- [ ] Brand compliance review passed
- [ ] Legal review completed
- [ ] Final stakeholder approval

**Phase 3: Pre-Launch** [Entry: preceding phase checks pass]

- [ ] Media placements booked
- [ ] Email campaigns scheduled
- [ ] Landing pages live
- [ ] Analytics tracking configured
- [ ] Sales/partner enablement complete
- [ ] Internal launch communications sent

**Phase 4: Campaign Live** [Entry: preceding phase checks pass]

- [ ] Campaign launched
- [ ] Daily/weekly monitoring
- [ ] Optimization based on performance
- [ ] Stakeholder updates
- [ ] Mid-campaign review (if applicable)

**Phase 5: Post-Campaign** [Entry: preceding phase checks pass]

- [ ] Campaign ended
- [ ] Final data collection
- [ ] Performance analysis (RPT-{id})
- [ ] Post-mortem/retrospective
- [ ] Learnings documented

### Key Milestones

| Milestone | Completion Gate | Owner | Success Criteria | Status |
|-----------|------|-------|------------------|--------|
| Strategy approved | [Acceptance checks for Strategy approved pass] | [name] | Strategy doc signed off | [ ] |
| Creative approved | [Acceptance checks for Creative approved pass] | [name] | Brand/legal approval | [ ] |
| Assets ready | [Acceptance checks for Assets ready pass] | [name] | All assets delivered | [ ] |
| Launch | [Acceptance checks for Launch pass] | [name] | Campaign live | [ ] |
| Mid-point review | [Acceptance checks for Mid-point review pass] | [name] | Performance on track | [ ] |
| Campaign end | [Acceptance checks for Campaign end pass] | [name] | All activity stopped | [ ] |
| Report published | [Acceptance checks for Report published pass] | [name] | Final analysis shared | [ ] |

## Success Metrics

### Primary KPIs

**KPI 1**: [Metric name - e.g., MQLs Generated]

- **Target**: [Specific goal with number]
- **Baseline**: [Current/historical performance]
- **Measurement**: [Tool/method - e.g., Salesforce, Google Analytics]
- **Reporting Frequency**: Daily | Weekly | Monthly

**KPI 2**: [Metric name - e.g., Campaign ROI]

- **Target**: [Specific goal with number]
- **Baseline**: [Current/historical performance]
- **Measurement**: [Tool/method]
- **Reporting Frequency**: Daily | Weekly | Monthly

**KPI 3**: [Metric name - e.g., Cost per Acquisition]

- **Target**: [Specific goal with number]
- **Baseline**: [Current/historical performance]
- **Measurement**: [Tool/method]
- **Reporting Frequency**: Daily | Weekly | Monthly

### Secondary Metrics

| Metric | Target | Baseline | Actual | Variance | Status |
|--------|--------|----------|--------|----------|--------|
| Impressions | [number] | [number] | [TBD] | [TBD] | [ ] |
| Click-through rate | [%] | [%] | [TBD] | [TBD] | [ ] |
| Conversion rate | [%] | [%] | [TBD] | [TBD] | [ ] |
| Engagement rate | [%] | [%] | [TBD] | [TBD] | [ ] |
| Email open rate | [%] | [%] | [TBD] | [TBD] | [ ] |
| Landing page CVR | [%] | [%] | [TBD] | [TBD] | [ ] |

### Success Definition

**Campaign Success Defined As**: [What combination of metrics/outcomes = success]

**Minimum Viable Success**: [Threshold below which campaign is considered underperforming]

**Stretch Goals**: [Aspirational targets beyond baseline success]

**ROI Calculation**:

- **Total Investment**: $[budget]
- **Revenue Target**: $[expected revenue or pipeline value]
- **Expected ROI**: [X.X]x or [XX]%
- **Break-Even Point**: [When campaign pays for itself]

## Budget

### Budget Allocation

**Total Campaign Budget**: $[total]

| Category | Allocated | Spent | Remaining | % Utilization |
|----------|-----------|-------|-----------|---------------|
| Paid Media | $[amount] | $[TBD] | $[TBD] | [TBD]% |
| Content Production | $[amount] | $[TBD] | $[TBD] | [TBD]% |
| Creative/Design | $[amount] | $[TBD] | $[TBD] | [TBD]% |
| Agency/Vendor Fees | $[amount] | $[TBD] | $[TBD] | [TBD]% |
| Technology/Tools | $[amount] | $[TBD] | $[TBD] | [TBD]% |
| Events/Experiences | $[amount] | $[TBD] | $[TBD] | [TBD]% |
| Contingency | $[amount] | $[TBD] | $[TBD] | [TBD]% |
| **TOTAL** | **$[total]** | **$[TBD]** | **$[TBD]** | **[TBD]%** |

**Budget Tracking**: [Link to detailed budget tracker: BDG-{id}]

**Budget Authority**: [Who approves budget changes]

**Variance Threshold**: [Acceptable variance before requiring re-approval - e.g., +/- 10%]

### Paid Media Budget

| Platform/Channel | Budget | Flight Dates | Objective | Owner |
|------------------|--------|--------------|-----------|-------|
| Google Ads | $[amount] | [dates] | [objective] | [name] |
| LinkedIn Ads | $[amount] | [dates] | [objective] | [name] |
| Facebook/Instagram | $[amount] | [dates] | [objective] | [name] |
| Display Network | $[amount] | [dates] | [objective] | [name] |
| Sponsored Content | $[amount] | [dates] | [objective] | [name] |

## Dependencies

### Upstream Dependencies

Items that must be completed before campaign can launch:

| Dependency | Owner | Status | Due Date | Risk if Delayed |
|------------|-------|--------|----------|-----------------|
| [Item 1] | [name] | [ ] | [date] | [impact] |
| [Item 2] | [name] | [ ] | [date] | [impact] |
| [Item 3] | [name] | [ ] | [date] | [impact] |

### External Dependencies

Third-party, cross-team, or partner dependencies:

| Dependency | Owner/Team | Status | Impact if Delayed |
|------------|------------|--------|-------------------|
| [System/partner/team] | [contact] | [ ] | [impact] |
| [System/partner/team] | [contact] | [ ] | [impact] |

### Downstream Impact

Other campaigns, launches, or initiatives that depend on this campaign:

| Dependent Item | Impact if This Campaign Delayed |
|----------------|--------------------------------|
| [Item 1] | [impact description] |
| [Item 2] | [impact description] |

## Risks and Assumptions

### Risks

| Risk | Probability | Impact | Mitigation | Contingency |
|------|-------------|--------|------------|-------------|
| [Risk 1] | High/Med/Low | High/Med/Low | [Strategy] | [Plan B] |
| [Risk 2] | High/Med/Low | High/Med/Low | [Strategy] | [Plan B] |
| [Risk 3] | High/Med/Low | High/Med/Low | [Strategy] | [Plan B] |

### Assumptions

| Assumption | Impact if Invalid | Validation Approach |
|------------|-------------------|---------------------|
| [Assumption 1] | [impact] | [how to validate] |
| [Assumption 2] | [impact] | [how to validate] |
| [Assumption 3] | [impact] | [how to validate] |

## Performance Tracking

### Live Dashboard

**Analytics Dashboard**: [Link to real-time analytics dashboard]

**Reporting Cadence**:

- **Daily**: [Who receives, what metrics]
- **Weekly**: [Who receives, what metrics]
- **Monthly**: [Who receives, what metrics]

**Alert Thresholds**: [When to notify stakeholders of under/over-performance]

### Post-Campaign Analysis

**Final Report**: [Link to campaign performance report: RPT-{id}]

**Key Learnings**:

1. [Learning 1]
2. [Learning 2]
3. [Learning 3]

**Recommendations for Future Campaigns**:

1. [Recommendation 1]
2. [Recommendation 2]
3. [Recommendation 3]

**Assets to Repurpose**: [Which assets performed well and can be reused]

## Notes & Attachments

### Conversation Log

Track key decisions and clarifications:

- **YYYY-MM-DD**: [Decision or clarification]
- **YYYY-MM-DD**: [Decision or clarification]
- **YYYY-MM-DD**: [Decision or clarification]

### Attachments

- **Campaign Strategy**: [Link to strategy document: STR-{id}]
- **Creative Brief**: [Link to creative brief: CRE-{id}]
- **Media Plan**: [Link to media plan]
- **Content Calendar**: [Link to content calendar]
- **Analytics Reports**: [Link to analytics folder/dashboard]

### Open Questions

- [ ] [Question 1] - Assigned: [name] - Due: [date]
- [ ] [Question 2] - Assigned: [name] - Due: [date]
- [x] [Resolved question] - Resolution: [answer] - Date: [date]

## Approval Checklist

### Pre-Launch Approvals

- [ ] Campaign strategy approved by VP Marketing
- [ ] Budget approved by Finance
- [ ] Creative assets approved by Brand Manager
- [ ] Legal/compliance review complete
- [ ] Media plan approved by Media Lead
- [ ] Technology/tracking configured and tested
- [ ] Sales enablement/internal communications complete
- [ ] Executive sponsor sign-off

### Launch Readiness

- [ ] All content and assets delivered
- [ ] All media placements confirmed
- [ ] Landing pages/forms tested
- [ ] Analytics tracking verified
- [ ] Team briefed on campaign
- [ ] Contingency plans documented
- [ ] Launch checklist complete

## Agent Notes

### For Campaign Manager

- Maintain single source of truth for all campaign activity
- Update status and metrics at least weekly during live campaign
- Escalate risks and blockers immediately
- Coordinate cross-functional teams (creative, content, media, analytics)
- Ensure all dependencies are tracked and resolved before launch
- Document learnings for future campaign optimization

### For Creative Lead

- Ensure all creative assets align with brand guidelines (BRD-{id})
- Coordinate with content team for messaging consistency
- Plan for asset variations (A/B testing, channel-specific formats)
- Track asset performance to inform creative optimization
- Document successful creative approaches for reuse

### For Media Buyer

- Optimize campaigns daily based on performance data
- Track budget pacing to avoid overspend or underspend
- Report on channel performance vs. targets
- Recommend budget reallocation based on results
- Document platform-specific learnings

### For Analytics Lead

- Configure tracking and attribution before launch
- Validate data accuracy during first 24-48 hours
- Provide regular performance updates to campaign manager
- Identify trends and optimization opportunities
- Prepare final campaign analysis (RPT-{id})

### For Brand Manager

- Review all creative and messaging for brand compliance
- Ensure campaign aligns with brand positioning and voice
- Approve final assets before launch
- Monitor brand sentiment during campaign
- Provide post-campaign brand impact assessment

## Quality Gates

**Campaign is Ready for Launch When**:

- [ ] All pre-launch approvals obtained
- [ ] All content and assets delivered and approved
- [ ] All media placements confirmed
- [ ] All technology/tracking configured
- [ ] All dependencies resolved
- [ ] All team members briefed
- [ ] Launch checklist 100% complete

**Campaign is Complete When**:

- [ ] All campaign activity ended
- [ ] Final data collected and validated
- [ ] Performance analysis complete (RPT-{id})
- [ ] Post-mortem conducted
- [ ] Learnings documented
- [ ] Assets archived for future use
- [ ] Budget reconciled and closed

## Related Templates

- `/templates/intake/campaign-intake-template.md` - Initial campaign request
- `/templates/strategy/campaign-strategy-template.md` - Detailed strategy document
- `/templates/operations/content-card.md` - Individual content tracking
- `/templates/operations/asset-card.md` - Creative asset tracking
- `/templates/operations/budget-tracker-template.md` - Budget management
- `/templates/analytics/campaign-performance-report-template.md` - Final analysis

## Version Control

**Version**: 1.0
**Last Updated**: 2025-01-28
**Owner**: Marketing Operations + Campaign Manager
**Change History**:

- 2025-01-28: Initial template created (v1.0)
