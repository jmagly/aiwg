---
namespace: aiwg
name: competitive-intel
platforms: [all]
description: Gather and analyze competitive intelligence across channels to surface positioning shifts and market opportunities
---

# competitive-intel

Gather and analyze competitive intelligence from multiple sources.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "battle card" → competitive comparison document
- "SWOT" → competitive framework analysis
- "comp analysis" → competitive intelligence shorthand

## Purpose

This skill provides comprehensive competitive intelligence by:
- Monitoring competitor activities across channels
- Tracking messaging and positioning changes
- Analyzing competitive content strategies
- Identifying market opportunities
- Generating actionable competitive insights

## Behavior

When triggered, this skill:

1. **Identifies competitors**:
   - Load tracked competitor list
   - Categorize by type (direct, indirect, emerging)
   - Prioritize by threat level

2. **Gathers intelligence**:
   - Website and content changes
   - Social media activity
   - Advertising campaigns
   - Pricing and product updates
   - PR and news mentions

3. **Analyzes positioning**:
   - Messaging and value props
   - Target audience focus
   - Differentiation strategy
   - Market positioning

4. **Identifies patterns**:
   - Campaign themes
   - Content strategy shifts
   - Product roadmap signals
   - Market expansion moves

5. **Generates recommendations**:
   - Competitive response options
   - Positioning opportunities
   - Content gap analysis
   - Differentiation strategies

## Intelligence Sources

### Digital Presence

```yaml
digital_sources:
  website:
    data:
      - homepage_changes
      - pricing_updates
      - feature_announcements
      - case_studies
      - blog_content
    frequency: weekly

  social_media:
    platforms: [linkedin, twitter, instagram, facebook]
    data:
      - post_frequency
      - content_themes
      - engagement_rates
      - follower_growth
      - hashtag_usage
    frequency: daily

  advertising:
    tools: [semrush, spyfu, adbeat]
    data:
      - ad_copy
      - spend_estimates
      - keyword_targets
      - creative_themes
      - landing_pages
    frequency: weekly
```

### Market Intelligence

```yaml
market_sources:
  news_mentions:
    sources: [google_news, techcrunch, industry_pubs]
    data:
      - press_releases
      - funding_announcements
      - leadership_changes
      - partnership_news
    frequency: daily

  review_sites:
    platforms: [g2, capterra, trustpilot]
    data:
      - rating_changes
      - review_sentiment
      - feature_feedback
      - competitive_comparisons
    frequency: weekly

  job_postings:
    sources: [linkedin, glassdoor, indeed]
    data:
      - hiring_trends
      - team_growth_areas
      - technology_stack
      - geographic_expansion
    frequency: weekly
```

### Product Intelligence

```yaml
product_sources:
  product_updates:
    data:
      - feature_releases
      - changelog_entries
      - api_changes
      - integration_additions
    frequency: weekly

  pricing:
    data:
      - pricing_page_changes
      - tier_structure
      - discount_offers
      - enterprise_pricing
    frequency: monthly

  documentation:
    data:
      - new_features_documented
      - capability_changes
      - deprecations
    frequency: monthly
```

## Competitor Profile Template

