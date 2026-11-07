# ROI Calculator Specification

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

**Card ID**: `SLS-{PROJECT}-{NNNN}`
**Version**: 1.0
**Status**: Draft | Development | Live
**Product**: {PRODUCT_NAME}
**Owner**: {OWNER_NAME}

---

## Calculator Overview

### Purpose

{What business outcomes this calculator helps prospects understand}

### Target User

- Role: {Who will use this}
- Stage: {Where in buying journey}
- Goal: {What they want to learn}

### Key Value Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| {Metric 1} | {What it measures} | {Customer data, benchmarks} |
| {Metric 2} | {What it measures} | {Customer data, benchmarks} |
| {Metric 3} | {What it measures} | {Customer data, benchmarks} |

---

## Input Variables

### Company Information

| Input | Label | Type | Default | Range | Help Text |
|-------|-------|------|---------|-------|-----------|
| employees | Number of employees | Number | 100 | 10-10,000 | Full-time employees |
| annual_revenue | Annual revenue | Currency | $10M | $1M-$1B | Annual revenue |
| industry | Industry | Dropdown | - | {List} | Your primary industry |

### Current State

| Input | Label | Type | Default | Range | Help Text |
|-------|-------|------|---------|-------|-----------|
| current_cost | Current annual spend | Currency | $0 | - | What you spend today |
| time_spent | Hours spent per week | Number | 10 | 1-100 | Team hours on {task} |
| error_rate | Error rate | Percentage | 5% | 0-50% | Current error rate |

### Operational Metrics

| Input | Label | Type | Default | Range | Help Text |
|-------|-------|------|---------|-------|-----------|
| volume | Monthly {transactions} | Number | 1,000 | - | Volume of {activity} |
| avg_value | Average {value} | Currency | $100 | - | Typical {value} |
| team_size | Team members | Number | 5 | 1-100 | People involved in {process} |

---

## Calculation Logic

### Cost Savings Calculations

**Labor cost savings**:
```
hours_saved = time_spent * time_savings_rate
labor_savings = hours_saved * 52 * hourly_rate * team_size
```

**Error reduction savings**:
```
current_error_cost = volume * 12 * avg_value * error_rate * rework_cost_factor
new_error_cost = volume * 12 * avg_value * (error_rate * (1 - error_reduction_rate)) * rework_cost_factor
error_savings = current_error_cost - new_error_cost
```

**Tool consolidation savings**:
```
tool_savings = current_cost - our_cost
```

### Revenue Impact Calculations

**Productivity gains**:
```
productivity_gain = team_size * hours_saved * 52 * hourly_rate * productivity_multiplier
```

**Revenue acceleration**:
```
cycle_reduction = avg_cycle * cycle_improvement_rate
revenue_acceleration = (volume * avg_value * 12) * (cycle_reduction / avg_cycle)
```

### Total Value Calculation

```
total_annual_value = labor_savings + error_savings + tool_savings + productivity_gain + revenue_acceleration

investment = our_annual_cost + implementation_cost

roi_percentage = ((total_annual_value - investment) / investment) * 100
payback_months = investment / (total_annual_value / 12)
three_year_value = (total_annual_value * 3) - (investment + (our_annual_cost * 2))
```

---

## Benchmark Data

### Industry Benchmarks

| Industry | Time Savings | Error Reduction | Productivity Gain |
|----------|--------------|-----------------|-------------------|
| {Industry 1} | {%} | {%} | {%} |
| {Industry 2} | {%} | {%} | {%} |
| {Industry 3} | {%} | {%} | {%} |
| Default | {%} | {%} | {%} |

### Size-Based Adjustments

| Company Size | Adjustment Factor | Rationale |
|--------------|-------------------|-----------|
| <50 employees | 0.8x | Less complexity |
| 50-500 employees | 1.0x | Baseline |
| 500-5000 employees | 1.2x | Scale benefits |
| 5000+ employees | 1.5x | Enterprise scale |

### Customer-Validated Assumptions

| Assumption | Value | Source |
|------------|-------|--------|
| Avg hourly rate | $50 | Industry average |
| Time savings rate | 40% | Customer average |
| Error reduction rate | 75% | Customer data |
| Rework cost factor | 3x | Industry research |
| Productivity multiplier | 1.2x | Customer data |
| Cycle improvement rate | 25% | Customer data |

---

## Output Display

### Summary Results

