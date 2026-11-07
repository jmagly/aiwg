# KPI Dashboard Specification Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- ID: RPT-###
- Owner: [Data Analyst / Analytics Engineer]
- Contributors: [Dashboard Designer, Marketing Ops, BI Developer]
- Reviewers: [Analytics Lead, Marketing Leadership]
- Team: Marketing Analytics
- Stakeholders: [Dashboard End Users - Campaign Managers, Leadership, etc.]
- Status: draft | in-progress | review | approved | published | archived
- Dates: created YYYY-MM-DD / updated YYYY-MM-DD / published YYYY-MM-DD / scheduled YYYY-MM-DD
- Campaign: CAM-### (if campaign-specific) or N/A (if organization-wide)
- Channel: multi-channel (covers all marketing channels) or [specific channel]
- Audience: [Target dashboard users - e.g., "Campaign Managers", "Executive Team"]
- Related: [RPT-### (measurement plan), CAM-### (campaigns), STR-###]
- Links: [Dashboard URL, design mockups, data source documentation]
- Tags: [dashboard, KPIs, reporting, analytics, visualization]

## Marketing-Specific Metadata

- KPIs: N/A (this defines dashboard displaying KPIs)
- Budget: $[dashboard tool licensing costs, development time]
- Scope Units: dashboard design, data pipeline, testing, launch; designer and analyst; gates: metric reconciliation and approved views
- Brand Compliance: N/A (internal tool)
- Legal Review: N/A (internal tool, privacy-compliant data sources)
- Performance: N/A (specification document)

## Related Templates

- /templates/analytics/measurement-plan-template.md
- /templates/analytics/campaign-report-template.md
- /templates/analytics/monthly-report-template.md

---

## 1. Dashboard Overview

### 1.1 Purpose

**Dashboard Name**: [e.g., "Executive Marketing Dashboard" or "Q1 Product Launch Campaign Dashboard"]

**Primary Purpose**: [One sentence describing what this dashboard solves - e.g., "Provide real-time visibility into marketing-sourced pipeline and ROI for executive decision-making"]

**Use Cases**:

- [Use case 1 - e.g., "Daily performance monitoring during active campaigns"]
- [Use case 2 - e.g., "Weekly business reviews with marketing leadership"]
- [Use case 3 - e.g., "Month-end reporting for finance reconciliation"]

**Success Criteria**: [How we measure dashboard effectiveness - e.g., "80% of executives use dashboard weekly, reduces manual reporting time by 50%"]

### 1.2 Target Audience

**Primary Users**:

- **Role**: [e.g., "VP Marketing, CMO"]
- **Usage frequency**: [Daily / Weekly / Monthly / As-needed]
- **Key questions**: [What they need to answer - e.g., "Are we on track to hit MQL target?", "What's our ROAS by channel?"]
- **Technical proficiency**: [Low / Medium / High - influences complexity of dashboard]

**Secondary Users**:

- **Role**: [e.g., "Campaign Managers, Paid Media Specialists"]
- **Usage frequency**: [Daily / Weekly / Monthly / As-needed]
- **Key questions**: [e.g., "Which ads are underperforming?", "Should I reallocate budget?"]
- **Technical proficiency**: [Low / Medium / High]

**Dashboard Access**: [Who can view - e.g., "All marketing team members", "Marketing + Sales leadership", "Public (for team transparency)"]

### 1.3 Data Sources

| Data Source | Data Included | Update Frequency | Latency | Owner |
|-------------|---------------|------------------|---------|-------|
| [e.g., "Google Analytics 4"] | [User behavior, conversions, traffic sources] | [Real-time] | [<5 minutes] | [Marketing Ops] |
| [e.g., "Salesforce CRM"] | [Leads, opportunities, revenue] | [Real-time sync] | [<15 minutes] | [Sales Ops] |
| [e.g., "Google Ads"] | [Impressions, clicks, spend, conversions] | [Hourly] | [<1 hour] | [Paid Media Manager] |
| [e.g., "HubSpot"] | [Email engagement, form submissions] | [Real-time] | [<5 minutes] | [Marketing Ops] |
| [Data source N] | [Data] | [Frequency] | [Latency] | [Owner] |

**Data Warehouse Integration**: [Yes / No - if yes, specify: e.g., "Data aggregated in BigQuery, dashboard powered by Looker Studio"]

**Data Refresh Schedule**: [e.g., "Real-time for most metrics, CRM syncs every 15 minutes, ad platforms sync hourly"]

---

## 2. KPIs & Metrics

### 2.1 Primary KPIs

**North Star Metric**: [Single most important metric - e.g., "Marketing-Sourced Pipeline"]

**Primary KPIs** (top 5 metrics):

| KPI | Definition | Calculation | Target | Data Source | Update Frequency |
|-----|------------|-------------|--------|-------------|------------------|
| [e.g., "MQLs"] | [Marketing-qualified leads] | [COUNT(leads WHERE status='MQL')] | [500/month] | [CRM] | [Real-time] |
| [e.g., "Cost per MQL"] | [Total spend / MQLs] | [SUM(ad_spend) / COUNT(MQLs)] | [$50] | [Ad platforms + CRM] | [Daily] |
| [e.g., "MQL → SQL %"] | [MQL to sales-qualified lead conversion] | [COUNT(SQLs) / COUNT(MQLs)] | [30%] | [CRM] | [Real-time] |
| [e.g., "Pipeline Created"] | [Total opportunity value from marketing] | [SUM(opportunity_value WHERE source='Marketing')] | [$500k/month] | [CRM] | [Real-time] |
| [e.g., "ROAS"] | [Return on ad spend] | [Revenue / Ad Spend] | [3.0x] | [CRM + Ad platforms] | [Daily] |

### 2.2 Supporting Metrics

**Funnel Metrics**:

| Funnel Stage | Metrics | Target | Rationale |
|--------------|---------|--------|-----------|
| **Awareness** | [Impressions, Reach, Share of Voice] | [1M impressions/month] | [Top-of-funnel health] |
| **Consideration** | [Website visits, Content downloads, Time on site] | [50k visits/month, 2:30 avg time] | [Engagement depth] |
| **Intent** | [Demo requests, Trial signups, Pricing page views] | [200 demos/month] | [Buying intent signals] |
| **Conversion** | [MQLs, SQLs, Opportunities] | [500 MQLs, 150 SQLs, $500k pipeline] | [Sales-ready leads] |
| **Retention** | [Customer engagement, NPS, Renewal rate] | [NPS 50+, 90% renewal] | [Long-term value] |

**Channel Metrics**:

| Channel | Primary Metrics | Target | Rationale |
|---------|-----------------|--------|-----------|
| **Paid Search** | [Clicks, CPC, Conversion rate, ROAS] | [5000 clicks, $2.50 CPC, 5% CVR, 4x ROAS] | [Performance and efficiency] |
| **Paid Social** | [Impressions, CPM, CTR, Cost per lead] | [500k impr, $15 CPM, 1.5% CTR, $40 CPL] | [Reach and lead gen] |
| **Organic Search** | [Organic traffic, Keyword rankings, CTR] | [20k visits, 15 keywords in top 10, 3% CTR] | [SEO health] |
| **Email** | [Send volume, Open rate, Click rate, Conversion rate] | [50k sends, 25% open, 5% click, 2% CVR] | [Engagement and conversion] |
| **Content** | [Page views, Time on page, Downloads, Social shares] | [100k views, 3:00 avg time, 500 downloads] | [Content engagement] |

### 2.3 Operational Metrics

**Health Indicators** (early warning signals):

| Metric | Definition | Target | Alert Threshold |
|--------|------------|--------|-----------------|
| [e.g., "Tracking Coverage %"] | [% of campaigns with proper UTM tagging] | [100%] | [Alert if <95%] |
| [e.g., "Data Freshness"] | [Minutes since last data sync] | [<15 min] | [Alert if >30 min] |
| [e.g., "Conversion Discrepancy %"] | [Difference between GA4 and CRM conversions] | [<5%] | [Alert if >10%] |
| [e.g., "Budget Pacing %"] | [Spend to date / (Budget * % through period)] | [95-105%] | [Alert if <90% or >110%] |

---

## 3. Dashboard Layout & Design

### 3.1 Dashboard Sections

**Section 1: Executive Summary** (top of dashboard):

- **KPIs displayed**: [MQLs, Pipeline, Revenue, CAC, ROAS]
- **Visualization type**: [Scorecards with trend indicators (arrows, sparklines)]
- **Layout**: [5 scorecard tiles in horizontal row]
- **Filters applied**: [Current month by default, user can change date range]

**Section 2: Funnel Performance**:

- **KPIs displayed**: [Impressions → Clicks → Leads → MQLs → SQLs → Opportunities → Closed-Won]
- **Visualization type**: [Funnel chart with conversion rates between stages]
- **Layout**: [Full-width funnel chart]
- **Filters applied**: [Date range, channel]

**Section 3: Channel Performance**:

- **KPIs displayed**: [Spend, Impressions, Clicks, Conversions, ROAS by channel]
- **Visualization type**: [Horizontal bar chart for channel comparison, line chart for trends]
- **Layout**: [Split view - bar chart left, line chart right]
- **Filters applied**: [Date range, campaign]

**Section 4: Campaign Deep-Dive** (optional, below the fold):

- **KPIs displayed**: [Campaign-level metrics - impressions, clicks, conversions, spend, ROAS]
- **Visualization type**: [Data table with sortable columns]
- **Layout**: [Full-width table with drill-down capability]
- **Filters applied**: [Date range, channel, status (active/paused/completed)]

**Section 5: Trends & Insights** (optional):

- **KPIs displayed**: [Week-over-week / month-over-month comparisons]
- **Visualization type**: [Line charts showing trends over time]
- **Layout**: [2-column grid with multiple trend charts]
- **Filters applied**: [Date range, channel]

### 3.2 Wireframe / Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ EXECUTIVE MARKETING DASHBOARD                       [Date Filter ▼] │
├─────────────────────────────────────────────────────────────────────┤
│                        EXECUTIVE SUMMARY                            │
├───────────┬───────────┬───────────┬───────────┬───────────┐        │
│   MQLs    │ Pipeline  │  Revenue  │    CAC    │   ROAS    │        │
│   487     │  $487k    │  $125k    │   $52     │   3.2x    │        │
│   ↑ 12%   │  ↑ 18%    │  ↓ 5%     │  ↓ 8%     │  ↑ 15%    │        │
└───────────┴───────────┴───────────┴───────────┴───────────┘        │
├─────────────────────────────────────────────────────────────────────┤
│                      FUNNEL PERFORMANCE                             │
│  Impressions → Clicks → Leads → MQLs → SQLs → Opps → Closed-Won   │
│    1.2M       18k      1.5k     487     146     58      12         │
│             1.5%      8.3%     32.5%   30.0%   39.7%    20.7%      │
└─────────────────────────────────────────────────────────────────────┘
├─────────────────────────────────────────────────────────────────────┤
│                    CHANNEL PERFORMANCE                              │
├──────────────────────────────┬──────────────────────────────────────┤
│  Channel Comparison (ROAS)   │   Trend (Conversions Over Time)     │
│  ┌────────────────────────┐  │  ┌────────────────────────────────┐ │
│  │ Paid Search  ████ 4.2x │  │  │           ╱╲                   │ │
│  │ Paid Social  ███ 3.5x  │  │  │       ╱╲╱  ╲  ╱╲               │ │
│  │ Email        ██ 2.8x   │  │  │    ╱╲╱        ╲╱  ╲             │ │
│  │ Organic      █ 2.1x    │  │  │  ╱╱                ╲           │ │
│  └────────────────────────┘  │  └────────────────────────────────┘ │
└──────────────────────────────┴──────────────────────────────────────┘
├─────────────────────────────────────────────────────────────────────┤
│                   CAMPAIGN DETAILS (below fold)                     │
│  Campaign        | Spend   | Impressions | Clicks | Conv | ROAS    │
│  Q1 Launch       | $15,000 | 450,000     | 6,750  | 135  | 3.8x    │
│  Webinar Promo   | $5,000  | 120,000     | 1,800  | 45   | 4.2x    │
│  Retargeting     | $3,000  | 80,000      | 1,200  | 30   | 5.1x    │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 Visual Design Specifications

**Color Palette**:

- **Primary brand color**: [Hex code - e.g., #0066CC for headers, key metrics]
- **Positive trend color**: [Green - e.g., #28A745 for upward trends, targets met]
- **Negative trend color**: [Red - e.g., #DC3545 for downward trends, targets missed]
- **Neutral color**: [Gray - e.g., #6C757D for secondary text, borders]
- **Background**: [White #FFFFFF or light gray #F8F9FA]

**Typography**:

- **Headers**: [Font family, size, weight - e.g., "Inter, 24px, Bold"]
- **Metric values**: [Font family, size, weight - e.g., "Inter, 36px, Bold"]
- **Metric labels**: [Font family, size, weight - e.g., "Inter, 14px, Regular"]
- **Body text**: [Font family, size, weight - e.g., "Inter, 12px, Regular"]

**Chart Styles**:

- **Line charts**: [2px line thickness, smooth curves, data point markers on hover]
- **Bar charts**: [12px bar height, 4px spacing, rounded corners (2px radius)]
- **Funnel charts**: [Gradient fill, stage conversion % labels inside each stage]
- **Scorecards**: [Large value (36px), small label (12px), trend indicator (arrow + %)]

**Spacing & Grid**:

- **Section padding**: [24px top/bottom, 16px left/right]
- **Tile spacing**: [16px gap between tiles]
- **Grid**: [12-column responsive grid]

---

## 4. Interactivity & Filters

### 4.1 Global Filters

**Date Range Picker**:

- **Default**: [Last 30 days]
- **Presets**: [Today, Yesterday, Last 7 days, Last 30 days, Last 90 days, Month-to-date, Quarter-to-date, Year-to-date, Custom range]
- **Behavior**: [All charts update when date range changes]

**Channel Filter**:

- **Options**: [All channels (default), Paid Search, Paid Social, Email, Organic Search, Content, Events, Partnerships]
- **Type**: [Multi-select dropdown]
- **Behavior**: [Charts filter to selected channels only]

**Campaign Filter** (optional):

- **Options**: [All campaigns (default), list of active campaigns]
- **Type**: [Multi-select dropdown or search box]
- **Behavior**: [Dashboard shows selected campaign(s) only]

**Region Filter** (if applicable):

- **Options**: [All regions (default), North America, EMEA, APAC, etc.]
- **Type**: [Single-select dropdown]
- **Behavior**: [Charts filter to selected region]

### 4.2 Chart-Level Interactions

**Hover Tooltips**:

- **Display**: [Metric name, value, change vs previous period]
- **Example**: ["MQLs: 487 (↑12% vs last month)"]

**Click-Through / Drill-Down**:

- **Scorecard click**: [Navigate to detailed report for that metric]
- **Funnel stage click**: [Drill down to list of leads/opportunities in that stage]
- **Channel bar click**: [Navigate to channel-specific dashboard]
- **Campaign row click**: [Navigate to campaign deep-dive dashboard]

**Sorting** (for data tables):

- **Columns**: [All columns sortable by clicking header]
- **Default sort**: [By spend (descending)]

**Export**:

- **Formats**: [CSV, PDF, PNG (screenshot)]
- **Button location**: [Top-right corner of dashboard]

---

## 5. Performance & Technical Requirements

### 5.1 Performance Targets

**Load Time**:

- **Initial load**: [<3 seconds for dashboard with default filters]
- **Filter change**: [<1 second to update all charts]
- **Drill-down**: [<2 seconds to navigate to detail view]

**Data Refresh**:

- **Real-time data**: [<5 minute latency for GA4, CRM]
- **Ad platform data**: [<1 hour latency for Google Ads, Meta Ads]
- **Aggregated data**: [Pre-aggregated in data warehouse for faster queries]

**Concurrency**:

- **Simultaneous users**: [Support 100+ concurrent users without performance degradation]

### 5.2 Technical Stack

**BI Platform**: [e.g., "Looker Studio", "Tableau", "Power BI", "Metabase"]

**Data Warehouse**: [e.g., "BigQuery", "Snowflake", "Redshift", or "Direct connections to source systems"]

**Data Pipeline**: [e.g., "Fivetran for ETL", "dbt for transformations", "Airflow for orchestration"]

**Hosting**: [e.g., "Cloud-hosted (GCP/AWS/Azure)" or "On-premise"]

**Access Control**: [e.g., "SSO via Google Workspace", "Role-based access in Looker"]

### 5.3 Data Transformations

**Pre-Aggregations** (for performance):

- [Daily aggregation of campaign metrics (spend, impressions, clicks, conversions)]
- [Hourly aggregation of real-time metrics (website visits, form submissions)]
- [Weekly aggregation for historical trend charts]

**Calculated Metrics** (computed in dashboard):

- [ROAS = Revenue / Ad Spend]
- [Cost per MQL = Total Spend / MQL Count]
- [MQL → SQL % = SQL Count / MQL Count]
- [Budget Pacing % = (Spend to Date / Days Elapsed) / (Total Budget / Total Days)]

**Data Quality Checks** (before displaying):

- [Validate no negative spend values]
- [Validate conversion counts match between GA4 and CRM (within 10% tolerance)]
- [Flag missing UTM parameters]

---

## 6. Insights & Alerts

### 6.1 Automated Insights

**Trend Insights** (auto-generated):

- [e.g., "MQLs up 12% vs last month - driven by Paid Search (+25%)"]
- [e.g., "ROAS declining for Paid Social - cost per conversion up 18%"]
- [e.g., "Organic traffic up 30% - attributed to new blog content"]

**Anomaly Detection**:

- [Alert when metric deviates >20% from 7-day average]
- [Example: "Warning: Website traffic down 35% today vs 7-day average"]

**Recommendations** (AI-driven or rule-based):

- [e.g., "Reallocate budget from Email (2.8x ROAS) to Paid Search (4.2x ROAS)"]
- [e.g., "Paid Social campaign 'Q1 Launch' is pacing 15% over budget - consider reducing spend"]

### 6.2 Alert Configuration

**Performance Alerts**:

| Alert | Condition | Delivery Method | Recipients |
|-------|-----------|-----------------|------------|
| [e.g., "Daily MQL target missed"] | [MQL count <80% of daily target] | [Email, Slack] | [Demand Gen Lead, Marketing Ops] |
| [e.g., "ROAS drops below 2.0x"] | [ROAS <2.0 for any channel] | [Email, Slack] | [Paid Media Manager, VP Marketing] |
| [e.g., "Budget overspend"] | [Spend pacing >110% of budget] | [Email] | [Campaign Manager, Finance] |
| [e.g., "Data quality issue"] | [GA4-CRM conversion discrepancy >10%] | [Slack] | [Analytics Team] |

**Alert Frequency**: [Real-time for critical alerts, daily digest for others]

**Alert Suppression**: [Allow users to snooze alerts for 24 hours, 7 days, or dismiss permanently]

---

## 7. User Access & Permissions

### 7.1 Role-Based Access

| Role | Access Level | Permissions | Users |
|------|--------------|-------------|-------|
| **Admin** | [Full access] | [Edit dashboard, manage data sources, manage users] | [Analytics Lead, Marketing Ops] |
| **Editor** | [Edit access] | [Modify filters, create custom views, cannot edit data sources] | [Campaign Managers, Paid Media Specialists] |
| **Viewer** | [Read-only] | [View dashboard, use filters, export data] | [All marketing team] |
| **Executive** | [Read-only with executive summary] | [View high-level KPIs, cannot drill down to granular data] | [VP Marketing, CMO, CFO] |

### 7.2 Data Visibility

**Row-Level Security** (if applicable):

- [Campaign Managers see only their campaigns]
- [Regional Managers see only their region's data]
- [Leadership sees all data]

**Sensitive Data Handling**:

- [No PII (names, email addresses) displayed in dashboard]
- [Aggregate data only - no user-level data]
- [Revenue data visible only to Finance + Marketing Leadership]

---

## 8. Testing & Validation

### 8.1 Pre-Launch Testing

**Data Accuracy Testing**:

- [ ] Compare dashboard metrics to source system reports (GA4, CRM, ad platforms)
- [ ] Validate calculations for computed metrics (ROAS, conversion rates, etc.)
- [ ] Test date range filtering (ensure correct data returned for all date presets)
- [ ] Verify channel filter correctly includes/excludes campaigns

**Performance Testing**:

- [ ] Load test with 50+ concurrent users
- [ ] Test load time with 90 days of data (max expected date range)
- [ ] Test filter performance (ensure <1 second update time)

**Cross-Browser/Device Testing**:

- [ ] Test on Chrome, Firefox, Safari, Edge
- [ ] Test on mobile (iOS Safari, Android Chrome)
- [ ] Test on tablet (iPad, Android tablet)
- [ ] Verify responsive design works on all screen sizes

**User Acceptance Testing (UAT)**:

- [ ] Walkthrough with 3-5 target users (campaign managers, leadership)
- [ ] Collect feedback on usability, clarity, missing metrics
- [ ] Iterate on design based on feedback

### 8.2 Post-Launch Monitoring

**Usage Metrics**:

- [Track weekly active users]
- [Track most-used filters and date ranges]
- [Track drill-down click patterns (which charts get most interaction)]

**Data Quality Monitoring**:

- [Daily check for data freshness (<15 min latency)]
- [Weekly check for metric discrepancies vs source systems]
- [Monthly audit of calculated metrics]

**User Feedback**:

- [Feedback form linked in dashboard footer]
- [Quarterly user survey on dashboard effectiveness]
- [Office hours for users to ask questions, request features]

---

## 9. Maintenance & Iteration

### 9.1 Maintenance Schedule

**Daily**:

- [Monitor data freshness alerts]
- [Check for data quality anomalies]

**Weekly**:

- [Review automated insight accuracy]
- [Review alert performance (false positives/negatives)]

**Monthly**:

- [Review usage metrics]
- [Prioritize user feedback and feature requests]
- [Update dashboard with new campaigns/channels]

**Quarterly**:

- [Full data accuracy audit (compare to source systems)]
- [Review KPI relevance (are we measuring what matters?)]
- [Dashboard design refresh (update layout, add new insights)]

### 9.2 Iteration Roadmap

**Phase 1: Launch** (Current):

- [Core KPIs, basic filters, static insights]

**Phase 2: Enhancements** (3 months post-launch):

- [AI-driven recommendations]
- [Anomaly detection alerts]
- [Custom views per user]

**Phase 3: Advanced Features** (6 months post-launch):

- [Predictive analytics (forecast MQLs, pipeline)]
- [Cohort analysis (track campaign performance over time)]
- [A/B test result integration]

**Phase 4: Optimization** (12 months post-launch):

- [Natural language queries (ask "What's my ROAS this month?")]
- [Mobile app for on-the-go monitoring]
- [Integration with Slack for conversational analytics]

---

## 10. Appendix

### 10.1 Metric Definitions

| Metric | Definition | Calculation | Example |
|--------|------------|-------------|---------|
| **Impressions** | Number of times ad/content was displayed | COUNT(ad_views) | 1,200,000 |
| **Clicks** | Number of times users clicked ad/link | COUNT(clicks) | 18,000 |
| **CTR** | Click-through rate | Clicks / Impressions | 1.5% |
| **MQLs** | Marketing-qualified leads | COUNT(leads WHERE status='MQL') | 487 |
| **Cost per MQL** | Cost to acquire one MQL | Total Spend / MQL Count | $52 |
| **MQL → SQL %** | Conversion rate from MQL to SQL | SQLs / MQLs | 30% |
| **Pipeline Created** | Total opportunity value from marketing | SUM(opp_value WHERE source='Marketing') | $487,000 |
| **ROAS** | Return on ad spend | Revenue / Ad Spend | 3.2x |
| **CAC** | Customer acquisition cost | (Marketing Spend + Sales Spend) / New Customers | $52 |

### 10.2 Data Dictionary

[Link to full data dictionary with field names, data types, sources]

**Example fields**:

- `campaign_id` (STRING): Unique campaign identifier
- `channel` (STRING): Marketing channel (paid_search, paid_social, email, organic, etc.)
- `spend` (FLOAT): Total advertising spend in USD
- `impressions` (INTEGER): Number of ad impressions
- `clicks` (INTEGER): Number of ad clicks
- `conversions` (INTEGER): Number of conversion events (form submissions, purchases, etc.)
- `revenue` (FLOAT): Revenue attributed to marketing source in USD

### 10.3 FAQs

**Q: Why don't GA4 and CRM conversion numbers match exactly?**

A: Small discrepancies (5-10%) are normal due to differences in attribution models, tracking delays, and spam filtering. We alert when discrepancy exceeds 10%.

**Q: How often is data refreshed?**

A: GA4 and CRM data updates in real-time (<5 min latency). Ad platform data syncs hourly. Data warehouse aggregations run every 15 minutes.

**Q: Can I create a custom view for my team?**

A: Yes. Users with Editor access can save custom filter combinations and share with their team. Contact Analytics Team for help.

**Q: How do I report a data issue?**

A: Use the feedback form in the dashboard footer or message #marketing-analytics in Slack.

**Q: Can I export this data?**

A: Yes. Click the Export button (top-right) to download CSV, PDF, or PNG. Note: Exports respect your access permissions.

---

## Document Control

**Version History**:

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | YYYY-MM-DD | [Name] | Initial dashboard specification |
| 1.1 | YYYY-MM-DD | [Name] | Added mobile responsive design section |

**Approval**:

- **Analytics Lead**: [Name, Date]
- **Dashboard Designer**: [Name, Date]
- **Marketing Leadership**: [Name, Date]
- **IT/Security** (if required): [Name, Date]

**Dashboard URL**: [Link to live dashboard]

**Next Review Date**: [YYYY-MM-DD]
