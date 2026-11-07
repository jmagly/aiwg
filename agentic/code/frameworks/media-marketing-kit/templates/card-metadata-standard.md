# Card Metadata Standard (Media & Marketing Kit)

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates.

## Purpose

Define a consistent metadata header for all marketing and media "card" templates so teams can assign ownership, maintain traceability, track campaign performance, and relate cards to their parent campaigns and artifacts.

This standard ensures consistency across campaign planning, content creation, asset management, and performance reporting.

## Required Fields

- ID: use a prefix plus number (examples below)
- Owner: person/role/team responsible for delivery
- Contributors: collaborators (writers, designers, developers)
- Reviewers: approvers (brand, legal, compliance)
- Team: primary team (content, social, creative, etc.)
- Stakeholders: key contacts (product, sales, leadership)
- Status: draft | in-progress | review | approved | published | archived
- Dates: created / updated / published (observed); scheduled only when supplied by an operator with a source
- Campaign: parent campaign ID (if applicable)
- Channel: distribution channel (blog, social, email, paid, etc.)
- Audience: target segment or persona
- Related: IDs to other artifacts (CAM, CNT, AST, BRD, STR, etc.)
- Links: file paths or URLs to assets, briefs, analytics
- Tags: keywords for discovery and filtering

## Marketing-Specific Fields

- KPIs: target metrics (views, clicks, conversions, engagement rate, etc.)
- Budget: allocated spend (total or per-channel)
- Scope Units: named deliverables / responsible roles / review passes / completion gates
- Operator Commitments: supplied campaign/event dates and source, or unset
- Brand Compliance: status (pending | approved | rejected | exempt)
- Legal Review: status (pending | approved | conditional | exempt)
- Performance: actual metrics vs targets (post-launch only)

## Allowed ID Prefixes

- CAM-: Campaign (e.g., CAM-001 for Q1 Product Launch)
- CNT-: Content (e.g., CNT-045 for blog post, video, podcast)
- AST-: Asset (e.g., AST-112 for graphic, video file, template)
- BRD-: Brand artifact (e.g., BRD-003 for brand guidelines, style guide)
- STR-: Strategy document (e.g., STR-008 for content strategy, go-to-market plan)
- PRS-: Press/PR material (e.g., PRS-015 for press release, media kit)
- RPT-: Report/analytics (e.g., RPT-022 for campaign performance report)
- CRE-: Creative brief (e.g., CRE-009 for campaign creative brief)
- EVT-: Event material (e.g., EVT-006 for webinar, conference booth)
- ADS-: Advertising creative (e.g., ADS-018 for paid social ad, display banner)
- EML-: Email campaign (e.g., EML-031 for newsletter, drip sequence)
- SOC-: Social media post (e.g., SOC-074 for Twitter thread, LinkedIn post)
- SEO-: SEO artifact (e.g., SEO-012 for keyword research, meta descriptions)
- INF-: Influencer collaboration (e.g., INF-005 for influencer partnership)
- PAR-: Partnership/co-marketing (e.g., PAR-003 for joint campaign)

## Status Values

**Draft**: Initial creation, not ready for review

**In-Progress**: Actively being developed or executed

**Review**: Submitted for approval (brand, legal, stakeholder)

**Approved**: Cleared for publication/deployment

**Published**: Live and publicly available

**Archived**: Campaign ended, content retired, or asset deprecated

## Header Block (Copy into Cards)

```markdown
## Metadata

- ID: <PREFIX-###>
- Owner: <name/role/team>
- Contributors: <list>
- Reviewers: <list>
- Team: <team>
- Stakeholders: <list>
- Status: <draft/in-progress/review/approved/published/archived>
- Dates: created <YYYY-MM-DD> / updated <YYYY-MM-DD> / published <YYYY-MM-DD> / scheduled <YYYY-MM-DD>
- Campaign: CAM-<id> (parent campaign reference)
- Channel: <blog/social/email/paid/organic/pr/events/partnerships>
- Audience: <target segment/persona>
- Related: CAM-<id>, CNT-<id>, AST-<id>, BRD-<id>, STR-<id>, PRS-<id>, RPT-<id>, CRE-<id>
- Links: <paths/urls to assets, briefs, analytics dashboards>
- Tags: <keywords for discovery>

## Marketing-Specific Metadata

- KPIs: <target metrics: views, clicks, conversions, engagement rate, etc.>
- Budget: $<amount> (<channel breakdown if multi-channel>)
- Scope Units: <deliverables, roles, passes, prerequisites, and acceptance checks>
- Operator Commitments: <supplied dates/windows, source, fixed/flexible; or unset>
- Brand Compliance: <pending/approved/rejected/exempt>
- Legal Review: <pending/approved/conditional/exempt>
- Performance: <actual metrics vs targets (post-launch only)>

## Related Templates

- <template path 1>
- <template path 2>
```

