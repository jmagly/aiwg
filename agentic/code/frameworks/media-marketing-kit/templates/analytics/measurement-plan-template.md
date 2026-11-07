# Measurement Plan Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- ID: RPT-###
- Owner: [Marketing Analyst / Analytics Lead]
- Contributors: [Campaign Manager, Data Engineer, Marketing Operations]
- Reviewers: [VP Marketing, Data Privacy Officer, Compliance]
- Team: Marketing Analytics
- Stakeholders: [Marketing Leadership, Campaign Teams, Data Team]
- Status: draft | in-progress | review | approved | published | archived
- Dates: created YYYY-MM-DD / updated YYYY-MM-DD / published YYYY-MM-DD / scheduled YYYY-MM-DD
- Campaign: CAM-### (if campaign-specific) or N/A (if organization-wide)
- Channel: multi-channel (covers all marketing channels)
- Audience: Internal (marketing team, analytics team, leadership)
- Related: [CAM-###, STR-###, RPT-###]
- Links: [Analytics platform URLs, data warehouse schema docs, privacy policy]
- Tags: [measurement, KPIs, tracking, analytics-foundation]

## Marketing-Specific Metadata

- KPIs: N/A (this defines KPIs for other initiatives)
- Budget: $[analytics tooling costs]
- Scope Units: event inventory, instrumentation, validation; analyst and implementer; gates: validated event fixtures and reconciled metrics
- Brand Compliance: N/A (internal planning document)
- Legal Review: required (privacy compliance validation)
- Performance: N/A (planning artifact)

## Related Templates

- /templates/analytics/kpi-dashboard-spec-template.md
- /templates/analytics/campaign-report-template.md
- /templates/analytics/attribution-model-template.md
- /templates/strategy/marketing-strategy-template.md

---

## 1. Executive Summary

**Measurement Plan Purpose**: [One paragraph describing what this measurement plan covers - campaign, channel, or organization-wide analytics strategy]

**Measurement Objectives**:

- [Primary objective - e.g., "Track ROI across all paid marketing channels"]
- [Secondary objective - e.g., "Understand customer journey across touchpoints"]
- [Tertiary objective - e.g., "Enable real-time campaign optimization"]

**Key Stakeholders**:

- **Primary audience**: [Who consumes this data - e.g., "Campaign Managers, Demand Gen Team"]
- **Executive audience**: [Leadership recipients - e.g., "VP Marketing, CMO, CFO"]
- **Technical audience**: [Implementation teams - e.g., "Data Engineers, Analytics Team"]

**Implementation Status**: [Not started / In progress / Complete / Ongoing]

---

## 2. Business Goals & Measurement Objectives

### 2.1 Business Goals

| Business Goal | Description | Owner | Completion Gate |
|---------------|-------------|-------|----------|
| [e.g., "Increase MQLs by 25%"] | [Detailed description of what this means] | [Demand Gen Lead] | [Q1 2025] |
| [e.g., "Improve CAC efficiency"] | [Description] | [Marketing Ops] | [Ongoing] |
| [Goal 3] | [Description] | [Owner] | [Evidence demonstrating the goal is met] |

### 2.2 Measurement Objectives

Link each measurement objective to business goals:

**Objective 1**: [e.g., "Track MQL volume and quality across all channels"]

- **Supports business goal**: [Reference goal from 2.1]
- **Success criteria**: [What defines success - e.g., "Real-time MQL tracking with <5min latency"]
- **Measurement approach**: [How we'll measure - e.g., "Form submissions tagged with UTM parameters"]

**Objective 2**: [e.g., "Attribute revenue to marketing touchpoints"]

- **Supports business goal**: [Reference goal]
- **Success criteria**: [Definition of success]
- **Measurement approach**: [Methodology]

**Objective 3**: [Additional objective]

- **Supports business goal**: [Reference goal]
- **Success criteria**: [Definition]
- **Measurement approach**: [Methodology]

---

## 3. KPI Framework

### 3.1 KPI Hierarchy

**North Star Metric**: [Single metric that best represents business value - e.g., "Marketing-Sourced Revenue"]

**Primary KPIs** (drive North Star):

- [KPI 1 - e.g., "MQL volume"]
- [KPI 2 - e.g., "MQL → SQL conversion rate"]
- [KPI 3 - e.g., "Average deal size"]

**Secondary KPIs** (support primary KPIs):

- [Supporting metric 1 - e.g., "Landing page conversion rate"]
- [Supporting metric 2 - e.g., "Email engagement rate"]
- [Supporting metric 3 - e.g., "Content downloads"]

**Operational Metrics** (health checks):

- [Operational metric 1 - e.g., "Campaign setup errors"]
- [Operational metric 2 - e.g., "Data quality score"]
- [Operational metric 3 - e.g., "Tracking coverage %"]

### 3.2 KPI Definitions

| KPI Name | Definition | Calculation | Data Source | Owner | Target | Reporting Frequency |
|----------|------------|-------------|-------------|-------|--------|---------------------|
| [e.g., "MQL Volume"] | [Number of marketing-qualified leads generated] | [COUNT(leads WHERE status = 'MQL')] | [CRM system] | [Demand Gen] | [500/month] | [Daily] |
| [KPI 2] | [Clear definition] | [Formula] | [Source system] | [Owner] | [Target] | [Frequency] |
| [KPI 3] | [Definition] | [Formula] | [Source] | [Owner] | [Target] | [Frequency] |

### 3.3 KPI Categorization

**By Funnel Stage**:

| Stage | KPIs |
|-------|------|
| **Awareness** | [Impressions, Reach, Share of Voice, Brand Lift] |
| **Consideration** | [Website visits, Content downloads, Time on site, Pages per session] |
| **Intent** | [Demo requests, Trial signups, Pricing page views, Quote requests] |
| **Conversion** | [MQLs, SQLs, Opportunities created, Closed-won deals] |
| **Retention** | [Customer engagement score, NPS, Renewal rate, Expansion revenue] |

**By Channel**:

| Channel | Primary KPIs | Secondary KPIs |
|---------|--------------|----------------|
| **Paid Search** | [Clicks, CPC, Conversion rate, ROAS] | [Impression share, Quality score, CTR] |
| **Paid Social** | [Impressions, CPM, CTR, Cost per lead] | [Engagement rate, Video completion rate] |
| **Organic Search** | [Organic traffic, Keyword rankings, CTR] | [Backlinks, Domain authority] |
| **Email** | [Open rate, Click rate, Conversion rate] | [Unsubscribe rate, Deliverability] |
| **Content** | [Page views, Time on page, Downloads] | [Scroll depth, Social shares] |
| [Add channels] | [KPIs] | [KPIs] |

---

## 4. Data Sources & Collection

### 4.1 Data Sources Inventory

| Data Source | Type | Data Collected | Update Frequency | Owner | Access Method |
|-------------|------|----------------|------------------|-------|---------------|
| [e.g., "Google Analytics 4"] | [Web analytics] | [User behavior, conversions, traffic sources] | [Real-time] | [Marketing Ops] | [API, UI export] |
| [e.g., "Salesforce CRM"] | [CRM] | [Leads, opportunities, revenue] | [Real-time sync] | [Sales Ops] | [API] |
| [e.g., "HubSpot"] | [Marketing automation] | [Email engagement, form submissions, workflows] | [Real-time] | [Marketing Ops] | [API] |
| [Ad Platform 1] | [Paid media] | [Impressions, clicks, spend, conversions] | [Daily] | [Paid Media Manager] | [API] |
| [Data source N] | [Type] | [Data] | [Frequency] | [Owner] | [Access] |

### 4.2 Data Collection Methods

**First-Party Data Collection** (privacy-compliant, consented):

- **Website tracking**:
  - **Method**: [e.g., "Google Analytics 4 with consent mode v2"]
  - **Implementation**: [Server-side tracking via GTM + consent banner]
  - **Privacy controls**: [Cookie consent, data minimization, user deletion API]
  - **Data retention**: [26 months for users, 14 months for events]

- **Form submissions**:
  - **Method**: [CRM form integration with UTM capture]
  - **Implementation**: [Hidden fields capture UTM, referrer, landing page]
  - **Privacy controls**: [Privacy policy disclosure, opt-in checkbox for marketing]
  - **Data retention**: [Per CRM data retention policy]

- **Email engagement**:
  - **Method**: [Email platform tracking pixels + link click tracking]
  - **Implementation**: [UTM parameters on all email links, unique tracking IDs]
  - **Privacy controls**: [Unsubscribe link, preference center, data subject requests]
  - **Data retention**: [Per email platform policy]

**Server-Side Tracking** (cookieless, privacy-enhanced):

- **Implementation**: [Google Tag Manager Server-Side container]
- **Benefits**: [First-party data collection, reduced client-side script load, PII control]
- **Data flow**: [User event → GTM client → GTM server → GA4/CRM]
- **Privacy enhancements**: [PII redaction, IP anonymization, consent enforcement]

**Zero-Party Data** (user-volunteered):

- **Collection points**: [Preference centers, surveys, account profiles]
- **Data types**: [Interests, preferences, intent signals, contact preferences]
- **Privacy controls**: [Explicit opt-in, granular controls, easy deletion]

### 4.3 Privacy-First Tracking Architecture

**Consent Management**:

- **Platform**: [e.g., "OneTrust, Cookiebot, or custom"]
- **Consent categories**: [Strictly necessary, Functional, Analytics, Advertising]
- **Default state**: [Opt-in for GDPR regions, opt-out elsewhere (based on regulation)]
- **Consent enforcement**: [Tag Manager only fires tags when consent granted]

**Data Minimization**:

- **PII exclusion**: [No email addresses, phone numbers, or names in analytics tools]
- **IP anonymization**: [Enabled in GA4, server-side tracking]
- **User ID hashing**: [SHA-256 hashing for cross-device tracking]
- **Data retention limits**: [Automatic deletion after retention period]

**Cross-Domain Tracking** (privacy-compliant):

- **Method**: [GA4 cross-domain measurement with consent]
- **Domains**: [List domains - e.g., "example.com, shop.example.com, blog.example.com"]
- **User ID strategy**: [First-party cookie with consented cross-domain linking]

---

## 5. Attribution Model

### 5.1 Attribution Approach

**Primary Attribution Model**: [e.g., "Data-Driven Attribution (Google Analytics 4)"]

**Why this model**:

- [Rationale 1 - e.g., "Machine learning distributes credit based on actual conversion paths"]
- [Rationale 2 - e.g., "Works in cookieless environment using modeled data"]
- [Rationale 3 - e.g., "Supported natively in GA4 for cross-channel view"]

**Secondary Attribution Models** (for comparison):

- [Model 2 - e.g., "First-Touch Attribution (for awareness measurement)"]
- [Model 3 - e.g., "Last-Touch Non-Direct (for demand gen validation)"]

**Attribution Windows**:

- **Click-through window**: [e.g., "30 days"]
- **View-through window**: [e.g., "7 days for display/video ads"]
- **Rationale**: [Why these windows - e.g., "Average sales cycle is 45 days, so 30-day click + 7-day view captures majority of influence"]

### 5.2 Attribution Challenges & Solutions

| Challenge | Privacy-First Solution |
|-----------|------------------------|
| **Cookie deprecation** | [First-party data collection, server-side tracking, consent-based cookies] |
| **Cross-device tracking** | [User ID login tracking (consented), probabilistic modeling, GA4 cross-device reports] |
| **Walled garden data silos** | [Platform-specific conversion tracking, data clean rooms for collaboration] |
| **Incomplete user journeys** | [Marketing Mix Modeling for aggregate analysis, incrementality testing] |
| **Offline conversions** | [CRM integration, call tracking with UTM passthrough, offline conversion import] |

### 5.3 Attribution Reporting

**Attribution Report Cadence**: [e.g., "Monthly detailed analysis, quarterly deep-dive"]

**Key Attribution Questions**:

- Which channels drive the most conversions? (Last-touch)
- Which channels initiate customer journeys? (First-touch)
- Which channels assist conversions? (Multi-touch contribution)
- What is the typical customer journey? (Path analysis)
- Which combinations of channels perform best? (Channel interaction)

**Attribution Outputs**:

- [Path analysis report - visualize common conversion paths]
- [Channel contribution report - credit distribution across channels]
- [Assisted conversion analysis - identify supporting channels]
- [Time lag analysis - understand sales cycle by channel]

---

## 6. Data Infrastructure & Integration

### 6.1 Data Flow Architecture

```
[User Action]
    ↓
[Client-Side Tracking (GTM)] → (with consent) → [Server-Side Tracking (GTM Server)]
    ↓                                                    ↓
[GA4 / Advertising Platforms]                    [Data Warehouse (BigQuery/Snowflake)]
    ↓                                                    ↓
[CRM (Salesforce/HubSpot)] ← (API sync) ← [ETL Pipeline]
    ↓
[Unified Reporting Layer (Looker/Tableau)]
    ↓
[Dashboards & Reports]
```

**Key Integration Points**:

- **Web → Analytics**: [GA4 tracking via GTM]
- **Analytics → CRM**: [GA4 conversions pushed to CRM via Zapier/native integration]
- **CRM → Data Warehouse**: [Nightly ETL via Fivetran/Stitch]
- **Ad Platforms → Data Warehouse**: [API pulls for spend, impressions, clicks]
- **Data Warehouse → BI Tool**: [Direct connection for unified reporting]

### 6.2 UTM Tagging Strategy

**UTM Parameter Standard**:

| Parameter | Purpose | Format | Example |
|-----------|---------|--------|---------|
| `utm_source` | Traffic source | [Platform name] | `google`, `linkedin`, `newsletter` |
| `utm_medium` | Marketing medium | [Channel category] | `cpc`, `social`, `email`, `organic` |
| `utm_campaign` | Campaign name | [Campaign ID or descriptor] | `q1-product-launch`, `webinar-2025-02` |
| `utm_content` | Ad/content variant | [Creative version] | `headline-a`, `cta-button-red`, `video-30s` |
| `utm_term` | Keyword (paid search) | [Keyword or audience] | `enterprise-software`, `{keyword}` (dynamic) |

**Custom Parameters** (optional, for advanced tracking):

- `utm_id`: [Campaign ID for GA4 campaign grouping]
- `utm_source_platform`: [Differentiate platform vs partner - e.g., "linkedin" vs "linkedin_sponsored"]

**Naming Conventions**:

- **Always lowercase**: [utm_source=linkedin, not LinkedIn]
- **Use hyphens, not underscores**: [q1-product-launch, not q1_product_launch]
- **Be consistent**: [Use "cpc" for all paid search, not mix of "cpc", "ppc", "paid-search"]
- **Avoid special characters**: [No spaces, no &, no =]

**UTM Builder Tool**: [Link to internal UTM builder or standardized spreadsheet]

### 6.3 Conversion Tracking

**Conversion Events**:

| Conversion Event | Trigger | Tracking Method | Value | Destination |
|------------------|---------|-----------------|-------|-------------|
| [e.g., "MQL Submission"] | [Form submission on /contact page] | [GA4 event + CRM API] | [$0 or estimated value] | [GA4, CRM, Data Warehouse] |
| [e.g., "Demo Request"] | [Calendly booking confirmation] | [Webhook to CRM + GA4 Measurement Protocol] | [$500 estimated pipeline value] | [GA4, CRM] |
| [e.g., "Trial Signup"] | [Account created in product] | [Product event API → GA4] | [$1000 estimated LTV] | [GA4, Product DB, CRM] |
| [Event N] | [Trigger] | [Method] | [Value] | [Destination] |

**Offline Conversion Import**:

- **Phone call conversions**: [Call tracking platform (CallRail) → CRM → GA4 offline conversion import]
- **In-person event leads**: [Event app → CRM (manual or API) → GA4 offline import]
- **Partner-driven leads**: [Partner portal submission → CRM → GA4 offline import]

**Conversion Value Assignment**:

- **Actual revenue**: [Use actual deal value for closed-won opportunities]
- **Estimated value**: [Use historical average for MQLs, trials, demos (e.g., MQL = $200 expected value)]
- **Dynamic value**: [For e-commerce, pass actual cart value]

---

## 7. Data Quality & Governance

### 7.1 Data Quality Standards

**Data Accuracy**:

- **Target**: [95% accuracy for UTM tagging, 99% for conversion tracking]
- **Validation**: [Monthly audits of UTM parameters, daily conversion tracking tests]
- **Error handling**: [Alerts for missing UTMs, conversion discrepancies >10%]

**Data Completeness**:

- **Target**: [100% of paid campaigns tagged with UTMs, 100% of forms tracked]
- **Validation**: [Pre-launch checklist for campaign tracking, automated tests]

**Data Consistency**:

- **Target**: [Consistent naming conventions across all platforms]
- **Validation**: [Automated checks for naming convention violations]
- **Remediation**: [Quarterly cleanup of non-standard tags]

### 7.2 Data Governance

**Data Ownership**:

| Data Type | Owner | Steward | Consumers |
|-----------|-------|---------|-----------|
| [Website analytics] | [Marketing Ops] | [Analytics Team] | [All marketing, product] |
| [CRM data] | [Sales Ops] | [CRM Admin] | [Sales, marketing, customer success] |
| [Ad platform data] | [Paid Media Manager] | [Marketing Ops] | [Paid media team, analytics] |
| [Data N] | [Owner] | [Steward] | [Consumers] |

**Data Access Controls**:

- **Admin access**: [Marketing Ops, Analytics Lead, Data Engineers]
- **Edit access**: [Campaign Managers, Paid Media Specialists]
- **View access**: [All marketing team members]
- **No access**: [External contractors unless NDA signed]

**Data Retention Policy**:

| Data Type | Retention Period | Rationale | Deletion Method |
|-----------|------------------|-----------|-----------------|
| [User-level analytics] | [26 months] | [GA4 default, supports year-over-year analysis] | [Automatic deletion in GA4] |
| [Aggregated campaign data] | [Indefinite] | [Historical benchmarking] | [N/A - no PII] |
| [CRM lead data] | [Per CRM policy - e.g., 7 years] | [Legal compliance, sales cycle support] | [Manual or automated purge] |
| [Email engagement data] | [Per email platform policy] | [Subscriber preference management] | [Automatic upon unsubscribe] |

### 7.3 Privacy Compliance

**Regulatory Compliance**:

- **GDPR** (EU): [Consent required, data minimization, right to deletion]
- **CCPA** (California): [Opt-out available, data disclosure rights]
- **PIPEDA** (Canada): [Consent for collection, use, disclosure]
- **Other**: [List applicable regulations]

**Privacy Controls Checklist**:

- [ ] Consent banner implemented (required regions)
- [ ] Privacy policy updated with data collection disclosure
- [ ] Data subject request (DSR) process documented
- [ ] PII redaction in analytics tools (no email, phone, names)
- [ ] IP anonymization enabled
- [ ] Data retention limits configured
- [ ] User deletion API implemented
- [ ] Cross-border data transfer safeguards (if applicable)

**Data Subject Rights Support**:

- **Right to access**: [Process to export user data from all systems]
- **Right to deletion**: [Process to purge user data from analytics, CRM, email platforms]
- **Right to portability**: [Data export in machine-readable format]
- **Right to rectification**: [Process to update incorrect data]

---

## 8. Reporting & Visualization

### 8.1 Reporting Cadence

| Report Type | Frequency | Audience | Delivery Method | Owner |
|-------------|-----------|----------|-----------------|-------|
| [Real-time dashboard] | [Always-on] | [Campaign Managers] | [Looker/Tableau live dashboard] | [Analytics Team] |
| [Daily flash report] | [Daily] | [Marketing Leadership] | [Email summary] | [Marketing Ops] |
| [Weekly performance] | [Weekly] | [Marketing Team] | [Slack post + dashboard link] | [Marketing Analyst] |
| [Monthly deep-dive] | [Monthly] | [Leadership, Finance] | [Slide deck + dashboard] | [Marketing Analyst] |
| [Quarterly business review] | [Quarterly] | [Executive Team, Board] | [Executive summary] | [VP Marketing] |
| [Campaign retrospective] | [Post-campaign] | [Campaign Team] | [Document + presentation] | [Campaign Manager] |

### 8.2 Dashboard Specifications

**Executive Dashboard** (Monthly KPIs):

- **KPIs displayed**: [MQLs, Pipeline, Revenue, CAC, ROAS]
- **Visualizations**: [Scorecards with trend arrows, line charts for trends, bar charts for channel comparison]
- **Filters**: [Date range, channel, region]
- **Access**: [VP Marketing, CMO, CFO]

**Campaign Manager Dashboard** (Daily/Weekly):

- **KPIs displayed**: [Impressions, clicks, CTR, conversions, cost per conversion, ROAS]
- **Visualizations**: [Time series, funnel charts, channel mix pie chart]
- **Filters**: [Campaign, channel, date range, device, geography]
- **Access**: [All campaign managers, paid media team]

**Channel-Specific Dashboards**:

- [Paid Search Dashboard - impressions, clicks, CPC, conversion rate, quality score, impression share]
- [Paid Social Dashboard - impressions, CPM, CTR, engagement rate, video completion rate, cost per lead]
- [Email Dashboard - sends, open rate, click rate, conversion rate, unsubscribe rate]
- [Content Dashboard - page views, time on page, scroll depth, downloads, social shares]

### 8.3 Visualization Best Practices

**Chart Type by Metric**:

| Metric Type | Recommended Visualization |
|-------------|---------------------------|
| **Trends over time** | Line chart |
| **Channel comparison** | Horizontal bar chart |
| **Funnel stages** | Funnel chart |
| **Composition (channel mix)** | Stacked bar or donut chart |
| **Single KPI** | Scorecard with trend indicator |
| **Relationship (spend vs. conversions)** | Scatter plot |
| **Geographic performance** | Map (choropleth or bubble map) |

**Dashboard Design Principles**:

- **Most important KPIs at top**: [Executives scan top-left first]
- **Trend indicators**: [Up/down arrows, red/green color coding]
- **Consistent color scheme**: [Match brand, use color sparingly for emphasis]
- **Mobile-responsive**: [Key dashboards accessible on mobile]
- **Annotations**: [Mark campaign launches, major events, anomalies]

---

## 9. Incrementality Testing

### 9.1 Purpose

Incrementality testing validates whether marketing channels truly drive incremental conversions (not just claiming credit for users who would have converted anyway).

**Key Questions**:

- Does this channel actually drive new conversions, or just reach existing intent?
- What happens if we turn off this channel for a period?
- How much lift does this campaign provide vs. no campaign?

### 9.2 Testing Methodology

**Geo-based Holdout Test**:

- **Approach**: [Run campaign in Treatment markets, withhold from Control markets]
- **Example**: ["Run paid search in 80% of markets, exclude 20% as control"]
- **Measurement**: [Compare conversion rates in Treatment vs Control markets]
- **Incrementality calculation**: [(Treatment conversions - Control conversions) / Control conversions]

**Time-based Holdout Test**:

- **Approach**: [Run campaign for 2 weeks, pause for 1 week, measure delta]
- **Example**: ["Pause LinkedIn ads for 1 week per month, measure impact on MQLs"]
- **Measurement**: [Compare conversion rates during on-weeks vs off-weeks]

**User-level Randomized Test** (PSA approach):

- **Approach**: [Show campaign to Treatment group, show PSA to Control group]
- **Example**: ["Meta Conversion Lift Study - show ad to 90%, PSA to 10%"]
- **Measurement**: [Compare conversion rates between Treatment and Control cohorts]

### 9.3 Test Design

**Sample Test Plan**:

- **Channel**: [e.g., "Paid Social (Meta)"]
- **Hypothesis**: ["Paid social drives 200 incremental MQLs per month"]
- **Test type**: [Geo-holdout or platform conversion lift study]
- **Treatment**: [Run ads in selected markets]
- **Control**: [Exclude ads from control markets or show PSA]
- **Duration**: [4 weeks minimum for statistical significance]
- **Success criteria**: [>10% lift in Treatment vs Control]

**Statistical Rigor**:

- **Minimum sample size**: [Use power analysis - typically need 1000+ conversions for 95% confidence]
- **Significance level**: [95% confidence, p < 0.05]
- **Test duration**: [Long enough to cover full sales cycle - at least 2x average conversion window]

### 9.4 Incrementality Reporting

**Test Results Template**:

| Metric | Control | Treatment | Lift | Significance |
|--------|---------|-----------|------|--------------|
| [Impressions] | [N/A] | [500,000] | [N/A] | [N/A] |
| [Conversions] | [150] | [195] | [+30%] | [p = 0.02, significant] |
| [Conversion rate] | [2.5%] | [3.3%] | [+0.8pp] | [Significant] |
| [Cost per incremental conversion] | [N/A] | [$45 / (195-150) = $222] | [N/A] | [N/A] |

**Interpretation**: [Based on this test, paid social drives 45 incremental conversions (195 - 150), representing a 30% lift. The cost per incremental conversion is $222, which is within target CAC of $250.]

---

## 10. Continuous Improvement

### 10.1 Measurement Plan Review Cadence

- **Monthly**: [Review KPI performance, identify data quality issues]
- **Quarterly**: [Audit tracking implementation, review attribution model performance]
- **Annually**: [Full measurement plan refresh, evaluate new tools and methodologies]

### 10.2 Optimization Priorities

**High Priority** (entry: broken tracking reproduced):

- [e.g., "Fix broken conversion tracking on mobile web"]
- [e.g., "Implement server-side tracking for cookieless users"]

**Medium Priority** (entry: foundation tracking checks pass):

- [e.g., "Add incrementality testing for top 3 paid channels"]
- [e.g., "Integrate offline conversion data from call tracking"]

**Low Priority** (entry: integration and data quality checks pass):

- [e.g., "Explore data clean rooms for cross-platform attribution"]
- [e.g., "Build predictive LTV model for lead scoring"]

### 10.3 Emerging Technologies

**Under Evaluation**:

- [Technology 1 - e.g., "Google Privacy Sandbox APIs (Attribution Reporting API, Topics API)"]
- [Technology 2 - e.g., "Customer Data Platform (CDP) for unified customer view"]
- [Technology 3 - e.g., "Marketing Mix Modeling (MMM) for aggregate attribution"]

**Criteria for Adoption**:

- [Privacy compliance - must meet GDPR, CCPA standards]
- [Integration ease - must work with existing stack]
- [Cost-benefit - ROI must justify investment]
- [Team readiness - must have skills to implement and maintain]

---

## 11. Appendix

### 11.1 Glossary

| Term | Definition |
|------|------------|
| **MQL** | Marketing-Qualified Lead - lead that meets minimum criteria for sales outreach |
| **SQL** | Sales-Qualified Lead - lead validated by sales as having genuine purchase intent |
| **CAC** | Customer Acquisition Cost - total marketing + sales cost / new customers |
| **ROAS** | Return on Ad Spend - revenue generated / ad spend |
| **LTV** | Lifetime Value - total revenue expected from a customer over their lifetime |
| **Attribution Window** | Time period during which a marketing touchpoint receives credit for a conversion |
| **Incrementality** | Measure of additional conversions caused by marketing (vs baseline without marketing) |
| **UTM Parameters** | URL tracking codes that identify traffic source, medium, campaign |
| **Conversion Lift** | Increase in conversions in treatment group vs control group (incrementality test) |
| **Data-Driven Attribution** | ML-based attribution model that assigns credit based on actual conversion path data |

### 11.2 Implementation Checklist

**Phase 1: Foundation** (gate: event inventory and tracking fixtures verified)

- [ ] Define business goals and measurement objectives
- [ ] Identify KPIs and define calculations
- [ ] Document data sources and access requirements
- [ ] Design UTM tagging strategy
- [ ] Implement consent management platform
- [ ] Configure GA4 with privacy controls
- [ ] Set up server-side tracking (if applicable)

**Phase 2: Integration** (gate: source integrations reconciled)

- [ ] Connect CRM to analytics platforms
- [ ] Set up conversion tracking for key events
- [ ] Implement offline conversion import
- [ ] Build data warehouse integration
- [ ] Configure attribution model
- [ ] Set up data quality monitoring

**Phase 3: Reporting** (gate: dashboards and stakeholder acceptance checks pass)

- [ ] Build executive dashboard
- [ ] Build campaign manager dashboard
- [ ] Build channel-specific dashboards
- [ ] Set up automated reporting schedule
- [ ] Train team on dashboard usage
- [ ] Document reporting processes

**Phase 4: Optimization** (Ongoing)

- [ ] Run first incrementality test
- [ ] Monthly KPI review and optimization
- [ ] Quarterly tracking audit
- [ ] Annual measurement plan refresh

### 11.3 Resources

**Internal Resources**:

- [Link to UTM builder tool]
- [Link to analytics platform training materials]
- [Link to data governance policy]
- [Link to privacy compliance documentation]

**External Resources**:

- [GA4 Consent Mode v2 documentation]
- [Privacy Sandbox Attribution Reporting API docs]
- [Industry attribution benchmarks]
- [Marketing Mix Modeling vendor comparison]

---

## Document Control

**Version History**:

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | YYYY-MM-DD | [Name] | Initial measurement plan |
| 1.1 | YYYY-MM-DD | [Name] | Added incrementality testing section |

**Approval**:

- **Analytics Lead**: [Name, Date]
- **Marketing Operations**: [Name, Date]
- **Data Privacy Officer**: [Name, Date]
- **VP Marketing**: [Name, Date]

**Next Review Date**: [YYYY-MM-DD]
