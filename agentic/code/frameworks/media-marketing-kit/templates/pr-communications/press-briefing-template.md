# Press Briefing Document Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- ID: PRS-004
- Owner: PR Manager (agents/pr-manager.md)
- Contributors: Product Strategist (agents/product-strategist.md), Subject Matter Expert (agents/subject-matter-expert.md)
- Reviewers: Executive Orchestrator (agents/executive-orchestrator.md), Legal Advisor (agents/legal-advisor.md)
- Team: `team`
- Status: `draft/review/approved/distributed`
- Dates: created `YYYY-MM-DD` / updated `YYYY-MM-DD` / embargo `YYYY-MM-DD HH:MM TZ`
- Related: PRS-001, PRS-003, PRS-006
- Links: `briefing-document-url`, `supporting-materials-url`

## Purpose

Detailed background document providing journalists, analysts, and influencers with comprehensive context for deep-dive coverage, feature articles, and analytical pieces. Goes beyond press release facts to include strategy, technical details, market context, and expert perspectives.

## Briefing vs Press Release

| Aspect | Press Release | Press Briefing |
|--------|--------------|----------------|
| **Purpose** | Announce news | Provide context |
| **Length** | 400-600 words | 1,500-3,000 words |
| **Audience** | General media | Tier 1 journalists, analysts |
| **Format** | AP Style, public | Conversational, often embargoed |
| **Distribution** | Broad (wire, website) | Targeted (select media) |
| **Content** | What happened | Why it matters, how it works |
| **Quotes** | Executive soundbites | Detailed expert commentary |
| **Usage** | Pick up and publish | Background research |

## Document Structure

### Cover Page

```markdown
# PRESS BRIEFING
## [Topic/Announcement Title]

**EMBARGOED UNTIL**: [Day, Month DD, YYYY at HH:MM AM/PM TIMEZONE]
*OR*
**FOR BACKGROUND USE ONLY** (Not for direct quotation without permission)
*OR*
**FOR IMMEDIATE RELEASE**

**Date Prepared**: [Month DD, YYYY]
**Contact**: [Name, Title, Email, Phone]
**Company**: [Company Name]

---

**Distribution**: Tier 1 media and analysts only
**Confidentiality**: [Level - Public, Embargoed, Confidential]
```

### Executive Summary (1 page max)

**Purpose**: Provide busy journalists with key takeaways they can scan in 2-3 minutes.

**Format**:
```markdown
## Executive Summary

### What's Happening
[2-3 sentences: Core announcement or topic]

### Why It Matters
[2-3 sentences: Significance, impact, timeliness]

### Key Facts
- [Fact 1: Most important data point or metric]
- [Fact 2: Secondary important detail]
- [Fact 3: Supporting information]
- [Fact 4: Market/customer impact]

### Who's Affected
[1-2 sentences: Target audience, market, stakeholders]

### What's Next
[1-2 sentences: Timeline, availability, future plans]

### Expert Available
[Name, Title] available for interview: [Contact method]
```

### Background & Context (1-2 pages)

**Market Context**:
```markdown
## Market Background

### Industry Challenge
[Describe the problem, pain point, or opportunity that provides context
for your announcement. Include data from third-party sources when possible.]

**Current Market Size**: $[Amount] ([Source, Year])
**Projected Growth**: [X]% CAGR through [Year] ([Source])
**Key Drivers**: [2-3 trends driving market change]

### Competitive Landscape
[Explain existing solutions, their limitations, and market gaps - without
directly naming competitors unless absolutely necessary]

**Existing Approaches**:
- Approach 1: [Brief description and limitation]
- Approach 2: [Brief description and limitation]
- Approach 3: [Brief description and limitation]

**Market Gap**: [What's missing that your announcement addresses]

### Customer Pain Points
[Specific problems customers face, ideally with quantified impact]

Research from [Source] shows:
- [X]% of [target customers] struggle with [problem]
- Average cost of [problem]: $[Amount] annually
- [Y] hours per week lost to [inefficiency]
```

### Announcement Details (2-4 pages)

