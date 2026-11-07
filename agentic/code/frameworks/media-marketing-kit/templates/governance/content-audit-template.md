# Content Audit Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

---

**Document ID**: GOV-005
**Template Version**: 1.0.0
**Last Updated**: 2025-11-28
**Owner**: Content Strategy Lead
**Status**: Active

---

## YAML Frontmatter

```yaml
content_audit:
  audit_id: "[AUDIT-ID]"
  audit_name: "[Descriptive name]"
  audit_date_start: "[YYYY-MM-DD]"
  audit_date_end: "[YYYY-MM-DD]"
  conducted_by: "[Name/Team]"

scope:
  audit_type: "[Full Inventory | Focused Audit | Competitive Audit | Content Quality Audit]"
  channels: "[Website | Blog | Social Media | Email | All Channels]"
  date_range: "[YYYY-MM-DD to YYYY-MM-DD or All Time]"
  content_types: "[Blog Posts | Landing Pages | Social Posts | Videos | PDFs | All]"

objectives:
  primary_goal: "[Identify outdated content | Improve SEO | Align with brand | Reduce redundancy | Other]"
  success_metrics: "[What defines a successful audit]"

findings:
  total_assets_reviewed: "[Number]"
  assets_to_keep: "[Number]"
  assets_to_update: "[Number]"
  assets_to_consolidate: "[Number]"
  assets_to_archive: "[Number]"
  assets_to_delete: "[Number]"

status:
  audit_status: "[Planning | In Progress | Review | Complete]"
  completion_percentage: "[X%]"
  next_review_date: "[YYYY-MM-DD]"
```

---

## Purpose

This template provides a structured framework for conducting content audits to evaluate, organize, and optimize marketing content across all channels. It helps identify content gaps, redundancies, and opportunities for improvement.

---

## 1. Audit Planning and Scope

### 1.1 Audit Overview

**Audit Name**: [Descriptive name - e.g., "Q4 2025 Website Content Audit"]

**Audit Type**:
- [ ] **Full Inventory Audit**: Catalog all content assets
- [ ] **Focused Audit**: Specific channel, content type, or topic area
- [ ] **Quality Audit**: Evaluate content quality and effectiveness
- [ ] **SEO Audit**: Optimize for search performance
- [ ] **Brand Alignment Audit**: Ensure brand consistency
- [ ] **Competitive Audit**: Benchmark against competitors
- [ ] **Compliance Audit**: Verify legal/regulatory compliance
- [ ] **Accessibility Audit**: Ensure WCAG compliance
- [ ] **Other**: [Specify]

**Primary Objective**: [What is the main goal of this audit?]

```text
Example: "Identify and update outdated product information on website to improve accuracy and SEO performance."
```

**Secondary Objectives**: [Additional goals]

1. [Objective 1]
2. [Objective 2]
3. [Objective 3]

**Business Driver**: [Why are we conducting this audit now?]

```text
Example: "Preparing for product launch, need to ensure all existing content aligns with new messaging framework and doesn't contradict new product positioning."
```

---

### 1.2 Scope Definition

**Channels Included**:
- [ ] Company Website
- [ ] Company Blog
- [ ] Landing Pages
- [ ] Social Media (specify platforms)
- [ ] Email Marketing
- [ ] Video Content (YouTube, Vimeo)
- [ ] PDF Resources (whitepapers, case studies)
- [ ] Presentation Decks
- [ ] External Publications (Medium, LinkedIn Articles)
- [ ] Other: [Specify]

**Content Types Included**:
- [ ] Blog Posts / Articles
- [ ] Landing Pages
- [ ] Product Pages
- [ ] Service Pages
- [ ] About/Company Pages
- [ ] Case Studies
- [ ] Whitepapers / eBooks
- [ ] Infographics
- [ ] Videos
- [ ] Podcasts
- [ ] Social Media Posts
- [ ] Email Campaigns
- [ ] Press Releases
- [ ] FAQs / Help Documentation
- [ ] Other: [Specify]

**Date Range**: [YYYY-MM-DD to YYYY-MM-DD or "All Time"]

**Geographic/Language Scope**:
- [ ] English (US)
- [ ] English (UK)
- [ ] Spanish
- [ ] French
- [ ] German
- [ ] Other: [Specify]

**Content Exclusions** (Out of Scope):
```text
[What content will NOT be audited? E.g., archived blog posts before 2020, third-party guest posts, employee-generated content, etc.]
```