| Output | Label | Format | Display Logic |
|--------|-------|--------|---------------|
| total_annual_value | Total Annual Value | Currency | Always show |
| roi_percentage | ROI | Percentage | Always show |
| payback_months | Payback Period | Months | Show if positive |
| three_year_value | 3-Year Value | Currency | Always show |

### Detailed Breakdown

| Category | Value | Percentage |
|----------|-------|------------|
| Labor savings | ${calculated} | {%} |
| Error reduction | ${calculated} | {%} |
| Tool consolidation | ${calculated} | {%} |
| Productivity gains | ${calculated} | {%} |
| Revenue impact | ${calculated} | {%} |

### Visual Elements

| Element | Type | Purpose |
|---------|------|---------|
| ROI gauge | Gauge chart | Quick visual of ROI |
| Value breakdown | Pie chart | Category distribution |
| Timeline | Bar chart | Value over 3 years |
| Comparison | Before/after | Current vs. future state |

---

## Output Scenarios

### Conservative / Moderate / Aggressive

| Scenario | Time Savings | Error Reduction | Multiplier |
|----------|--------------|-----------------|------------|
| Conservative | 25% | 50% | 0.7x |
| Moderate | 40% | 75% | 1.0x |
| Aggressive | 60% | 90% | 1.3x |

---

## Lead Capture

### Gating Strategy

| Stage | Access |
|-------|--------|
| Basic calculator | Ungated |
| Detailed report | Email required |
| PDF export | Email + phone |
| Custom analysis | Sales contact |

### Lead Information

| Field | Required | Use |
|-------|----------|-----|
| Email | Yes | Report delivery |
| Name | Yes | Personalization |
| Company | Yes | Account matching |
| Phone | No | Sales follow-up |
| Role | No | Qualification |

### Sales Follow-Up

**Trigger**: Report downloaded

**Lead score**: Based on inputs
- High: ROI > 300%, enterprise size
- Medium: ROI > 150%, mid-market
- Low: ROI < 150%, SMB

**Follow-up cadence**:
- Day 1: Email with additional resources
- Day 3: SDR call
- Day 7: Follow-up email

---

## Export / Report

### PDF Report Contents

1. Executive summary
2. Input assumptions
3. Detailed calculations
4. Value breakdown chart
5. Implementation roadmap
6. Next steps / CTA
7. Methodology notes
8. Contact information

### CRM Integration

| Action | Trigger | Data Passed |
|--------|---------|-------------|
| Create lead | Report download | All inputs + outputs |
| Update opportunity | Calculator used | ROI value, inputs |
| Alert sales | High-value lead | Summary, contact info |

---

## Technical Requirements

### Platform

- [ ] Web-based
- [ ] Mobile responsive
- [ ] Offline capable
- [ ] Embeddable
- [ ] Standalone page

### Integration

| System | Purpose |
|--------|---------|
| CRM | Lead/opportunity sync |
| Marketing automation | Lead nurture |
| Analytics | Usage tracking |
| Pricing tool | Cost data |

### Performance

- Load time: < 2 seconds
- Calculation: Real-time
- Save/resume: Session-based
- Export: < 5 seconds

---

## Testing & Validation

### Test Scenarios

| Scenario | Inputs | Expected Output |
|----------|--------|-----------------|
| Small company | {Values} | {Expected range} |
| Mid-market | {Values} | {Expected range} |
| Enterprise | {Values} | {Expected range} |
| Edge case: minimum | {Values} | {Expected behavior} |
| Edge case: maximum | {Values} | {Expected behavior} |

### Validation Against Customer Data

| Customer | Calculator Estimate | Actual Results | Variance |
|----------|---------------------|----------------|----------|
| {Customer 1} | ${Amount} | ${Amount} | {%} |
| {Customer 2} | ${Amount} | ${Amount} | {%} |

---

## Maintenance

### Update Schedule

| Element | Frequency | Owner |
|---------|-----------|-------|
| Benchmark data | Quarterly | Product Marketing |
| Pricing | As needed | Product/Finance |
| Customer data | Quarterly | Customer Success |
| Design refresh | Annually | Creative |

### Version Control

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | {DATE} | Initial release |

---

## Approvals

| Role | Name | Status | Date |
|------|------|--------|------|
| Product Marketing | | | |
| Sales | | | |
| Finance | | | |
| Legal | | | |

---

*Template version: 1.0 | MMK Framework*