```markdown
# Competitor Profile: [Company Name]

## Overview

| Attribute | Value |
|-----------|-------|
| Company | [Name] |
| Type | Direct / Indirect / Emerging |
| Threat Level | High / Medium / Low |
| Last Updated | 2025-12-08 |
| Market Position | Leader / Challenger / Niche |

## Company Snapshot

### Basics
- **Founded**: [Year]
- **Headquarters**: [Location]
- **Employees**: [Range]
- **Funding**: [Total raised / Public]
- **Revenue**: [Estimate if available]

### Leadership
| Role | Name | Background |
|------|------|------------|
| CEO | [Name] | [Brief background] |
| CMO | [Name] | [Brief background] |
| CTO | [Name] | [Brief background] |

## Product Analysis

### Core Offering
[Description of main product/service]

### Key Features
| Feature | Their Approach | Our Approach | Comparison |
|---------|----------------|--------------|------------|
| Feature A | [Details] | [Details] | We lead / They lead / Parity |
| Feature B | [Details] | [Details] | We lead / They lead / Parity |
| Feature C | [Details] | [Details] | We lead / They lead / Parity |

### Pricing
| Tier | Price | Features | vs. Our Pricing |
|------|-------|----------|-----------------|
| Starter | $X/mo | [List] | Higher / Lower / Similar |
| Pro | $X/mo | [List] | Higher / Lower / Similar |
| Enterprise | Custom | [List] | Higher / Lower / Similar |

### Integrations
[List key integrations and ecosystem]

## Positioning Analysis

### Value Proposition
> "[Their main value prop / tagline]"

### Target Audience
- **Primary**: [Segment]
- **Secondary**: [Segment]
- **Verticals**: [Industries]

### Key Messages
1. [Message 1]
2. [Message 2]
3. [Message 3]

### Differentiation Claims
- [Claim 1]
- [Claim 2]
- [Claim 3]

## Marketing Analysis

### Content Strategy
- **Blog frequency**: [X posts/week]
- **Content themes**: [Topics]
- **Content types**: [Blog, video, podcast, etc.]
- **SEO focus**: [Keywords]

### Social Presence
| Platform | Followers | Engagement | Strategy |
|----------|-----------|------------|----------|
| LinkedIn | [X] | [High/Med/Low] | [Focus] |
| Twitter | [X] | [High/Med/Low] | [Focus] |
| Instagram | [X] | [High/Med/Low] | [Focus] |

### Advertising
- **Estimated monthly spend**: $[X]
- **Primary channels**: [List]
- **Key messages in ads**: [Themes]
- **Landing page approach**: [Description]

### Events & PR
- **Conference presence**: [List]
- **Recent press**: [Summary]
- **Thought leadership**: [Topics]

## Strengths & Weaknesses

### Strengths
1. [Strength 1]
2. [Strength 2]
3. [Strength 3]

### Weaknesses
1. [Weakness 1]
2. [Weakness 2]
3. [Weakness 3]

## Recent Activity

### Last 30 Days
| Date | Activity | Significance |
|------|----------|--------------|
| 2025-12-01 | New feature launch | High |
| 2025-11-28 | Pricing change | Medium |
| 2025-11-15 | Press release | Low |

### Signals to Watch
- [Signal 1]
- [Signal 2]
- [Signal 3]

## Competitive Response

### When Competing Against Them
- **Lead with**: [Our advantages]
- **Acknowledge**: [Their strengths]
- **Differentiate on**: [Key differentiators]
- **Avoid**: [Their strong areas]

### Objection Handlers
| Objection | Response |
|-----------|----------|
| "They have X" | [Response] |
| "They're cheaper" | [Response] |
| "They're bigger" | [Response] |

### Win/Loss Insights
- **Win rate vs. them**: [X%]
- **Common win reasons**: [List]
- **Common loss reasons**: [List]
```

## Competitive Landscape Report

```markdown
# Competitive Landscape Report

**Date**: 2025-12-08
**Period**: Q4 2025
**Analyzed**: 8 competitors

## Executive Summary

### Market Position Map

```
                    Enterprise-Focus
                          │
                          │  [Competitor A]
           [Competitor B] │
                          │
Feature-Light ────────────┼──────────── Feature-Rich
                          │
         [Our Position]   │  [Competitor C]
                          │
           [Competitor D] │
                          │
                    SMB-Focus
