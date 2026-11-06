# Metrics Catalogs

## Purpose

Comprehensive metric definitions, collection methods, and targets for data-driven SDLC management.

**Philosophy**: Specification and framing over prescriptive solutions. Define WHAT to measure and WHY it matters, not specific analytics platforms.

---

## Catalog Contents

### 1. Delivery Metrics Catalog

**File**: `delivery-metrics-catalog.md`

**Scope**: DORA metrics, velocity, flow, and quality-adjusted delivery

**Metrics Covered** (10 total):

- **DORA Metrics (4)**: Deployment Frequency, Lead Time for Changes, Change Failure Rate, MTTR
- **Velocity Metrics (3)**: Story Point Velocity, Throughput, Cycle Time
- **Flow Metrics (3)**: Work In Progress (WIP), Code Review Queue Depth, Build Duration

**Use Cases**:

- Measure engineering efficiency
- Identify delivery bottlenecks
- Benchmark against DORA industry standards
- Predict project completion

---

### 2. Product Metrics Catalog

**File**: `product-metrics-catalog.md`

**Scope**: AARRR framework (Pirate Metrics), engagement, business health

**Metrics Covered** (12 total):

- **Acquisition (2)**: User Signups, Traffic to Signup Conversion Rate
- **Activation (2)**: Onboarding Completion Rate, Time to Value (TTV)
- **Retention (3)**: DAU/WAU/MAU, Retention Rate (Cohort-Based), Churn Rate
- **Revenue (3)**: Monthly Recurring Revenue (MRR), Average Revenue Per User (ARPU), Customer Lifetime Value (LTV)
- **Referral (2)**: Net Promoter Score (NPS), Viral Coefficient (K-Factor)

**Use Cases**:

- Measure product-market fit
- Track user engagement and retention
- Validate business model viability
- Prioritize feature development based on impact

---

### 3. Quality Metrics Catalog

**File**: `quality-metrics-catalog.md`

**Scope**: Test coverage, defect management, code quality, technical debt

**Metrics Covered** (13 total):

- **Test Coverage (4)**: Line Coverage, Branch Coverage, Mutation Score, Test Execution Time
- **Defect Metrics (4)**: Defect Density, Defect Escape Rate, Defect Age, Flaky Test Rate
- **Code Quality (3)**: Cyclomatic Complexity, Code Duplication, Maintainability Index
- **Technical Debt (2)**: Technical Debt Ratio, Code Churn

**Use Cases**:

- Set quality gates in CI/CD
- Track code health and maintainability
- Predict future maintenance burden
- Identify refactoring targets

---

### 4. Operational Metrics Catalog

**File**: `operational-metrics-catalog.md`

**Scope**: SLO/SLI metrics, infrastructure health, incidents, costs

**Metrics Covered** (16 total):

- **SLO/SLI (5)**: Availability (Uptime), Latency, Error Rate, Saturation, Error Budget
- **Infrastructure (4)**: CPU Utilization, Memory Utilization, Disk Usage, Network Throughput
- **Incidents (4)**: MTTD, MTTA, MTBF, Incident Count by Severity
- **Cost (3)**: Infrastructure Cost per User, Cloud Spend by Service, Cost Efficiency

**Use Cases**:

- Define and track SLOs
- Monitor production reliability
- Manage incident response effectiveness
- Optimize infrastructure costs

---

### 5. DORA Metrics Quickstart Guide

**File**: `dora-metrics-quickstart.md`

**Scope**: Rapid implementation guide for the 4 DORA metrics

**Timeline**: 1-2 weeks to implement basic collection

**Contents**:

- Performance benchmarks (Elite, High, Medium, Low)
- Baseline establishment process
- Collection scripts (GitHub, Jira, PagerDuty examples)
- Storage options (InfluxDB, PostgreSQL, CSV)
- Dashboard examples (Grafana, HTML)
- Improvement roadmap (Month 1-12)