---

### 1.3 Audit Team and Responsibilities

| Role | Name | Email | Responsibilities |
|------|------|-------|------------------|
| Audit Lead | [Name] | [Email] | Overall coordination, final decisions |
| Content Strategist | [Name] | [Email] | Content evaluation, recommendations |
| SEO Specialist | [Name] | [Email] | SEO analysis, keyword optimization |
| Brand Manager | [Name] | [Email] | Brand alignment review |
| Legal/Compliance | [Name] | [Email] | Compliance verification |
| Developer/Web | [Name] | [Email] | Technical implementation of changes |
| Designer | [Name] | [Email] | Visual asset updates |

**Stakeholder Communication**: [How will audit progress and findings be communicated?]

- **Update Frequency**: [Weekly | Bi-weekly | Monthly]
- **Update Format**: [Email | Slack | Meeting | Dashboard]
- **Executive Summary Date**: [YYYY-MM-DD]

---

### 1.4 Audit Gates

| Phase | Entry Gate | Completion Gate | Owner | Status |
|-------|------------|----------|-------|--------|
| Planning & Scoping | [Prerequisites for Planning & Scoping verified] | [Acceptance checks for Planning & Scoping pass] | [Name] | [ ] Not Started<br>[ ] In Progress<br>[ ] Complete |
| Content Inventory | [Prerequisites for Content Inventory verified] | [Acceptance checks for Content Inventory pass] | [Name] | [ ] Not Started<br>[ ] In Progress<br>[ ] Complete |
| Content Evaluation | [Prerequisites for Content Evaluation verified] | [Acceptance checks for Content Evaluation pass] | [Name] | [ ] Not Started<br>[ ] In Progress<br>[ ] Complete |
| Recommendations | [Prerequisites for Recommendations verified] | [Acceptance checks for Recommendations pass] | [Name] | [ ] Not Started<br>[ ] In Progress<br>[ ] Complete |
| Stakeholder Review | [Prerequisites for Stakeholder Review verified] | [Acceptance checks for Stakeholder Review pass] | [Name] | [ ] Not Started<br>[ ] In Progress<br>[ ] Complete |
| Implementation Plan | [Prerequisites for Implementation Plan verified] | [Acceptance checks for Implementation Plan pass] | [Name] | [ ] Not Started<br>[ ] In Progress<br>[ ] Complete |
| Final Report | [Prerequisites for Final Report verified] | [Acceptance checks for Final Report pass] | [Name] | [ ] Not Started<br>[ ] In Progress<br>[ ] Complete |

**Audit Scope Units**: [Asset count, evaluator roles, review passes, and evidence checks]

---

## 2. Content Inventory

### 2.1 Inventory Collection Method

**Inventory Tool/Method**:
- [ ] Manual spreadsheet (Google Sheets, Excel)
- [ ] Content audit tool (Screaming Frog, Semrush, ContentWRX)
- [ ] CMS export (WordPress, HubSpot, etc.)
- [ ] Custom script/crawler
- [ ] Combination: [Specify]

**Inventory Location**: [Link to Google Sheet, Airtable, or tool]

**Inventory Structure**: [Columns/fields tracked]

Recommended Minimum Fields:
- Content ID / URL
- Title
- Content Type
- Author
- Publish Date
- Last Updated Date
- Word Count
- Target Audience
- Topic/Category
- Primary Keyword
- Page Views (last 30/90 days)
- Engagement Metrics (time on page, bounce rate)
- SEO Metrics (organic traffic, ranking keywords)
- Status (Keep, Update, Archive, Delete)

---

### 2.2 Content Inventory Snapshot

**Total Content Assets Inventoried**: [X]

**Breakdown by Content Type**:
| Content Type | Count | % of Total |
|--------------|-------|------------|
| Blog Posts | [X] | [X%] |
| Landing Pages | [X] | [X%] |
| Product Pages | [X] | [X%] |
| Case Studies | [X] | [X%] |
| Videos | [X] | [X%] |
| Whitepapers/eBooks | [X] | [X%] |
| Email Campaigns | [X] | [X%] |
| Social Posts | [X] | [X%] |
| Other | [X] | [X%] |