**Product/Service/News Deep Dive**:
```markdown
## [Product/Service/Announcement] In Depth

### What It Is
[Comprehensive description in plain language - avoid jargon, but include
technical detail for specialist journalists]

### How It Works
[Step-by-step explanation or architectural overview]

1. [Step 1 with detail]
2. [Step 2 with detail]
3. [Step 3 with detail]

[Include diagrams, flowcharts, or technical schematics as appendices]

### Key Features & Capabilities

#### Feature 1: [Name]
**What it does**: [Description]
**Customer benefit**: [Specific outcome or value]
**Technical detail**: [How it's implemented - for technical journalists]

#### Feature 2: [Name]
**What it does**: [Description]
**Customer benefit**: [Specific outcome or value]
**Technical detail**: [How it's implemented]

[Repeat for 3-5 key features]

### Differentiation
**What makes this unique**:
- [Differentiator 1 with supporting evidence]
- [Differentiator 2 with supporting evidence]
- [Differentiator 3 with supporting evidence]

### Technical Specifications
[For technical journalists and analysts - skip for general business press]

- Platform: [Details]
- Integration: [APIs, protocols, standards supported]
- Performance: [Metrics - speed, capacity, scalability]
- Security: [Certifications, compliance, architecture]
- Deployment: [Cloud, on-premise, hybrid options]
```

### Business Impact & Strategy (1-2 pages)

```markdown
## Strategic Context

### Why Now
[Explain timing - market readiness, technology maturity, customer demand,
competitive dynamics, regulatory changes, etc.]

### Target Market
**Primary Audience**:
- Industry: [Sectors]
- Company Size: [Employee count, revenue range]
- Geography: [Markets]
- Use Cases: [Primary applications]

**Market Opportunity**:
- Total Addressable Market (TAM): $[Amount]
- Serviceable Addressable Market (SAM): $[Amount]
- Target penetration: [X]% in [Timeframe]

### Revenue Model
[If relevant and public]
- Pricing: [Starting at $X, tiers, volume discounts]
- Contract terms: [Annual, multi-year, usage-based]
- Average deal size: [Range]

### Go-to-Market Strategy
- Sales channels: [Direct, partners, online, etc.]
- Marketing approach: [Key tactics]
- Launch timeline: [Phases and dates]
- Geographic rollout: [Regions and schedule]

### Company Impact
[How this fits into broader company strategy]
- Builds on: [Previous products, capabilities]
- Enables: [Future roadmap, adjacent opportunities]
- Positions company as: [Market leader in X, innovator in Y]
```

### Customer Evidence (1-2 pages)

```markdown
## Early Adopter Results

### Customer 1: [Company Name or "Anonymous Fortune 500 Financial Firm"]

**Profile**:
- Industry: [Sector]
- Size: [Employees, revenue]
- Challenge: [Specific problem faced]

**Implementation**:
- Timeline: [Duration]
- Scope: [Scale of deployment]
- Integration: [Systems connected]

**Results** (After [Timeframe]):
- [Metric 1]: Improved [X]% (from [baseline] to [current])
- [Metric 2]: Reduced [Y]% (from [baseline] to [current])
- [Metric 3]: Achieved [Z outcome]
- ROI: [Timeframe to break even or return percentage]

**Customer Quote**:
"[Testimonial with specific details and attribution]"
— [Name, Title, Company]

[Repeat for 2-3 customers if available]

### Aggregate Results (Beta/Pilot Program)
[If you don't have individual case studies, provide aggregated data]

Based on [N] customers in pilot program ([Date Range]):
- Average improvement in [Metric]: [X]%
- [Y]% achieved ROI within [Timeframe]
- [Z]% plan to expand deployment to additional [units/users/locations]
```

### Expert Perspectives (1 page)