**Use Cases**:

- Bootstrap DORA metrics quickly
- Understand "good" vs "poor" performance levels
- Implement automated collection
- Create first metrics dashboard

---

## How to Use These Catalogs

### Step 1: Select Metrics by Phase

**Inception Phase**: Focus on planning and risk metrics

- Metrics: Risk Identification Rate, Stakeholder Alignment, Estimation Accuracy

**Elaboration Phase**: Focus on baseline establishment

- Metrics: Velocity (baseline), Architecture Coverage, Technical Debt Ratio, Defect Discovery Rate

**Construction Phase**: Focus on delivery and quality

- Metrics: All DORA metrics, Velocity, Test Coverage, Build Duration

**Transition Phase**: Focus on production readiness

- Metrics: MTTR, SLO Compliance, User Adoption Rate, NPS, Churn Rate

### Step 2: Populate Measurement Plan

1. Open `agentic/code/frameworks/sdlc-complete/templates/management/measurement-plan-template.md`
2. Copy metrics from relevant catalog (Delivery, Product, Quality, Operational)
3. Specify data sources available in your environment
4. Set targets based on team maturity and catalog benchmarks
5. Define collection automation strategy

### Step 3: Implement Collection

**Option A: Use Catalog Examples**

- Each metric includes collection method examples (SQL, Python, Bash)
- Adapt examples to your specific tools (GitHub vs GitLab, Jira vs Linear)

**Option B: Start with DORA Quickstart**

- Follow `dora-metrics-quickstart.md` for rapid bootstrap
- Expand to other metrics incrementally

### Step 4: Create Dashboards

**Tool-Agnostic Approach**: Catalogs specify WHAT to visualize, not specific tools

**Recommended Structure** (from Measurement Plan Template):

```
┌─────────────────────────────────────────────────┐
│               PROJECT DASHBOARD                  │
├─────────────────────────────────────────────────┤
│  DELIVERY        │  QUALITY                     │
│  PRODUCT         │  RISKS                       │
└─────────────────────────────────────────────────┘
```

**Dashboard Options**:

- Grafana + InfluxDB (time-series, real-time)
- Tableau / Looker (business intelligence)
- Google Sheets (lightweight, no infrastructure)
- Custom HTML + Chart.js (full control)

### Step 5: Review and Act

**Daily**: WIP, build status, deployment frequency (Team dashboard)

**Weekly**: Velocity, quality, risks (Status Assessment)

**Monthly**: Product metrics, ROI, milestones (Iteration Assessment)

**Quarterly**: Strategic metrics, DORA benchmarks, improvement planning

---

## Metric Selection Guidelines

**Avoid Metric Overload**: Select 5-7 metrics per phase, not all 50+

**Selection Criteria**:

1. **Aligned**: Metric supports a specific decision or objective
2. **Actionable**: Team can influence the metric through actions
3. **Available**: Data source exists or can be implemented quickly
4. **Automated**: Prefer automated collection (90%+ automation target)
5. **Reviewed**: Metric will be regularly reviewed and acted upon

**Anti-Patterns**:

- Vanity metrics (impressive but don't inform decisions)
- Metrics without thresholds (no action triggers)
- Manually collected metrics (high burden, low compliance)
- Metrics reviewed but never acted upon

---

## Integration with SDLC Templates

### Measurement Plan Template

**File**: `agentic/code/frameworks/sdlc-complete/templates/management/measurement-plan-template.md`

**Integration**: Appendix A provides starter metrics by phase. Full catalog references for detailed definitions.

### Status Assessment Template

**File**: `agentic/code/frameworks/sdlc-complete/templates/management/status-assessment-template.md`

**Integration**: Section 4 (Schedule/Effort) and Section 5 (Quality) include trend analysis examples using catalog metrics.

### Iteration Assessment Template

**File**: `agentic/code/frameworks/sdlc-complete/templates/management/iteration-assessment-template.md`

**Integration**: Section 3 (Adherence to Plan) compares planned vs actual velocity. Section 6 (Test Results) includes quality metrics.

---

## Industry Benchmarks

### DORA Performance Levels

| Metric | Elite | High | Medium | Low |
|--------|-------|------|--------|-----|
| Deployment Frequency | Multiple/day | Daily-weekly | Weekly-monthly | < Monthly |
| Lead Time | < 1 hour | 1 day - 1 week | 1 week - 1 month | > 1 month |
| Change Failure Rate | 0-15% | 16-30% | 31-45% | > 45% |
| MTTR | < 1 hour | 1 hour - 1 day | 1 day - 1 week | > 1 week |

**Source**: DORA State of DevOps Reports (annual)

### SaaS Product Benchmarks

| Metric | Best-in-Class | Good | Acceptable |
|--------|---------------|------|------------|
| Onboarding Completion (24hr) | > 70% | 60% | 40-60% |
| D30 Retention | > 25% | 15-25% | 10-15% |
| Monthly Churn (SMB) | < 3% | 3-5% | 5-10% |
| NPS | > 70 | 30-50 | 0-30 |
| LTV / CAC Ratio | > 5x | 3-5x | < 3x |

**Source**: OpenView Partners, ChartMogul, SaaS industry reports

### Code Quality Benchmarks

| Metric | Excellent | Good | Acceptable |
|--------|-----------|------|------------|
| Test Coverage (Line) | > 90% | 80-90% | 70-80% |
| Defect Density | < 0.5 per KLOC | 1-2 per KLOC | 2-5 per KLOC |
| Defect Escape Rate | < 5% | 5-10% | 10-15% |
| Technical Debt Ratio | < 5% | 5-10% | 10-20% |
| Code Duplication | < 3% | 3-5% | 5-10% |

**Source**: Software Engineering Institute, industry surveys

---

## Continuous Improvement

### Quarterly Metric Review

**Process**:

1. Review metric inventory for relevance
2. Retire metrics no longer informing decisions
3. Add metrics for emerging risks or objectives
4. Refine thresholds based on team maturity

### Improvement Triggers

**Metric Anomaly**: Investigate root cause, update process

**Target Missed**: Adjust threshold or improve process

**Metric Ignored**: Candidate for retirement

### Maturity Progression

**Month 1-3**: Establish baseline, automate collection

**Month 4-6**: Improve 1 level on 2+ DORA metrics

**Month 7-12**: Achieve "High" or "Elite" on majority of metrics

---

## Resources

### DORA Research

- State of DevOps Reports: https://dora.dev/research/
- DORA Metrics Calculator: https://cloud.google.com/blog/products/devops-sre/using-the-four-keys-to-measure-your-devops-performance

### Books

- "Accelerate" by Nicole Forsgren, Jez Humble, Gene Kim
- "The DevOps Handbook" by Gene Kim, Jez Humble, Patrick Debois
- "Site Reliability Engineering" (Google SRE Book)

### Tools

- Four Keys (Open Source DORA): https://github.com/GoogleCloudPlatform/fourkeys
- Time-Series Databases: InfluxDB, Prometheus
- Dashboards: Grafana, Tableau, Metabase
- Product Analytics: Mixpanel, Amplitude, Heap

---

## Conclusion

These catalogs enable data-driven SDLC management by:

1. Defining WHAT to measure (metrics, formulas, targets)
2. Explaining WHY it matters (purpose, use cases)
3. Describing HOW to collect (methods, tools, automation)
4. Providing industry benchmarks for comparison

**Next Steps**:

1. Read catalog relevant to your role (Delivery, Product, Quality, Operational)
2. Select 5-7 metrics for current project phase
3. Implement collection automation
4. Create dashboard
5. Review regularly, improve continuously

**Remember**: The goal is not perfect metrics. The goal is continuous improvement.