## Examples

### Example 1: Campaign Card

```markdown
## Metadata

- ID: CAM-001
- Owner: Sarah Chen (Campaign Manager)
- Contributors: Marketing team, Creative team, Content writers
- Reviewers: VP Marketing, Brand Manager, Legal
- Team: Product Marketing
- Stakeholders: Product team, Sales leadership, Customer Success
- Status: in-progress
- Dates: created 2025-01-15 / updated 2025-01-28 / published TBD / scheduled 2025-02-15
- Campaign: CAM-001 (this is the parent)
- Channel: multi-channel (blog, social, email, paid)
- Audience: Enterprise buyers, IT decision-makers
- Related: STR-003 (GTM strategy), CRE-001 (creative brief), BRD-001 (brand guidelines)
- Links: /campaigns/q1-product-launch/, https://analytics.example.com/cam-001
- Tags: product-launch, enterprise, Q1-2025, flagship

## Marketing-Specific Metadata

- KPIs: 10,000 impressions, 500 MQLs, 50 demos booked, 5% conversion rate
- Budget: $50,000 (paid social: $20k, paid search: $15k, events: $10k, creative: $5k)
- Scope Units: campaign brief, channel assets, tracking validation, performance report; campaign manager owns approvals before launch
- Operator Commitments: launch 2025-02-15, end 2025-03-31, review 2025-03-01, report 2025-04-07 (source: approved CAM-001 operator brief)
- Brand Compliance: approved
- Legal Review: approved
- Performance: (to be updated post-launch)

## Related Templates

- /templates/strategy/campaign-strategy-template.md
- /templates/content/content-calendar-template.md
- /templates/analytics/campaign-performance-report-template.md
```

### Example 2: Content Card (Blog Post)

```markdown
## Metadata

- ID: CNT-045
- Owner: Alex Rivera (Content Writer)
- Contributors: Subject matter expert (Product team), SEO specialist
- Reviewers: Content Manager, Brand Manager
- Team: Content Marketing
- Stakeholders: Product Marketing, Demand Gen
- Status: review
- Dates: created 2025-01-20 / updated 2025-01-27 / published TBD / scheduled 2025-02-10
- Campaign: CAM-001 (Q1 Product Launch)
- Channel: blog (organic + social distribution)
- Audience: Enterprise IT leaders, DevOps engineers
- Related: CAM-001, SEO-012 (keyword research), AST-078 (featured image), SOC-089 (social promo posts)
- Links: /drafts/how-to-scale-infrastructure.md, https://cms.example.com/posts/45
- Tags: infrastructure, scalability, DevOps, technical-how-to

## Marketing-Specific Metadata

- KPIs: 5,000 page views, 10% scroll depth, 2% CTA click-through, 50 newsletter signups
- Budget: $0 (organic content)
- Scope Units: one blog post, featured image, social copy, performance review; writer and brand reviewer verify publication checks
- Operator Commitments: publish 2025-02-10, promotion through 2025-02-17, review 2025-03-10 (source: approved editorial calendar)
- Brand Compliance: approved
- Legal Review: exempt (no legal claims or regulated content)
- Performance: (to be updated post-publish)

## Related Templates

- /templates/content/blog-post-template.md
- /templates/content/content-brief-template.md
- /templates/social/social-promotion-template.md
```

### Example 3: Asset Card (Video)

```markdown
## Metadata

- ID: AST-112
- Owner: Jordan Lee (Video Producer)
- Contributors: Creative Director, Motion Graphics Designer, Copywriter
- Reviewers: Creative Director, Brand Manager, Legal (for music licensing)
- Team: Creative
- Stakeholders: Campaign Manager, Social Media Manager
- Status: approved
- Dates: created 2025-01-10 / updated 2025-01-25 / published 2025-02-01 / scheduled 2025-02-15
- Campaign: CAM-001 (Q1 Product Launch)
- Channel: social (YouTube, LinkedIn, Twitter)
- Audience: Enterprise buyers, technical evaluators
- Related: CAM-001, CRE-001 (creative brief), SOC-095 (YouTube description), ADS-022 (paid social cut)
- Links: /assets/video/product-demo-v3-final.mp4, https://youtube.com/watch?v=example
- Tags: product-demo, video, explainer, 90-seconds

## Marketing-Specific Metadata

- KPIs: 50,000 views, 8,000 engagements, 500 click-throughs to landing page, 3% CTR
- Budget: $8,000 (production: $5k, paid promotion: $3k)
- Scope Units: one demo video and paid cut; producer, brand and legal review passes complete before distribution
- Operator Commitments: publish 2025-02-15, promotion 2025-02-16 through 2025-03-15, review 2025-03-01 (source: approved media booking)
- Brand Compliance: approved
- Legal Review: approved (music licensed, talent releases signed)
- Performance: (to be updated post-publish)

## Related Templates

- /templates/creative/video-brief-template.md
- /templates/creative/storyboard-template.md
- /templates/social/video-distribution-template.md
```