```

### Competitive Dynamics

| Competitor | Threat | Trend | Primary Threat |
|------------|--------|-------|----------------|
| Competitor A | High | ↑ Increasing | Enterprise deals |
| Competitor B | Medium | → Stable | Price competition |
| Competitor C | High | ↑ Increasing | Feature parity |
| Competitor D | Low | ↓ Declining | Market exit signals |

## Key Movements This Quarter

### Competitor A: Enterprise Push
- Launched SOC 2 Type II certification
- Hired enterprise sales team (8 reps)
- New case study: Fortune 500 client
- **Our response**: Accelerate compliance roadmap

### Competitor B: Pricing War
- Dropped starter tier by 30%
- Added free tier (limited features)
- Aggressive discount offers
- **Our response**: Value-based positioning, not price match

### Competitor C: Feature Expansion
- Launched AI-powered recommendations
- Added 12 new integrations
- Expanded API capabilities
- **Our response**: Feature roadmap review, differentiation

## Messaging Analysis

### Positioning Themes

| Competitor | Primary Theme | Secondary Theme |
|------------|---------------|-----------------|
| A | Enterprise-grade | Security |
| B | Affordable | Easy to use |
| C | All-in-one | AI-powered |
| D | Industry-specific | Compliance |
| **Us** | ROI-focused | Ease of use |

### Value Prop Comparison

| Value Prop | Us | A | B | C |
|------------|-----|---|---|---|
| Time savings | ★★★ | ★★ | ★★ | ★★★ |
| ROI proof | ★★★ | ★★ | ★ | ★★ |
| Ease of use | ★★★ | ★ | ★★★ | ★★ |
| Features | ★★ | ★★★ | ★ | ★★★ |
| Price | ★★ | ★ | ★★★ | ★★ |

## Content Strategy Analysis

### Content Volume

| Competitor | Blog/Week | Video/Mo | Podcast | Webinar/Mo |
|------------|-----------|----------|---------|------------|
| A | 3 | 4 | No | 2 |
| B | 5 | 2 | Yes | 1 |
| C | 4 | 6 | No | 3 |
| D | 1 | 1 | No | 0 |
| **Us** | 2 | 2 | No | 2 |

### Top Performing Content (by engagement)

| Competitor | Top Content | Theme | Our Gap? |
|------------|-------------|-------|----------|
| A | "Enterprise ROI Calculator" | ROI | Similar tool exists |
| B | "5 Min Setup Guide" | Ease | Need video version |
| C | "AI Features Demo" | Features | No equivalent |

## Advertising Analysis

### Estimated Ad Spend

| Competitor | Monthly Est. | Primary Channel | YoY Change |
|------------|--------------|-----------------|------------|
| A | $150K | LinkedIn | +40% |
| B | $80K | Google | +10% |
| C | $120K | Meta | +25% |
| D | $30K | Google | -20% |
| **Us** | $100K | Mixed | +15% |

### Ad Messaging Themes

```
Most Common Themes:
A: "Enterprise-ready" "Secure" "Scale"
B: "Free trial" "Easy setup" "Affordable"
C: "AI-powered" "All features" "One platform"
```

## Opportunity Analysis

### Market Gaps

1. **Mid-market focus**: Competitors focused on extremes (SMB or Enterprise)
2. **Industry verticalization**: Healthcare and finance underserved
3. **Integration depth**: Native integrations vs. Zapier-only

### Differentiation Opportunities

| Opportunity | Investment | Impact | Timeline |
|-------------|------------|--------|----------|
| Healthcare vertical | Medium | High | Q1 2026 |
| Native CRM integration | High | High | Q2 2026 |
| Advanced reporting | Low | Medium | Q4 2025 |

### Competitive Moat

- **Our advantages**: Customer success, ease of use, ROI proof
- **Defend against**: Feature parity, enterprise security
- **Build**: AI capabilities, vertical expertise

## Recommendations

### Immediate Actions (This Quarter)
1. [ ] Launch competitive comparison page for Competitor C
2. [ ] Update sales battle cards for all competitors
3. [ ] Create "switching from X" content for Competitor B
4. [ ] Brief sales on Competitor A enterprise push

### Strategic Initiatives (Next Quarter)
1. [ ] Develop healthcare vertical positioning
2. [ ] Accelerate compliance certifications
3. [ ] Evaluate AI feature roadmap
4. [ ] Review pricing vs. Competitor B

## Intelligence Calendar

### Upcoming Events to Monitor
- Jan 15: Competitor A annual conference
- Feb 1: Competitor C funding announcement expected
- Mar: Industry analyst reports published

### Review Schedule
- Weekly: Social and ad monitoring
- Monthly: Full competitive update
- Quarterly: Comprehensive landscape report
```