**Breakdown by Channel**:
| Channel | Count | % of Total |
|---------|-------|------------|
| Website | [X] | [X%] |
| Blog | [X] | [X%] |
| Social Media | [X] | [X%] |
| Email | [X] | [X%] |
| Other | [X] | [X%] |

**Breakdown by Age**:
| Age Range | Count | % of Total |
|-----------|-------|------------|
| 0-6 months | [X] | [X%] |
| 6-12 months | [X] | [X%] |
| 1-2 years | [X] | [X%] |
| 2-3 years | [X] | [X%] |
| 3+ years | [X] | [X%] |

---

## 3. Content Evaluation Criteria

### 3.1 Quality Assessment

**Evaluate Each Asset on These Dimensions** (1-5 scale):

**Content Quality**:
- [ ] **Accuracy**: Information current and factually correct
- [ ] **Clarity**: Well-written, easy to understand
- [ ] **Depth**: Sufficient detail and value for audience
- [ ] **Uniqueness**: Original content, not duplicated elsewhere
- [ ] **Grammar/Spelling**: Free of errors

**Brand Alignment**:
- [ ] **Voice & Tone**: Matches brand voice guidelines
- [ ] **Messaging**: Aligns with current messaging framework
- [ ] **Visual Style**: Images/design align with brand guidelines
- [ ] **Positioning**: Supports brand positioning

**SEO Performance**:
- [ ] **Keyword Optimization**: Target keyword present and optimized
- [ ] **Meta Tags**: Title tag, meta description optimized
- [ ] **Internal Links**: Appropriate internal linking
- [ ] **Organic Traffic**: Receiving organic search traffic
- [ ] **Ranking**: Ranking for target keywords

**User Engagement**:
- [ ] **Page Views**: Receives meaningful traffic
- [ ] **Time on Page**: Visitors engage with content (not immediate bounce)
- [ ] **Conversion Rate**: Drives desired action (sign-up, download, purchase)
- [ ] **Social Shares**: Shared on social media

**Technical Quality**:
- [ ] **Mobile Responsive**: Displays correctly on mobile devices
- [ ] **Load Speed**: Page loads quickly (<3 seconds)
- [ ] **Accessibility**: Meets WCAG 2.1 AA standards
- [ ] **Broken Links**: No broken internal or external links
- [ ] **Functional Elements**: Forms, CTAs, embeds work correctly

**Compliance**:
- [ ] **Legal Compliance**: No legal/compliance issues (claims, testimonials, disclosures)
- [ ] **Privacy**: GDPR/CCPA compliant if collecting data
- [ ] **Copyright**: All images/content properly licensed

---

### 3.2 Evaluation Scoring System

**Overall Content Score** (Average of category scores):

| Asset URL | Quality | Brand | SEO | Engagement | Technical | Compliance | **Avg Score** | **Status** |
|-----------|---------|-------|-----|------------|-----------|------------|---------------|------------|
| [URL] | [1-5] | [1-5] | [1-5] | [1-5] | [1-5] | [1-5] | [X.X] | [Keep/Update/Archive/Delete] |

**Scoring Guide**:
- **5 - Excellent**: Exceeds standards, top-performing content
- **4 - Good**: Meets standards, minor improvements possible
- **3 - Fair**: Meets minimum standards, moderate improvements needed
- **2 - Poor**: Below standards, significant improvements or consolidation needed
- **1 - Failing**: Does not meet standards, archive or delete

**Decision Thresholds**:
- **Keep (4.0-5.0)**: Content performing well, minimal updates needed
- **Update (2.5-3.9)**: Content has value but needs improvement
- **Archive (1.5-2.4)**: Content outdated or redundant, preserve but remove from site
- **Delete (1.0-1.4)**: No value, delete permanently

---

## 4. Detailed Audit Findings

### 4.1 Content to Keep (Score 4.0-5.0)

**Total Assets**: [X] ([X%] of inventory)

**Characteristics of Top-Performing Content**:
```text
[What do these high-performing assets have in common? Topics, formats, lengths, keywords, etc.]
```

**Representative Examples**:
| Title | URL | Score | Why It's Performing Well |
|-------|-----|-------|--------------------------|
| [Title] | [URL] | [X.X] | [Reason] |
| [Title] | [URL] | [X.X] | [Reason] |

**Minor Updates Recommended** (Optional):
```text
[Even top content may benefit from updates - freshen stats, update CTAs, add recent examples]
```

---

### 4.2 Content to Update (Score 2.5-3.9)