### Example 4: Report Card (Campaign Performance)

```markdown
## Metadata

- ID: RPT-022
- Owner: Data Analyst (Marketing Analytics)
- Contributors: Campaign Manager, Paid Media Specialist
- Reviewers: VP Marketing, Director of Demand Gen
- Team: Marketing Analytics
- Stakeholders: Executive team, Sales leadership
- Status: published
- Dates: created 2025-04-01 / updated 2025-04-05 / published 2025-04-07 / scheduled N/A
- Campaign: CAM-001 (Q1 Product Launch)
- Channel: N/A (performance report)
- Audience: Internal stakeholders (marketing, sales, exec)
- Related: CAM-001, RPT-015 (mid-campaign report), STR-003 (GTM strategy)
- Links: /reports/cam-001-final-performance.pdf, https://analytics.example.com/reports/cam-001-final
- Tags: performance-report, Q1-2025, product-launch, post-mortem

## Marketing-Specific Metadata

- KPIs: Target: 10k impressions, 500 MQLs, 50 demos, 5% conversion | Actual: 12.3k impressions, 487 MQLs, 62 demos, 6.1% conversion
- Budget: Allocated: $50k | Spent: $48.2k (96% utilization)
- Scope Units: reconcile campaign metrics and budget; analyst verifies dashboard totals and reviewer accepts report
- Observed Campaign Window: 2025-02-15 through 2025-03-31; report published 2025-04-07
- Brand Compliance: N/A (internal report)
- Legal Review: N/A (internal report)
- Performance: MQLs: 97% of target, Demos: 124% of target, Conversion: 122% of target, ROMI: 3.2x

## Related Templates

- /templates/analytics/campaign-performance-report-template.md
- /templates/analytics/roi-analysis-template.md
```

### Example 5: Creative Brief Card

```markdown
## Metadata

- ID: CRE-009
- Owner: Creative Director
- Contributors: Campaign Manager, Brand Manager, Copywriter
- Reviewers: VP Marketing, Product Marketing Manager
- Team: Creative
- Stakeholders: Campaign team, Product team
- Status: approved
- Dates: created 2025-01-05 / updated 2025-01-12 / published N/A / scheduled N/A
- Campaign: CAM-001 (Q1 Product Launch)
- Channel: multi-channel (informs all creative assets)
- Audience: Enterprise buyers, IT decision-makers
- Related: CAM-001, STR-003 (GTM strategy), BRD-001 (brand guidelines), AST-112 (hero video), CNT-045 (blog post)
- Links: /briefs/cam-001-creative-brief.md
- Tags: creative-brief, campaign-planning, Q1-2025, product-launch

## Marketing-Specific Metadata

- KPIs: N/A (this is a planning artifact, not a deliverable)
- Budget: N/A (budget allocated at campaign and asset level)
- Scope Units: creative concepts, selected direction, approved assets; creative director owns concept and final review gates
- Operator Commitments: start N/A / end N/A / milestones [brief finalized 2025-01-12, assets due 2025-02-01] (source: approved CRE-009 operator brief)
- Brand Compliance: approved (brief aligns with brand guidelines)
- Legal Review: exempt (planning document)
- Performance: N/A (not a published asset)

## Related Templates

- /templates/creative/creative-brief-template.md
- /templates/strategy/campaign-strategy-template.md
- /templates/brand/brand-guidelines-template.md
```

## Usage Guidelines

### When to Create a Card

Create a card for:

- Every campaign (CAM-)
- Every published content piece (CNT-)
- Every creative asset (AST-)
- Every strategic document (STR-)
- Every creative brief (CRE-)
- Every performance report (RPT-)
- Major brand artifacts (BRD-)
- Press/PR materials (PRS-)
- Event materials (EVT-)

### Ownership and Assignment

**Owner**: Single point of accountability for delivery

**Contributors**: Active collaborators who create/edit content

**Reviewers**: Approvers with veto power (brand, legal, stakeholder)

**Team**: Primary functional team (for cross-functional visibility)

**Stakeholders**: Informed parties who provide input but don't approve

### Linking Cards

Use the Related field to create traceability:

- Link content cards (CNT-) to parent campaign (CAM-)
- Link assets (AST-) to content cards (CNT-) and campaigns (CAM-)
- Link reports (RPT-) to campaigns (CAM-) and strategy docs (STR-)
- Link creative briefs (CRE-) to campaigns (CAM-) and assets (AST-)

### Updating Cards

**Status progression**:

1. Draft → In-Progress (work begins)
2. In-Progress → Review (submitted for approval)
3. Review → Approved (cleared for publication)
4. Approved → Published (live)
5. Published → Archived (campaign ended or content retired)