```markdown
## Industry Expert Commentary

### Company Executives

**[Executive 1 Name], [Title]**
On [Topic 1 - e.g., Market Opportunity]:

"[2-3 paragraph quote providing strategic perspective, market analysis,
or vision for future. More conversational and detailed than press release
soundbites.]"

**[Executive 2 Name], [Title]**
On [Topic 2 - e.g., Technical Innovation]:

"[2-3 paragraph quote explaining technical approach, methodology, or
innovation. Can include technical detail appropriate for specialist journalists.]"

### Third-Party Validation (If Available)

**[Analyst Name], [Title], [Firm]**
*Independent analyst covering [Industry]*

"[Quote providing objective third-party perspective on market significance,
competitive positioning, or innovation. Obtain permission before including.]*"

**[Customer Executive], [Title], [Company]**
*[Company description]*

"[Customer perspective on business impact, implementation experience, or
results achieved.]*"

### Academic/Research Perspective (If Relevant)

**[Professor Name], [Institution]**
*[Credentials and research focus]*

"[Quote providing academic or research-based perspective on technology,
methodology, or market dynamics.]*"
```

### Competitive Analysis (Internal Use / Background Only)

```markdown
## Competitive Positioning
**NOTE**: For background context only - not for direct quotation

### How [Product] Compares

| Capability | [Your Product] | Competitor A | Competitor B | Industry Standard |
|------------|----------------|--------------|--------------|-------------------|
| [Feature 1] | [Status/Metric] | [Status/Metric] | [Status/Metric] | [Baseline] |
| [Feature 2] | [Status/Metric] | [Status/Metric] | [Status/Metric] | [Baseline] |
| [Feature 3] | [Status/Metric] | [Status/Metric] | [Status/Metric] | [Baseline] |

### Advantages
- [Advantage 1 with supporting evidence]
- [Advantage 2 with supporting evidence]
- [Advantage 3 with supporting evidence]

### Limitations / Roadmap
[State current limitations, fix scope, prerequisites, and completion checks; cite supplied commitments separately]
- [Current gap]: Planned for [Quarter/Year]
- [Tradeoff made]: [Rationale for decision]

**Messaging Guidance**:
Focus on [unique strengths] rather than direct competitor comparisons.
Recommended positioning: "[Positioning statement]"
```

### Technical Deep Dive (Appendix for Technical Press)

```markdown
## Technical Architecture

### System Overview
[High-level architecture diagram with explanation]

### Technology Stack
- **Frontend**: [Technologies, frameworks]
- **Backend**: [Technologies, frameworks]
- **Database**: [Type, scaling approach]
- **Infrastructure**: [Cloud provider, services used]
- **Security**: [Encryption, authentication, compliance]

### Integration Capabilities
**APIs**:
- REST API: [Endpoints, authentication, rate limits]
- GraphQL: [If supported]
- Webhooks: [Event types, payloads]
- SDKs: [Languages supported]

**Pre-built Integrations**:
- [Platform 1]: [Integration scope]
- [Platform 2]: [Integration scope]
- [Platform 3]: [Integration scope]

### Performance Specifications
- Throughput: [Requests/transactions per second]
- Latency: [Response time percentiles - p50, p95, p99]
- Availability: [SLA - e.g., 99.99% uptime]
- Scalability: [Horizontal/vertical, max capacity]

### Security & Compliance
**Certifications**:
- [SOC 2 Type II]
- [ISO 27001]
- [HIPAA] (if applicable)
- [PCI DSS] (if applicable)

**Security Features**:
- Encryption at rest: [Algorithm, key management]
- Encryption in transit: [TLS version]
- Authentication: [Methods supported]
- Authorization: [RBAC, ABAC, etc.]
- Audit logging: [What's logged, retention]

### Data Privacy
- Data residency: [Regions, options]
- GDPR compliance: [Measures taken]
- Data retention: [Policies]
- Right to deletion: [Process]
```

### FAQ (2-3 pages)