## Usage Examples

### Full Competitive Analysis

```
User: "Analyze competitive landscape"

Skill executes:
1. Update all competitor data
2. Analyze positioning changes
3. Compare messaging
4. Generate recommendations

Output:
"Competitive Analysis Complete

8 competitors analyzed across 12 dimensions

Key Findings:
1. Competitor A increasing enterprise focus (+40% ad spend)
2. Competitor B started price war (30% drop)
3. Competitor C launched AI features we lack

Market Gaps Identified:
- Mid-market segment underserved
- Healthcare vertical opportunity
- Integration depth differentiator

Urgent Actions:
1. Update battle cards for Competitor A
2. Create competitive page vs. Competitor C
3. Brief sales on pricing response strategy

Report: .aiwg/marketing/competitive/landscape-2025-12.md"
```

### Single Competitor Deep Dive

```
User: "Deep dive on Competitor A"

Skill analyzes:
- All recent activity
- Positioning changes
- Strength/weakness

Output:
"Competitor A Analysis

Profile: Enterprise-focused challenger
Threat Level: High (increasing)

Recent Moves:
- SOC 2 Type II certification (Nov)
- Enterprise sales team (+8 reps)
- Fortune 500 case study published

Strategy Shift:
Moving upmarket aggressively. Targeting our enterprise deals.

Our Response Options:
1. Accelerate compliance roadmap
2. Strengthen mid-market positioning
3. Create enterprise-specific content

Profile updated: .aiwg/marketing/competitive/competitor-a.md"
```

## Integration

This skill uses:
- `data-pipeline`: Source competitive data
- `project-awareness`: Understand our positioning
- `artifact-metadata`: Track intelligence artifacts

## Agent Orchestration

```yaml
agents:
  research:
    agent: market-researcher
    focus: Data gathering and monitoring

  analysis:
    agent: marketing-analyst
    focus: Pattern analysis and insights

  strategy:
    agent: positioning-specialist
    focus: Strategic recommendations
```

## Configuration

### Competitor Tracking

```yaml
competitor_config:
  direct_competitors:
    - name: Competitor A
      website: competitor-a.com
      priority: high
      track: [website, social, ads, reviews]

    - name: Competitor B
      website: competitor-b.com
      priority: medium
      track: [website, social, pricing]

  indirect_competitors:
    - name: Alternative X
      priority: low
      track: [website, news]

  emerging:
    - name: Startup Y
      priority: watch
      track: [funding, product]
```

### Alert Triggers

```yaml
alerts:
  pricing_change:
    trigger: pricing_page_modified
    priority: high
    notify: [product, sales]

  feature_launch:
    trigger: new_feature_announced
    priority: medium
    notify: [product, marketing]

  funding:
    trigger: funding_announcement
    priority: high
    notify: [leadership, strategy]
```

## Output Locations

- Competitor profiles: `.aiwg/marketing/competitive/profiles/`
- Landscape reports: `.aiwg/marketing/competitive/`
- Battle cards: `.aiwg/marketing/competitive/battle-cards/`
- Intelligence alerts: `.aiwg/marketing/competitive/alerts/`

## References

- Competitor template: templates/strategy/competitive-analysis-template.md
- Battle card template: templates/sales-enablement/battlecard-template.md
- Intelligence sources: .aiwg/marketing/config/intel-sources.yaml