**Total Assets**: [X] ([X%] of inventory)

**Common Issues Identified**:
- [ ] Outdated information (statistics, product features, screenshots)
- [ ] Off-brand voice or messaging
- [ ] Poor SEO optimization (missing keywords, meta tags)
- [ ] Low engagement / high bounce rate
- [ ] Broken links or images
- [ ] Missing or poor CTAs
- [ ] Accessibility issues
- [ ] Poor mobile experience
- [ ] Thin content (too short, lacks depth)
- [ ] Duplicate or redundant content

**Priority Updates** (High-Impact):
| Title | URL | Score | Primary Issue | Scope Units | Impact | Priority |
|-------|-----|-------|---------------|--------|--------|----------|
| [Title] | [URL] | [X.X] | [Issue] | [Named asset updates and review passes] | [Low/Med/High] | [1-5] |

**Update Recommendations**:
```text
[Describe recommended updates - rewrite sections, add new data, optimize for SEO, improve CTAs, etc.]
```

---

### 4.3 Content to Consolidate

**Total Assets**: [X] ([X%] of inventory)

**Consolidation Opportunities**:

**Example**: Multiple blog posts on same topic

| Asset 1 | Asset 2 | Asset 3 | Consolidation Action |
|---------|---------|---------|----------------------|
| [Title/URL] | [Title/URL] | [Title/URL] | Merge into comprehensive guide, 301 redirect old URLs |

**Benefits of Consolidation**:
```text
[Explain why consolidation is recommended - reduces redundancy, improves SEO (avoid keyword cannibalization), creates authoritative resource]
```

---

### 4.4 Content to Archive (Score 1.5-2.4)

**Total Assets**: [X] ([X%] of inventory)

**Archival Criteria**:
- [ ] Content no longer relevant but has historical value
- [ ] Content about discontinued products/services
- [ ] Event-specific content (past events)
- [ ] Time-sensitive content that's expired
- [ ] Content replaced by newer/better versions
- [ ] Low traffic, low value, but not harmful

**Archive Examples**:
| Title | URL | Reason for Archival | Archive Location |
|-------|-----|---------------------|------------------|
| [Title] | [URL] | [Reason] | [Archive folder, hidden category] |

**Archive Process**:
1. Remove from site navigation and search
2. Add "noindex" meta tag (prevent search indexing)
3. Optionally add banner: "This content is archived and may be outdated"
4. Store in archive folder or hidden category
5. Optional: 301 redirect to relevant current content

---

### 4.5 Content to Delete (Score 1.0-1.4)

**Total Assets**: [X] ([X%] of inventory)

**Deletion Criteria**:
- [ ] Factually incorrect or misleading
- [ ] Brand-damaging content
- [ ] Duplicate content with no SEO value
- [ ] Spam or low-quality content
- [ ] Legal/compliance risk
- [ ] Receiving zero traffic and no inbound links
- [ ] No historical or archival value

**Delete Examples**:
| Title | URL | Reason for Deletion | Redirect To |
|-------|-----|---------------------|-------------|
| [Title] | [URL] | [Reason] | [Redirect URL or 404/410] |

**Deletion Process**:
1. Check for inbound links (preserve SEO if valuable backlinks)
2. If inbound links exist, 301 redirect to relevant page
3. If no inbound links, return 410 (Gone) status
4. Remove from CMS/file system
5. Document deletion in audit log

**Pre-Deletion Checklist**:
- [ ] Stakeholder approval obtained
- [ ] Redirects implemented (if applicable)
- [ ] No critical inbound links (or redirected)
- [ ] Backup archived before deletion
- [ ] Deletion logged in audit trail

---

## 5. Content Gap Analysis

### 5.1 Missing Content Opportunities

**Topic Gaps**:

**What topics should we cover but don't?**

| Topic/Keyword | Search Volume | Current Coverage | Competitor Coverage | Priority |
|---------------|---------------|------------------|---------------------|----------|
| [Topic] | [Monthly searches] | [None / Weak] | [Strong / Weak] | [High / Med / Low] |

**Audience Gaps**:

**Are we serving all target audience segments?**

| Audience Segment | Current Content | Gap | Recommendation |
|------------------|-----------------|-----|----------------|
| [Segment] | [X assets] | [Underserved / Not addressed] | [Create content for this persona] |

**Funnel Stage Gaps**:

**Do we have content for each stage of the buyer journey?**

| Funnel Stage | Current Content Count | Gap | Priority Content Needed |
|--------------|----------------------|-----|-------------------------|
| Awareness | [X] | [Sufficient / Gap] | [Blog posts, social] |
| Consideration | [X] | [Sufficient / Gap] | [Case studies, comparison guides] |
| Decision | [X] | [Sufficient / Gap] | [Product pages, demos, trials] |
| Retention | [X] | [Sufficient / Gap] | [Help docs, webinars, newsletters] |

**Format Gaps**:

**Are we diversifying content formats?**

| Format | Current Count | Audience Preference | Recommendation |
|--------|---------------|---------------------|----------------|
| Blog Posts | [X] | [High / Med / Low] | [Maintain / Increase / Decrease] |
| Videos | [X] | [High / Med / Low] | [Maintain / Increase / Decrease] |
| Infographics | [X] | [High / Med / Low] | [Maintain / Increase / Decrease] |
| Podcasts | [X] | [High / Med / Low] | [Maintain / Increase / Decrease] |
| Interactive Tools | [X] | [High / Med / Low] | [Maintain / Increase / Decrease] |

---

### 5.2 Content Creation Recommendations

**New Content to Create** (Top 10 Priorities):

| Rank | Topic | Content Type | Target Audience | Target Keyword | Rationale | Owner | Due Date |
|------|-------|--------------|-----------------|----------------|-----------|-------|----------|
| 1 | [Topic] | [Format] | [Persona] | [Keyword] | [Why create this] | [Name] | [Date] |
| 2 | [Topic] | [Format] | [Persona] | [Keyword] | [Why create this] | [Name] | [Date] |
| 3 | [Topic] | [Format] | [Persona] | [Keyword] | [Why create this] | [Name] | [Date] |

---

## 6. SEO and Performance Analysis

### 6.1 SEO Findings

**Overall SEO Health**:
- **Avg. Organic Traffic per Asset**: [X sessions/month]
- **Top Performing Content** (by organic traffic): [Link to top 10 list]
- **Keyword Ranking Breakdown**:
  - Ranking #1-3: [X assets]
  - Ranking #4-10: [X assets]
  - Ranking #11-20: [X assets]
  - Not ranking for target keyword: [X assets]

**SEO Issues Identified**:
- [ ] Missing or duplicate title tags: [X assets]
- [ ] Missing or duplicate meta descriptions: [X assets]
- [ ] Missing H1 tags: [X assets]
- [ ] Keyword cannibalization (multiple pages targeting same keyword): [X instances]
- [ ] Thin content (<300 words): [X assets]
- [ ] Broken internal links: [X links]
- [ ] Broken external links: [X links]
- [ ] Missing alt text on images: [X images]
- [ ] Slow page load speed (>3 seconds): [X assets]
- [ ] Not mobile-friendly: [X assets]

**Top SEO Opportunities**:
1. [Opportunity 1 - e.g., "Optimize 25 high-traffic pages with weak meta descriptions"]
2. [Opportunity 2]
3. [Opportunity 3]

---

### 6.2 Performance Metrics

**Traffic Analysis** (Last 90 days):

| Metric | Value |
|--------|-------|
| Total Page Views | [X] |
| Unique Visitors | [X] |
| Avg. Time on Page | [X min] |
| Avg. Bounce Rate | [X%] |
| Total Conversions | [X] |
| Conversion Rate | [X%] |

**Content Performance Distribution**:
- **Top 10% of content** drives [X%] of total traffic
- **Bottom 50% of content** drives [X%] of total traffic
- **Zero-traffic content**: [X assets] ([X%])

**High-Value, Low-Performing Content** (Opportunity to Optimize):