```markdown
## Frequently Asked Questions

### General

**Q: What is [Product/Announcement] in simple terms?**
A: [One-paragraph explanation for general audience]

**Q: When is this available?**
A: [Specific dates, phases, geographic rollout]

**Q: How much does it cost?**
A: [Pricing structure, starting price, what's included]

**Q: Who is this for?**
A: [Target customers, ideal use cases, size/industry]

### Technical

**Q: What platforms/systems does this integrate with?**
A: [List with details on integration depth]

**Q: What are the technical requirements?**
A: [Infrastructure, browser, OS, bandwidth, etc.]

**Q: How does it handle [specific technical concern]?**
A: [Detailed technical answer]

### Business

**Q: How does this compare to [existing solution/competitor]?**
A: [Factual comparison focusing on differentiation, not disparagement]

**Q: What's the ROI/payback period?**
A: [Typical metrics from customers, variables affecting ROI]

**Implementation gates** — Q: What is required for implementation?
A: [Named deliverables, prerequisites, owner roles, and deployment acceptance checks; cite any operator-supplied commitments separately]

### Strategic

**Q: How does this fit into your company's broader strategy?**
A: [Connection to vision, roadmap, market positioning]

**Q: What's next on the roadmap?**
A: [Future features, expansion plans - what you're comfortable sharing]

**Q: How long have you been working on this?**
A: [Development timeline, investment made, team size]
```

### Appendices

```markdown
## Appendix A: Data & Methodology

### Research Methodology
[If citing proprietary research]
- Survey size: [N] respondents
- Demographics: [Industries, company sizes, geographies]
- Data collection: [Date range]
- Margin of error: [±X% at Y% confidence level]
- Survey instrument: [Available upon request]

### Third-Party Data Sources
- [Source 1]: [Citation, link]
- [Source 2]: [Citation, link]
- [Source 3]: [Citation, link]

## Appendix B: Visual Assets

Available for download at [URL]:
- Product screenshots (high-resolution)
- Architecture diagrams
- Infographics (editable formats)
- Executive headshots
- Company logos
- Demo videos
- Customer testimonial videos

## Appendix C: About [Company]

[Standard company boilerplate - 100-200 word version]

### Company Milestones
- [Year]: [Achievement]
- [Year]: [Achievement]
- [Year]: [Achievement]

### Leadership Team
[Brief bios of key executives - link to full bios]

## Appendix D: Additional Resources

**For Further Information**:
- Full press release: [URL]
- Product page: [URL]
- Demo video: [URL]
- Technical documentation: [URL]
- Customer case studies: [URL]

**Media Contact**:
[Name]
[Title]
[Company]
[Email]
[Phone]
[Hours/Timezone]
```

## Briefing Session Formats

### Written Briefing Only
- Send PDF document (embargoed or background)
- No live session
- Follow up via email
- Best for: Busy journalists, straightforward announcements

### Phone Briefing
- 30-45 minute call
- Send written briefing 24 hours in advance
- Walk through key points
- Q&A session
- Record with permission (for accuracy)
- Best for: Complex topics, tier 1 journalists

### In-Person/Video Briefing
- 60-90 minute session
- Send written briefing in advance
- Presentation with visuals
- Product demo (if applicable)
- Q&A session
- Best for: Major announcements, analyst briefings, trade shows

### Group Briefing
- 60-90 minute session with multiple journalists
- Formal presentation
- Panel of executives/experts
- Moderated Q&A
- NDA if showing unreleased products
- Best for: Product launches, strategy updates, analyst days

## Embargo Management

### Embargo Levels

**Standard Embargo**:
```
EMBARGOED UNTIL: [Day], [Month DD, YYYY] at [HH:MM AM/PM TIMEZONE]

This information is provided in advance to allow you to prepare coverage.
Please do not publish or share any details before the embargo lift time.

Background interviews and product demos are permitted under embargo.
```

**Partial Embargo** (Tiered):
```
TIER 1 EMBARGO: Access granted [Date], publish after [Date/Time]
TIER 2 EMBARGO: Access granted [Date], publish after [Date/Time]
GENERAL RELEASE: [Date/Time]

Allows tier 1 media early access while maintaining competitive fairness.
```

**Background Only**:
```
FOR BACKGROUND USE ONLY

This information is provided to help you understand context and develop
informed coverage. It is not for direct quotation or attribution without
explicit permission from [Company].

If you wish to reference specific facts or quotes, please contact [Name]
for clearance.
```

### Embargo Violation Protocol

