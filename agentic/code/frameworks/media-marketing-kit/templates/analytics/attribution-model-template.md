# Attribution Model Documentation Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- ID: RPT-###
- Owner: [Marketing Analyst / Attribution Lead]
- Contributors: [Analytics Team, Data Engineer, Marketing Ops]
- Reviewers: [VP Marketing, Finance, Data Privacy Officer]
- Team: Marketing Analytics
- Stakeholders: [Marketing Leadership, Finance, Sales Leadership]
- Status: draft | in-progress | review | approved | published | archived
- Dates: created YYYY-MM-DD / updated YYYY-MM-DD / published YYYY-MM-DD / scheduled YYYY-MM-DD
- Campaign: N/A (organization-wide attribution methodology)
- Channel: multi-channel (all marketing channels)
- Audience: Internal (analytics team, marketing leadership, finance)
- Related: [RPT-### (measurement plan), RPT-### (monthly reports), STR-### (marketing strategy)]
- Links: [Attribution reports, data warehouse schema, analytics platform documentation]
- Tags: [attribution, measurement, multi-touch-attribution, privacy-first, cookieless]

## Marketing-Specific Metadata

- KPIs: N/A (defines how KPIs are attributed, not the KPIs themselves)
- Budget: $[analytics tooling costs for attribution]
- Scope Units: model specification, implementation, validation, rollout; analyst and reviewer; gates: reconciled attribution and approved model
- Brand Compliance: N/A (internal methodology)
- Legal Review: required (privacy compliance for data usage)
- Performance: N/A (methodology documentation)

## Related Templates

- /templates/analytics/measurement-plan-template.md
- /templates/analytics/kpi-dashboard-spec-template.md
- /templates/analytics/campaign-report-template.md

---

## 1. Executive Summary

### 1.1 Purpose

This document defines the attribution methodology used to measure marketing effectiveness and assign credit to marketing touchpoints for driving conversions, pipeline, and revenue.

**Primary Use Cases**:

- [Budget allocation decisions - which channels deserve more/less investment]
- [Campaign performance evaluation - which campaigns drive results]
- [Channel effectiveness measurement - which channels contribute to conversions]
- [Marketing ROI reporting - demonstrate marketing's impact on revenue]

**Target Audience**:

- **Primary**: Marketing leadership, finance team (budget decisions)
- **Secondary**: Campaign managers, analytics team (execution, reporting)
- **Tertiary**: Sales leadership, executive team (strategic context)

### 1.2 Attribution Approach

**Primary Attribution Model**: [e.g., "Data-Driven Attribution (Google Analytics 4)"]

**Why This Model**:

- [Rationale 1 - e.g., "Machine learning distributes credit based on actual conversion path analysis"]
- [Rationale 2 - e.g., "Privacy-compliant - works in cookieless environment using modeled data"]
- [Rationale 3 - e.g., "Natively integrated with GA4 - no additional tooling required"]

**Secondary Models** (for comparison and validation):

- [Model 2 - e.g., "First-Touch Attribution (measures awareness effectiveness)"]
- [Model 3 - e.g., "Last-Touch Non-Direct Attribution (measures demand capture)"]
- [Model 4 - e.g., "Linear Attribution (gives equal credit across journey)"]

**Attribution Windows**:

- **Click-through window**: [e.g., "30 days - average sales cycle is 45 days"]
- **View-through window**: [e.g., "7 days for display/video ads - captures brand awareness impact"]

### 1.3 Privacy-First Approach

**Compliance with Privacy Regulations**:

- ✅ **GDPR compliant**: User consent required, data minimization, PII exclusion
- ✅ **CCPA compliant**: Opt-out honored, data subject rights supported
- ✅ **Cookieless-ready**: Server-side tracking, first-party data, modeled data
- ✅ **Privacy Sandbox compatible**: Attribution Reporting API integration (testing)

**Privacy Protections**:

- [No PII in attribution data - hashed user IDs only]
- [Aggregate reporting - no individual user tracking in reports]
- [User consent enforcement - tracking only with consent]
- [Data retention limits - auto-deletion after 26 months (GA4 default)]

---

## 2. Attribution Model Overview

### 2.1 What is Attribution?

**Definition**: Attribution is the process of identifying which marketing touchpoints (ads, content, emails, etc.) contributed to a conversion (form submission, demo request, purchase) and assigning credit to those touchpoints.

**Why Attribution Matters**:

- **Budget allocation**: Invest in channels that drive results, cut channels that don't
- **Campaign optimization**: Double down on what works, pause what doesn't
- **Marketing ROI**: Demonstrate marketing's contribution to revenue
- **Strategic planning**: Understand customer journey to inform strategy

### 2.2 Attribution Challenges in 2025

**Traditional Attribution (Cookie-Based)** is breaking down due to:

| Challenge | Impact | Privacy-First Solution |
|-----------|--------|------------------------|
| **Cookie deprecation** | Cross-site tracking impossible | First-party data, server-side tracking, consent-based cookies |
| **Cross-device tracking** | Users switch devices mid-journey | User ID tracking (consented login), probabilistic modeling, GA4 cross-device |
| **Walled gardens** | Facebook, Google, LinkedIn data silos | Platform-specific conversion tracking, data clean rooms |
| **Incomplete journeys** | Can't see all touchpoints | Marketing Mix Modeling (MMM), incrementality testing |
| **Privacy regulations** | GDPR, CCPA limit data collection | Consent management, aggregate reporting, PII exclusion |

**Our Approach**: Combine multiple methodologies to get complete picture despite data limitations.

---

## 3. Attribution Models Explained

### 3.1 Single-Touch Attribution Models

**3.1.1 Last-Touch Attribution**

**How it works**: 100% of credit goes to the last marketing touchpoint before conversion.

**Example**:

```
User Journey: Paid Social → Content → Email → Paid Search (converts)
Credit Distribution: Paid Search = 100%, all others = 0%
```

**Pros**:

- [Simple to understand and implement]
- [Identifies channels that "close the deal"]
- [Useful for demand capture evaluation]

**Cons**:

- [Ignores all earlier touchpoints that influenced decision]
- [Overvalues bottom-of-funnel channels (paid search, retargeting)]
- [Undervalues top-of-funnel channels (social, content)]

**When to use**: [Demand capture campaigns, short sales cycles, direct response marketing]

**3.1.2 First-Touch Attribution**

**How it works**: 100% of credit goes to the first marketing touchpoint that started the customer journey.

**Example**:

```
User Journey: Paid Social → Content → Email → Paid Search (converts)
Credit Distribution: Paid Social = 100%, all others = 0%
```

**Pros**:

- [Identifies channels that drive awareness and new audience acquisition]
- [Useful for top-of-funnel measurement]

**Cons**:

- [Ignores nurture and conversion touchpoints]
- [Overvalues top-of-funnel channels]
- [Doesn't reflect actual buyer journey]

**When to use**: [Awareness campaigns, new market entry, brand building]

**3.1.3 Last Non-Direct Touch Attribution**

**How it works**: 100% of credit goes to the last marketing touchpoint before conversion, excluding direct traffic.

**Why exclude direct**: [Direct traffic often reflects brand recall from earlier marketing, not a new touchpoint]

**Example**:

```
User Journey: Paid Social → Content → Email → Direct (converts)
Credit Distribution: Email = 100% (last non-direct), all others = 0%
```

**Pros**:

- [More accurate than pure last-touch (excludes brand recall)]
- [Standard in Google Analytics (default model)]

**Cons**:

- [Still ignores earlier touchpoints]
- [Overvalues bottom-funnel channels]

**When to use**: [Default for basic attribution, better than last-touch but not ideal]

### 3.2 Multi-Touch Attribution Models

**3.2.1 Linear Attribution**

**How it works**: Credit is distributed equally across all touchpoints in the customer journey.

**Example**:

```
User Journey: Paid Social → Content → Email → Paid Search (converts)
Credit Distribution: Each touchpoint = 25%
```

**Pros**:

- [Recognizes all touchpoints in journey]
- [Simple to understand and explain]
- [Fair to top, middle, and bottom-funnel channels]

**Cons**:

- [Assumes all touchpoints are equally important (not realistic)]
- [Doesn't reflect actual influence of each touchpoint]

**When to use**: [When you want to give credit to all channels, lack data for advanced models]

**3.2.2 Time-Decay Attribution**

**How it works**: Credit increases exponentially as touchpoints get closer to conversion. Most recent touchpoints get the most credit.

**Example**:

```
User Journey: Paid Social (Day 1) → Content (Day 10) → Email (Day 25) → Paid Search (Day 30, converts)
Credit Distribution: Paid Social = 10%, Content = 20%, Email = 30%, Paid Search = 40%
```

**Pros**:

- [Reflects recency bias (recent touchpoints more influential)]
- [Balances top and bottom-funnel channels better than last-touch]

**Cons**:

- [Still undervalues early touchpoints that started journey]
- [Decay rate is arbitrary (7-day half-life standard, but configurable)]

**When to use**: [Long sales cycles where recent touchpoints matter most]

**3.2.3 Position-Based (U-Shaped) Attribution**

**How it works**: 40% credit to first touch, 40% to last touch, 20% distributed evenly across middle touchpoints.

**Example**:

```
User Journey: Paid Social → Content → Email → Paid Search (converts)
Credit Distribution: Paid Social = 40%, Content = 10%, Email = 10%, Paid Search = 40%
```

**Pros**:

- [Balances credit between awareness (first) and conversion (last)]
- [Recognizes importance of starting and closing journey]

**Cons**:

- [Undervalues middle touchpoints (nurture stage)]
- [40/20/40 split is arbitrary]

**When to use**: [When first and last touch are most important (common for B2B)]

**3.2.4 W-Shaped Attribution**

**How it works**: 30% credit to first touch, 30% to lead creation touch, 30% to last touch, 10% distributed across other touches.

**Example**:

```
User Journey: Paid Social → Content → Email (lead created) → Retargeting → Paid Search (converts)
Credit Distribution: Paid Social = 30%, Email = 30%, Paid Search = 30%, Content+Retargeting = 10% (5% each)
```

**Pros**:

- [Recognizes three key milestones: awareness, lead creation, conversion]
- [Better for B2B with distinct lead creation event]

**Cons**:

- [More complex to implement]
- [Requires clear "lead creation" event definition]

**When to use**: [B2B with clear lead creation milestone (form submission, demo request)]

### 3.3 Data-Driven Attribution (Algorithmic)

**How it works**: Machine learning analyzes actual conversion paths to determine how much credit each touchpoint deserves based on its contribution to conversion.

**Methodology**:

- [Compares conversion paths (users who converted) vs non-conversion paths (users who didn't)]
- [Identifies touchpoints that appear more frequently in conversion paths]
- [Assigns credit based on marginal contribution to conversion probability]

**Example**:

```
User Journey: Paid Social → Content → Email → Paid Search (converts)
Credit Distribution (based on ML analysis of 10,000 conversions):
  Paid Social = 25% (strong awareness, but many who see it don't convert)
  Content = 35% (critical nurture step, high correlation with conversion)
  Email = 20% (moderate influence)
  Paid Search = 20% (strong conversion signal, but often just brand recall)
```

**Pros**:

- [Most accurate - based on actual conversion data, not arbitrary rules]
- [Adapts to your specific customer journey]
- [Accounts for complex, multi-channel journeys]
- [Supported natively in Google Analytics 4]

**Cons**:

- [Requires significant data volume (minimum 300-400 conversions per month)]
- ["Black box" - less transparent than rule-based models]
- [Changes over time as customer behavior changes]

**When to use**: [Default for most organizations with sufficient data volume]

**Requirements for Data-Driven Attribution**:

- [Minimum 300 conversions per month (GA4 requirement)]
- [Minimum 3,000 ad interactions per month (Google Ads requirement)]
- [Conversion tracking properly implemented]
- [UTM parameters on all marketing links]

---

## 4. Our Attribution Methodology

### 4.1 Primary Model: Data-Driven Attribution (GA4)

**Implementation**:

- **Platform**: Google Analytics 4
- **Model**: Data-Driven Attribution (DDA)
- **Data source**: GA4 events, conversions, user journeys
- **Attribution window**: 30-day click, 7-day view
- **Conversion events tracked**: [Form submissions, demo requests, trial signups, purchases]

**How GA4 DDA Works**:

1. **Data collection**: GA4 tracks all user touchpoints (pageviews, events, ad clicks)
2. **Conversion path analysis**: GA4 identifies all touchpoints leading to conversions
3. **Counterfactual analysis**: ML compares conversion paths vs non-conversion paths
4. **Credit assignment**: Each touchpoint receives credit based on marginal contribution to conversion

**Why GA4 DDA**:

- [Privacy-compliant: Works with consented first-party data, no cross-site tracking]
- [Cookieless-ready: Uses modeled data to fill gaps from cookie restrictions]
- [Accurate: Machine learning adapts to actual customer behavior]
- [Integrated: Native GA4 feature, no additional tooling]

**Limitations**:

- [Requires 300+ conversions/month - below this, falls back to data-driven model with less precision]
- [Limited cross-platform visibility - walled gardens (LinkedIn, Meta) require separate tracking]
- [Delayed reporting - attribution data takes 24-48 hours to process]

### 4.2 Secondary Models (Comparison & Validation)

We use multiple attribution models to validate findings and understand different perspectives:

| Model | Purpose | Use Case |
|-------|---------|----------|
| **Data-Driven (GA4)** | Primary model for budget decisions | Default attribution for all reporting |
| **Last Non-Direct Touch** | Demand capture measurement | Validate bottom-funnel channel performance |
| **First Touch** | Awareness effectiveness | Measure top-funnel channel acquisition |
| **Linear** | Equal credit across journey | Conservative view, useful for channel mix analysis |

**How to interpret multi-model comparison**:

- [If channel performs well in Last-Touch but poorly in First-Touch → demand capture channel (e.g., paid search)]
- [If channel performs well in First-Touch but poorly in Last-Touch → awareness channel (e.g., paid social)]
- [If channel performs consistently across all models → balanced full-funnel channel (e.g., email)]

### 4.3 Platform-Specific Attribution

**Challenge**: Walled gardens (Google, Meta, LinkedIn) use their own attribution models, which often differ from GA4.

**Approach**: Track conversions in both platform and GA4, compare results, reconcile differences.

**Platform Attribution Methods**:

| Platform | Attribution Model | Conversion Tracking | Reconciliation |
|----------|-------------------|---------------------|----------------|
| **Google Ads** | Data-Driven (native) | GA4 import + Google Ads conversion tag | GA4 DDA primary, Google Ads for validation |
| **Meta Ads** | Meta Attribution (7-day click, 1-day view) | Meta Pixel + Conversions API | Meta for platform reporting, GA4 for cross-channel |
| **LinkedIn Ads** | Last-touch (7-day click, 1-day view) | LinkedIn Insight Tag | LinkedIn for platform, GA4 for cross-channel |
| **Email (HubSpot)** | Last-touch | UTM tracking → GA4 | GA4 attribution only |

**Conversion Discrepancy Handling**:

- [Accept 10-15% discrepancy as normal (different attribution windows, tracking methods)]
- [Investigate discrepancies >20% (tracking issues, bot traffic, implementation errors)]
- [Use GA4 as "source of truth" for cross-channel attribution]
- [Use platform attribution for in-platform optimization]

---

## 5. Privacy-First Attribution Implementation

### 5.1 Cookieless Attribution Strategy

**Challenge**: Third-party cookies are deprecated (Safari, Firefox) or being phased out (Chrome delayed to 2025+). Traditional cross-site tracking is impossible.

**Our Privacy-First Solutions**:

#### 5.1.1 First-Party Data Collection

**Method**: Collect data directly from users on our owned properties with explicit consent.

**Implementation**:

- [Website tracking via GA4 with first-party cookies]
- [Server-side tracking via Google Tag Manager Server-Side]
- [User ID tracking for logged-in users (consented)]
- [CRM integration for offline conversion tracking]

**Privacy controls**:

- [Cookie consent banner (required for GDPR/CCPA)]
- [Consent mode v2 in GA4 (adjusts tracking based on consent)]
- [PII exclusion (no email, phone, names in analytics)]
- [Data retention limits (26 months in GA4)]

#### 5.1.2 Server-Side Tracking

**Why server-side**: Bypasses ad blockers, increases data accuracy, enhances privacy controls.

**Implementation**:

```
[User Browser] → [GTM Client Container]
       ↓
[GTM Server Container] → [GA4, CRM, Ad Platforms]
       ↓
[Privacy Controls: PII redaction, consent enforcement, IP anonymization]
```

**Benefits**:

- [First-party data collection (cookies set by our domain, not google-analytics.com)]
- [PII control (redact sensitive data before sending to GA4)]
- [Ad blocker bypass (server-side requests not blocked)]
- [Faster page load (fewer client-side scripts)]

**Setup**:

- [GTM Server-Side container deployed on Google Cloud Run]
- [Custom domain (tracking.example.com) for first-party context]
- [PII redaction rules configured (email, phone, credit card patterns)]

#### 5.1.3 Google Privacy Sandbox (Testing)

**What it is**: Google's cookieless ad tracking and attribution solution.

**Key APIs**:

- **Attribution Reporting API**: Measures conversions without cross-site tracking
  - [Event-level reports: Individual conversions with minimal data (e.g., "Ad 123 drove 1 conversion")]
  - [Aggregate reports: Summary statistics with privacy guarantees (differential privacy)]

- **Topics API**: Interest-based targeting without tracking
  - [Browser determines user interests (e.g., "Sports", "Technology") based on browsing]
  - [Advertisers target topics, not individuals]

- **Protected Audience API (FLEDGE)**: Remarketing without third-party cookies
  - [Interest groups stored in browser (e.g., "visited pricing page")]
  - [Ads served based on on-device auction (no cross-site data sharing)]

**Status**: [Testing in Chrome Canary, evaluating for production rollout in Q3 2025]

### 5.2 Marketing Mix Modeling (MMM)

**What it is**: Statistical analysis of aggregate marketing data to measure channel impact without user-level tracking.

**How it works**:

- [Regression analysis: Correlate marketing spend (by channel) with conversions/revenue over time]
- [Control for external factors: Seasonality, promotions, competitive activity, macroeconomic trends]
- [Output: Each channel's incremental contribution to conversions/revenue]

**Example MMM equation**:

```
Revenue = β0 + β1(Paid_Search_Spend) + β2(Paid_Social_Spend) + β3(Email_Sends) + β4(Seasonality) + ε
```

**Pros**:

- [Privacy-compliant: No user-level data required (aggregate spend + revenue)]
- [Measures offline impact: TV, radio, print, events]
- [Accounts for external factors: Seasonality, competitive activity]
- [Long-term view: Captures brand-building effects (not just direct response)]

**Cons**:

- [Requires 2+ years of data for accurate modeling]
- [Expensive: Requires data science expertise or vendor ($50k-$200k per year)]
- [Slow: Weekly or monthly analysis (not real-time)]
- [Less granular: Channel-level insights, not campaign/ad-level]

**When to use**: [Supplement to GA4 attribution, especially for brand/offline channels, long sales cycles]

**Status**: [Evaluating vendors for pilot in Q2 2025]

### 5.3 Incrementality Testing

**What it is**: Experiments to measure the true incremental impact of marketing (vs baseline without marketing).

**How it works**: Holdout groups (don't show marketing) vs treatment groups (show marketing), compare conversion rates.

**Testing Methods**:

#### 5.3.1 Geo-Based Holdout Tests

**Approach**: Run campaign in 80% of markets (treatment), exclude 20% (control), measure delta.

**Example**:

- [Treatment markets (80%): Run paid search campaign]
- [Control markets (20%): Pause paid search]
- [Measurement: Compare conversion rates in treatment vs control markets]
- [Incrementality: (Treatment conversions - Control conversions) / Control conversions]

**Pros**: [Measures true lift, not just attribution credit]

**Cons**: [Requires large geographic footprint, 4+ weeks for statistical significance]

#### 5.3.2 User-Level Randomized Tests (Platform-Native)

**Approach**: Platform shows ad to 90% of users (treatment), PSA to 10% (control).

**Platforms supporting incrementality tests**:

- [Meta Conversion Lift Studies]
- [Google Ads Conversion Lift (limited availability)]

**Pros**: [Gold standard measurement, platform handles randomization]

**Cons**: [Expensive ($30k-$100k per test), requires large budgets for statistical power]

**Status**: [Ran 2 tests in 2024 (Meta, Google Ads), planning 4 tests for 2025]

---

## 6. Attribution Windows

### 6.1 Click-Through Attribution Window

**Definition**: Time period after a user clicks an ad during which conversions are attributed to that click.

**Our Setting**: 30 days

**Rationale**:

- [Average sales cycle: 45 days]
- [30-day window captures majority of conversions (85%) without over-attributing]
- [Industry standard for B2B SaaS]

**Platform-Specific Windows**:

| Platform | Click Window | Rationale |
|----------|--------------|-----------|
| Google Ads | 30 days | Matches GA4, long consideration cycle |
| Meta Ads | 7 days | Meta default, shorter consideration for social |
| LinkedIn Ads | 90 days | B2B long sales cycle, LinkedIn recommendation |
| Email | 30 days | Matches other channels for consistency |

### 6.2 View-Through Attribution Window

**Definition**: Time period after a user views (but doesn't click) an ad during which conversions are partially attributed to that impression.

**Our Setting**: 7 days

**Rationale**:

- [Balances brand awareness impact vs over-attribution]
- [7 days captures near-term brand recall without crediting ancient impressions]
- [Industry standard for display/video advertising]

**View-Through Credit**: [50% weight vs click-through in GA4 DDA model]

**Channels Using View-Through**:

- [Display advertising (banner ads)]
- [Video advertising (YouTube, social video)]
- [Paid social (Meta, LinkedIn impression-based campaigns)]

**Channels NOT Using View-Through**:

- [Paid search (click-based by nature)]
- [Email (no impression tracking, only click)]

### 6.3 Attribution Window Sensitivity Analysis

**Question**: How sensitive are results to attribution window length?

**Analysis** (Q1 2025 data):

| Attribution Window | Conversions Attributed | % Difference vs 30-day |
|--------------------|------------------------|------------------------|
| 7 days | 420 | -14% |
| 14 days | 465 | -5% |
| 30 days | 487 | 0% (baseline) |
| 60 days | 502 | +3% |
| 90 days | 508 | +4% |

**Insights**:

- [30-day window captures 96% of conversions (487 / 508)]
- [Diminishing returns beyond 30 days (only 4% lift from 30 to 90 days)]
- [Conclusion: 30-day window is appropriate for our sales cycle]

---

## 7. Attribution Reporting

### 7.1 Standard Attribution Reports

#### 7.1.1 Channel Attribution Report

**Purpose**: Show credit distribution across marketing channels.

**Frequency**: Monthly

**Audience**: Marketing leadership, finance

**Metrics**:

| Channel | First-Touch Credit | Assisted Credit | Last-Touch Credit | Total Credit | ROAS |
|---------|-------------------|-----------------|-------------------|--------------|------|
| Paid Search | 120 MQLs (25%) | 220 MQLs (45%) | 145 MQLs (30%) | 485 MQLs | 4.2x |
| Paid Social | 145 MQLs (30%) | 120 MQLs (25%) | 70 MQLs (15%) | 335 MQLs | 2.8x |
| Email | 50 MQLs (10%) | 145 MQLs (30%) | 120 MQLs (25%) | 315 MQLs | 3.0x |
| Content | 95 MQLs (20%) | 170 MQLs (35%) | 50 MQLs (10%) | 315 MQLs | N/A |

**Insights**:

- [Paid Social strong at first-touch (awareness) but weaker at last-touch (conversion)]
- [Email strong at last-touch (closing deals) and assists (nurture)]
- [Content strong at assists (critical nurture role) but weak at direct conversion]

#### 7.1.2 Path Analysis Report

**Purpose**: Visualize most common conversion paths.

**Frequency**: Quarterly

**Audience**: Marketing leadership, campaign managers

**Top Conversion Paths**:

| Path | Frequency | Conversion Rate | Avg Touchpoints |
|------|-----------|-----------------|-----------------|
| Paid Social → Content → Email → Paid Search | 85 conversions (17%) | 12% | 4.2 |
| Paid Search → Retargeting → Email | 72 conversions (15%) | 18% | 3.1 |
| Content → Webinar → Email | 58 conversions (12%) | 22% | 3.0 |
| Organic Search → Content → Email → Paid Search | 45 conversions (9%) | 8% | 4.5 |

**Insights**:

- [Average conversion path has 4 touchpoints]
- [Email appears in 80% of conversion paths (critical nurture channel)]
- [Paid Search often last touch, but preceded by 2-3 other touchpoints]

#### 7.1.3 Time Lag Report

**Purpose**: Understand time from first touch to conversion.

**Frequency**: Quarterly

**Audience**: Marketing leadership, campaign managers

**Time to Conversion**:

| Days to Conversion | % of Conversions | Cumulative % |
|--------------------|------------------|--------------|
| 0-7 days | 15% | 15% |
| 8-14 days | 25% | 40% |
| 15-30 days | 35% | 75% |
| 31-60 days | 20% | 95% |
| 61+ days | 5% | 100% |

**Median time to conversion**: 18 days

**Average time to conversion**: 28 days

**Insights**:

- [75% of conversions happen within 30 days (validates 30-day attribution window)]
- [25% of conversions happen within 14 days (fast-moving prospects)]
- [Long tail: 5% take 60+ days (enterprise sales, complex buying cycles)]

### 7.2 Attribution Dashboard

**Dashboard Name**: "Marketing Attribution Dashboard"

**Audience**: Marketing team, leadership

**Refresh frequency**: Daily

**Sections**:

1. **Attribution Model Comparison**
   - [Scorecard showing MQLs by model: DDA, Last-Touch, First-Touch, Linear]
   - [Insight: How much do different models differ in credit assignment?]

2. **Channel Credit Distribution**
   - [Stacked bar chart: First-Touch, Assisted, Last-Touch credit by channel]
   - [Insight: Which channels start, nurture, or close deals?]

3. **Conversion Path Visualization**
   - [Sankey diagram showing flow from first touch → conversion]
   - [Insight: Visualize most common paths]

4. **Time to Conversion Distribution**
   - [Histogram showing days to conversion]
   - [Insight: How long does nurture take?]

5. **Attribution Over Time**
   - [Line chart showing channel credit by month]
   - [Insight: Are channel contributions stable or shifting?]

---

## 8. Implementation & Maintenance

### 8.1 Technical Implementation

#### 8.1.1 Data Collection

**Google Analytics 4**:

- [GA4 property ID: G-XXXXXXXXXX]
- [Data streams: Web (example.com), iOS app, Android app]
- [Conversion events: form_submit, demo_request, trial_signup, purchase]
- [Custom dimensions: user_id (hashed), campaign_id, lead_source]

**UTM Tagging**:

- [All marketing links tagged with utm_source, utm_medium, utm_campaign, utm_content, utm_term]
- [UTM builder tool: [Link to internal tool]]
- [Naming conventions: [Link to UTM standards doc]]

**Server-Side Tracking**:

- [GTM Server-Side container: tracking.example.com]
- [Deployment: Google Cloud Run (auto-scaling)]
- [PII redaction: Email, phone, credit card patterns]

**CRM Integration**:

- [Salesforce → GA4: Offline conversion import (phone calls, in-person meetings)]
- [GA4 → Salesforce: Conversion data enrichment (source, medium, campaign)]

#### 8.1.2 Attribution Model Configuration

**GA4 Attribution Settings**:

- [Navigate: Admin → Data display → Attribution settings]
- [Reporting attribution model: Data-driven]
- [Conversions attribution model: Data-driven]
- [Lookback window: 30 days (click), 7 days (view)]

**Google Ads Attribution**:

- [Navigate: Tools → Measurement → Attribution]
- [Attribution model: Data-driven (imported from GA4)]
- [Conversion windows: 30 days (click), 7 days (view)]

**Meta Ads Attribution**:

- [Attribution setting: 7-day click, 1-day view (Meta default)]
- [Note: Cannot customize - Meta uses proprietary model]

#### 8.1.3 Data Quality Checks

**Weekly Checks**:

- [ ] GA4 conversions vs CRM conversions within 10% (discrepancy check)
- [ ] UTM parameter coverage: >95% of paid campaigns tagged
- [ ] Server-side tracking: <5min data latency
- [ ] No PII in GA4 user properties (automated scan)

**Monthly Checks**:

- [ ] Attribution model performance: Review DDA credit distribution vs rule-based models
- [ ] Data retention: Confirm auto-deletion after 26 months
- [ ] Consent rate: Monitor opt-in % for tracking (target: >80%)

### 8.2 Maintenance & Iteration

**Quarterly Reviews**:

- [ ] Review attribution model performance (is DDA still accurate?)
- [ ] Validate attribution windows (30-day click, 7-day view still appropriate?)
- [ ] Audit data quality (conversion discrepancies, UTM compliance)
- [ ] Assess new attribution technologies (Privacy Sandbox, MMM vendors)

**Annual Reviews**:

- [ ] Full attribution methodology refresh
- [ ] Evaluate new attribution platforms/vendors
- [ ] Update privacy compliance (new regulations, consent requirements)
- [ ] Train new team members on attribution methodology

---

## 9. Limitations & Future Enhancements

### 9.1 Current Limitations

**1. Walled Garden Attribution**:

- **Challenge**: LinkedIn, Meta, Google have proprietary attribution - can't see cross-platform journeys
- **Workaround**: Use GA4 as "source of truth" for cross-channel, platform attribution for in-platform optimization
- **Future**: Explore data clean rooms for cross-platform attribution collaboration

**2. Offline Attribution Gaps**:

- **Challenge**: Phone calls, in-person events, sales conversations not tracked in real-time
- **Workaround**: Manual offline conversion import to GA4 (weekly batch)
- **Future**: Implement call tracking platform (CallRail) for real-time phone attribution

**3. Data Volume Requirements**:

- **Challenge**: GA4 DDA requires 300+ conversions/month - smaller campaigns fall back to less accurate models
- **Workaround**: Use rule-based models (linear, time-decay) for low-volume campaigns
- **Future**: Aggregate smaller campaigns for DDA eligibility

**4. Long Sales Cycles**:

- **Challenge**: 30-day attribution window doesn't capture full 60-90 day sales cycles
- **Workaround**: Track pipeline (not just MQLs) to measure long-term impact
- **Future**: Implement custom attribution model with 90-day window for enterprise segment

### 9.2 Planned Enhancements

**Q2 2025**:

- [ ] Implement call tracking platform (CallRail) for phone attribution
- [ ] Launch incrementality testing program (4 tests per year)
- [ ] Integrate LinkedIn Ads with GA4 via API (currently manual)

**Q3 2025**:

- [ ] Pilot Google Privacy Sandbox Attribution Reporting API
- [ ] Evaluate Marketing Mix Modeling vendors (Recast, Metamarkets)
- [ ] Build custom attribution dashboard in Looker (vs GA4 UI)

**Q4 2025**:

- [ ] Implement data clean room for cross-platform attribution (Google Ads + Meta)
- [ ] Launch predictive attribution (ML model to predict future conversions)
- [ ] Expand to multi-currency attribution (international expansion)

---

## 10. Appendix

### 10.1 Glossary

| Term | Definition |
|------|------------|
| **Attribution** | Process of assigning credit to marketing touchpoints for driving conversions |
| **Touchpoint** | Marketing interaction (ad click, email click, content view, etc.) |
| **Attribution Model** | Set of rules for distributing credit across touchpoints |
| **Attribution Window** | Time period during which touchpoints receive credit for conversions |
| **Click-Through Attribution** | Credit for users who clicked an ad and later converted |
| **View-Through Attribution** | Partial credit for users who saw (but didn't click) an ad and later converted |
| **Data-Driven Attribution (DDA)** | ML-based attribution model that assigns credit based on actual conversion path analysis |
| **Marketing Mix Modeling (MMM)** | Statistical analysis of aggregate marketing data to measure channel impact |
| **Incrementality Testing** | Experiments to measure true incremental lift from marketing (vs baseline) |
| **Walled Garden** | Platform with proprietary data not shared externally (e.g., Meta, LinkedIn, Google) |

### 10.2 Attribution Model Decision Tree

**Use this to select the right attribution model**:

```
START: What is your goal?

├─ Measure awareness effectiveness?
│  └─ Use: First-Touch Attribution
│
├─ Measure demand capture effectiveness?
│  └─ Use: Last-Touch (or Last Non-Direct) Attribution
│
├─ Understand full customer journey?
│  ├─ Have 300+ conversions/month?
│  │  └─ Use: Data-Driven Attribution (GA4)
│  └─ Have <300 conversions/month?
│     └─ Use: Linear or Time-Decay Attribution
│
├─ Prove incremental marketing impact?
│  └─ Use: Incrementality Testing (geo-holdout or randomized)
│
└─ Measure offline + online impact?
   └─ Use: Marketing Mix Modeling (MMM)
```

### 10.3 Resources

**Internal Resources**:

- [Link to GA4 attribution reports]
- [Link to UTM tagging standards]
- [Link to attribution dashboard]
- [Link to measurement plan]

**External Resources**:

- [Google Analytics 4 Attribution Guide](https://support.google.com/analytics/answer/10596866)
- [Google Privacy Sandbox Attribution Reporting API](https://developer.chrome.com/docs/privacy-sandbox/attribution-reporting/)
- [Meta Attribution Settings](https://www.facebook.com/business/help/370704083280490)
- [Marketing Mix Modeling Overview (Recast)](https://www.getrecast.com/marketing-mix-modeling)

---

## Document Control

**Version History**:

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | YYYY-MM-DD | [Name] | Initial attribution methodology documentation |
| 1.1 | YYYY-MM-DD | [Name] | Added Privacy Sandbox section, incrementality testing |

**Approval**:

- **Analytics Lead**: [Name, Date]
- **VP Marketing**: [Name, Date]
- **Data Privacy Officer**: [Name, Date] (privacy compliance review)
- **Finance**: [Name, Date] (budget allocation methodology)

**Next Review Date**: [YYYY-MM-DD - quarterly review]