| Title | URL | Keyword Potential | Current Ranking | Current Traffic | Recommendation |
|-------|-----|-------------------|-----------------|-----------------|----------------|
| [Title] | [URL] | [High search volume] | [#25] | [Low] | [Optimize and promote] |

---

## 7. Brand and Messaging Audit

### 7.1 Brand Consistency Findings

**Brand Alignment Score**: [X%] of content fully aligned with current brand guidelines

**Common Brand Issues**:
- [ ] Outdated brand messaging (references old positioning)
- [ ] Inconsistent voice/tone
- [ ] Off-brand visual style (old logo, colors, fonts)
- [ ] Competitor comparisons no longer accurate
- [ ] Product names/terminology outdated

**Brand Update Priorities**:
| Asset | Issue | Severity | Scope Units to Fix |
|-------|-------|----------|---------------|
| [Title/URL] | [Old messaging] | [High / Med / Low] | [Named asset updates and verification checks] |

---

### 7.2 Messaging Framework Alignment

**Current Messaging Themes in Content**:
- Theme 1: [X% of content]
- Theme 2: [X% of content]
- Theme 3: [X% of content]

**Messaging Gaps**:
```text
[What key messages from current messaging framework are underrepresented in content?]
```

**Messaging Overrepresentation**:
```text
[Are we over-focusing on certain messages at expense of others?]
```

---

## 8. Competitive Content Analysis

### 8.1 Competitor Benchmarking

**Competitors Analyzed**:
1. [Competitor A]
2. [Competitor B]
3. [Competitor C]

**Competitor Content Volume**:
| Competitor | Total Content Assets | Blog Posts | Videos | Resources | Update Frequency |
|------------|----------------------|------------|--------|-----------|------------------|
| [Comp A] | [X] | [X] | [X] | [X] | [X/month] |
| [Comp B] | [X] | [X] | [X] | [X] | [X/month] |
| [Comp C] | [X] | [X] | [X] | [X] | [X/month] |
| **Our Company** | **[X]** | **[X]** | **[X]** | **[X]** | **[X/month]** |

**Competitor Content Strengths**:
```text
[What are competitors doing well? Topics, formats, quality, frequency?]
```

**Competitor Content Weaknesses**:
```text
[What are competitors missing or doing poorly? Opportunities for us to differentiate?]
```

**Competitive Differentiation Opportunities**:
1. [Opportunity 1]
2. [Opportunity 2]
3. [Opportunity 3]

---

## 9. Compliance and Risk Assessment

### 9.1 Legal and Compliance Review

**Compliance Issues Identified**:
- [ ] Unsubstantiated product claims: [X assets]
- [ ] Missing disclaimers/disclosures: [X assets]
- [ ] Testimonials without proper consent/disclosure: [X assets]
- [ ] Copyright/licensing issues (images, quotes): [X assets]
- [ ] Trademark usage violations: [X assets]
- [ ] Privacy policy not linked (data collection forms): [X assets]
- [ ] GDPR/CCPA non-compliance: [X assets]
- [ ] Accessibility violations (WCAG 2.1 AA): [X assets]

**High-Risk Content** (Immediate Review Required):
| Asset | Risk Type | Description | Action Required |
|-------|-----------|-------------|-----------------|
| [Title/URL] | [Legal / Compliance / Brand] | [Description of risk] | [Update / Remove / Legal review] |

---

## 10. Content Audit Recommendations

### 10.1 Executive Summary

**Audit Highlights**:
- Total Assets Audited: [X]
- Keep as-is: [X] ([X%])
- Update: [X] ([X%])
- Consolidate: [X] ([X%])
- Archive: [X] ([X%])
- Delete: [X] ([X%])

**Key Findings**:
1. [Finding 1]
2. [Finding 2]
3. [Finding 3]

**Top Opportunities**:
1. [Opportunity 1 - with estimated impact]
2. [Opportunity 2 - with estimated impact]
3. [Opportunity 3 - with estimated impact]

---

### 10.2 Prioritized Action Plan

**Phase 1: Bounded Corrections (entry: inventory verified)**
| Action | Assets Affected | Owner | Scope Units | Impact | Completion Gate |
|--------|-----------------|-------|--------|--------|----------|
| [Action 1] | [X] | [Name] | [Named asset updates and review passes] | [Low/Med/High] | [Acceptance checks for affected assets pass] |

**Phase 2: High-Impact Updates (entry: priority findings accepted)**
| Action | Assets Affected | Owner | Scope Units | Impact | Completion Gate |
|--------|-----------------|-------|--------|--------|----------|
| [Action 2] | [X] | [Name] | [Named asset updates and review passes] | [Low/Med/High] | [Acceptance checks for affected assets pass] |

**Phase 3: Strategic Content Creation (entry: gap analysis approved)**
| Action | Assets Affected | Owner | Scope Units | Impact | Completion Gate |
|--------|-----------------|-------|--------|--------|----------|
| [Action 3] | [X] | [Name] | [Named asset updates and review passes] | [Low/Med/High] | [Acceptance checks for affected assets pass] |

---

### 10.3 Resource Requirements

**Team Resources Needed**:
- Content Writers: [Named assets/checks and review passes]
- SEO Specialist: [Named assets/checks and review passes]
- Designers: [Named assets/checks and review passes]
- Developers: [Named assets/checks and review passes]
- Legal/Compliance: [Named assets/checks and review passes]

**Budget Required**:
| Expense Category | Estimated Cost |
|------------------|----------------|
| Content Creation (new content) | $[X] |
| Content Updates (existing content) | $[X] |
| Design/Visual Assets | $[X] |
| SEO Tools/Auditing Tools | $[X] |
| External Writers/Agencies | $[X] |
| **TOTAL** | **$[X]** |

---

### 10.4 Success Metrics

**How Will We Measure Success?**

**3-Month Targets**:
- [ ] [X%] of high-priority updates completed
- [ ] Organic traffic increased by [X%]
- [ ] Average content quality score improved from [X] to [X]
- [ ] [X] new content assets created to fill gaps

**6-Month Targets**:
- [ ] All content audit recommendations implemented
- [ ] Avg. time on page increased by [X%]
- [ ] Conversion rate increased by [X%]
- [ ] [X] keywords ranking on page 1

**12-Month Targets**:
- [ ] Establish quarterly content audit cadence
- [ ] Build content governance process to maintain quality
- [ ] Achieve [X%] brand compliance across all content

---

## 11. Ongoing Content Governance

### 11.1 Content Maintenance Schedule

**Recommendation**: Establish regular content review cadence

**Quarterly Reviews** (High-Value Content):
- Review top 20% of traffic-driving content
- Update statistics, examples, screenshots
- Refresh CTAs and offers
- Check SEO rankings and optimize

**Annual Audits** (Full Content Inventory):
- Comprehensive audit of all content
- Archive outdated content
- Identify new content gaps
- Align with updated brand/messaging

**Event-Triggered Reviews**:
- Product launches or updates
- Rebranding or messaging changes
- Competitive landscape shifts
- Regulatory/compliance changes

---

### 11.2 Content Quality Standards

**Establish Standards for Future Content**:

**Pre-Publication Checklist**:
- [ ] Brand compliance review (GOV-002)
- [ ] Legal review if required (GOV-003)
- [ ] Accessibility check (GOV-004)
- [ ] SEO optimization (keyword, meta tags, internal links)
- [ ] Grammar/spelling check
- [ ] Fact-checking and source verification
- [ ] CTA and conversion path validated
- [ ] Mobile responsiveness tested

**Content Owner Responsibilities**:
- Review content annually or when product/messaging changes
- Monitor performance metrics (traffic, engagement, conversions)
- Update content when performance declines
- Archive or delete when no longer relevant

---

## 12. Audit Documentation and Reporting

### 12.1 Audit Deliverables

**Final Audit Report Includes**:
- [ ] Executive summary (2-page overview)
- [ ] Full content inventory (spreadsheet)
- [ ] Detailed findings by category
- [ ] Prioritized action plan
- [ ] Resource and budget estimates
- [ ] Success metrics and KPIs

**Report Distribution**:
- Executive Sponsor: [Name]
- Marketing Leadership: [Names]
- Content Team: [Team distribution list]
- SEO Team: [Team distribution list]

**Report Location**: [Link to final report]

---

### 12.2 Audit Review Meeting

**Meeting Date**: [YYYY-MM-DD]
**Attendees**: [List key stakeholders]

**Agenda**:
1. Audit overview and methodology
2. Key findings and insights
3. Recommendations and action plan
4. Scope units, role assignments, and prerequisite gates
5. Q&A and discussion
6. Next steps and approvals

**Decisions Made**:
```text
[Document key decisions, approvals, budget allocations, timeline commitments]
```

---

### 12.3 Next Content Audit

**Recommended Audit Frequency**: [Quarterly | Semi-Annual | Annual]

**Next Audit Scheduled**: [YYYY-MM-DD]

**Continuous Monitoring**:
- [ ] Set up Google Analytics alerts for traffic drops
- [ ] Monitor keyword rankings monthly
- [ ] Track content quality score quarterly
- [ ] Review user feedback and comments regularly

---

## Template Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-28 | MMK Framework Team | Initial template creation |

---

**END OF TEMPLATE**