**If embargo is broken**:
1. Immediately release to all media (level playing field)
2. Document violation (screenshot, archive URL)
3. Contact journalist/editor to clarify misunderstanding
4. Assess whether to exclude outlet from future embargoes
5. Don't publicly call out violations (damages relationships)

## Accessibility & Format

### Document Formats

**Primary**: PDF (searchable, tagged for accessibility)
- Accessible PDF requirements (WCAG 2.1 AA)
- Proper heading structure (H1, H2, H3)
- Alt text for all images/diagrams
- Logical reading order
- Bookmarks for navigation

**Alternative**: Microsoft Word (.docx)
- For journalists who need to copy/paste
- Use styles (not manual formatting)
- Include table of contents
- Embed fonts (if using custom fonts)

**Web Version** (If hosting online):
- HTML with proper semantic markup
- Mobile-responsive
- Print stylesheet for PDF generation
- Password-protected if embargoed

### File Naming

```
[Company]-Press-Briefing-[Topic]-[YYYY-MM-DD].pdf

Example:
AcmeCorp-Press-Briefing-SecureCloud3-Launch-2024-11-28.pdf
```

### File Size

- Target: Under 5 MB (email-friendly)
- Compress images (balance quality and size)
- If larger: Provide download link instead of email attachment

## Distribution Strategy

### Target Audience

**Tier 1 Media**:
- Personalized delivery (individual emails)
- Advance briefing calls offered
- Exclusive access/early embargo
- Follow-up to ensure received and understood

**Tier 2/3 Media**:
- Grouped distribution (BCC or media database)
- Standard embargo (if applicable)
- Written briefing only (no calls)
- Follow up if significant outlet

**Analysts**:
- Individual briefings (longer format, 60-90 min)
- Technical deep dives
- NDA for roadmap discussions
- Ongoing relationship (not one-time)

### Timing

**Advance Notice**:
- Tier 1: 7-14 days before embargo lift (complex stories)
- Tier 1: 3-5 days before embargo lift (standard news)
- Tier 2/3: 24-48 hours before embargo lift
- Analysts: 2-4 weeks before public announcement

**Embargo Lift**:
- Tuesday-Thursday: 9-11 AM ET (optimal for US media)
- Avoid Mondays (catch-up day), Fridays (light news days)
- Avoid holidays and major industry events (competing news)

## Best Practices

### Writing Style

**Clarity**:
- Write for intelligent non-expert (unless technical briefing)
- Define acronyms on first use
- Use concrete examples
- Include analogies for complex concepts

**Objectivity**:
- Present facts, not marketing claims
- Cite sources for third-party data
- Acknowledge limitations honestly
- Avoid superlatives without proof

**Depth**:
- More detail than press release
- Anticipate follow-up questions
- Provide context and background
- Include data and evidence

### Visual Aids

**Include**:
- Architecture diagrams (technical briefings)
- Charts/graphs (market data, performance metrics)
- Screenshots (product features)
- Comparison tables (competitive positioning)
- Timelines (company milestones, roadmap)

**Format**:
- High resolution (300 DPI for print)
- Clear labels and legends
- Accessible (alt text, described in text)
- Editable source files available (for media to customize)

### Fact-Checking

**Before Distribution**:
- Verify all statistics and data points
- Confirm names, titles, companies
- Check dates and timelines
- Validate quotes (get written approval)
- Legal review (claims, competitive statements)
- Executive approval (strategic messaging)

### Follow-Up

**After Distribution**:
- Confirm receipt (tier 1 media)
- Offer briefing calls
- Answer questions promptly (within 2 hours)
- Provide additional materials if requested
- Track who's planning coverage (intel for day-of coordination)

## Related Templates

- **Press Release**: PRS-001 (public announcement)
- **Media Kit**: PRS-002 (comprehensive background resource)
- **Media Pitch**: PRS-003 (journalist outreach email)
- **Spokesperson Guide**: PRS-005 (interview prep)
- **Q&A Document**: PRS-006 (anticipated questions)

## References

- Associated Press Stylebook (writing standards)
- Cision Media Briefing Best Practices
- WCAG 2.1 AA PDF Accessibility Guidelines
- Muck Rack Guide to Effective Media Briefings