**Date fields**:

- Created: First draft date
- Updated: Last edit date (update frequently)
- Published: Public launch date
- Scheduled: Operator-supplied publication date and source (leave unset when unknown)

**Performance field**:

- Leave empty until asset is published
- Update post-launch with actual metrics vs targets
- Include in campaign reports (RPT-) for full visibility

## Prefill Automation

Teams can use the `aiwg -prefill-cards` tool to auto-populate metadata from team profiles:

```bash
# Prefill ownership from team-profile.yaml
aiwg -prefill-cards --target /campaigns/cam-001/ --team team-profile.yaml --write

# Example team profile:
# teams:
#   content:
#     owner: Alex Rivera
#     reviewers: [Content Manager, Brand Manager]
#   creative:
#     owner: Jordan Lee
#     reviewers: [Creative Director, Brand Manager]
```

This reduces manual entry and ensures consistency across cards.

## Tools and Integration

**Card tracking tools**:

- `build-artifact-index`: Generate index of all cards by campaign, status, owner
- `check-traceability`: Validate links between campaigns, content, assets, reports
- `project-health-check`: Analyze card metadata for completeness, approval status

**Analytics integration**:

- Link cards to analytics dashboards via Links field
- Track performance in Performance field post-launch
- Generate reports (RPT-) that reference source cards

**Workflow automation**:

- Use Status field to trigger approvals (review → approved)
- Use Dates field to schedule publication
- Use KPIs field to auto-populate analytics dashboards

## Best Practices

1. **Assign owners early**: Every card needs a single owner (no shared ownership)
2. **Update dates frequently**: Keep Updated field current (shows card is active)
3. **Link generously**: Use Related field to connect artifacts (enables traceability)
4. **Set realistic KPIs**: Base targets on historical data, not aspirational guesses
5. **Review compliance early**: Get brand/legal approval before in-progress → review
6. **Archive old cards**: Move completed campaigns to archived status (keeps workspace clean)
7. **Use tags liberally**: Tags enable discovery across campaigns (e.g., find all "product-launch" cards)
8. **Track performance**: Update Performance field post-launch (informs future planning)

## Examples by Template Type

**Campaign Strategy**: CAM-001, links to STR-, CRE-, CNT-, AST-, RPT-

**Blog Post**: CNT-045, links to CAM-, SEO-, AST- (images), SOC- (promotion)

**Social Media Post**: SOC-074, links to CAM-, CNT- (source content), AST- (images/video)

**Email Campaign**: EML-031, links to CAM-, CNT- (content source), AST- (email graphics)

**Video Asset**: AST-112, links to CRE- (brief), CAM-, SOC- (distribution)

**Creative Brief**: CRE-009, links to CAM-, STR-, BRD-, AST- (deliverables)

**Performance Report**: RPT-022, links to CAM-, CNT-, AST-, STR- (original plan)

**Press Release**: PRS-015, links to CAM-, BRD- (brand guidelines), EVT- (if event-related)

**Event Material**: EVT-006, links to CAM-, AST- (slides, booth graphics), PRS- (press kit)

## Migration from Existing Systems

If migrating from existing project management or content systems:

1. **Assign IDs retroactively**: Use creation date or existing ticket numbers
2. **Populate minimum fields**: ID, Owner, Status, Dates, Related (other fields optional initially)
3. **Link incrementally**: Start with campaign-to-content links, expand over time
4. **Import metadata**: Use scripts to extract owner/dates from existing systems
5. **Archive old content**: Mark pre-migration content as archived (focus on active campaigns)

## Appendix: Complete ID Prefix Reference

| Prefix | Type | Example | Use Case |
|--------|------|---------|----------|
| CAM- | Campaign | CAM-001 | Q1 Product Launch Campaign |
| CNT- | Content | CNT-045 | Blog post, video, podcast episode |
| AST- | Asset | AST-112 | Image, video file, template, design |
| BRD- | Brand | BRD-003 | Brand guidelines, style guide |
| STR- | Strategy | STR-008 | Content strategy, GTM plan |
| PRS- | Press/PR | PRS-015 | Press release, media kit |
| RPT- | Report | RPT-022 | Campaign performance report |
| CRE- | Creative | CRE-009 | Creative brief, concept |
| EVT- | Event | EVT-006 | Webinar, conference, trade show |
| ADS- | Advertising | ADS-018 | Paid social ad, display banner |
| EML- | Email | EML-031 | Newsletter, drip campaign |
| SOC- | Social | SOC-074 | Social media post, thread |
| SEO- | SEO | SEO-012 | Keyword research, meta tags |
| INF- | Influencer | INF-005 | Influencer partnership |
| PAR- | Partnership | PAR-003 | Co-marketing campaign |
