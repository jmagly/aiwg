# Crisis Response & Communications Plan

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- ID: PRS-007
- Owner: PR Manager (agents/pr-manager.md)
- Contributors: Legal Advisor (agents/legal-advisor.md), Executive Orchestrator (agents/executive-orchestrator.md), Security Lead (agents/security-lead.md)
- Reviewers: Board of Directors, Executive Team
- Team: `team`
- Status: `active/testing/needs-update`
- Dates: created `YYYY-MM-DD` / updated `YYYY-MM-DD` / last-drill `YYYY-MM-DD` / next-review `YYYY-MM-DD`
- Related: PRS-005, PRS-006, SEC-`id`, OPS-`id`
- Links: `crisis-hotline`, `emergency-contacts`, `secure-channel-url`

## Purpose

Comprehensive playbook for identifying, managing, and communicating during crisis situations that threaten company reputation, operations, customer trust, or employee safety. Provides decision trees, escalation protocols, communication templates, and recovery procedures optimized for speed, accuracy, and stakeholder protection.

## Crisis Definition & Severity Levels

### What Constitutes a Crisis

A crisis is an unexpected event or situation that:
- Threatens company reputation or brand
- Impacts customer data, privacy, or safety
- Disrupts core business operations
- Violates legal or regulatory requirements
- Creates significant media attention (negative)
- Affects employee safety or well-being
- Threatens financial stability or investor confidence

### Severity Levels

#### Level 1: Minor Incident
**Definition**: Isolated issue with limited scope and impact
**Examples**:
- Service outage affecting < 10% of customers for < 1 hour
- Minor security vulnerability (low severity, quickly patched)
- Negative social media post from single customer
- Isolated product defect affecting < 100 units

**Response**:
- Handled by functional teams (support, engineering, product)
- PR informed but not lead
- Standard communication channels
- Resolution gate: issue contained and response owner verifies closure

**Escalation**: If impacts grow or media inquiries received

---

#### Level 2: Moderate Crisis
**Definition**: Significant issue requiring cross-functional coordination
**Examples**:
- Service outage affecting 10-50% of customers for 1-4 hours
- Data breach affecting < 1,000 customers (PII exposed)
- Executive departure under negative circumstances
- Product recall affecting thousands of units
- Regulatory inquiry or investigation
- Negative tier 2/3 media coverage

**Response**:
- PR leads communication + Legal + Functional lead
- Crisis response team activated (virtual)
- Holding statement within 2 hours
- Full statement within 24 hours
- Customer notification (if applicable)
- Resolution gate: remediation verified and stakeholder updates approved

**Escalation**: If national media picks up, customer impact worsens, or legal exposure increases

---

#### Level 3: Major Crisis
**Definition**: Severe incident with enterprise-wide impact
**Examples**:
- Major service outage (> 50% customers, > 4 hours)
- Large-scale data breach (> 1,000 customers, sensitive data)
- Security incident affecting core systems
- Tier 1 national media coverage (negative)
- Product defect causing injury or significant damage
- Executive misconduct allegations
- Regulatory enforcement action
- Activist investor campaign

**Response**:
- CEO leads + Full crisis response team activated
- War room established (physical + virtual)
- Holding statement within 1 hour
- Full statement within 4-6 hours
- Customer notification immediately
- Media monitoring 24/7
- Legal and regulatory notifications
- Board informed within 2 hours
- Resolution gate: root cause contained, integrity verified, and recovery approved

**Escalation**: Automatic board notification, potential outside counsel/crisis PR firm

---

#### Level 4: Catastrophic Crisis
**Definition**: Existential threat to company survival
**Examples**:
- Massive data breach (entire customer base compromised)
- Complete service outage (days, not hours)
- Product defect causing fatalities
- Criminal investigation of company or executives
- Cyberattack crippling operations (ransomware)
- Environmental disaster (if physical operations)
- Widespread employee safety incident

**Response**:
- CEO + Board chair lead
- Full crisis team + Outside crisis management firm
- Physical war room + 24/7 operations
- Immediate public statement (CEO on-camera)
- Continuous media monitoring and response
- Legal counsel on-site
- Regulatory notifications immediate
- Customer support scaled massively
- Resolution gate: independent recovery review and executive sign-off complete

---

## Crisis Response Team

### Core Team Members

| Role | Primary | Backup | Responsibilities |
|------|---------|--------|------------------|
| **Crisis Lead** | CEO | COO | Final decision authority, public face |
| **PR Lead** | PR Manager | PR Director | Communication strategy, media response |
| **Legal Lead** | General Counsel | Outside Counsel | Legal exposure, regulatory compliance |
| **Technical Lead** | CTO/CIO | VP Engineering | Root cause, remediation, technical details |
| **Customer Lead** | VP Customer Success | Support Director | Customer communication, impact assessment |
| **HR Lead** | CHRO | HR Director | Employee communication, safety |
| **Operations Lead** | COO | VP Operations | Business continuity, resource allocation |
| **Finance Lead** | CFO | Controller | Financial impact, investor relations |
| **Security Lead** | CISO | Security Director | Incident response, forensics, containment |

**Contact Information**: Maintained in separate secure document (PII-protected)
- Mobile phones (direct lines, not office)
- Personal emails (if corporate systems compromised)
- Backup communication channel (Signal, WhatsApp, other encrypted app)

### Extended Team (as needed)

- **Board Representative**: Chair or designated director
- **Outside Crisis PR Firm**: [Firm name, contact] (Level 3/4 only)
- **Outside Legal Counsel**: [Firm name, contact] (Level 3/4)
- **Cyber Forensics Firm**: [Firm name, contact] (if security incident)
- **Insurance Representative**: [Contact] (if claim likely)

### Team Activation

**Trigger Criteria**:
- Level 2+: Automatic activation
- Level 1: Discretionary (PR Manager decision)
- Any executive can declare crisis and activate team

**Activation Protocol**:
1. Crisis lead (or designee) initiates via [method - Slack channel, email, phone tree]
2. All team members acknowledge receipt within 15 minutes
3. Initial team call scheduled within 30 minutes (Level 3/4) or 2 hours (Level 2)
4. War room location: [Physical address + Virtual meeting link]

## First 60 Minutes: Immediate Response

### Minute 0-15: Initial Assessment

**Actions**:
- [ ] Confirm crisis (not false alarm)
- [ ] Classify severity level (1-4)
- [ ] Activate crisis response team
- [ ] Establish secure communication channel
- [ ] Document timeline (start incident log)

**Key Questions**:
- What happened? (facts only, no speculation)
- When did it occur? (exact timestamp)
- Who is affected? (customers, employees, systems)
- What is current status? (ongoing, contained, resolved)
- What are immediate safety/security concerns?

**Incident Log Template**:
```
Crisis ID: [YYYY-MM-DD-###]
Severity Level: [1/2/3/4]
Detected: [YYYY-MM-DD HH:MM TZ]
Reported By: [Name, Role]
Initial Description: [2-3 sentence factual summary]

Timeline:
- [HH:MM]: [Event]
- [HH:MM]: [Event]
- [HH:MM]: [Event]

[Update continuously throughout crisis]
```

### Minute 15-30: Containment & Notification

**Actions**:
- [ ] Initiate technical/operational containment
- [ ] Identify stakeholder notification requirements:
  - Customers (if data/service affected)
  - Employees (if safety/operations affected)
  - Board (Level 3/4 automatic, Level 2 if material)
  - Regulators (if legal requirement - GDPR, SEC, etc.)
  - Law enforcement (if criminal activity suspected)
- [ ] Assign spokesperson (CEO for Level 3/4)
- [ ] Monitor media and social media (set up alerts)
- [ ] Draft holding statement (approval within 30 min)

**Holding Statement Template**:
```
We are aware of [brief description of incident] affecting [scope - customers,
systems, etc.]. We are actively investigating and taking steps to [contain/
resolve/protect customers].

We will provide updates as we learn more. Customer safety and data protection
are our highest priorities.

For questions: [crisis email/hotline]
```

### Minute 30-60: Communication Planning

**Actions**:
- [ ] Assess communication needs:
  - Internal (employees need to know BEFORE external)
  - Customers (direct email/in-app notification)
  - Media (proactive statement or reactive only?)
  - Social media (official response on channels)
  - Partners/vendors (if affected)
  - Investors (if material impact)
- [ ] Draft customer notification (if applicable)
- [ ] Prepare FAQ for support team
- [ ] Brief executives on key messages
- [ ] Set next update timing (commit to transparency)

**Decision: Proactive vs Reactive Media**:

**Go Proactive If**:
- Widespread customer impact
- Likely to be discovered/reported anyway
- Legal/regulatory notification required
- Demonstrates transparency and control

**Stay Reactive If**:
- Limited scope (contained quickly)
- No customer impact
- Technical issue (not newsworthy)
- More facts needed before public statement

## Communication Protocols

### Internal Communication (Employees First)

**Principle**: Employees hear from company before external world

**Channels**:
1. **Critical/Immediate** (< 1 hour): CEO all-hands email
2. **Updates** (ongoing): Slack channel or intranet
3. **Detailed** (24 hours): Virtual town hall or recorded message

**Employee Email Template**:
```
Subject: [Company] Incident Update - [Date/Time]

Team,

I want to make you aware of [brief incident description] that [scope and impact].

What we know:
- [Fact 1]
- [Fact 2]
- [Fact 3]

What we're doing:
- [Action 1]
- [Action 2]
- [Action 3]

What this means for you:
- [Employee impact - systems affected, policy changes, etc.]
- If customers ask: [Brief talking points]
- For questions: [Internal channel]

I'll send another update by [time]. Thank you for your patience and
professionalism as we handle this situation.

[CEO Name]
```

**DO NOT**:
- Share unverified information
- Speculate about cause
- Blame individuals or teams
- Minimize severity (be honest)

### Customer Communication

**Notification Requirements**:

**Immediate** (< 2 hours):
- Service outage (critical systems)
- Security incident (potential data exposure)
- Product safety issue

**Within 24 hours**:
- Confirmed data breach (per GDPR/state laws)
- Material service degradation
- Product recall

**Channels** (use multiple for redundancy):
- Email (primary account holder + affected users)
- In-app notification (if app-based product)
- Status page (public or authenticated)
- Website banner (if public-facing)
- Social media (Twitter/X, LinkedIn)

**Customer Notification Template**:
```
Subject: Important Security Update for [Product] Customers

Dear [Customer],

We are writing to inform you of a security incident that may have affected
your [Company] account.

WHAT HAPPENED:
On [date], we detected [brief description]. [Number] customers were potentially
affected, including your account.

WHAT INFORMATION WAS INVOLVED:
[Specific data elements - be transparent]:
- [Data type 1 - e.g., email addresses]
- [Data type 2 - e.g., encrypted passwords]
- [Data type 3]

Data NOT affected:
- [Sensitive data that was NOT exposed - credit cards, SSN, etc.]

WHAT WE'RE DOING:
- [Containment action 1 with timestamp]
- [Remediation action 2]
- [Preventive measure 3]
- [External notification - law enforcement, regulators]

WHAT YOU SHOULD DO:
1. [Required action 1 - e.g., reset password]
2. [Recommended action 2 - e.g., enable MFA]
3. [Precautionary action 3 - e.g., monitor accounts]

We are offering [remediation - free credit monitoring, extended service, etc.]
as a precaution.

HOW TO GET HELP:
- Dedicated support line: [Phone number, hours]
- Email: [crisis-support email]
- FAQ: [URL with more details]

We sincerely apologize for this incident and any concern it causes. Protecting
your data is our highest priority, and we are taking this matter extremely
seriously.

We will provide updates at [URL] as we learn more.

Sincerely,
[CEO Name]
[Title]
[Company]
```

**Accessibility Requirements**:
- Plain language (8th grade reading level)
- Multiple languages (if serving non-English customers)
- Alternative formats (large print, screen reader compatible)
- Support line with TTY for hearing impaired

### Media Communication

**Spokesperson Hierarchy**:
- **Level 1-2**: PR Manager or designated spokesperson
- **Level 3**: CEO or COO
- **Level 4**: CEO only (on-camera if possible)

**Media Statement Template**:
```
FOR IMMEDIATE RELEASE

[Company] Statement on [Incident]

[CITY, STATE] - [Date] - [Company] today confirmed [brief factual description
of incident].

[WHAT HAPPENED - 1 paragraph]:
[Factual description without speculation. Include what, when, who affected.]

[WHAT WE'RE DOING - 1 paragraph]:
[Actions taken to contain, investigate, remediate. Include timeline and
external parties involved (law enforcement, forensics, regulators).]

[CUSTOMER PROTECTION - 1 paragraph]:
[Steps taken to protect customers. Resources provided. How to get help.]

[CEO QUOTE]:
"[Accountability statement. Commitment to transparency. Customer protection
priority. Lessons learned or improvements being made.]"
— [CEO Name], [Title], [Company]

[COMPANY BOILERPLATE]

Media Contact:
[Name]
[Title]
[Email]
[Phone]
[Hours/Timezone]
```

**Media Inquiry Response Protocol**:

**Within 2 hours** (business hours):
- Acknowledge receipt
- State the next response gate and owner; quote any operator-supplied response commitment
- Offer spokesperson interview if appropriate

**Within 24 hours**:
- Provide full statement or interview
- Offer follow-up resources (FAQ, background materials)

**Template**:
```
Hi [Journalist Name],

Thank you for your inquiry about [topic]. We take this matter seriously
and want to provide you with accurate information.

[Brief factual response or point to official statement]

[CEO/Spokesperson Name] is available for an interview to discuss further.
Please let me know your deadline and preferred format (phone, video, in-person).

I'll follow up with additional details by [time].

Best regards,
[PR Contact]
```

**Media Monitoring**:
- Set Google Alerts (company name + crisis keywords)
- Social media listening (Twitter/X, Reddit, LinkedIn, Facebook)
- News monitoring services (Cision, Muck Rack, Google News)
- Track sentiment and reach
- Daily clip report to crisis team

### Social Media Response

**Channels**:
- Twitter/X (primary for real-time updates)
- LinkedIn (professional/investor audience)
- Facebook (consumer audience if applicable)
- Instagram (if visual component)

**Posting Frequency**:
- **Level 3/4**: Every 2-4 hours with updates
- **Level 2**: Every 6-8 hours or as developments occur
- **Level 1**: Single post if public-facing

**Social Media Post Template**:
```
We are aware of [issue] affecting [scope]. We are investigating and will
provide updates as we learn more. Customer safety is our top priority.

For support: [link]
Updates: [status page link]

[Thread with additional details if character limit]
```

**Response Guidelines**:
- Respond to direct mentions/questions (don't ignore)
- Consistent messaging (match official statements)
- Empathetic tone (acknowledge customer frustration)
- Direct to support channels (don't troubleshoot publicly)
- Correct misinformation (politely, with facts)

**What NOT to Do**:
- Argue with customers or critics
- Delete negative comments (looks worse)
- Go dark/radio silent
- Post unrelated content (tone-deaf)
- Blame customers or third parties

## Dark Site / Crisis Website

### Purpose

Standalone crisis response website activated when:
- Main website compromised (cyberattack)
- Traffic surge crashes primary site
- Need for clean, dedicated crisis information hub

### Requirements

**Pre-Built Template** (ready to activate):
- Hosted on separate infrastructure (different provider from main site)
- Simple, fast-loading design (minimal graphics)
- WCAG 2.1 AA accessible
- Mobile-optimized
- Multilingual support (if global customers)

**Content Sections**:
1. **Incident Summary**: What happened (plain language)
2. **Customer Impact**: Who is affected, what data/services
3. **Actions Taken**: Timeline of response
4. **Resources**: FAQs, support contacts, claim forms
5. **Updates**: Reverse-chronological feed
6. **Media**: Official statements, press contacts

**URL**:
- `crisis.company.com` or `help.company.com`
- Pre-registered, SSL configured
- Can activate in < 1 hour

**Example Structure**:
```
┌───────────────────────────────────────┐
│ [Company Logo]  Crisis Response Center│
│                                       │
│ Updated: [Timestamp]                  │
│                                       │
│ ## What Happened                      │
│ [Incident summary]                    │
│                                       │
│ ## Who Is Affected                    │
│ [Customer impact]                     │
│                                       │
│ ## What We're Doing                   │
│ [Actions and timeline]                │
│                                       │
│ ## How to Get Help                    │
│ - Support: [Phone, Email]             │
│ - FAQ: [Link]                         │
│ - Submit Claim: [Form]                │
│                                       │
│ ## Latest Updates                     │
│ [HH:MM] - [Update]                    │
│ [HH:MM] - [Update]                    │
│                                       │
│ ## Media Inquiries                    │
│ [PR Contact]                          │
└───────────────────────────────────────┘
```

## Legal & Regulatory Notifications

### Notification Requirements (By Jurisdiction)

**Data Breach Notifications**:

**GDPR (EU)**:
- Timing: Within 72 hours of discovery
- To whom: Data Protection Authority (DPA) + affected individuals
- Threshold: High risk to rights and freedoms
- Penalties: Up to €20M or 4% of global revenue

**CCPA (California)**:
- Timing: Without unreasonable delay
- To whom: California Attorney General + affected residents
- Threshold: Unauthorized access to unencrypted personal information
- Penalties: Up to $7,500 per violation

**State Breach Laws** (US):
- Timing: Varies by state (most: "without unreasonable delay")
- To whom: Affected residents + state AG
- Threshold: Varies (some: any breach, others: likelihood of harm)

**HIPAA (Healthcare)**:
- Timing: Within 60 days
- To whom: HHS + affected individuals (+ media if > 500 individuals)
- Threshold: Unsecured PHI compromised
- Penalties: Up to $1.5M per year per violation

**Financial/SEC**:
- Timing: Material incidents within 4 business days
- To whom: SEC Form 8-K filing
- Threshold: Material impact on business or operations

**Notification Checklist**:
- [ ] Determine applicable jurisdictions (where affected individuals reside)
- [ ] Calculate affected individuals per jurisdiction
- [ ] Assess notification thresholds
- [ ] Draft notification (legal review required)
- [ ] Submit to regulators (within legal timeframe)
- [ ] Notify individuals (email, mail, or substitute notice if >500K)
- [ ] Document notification (proof of compliance)

### Working with Law Enforcement

**When to Contact**:
- Cyberattack (ransomware, data theft, DDoS)
- Criminal activity (fraud, theft, sabotage)
- Physical threats (violence, terrorism)
- Regulatory requirement (some breach laws mandate)

**Who to Contact**:
- **FBI**: Cyber crimes (Internet Crime Complaint Center - IC3)
- **Secret Service**: Financial crimes, cyber intrusions
- **Local Police**: Physical threats, immediate danger
- **State Attorney General**: Consumer protection, breach notifications

**Protocol**:
1. Inform legal counsel before contacting (attorney-client privilege)
2. Designate single point of contact (usually General Counsel)
3. Provide factual briefing (no speculation)
4. Cooperate fully (provide evidence, logs, access)
5. Coordinate communications (law enforcement may request media silence)

## Recovery & Reputation Repair

### Containment and Restoration (entry: incident scope established)

**Operational**:
- [ ] Contain and remediate root cause
- [ ] Restore service/systems
- [ ] Verify integrity and safety
- [ ] Document lessons learned (preliminary)

**Communication**:
- [ ] Provide regular updates (every 24-48 hours)
- [ ] Answer customer questions (FAQ expansion)
- [ ] Monitor sentiment (media, social, customer feedback)
- [ ] Adjust messaging based on feedback

**Customer Care**:
- [ ] Proactive outreach to key accounts
- [ ] Extended support hours
- [ ] Remediation offers (credits, free services, monitoring)
- [ ] Apology (if appropriate - CEO letter or video)

### Prevention and Validation (entry: service integrity verified)

**Operational**:
- [ ] Implement preventive measures
- [ ] Third-party audit (security, operations, etc.)
- [ ] Publish post-mortem (transparency)
- [ ] Train staff on new procedures

**Communication**:
- [ ] Shift from reactive to proactive (thought leadership)
- [ ] Customer success stories (if retention strong)
- [ ] Media interviews (lessons learned, improvements)
- [ ] Speaking engagements (industry events)

**Reputation Repair**:
- [ ] "We're back" campaign (if appropriate)
- [ ] Customer testimonials (rebuilt trust)
- [ ] Third-party validation (audits, certifications)
- [ ] Executive visibility (conference appearances, articles)

### Sustained Recovery (entry: preventive controls and external review complete)

**Operational**:
- [ ] Comprehensive incident review
- [ ] Update crisis plan (based on learnings)
- [ ] Regular drills (quarterly)
- [ ] Continuous improvement program

**Communication**:
- [ ] Anniversary updates (1 year later: "What we learned")
- [ ] Industry contributions (white papers, frameworks)
- [ ] Transparency reports (if appropriate)

**Culture**:
- [ ] Incorporate learnings into company values
- [ ] Celebrate recovery (internal recognition)
- [ ] Share case study (helping others avoid similar crisis)

## Crisis Preparedness

### Pre-Crisis Planning

**Quarterly Reviews**:
- [ ] Update crisis response plan
- [ ] Verify contact information (all team members)
- [ ] Test communication channels (Slack, email, phone tree)
- [ ] Review dark site (ensure accessible and current template)
- [ ] Update message templates (reflect current products, data)

**Annual Exercises**:
- [ ] Tabletop exercise (simulate crisis, walk through response)
- [ ] Full drill (activate team, test systems, evaluate performance)
- [ ] Third-party assessment (crisis PR firm evaluation)
- [ ] Legal review (regulatory compliance, notification protocols)

**Training**:
- [ ] Media training for executives (annual)
- [ ] Crisis response training for team (semi-annual)
- [ ] Employee crisis awareness (annual all-hands)

### Crisis Scenarios for Drills

**Scenario 1: Data Breach**:
- Customer database compromised (100K records)
- PII exposed (names, emails, encrypted passwords)
- Requires GDPR/CCPA notifications
- Media picks up story

**Scenario 2: Major Outage**:
- Core service down for 6 hours
- 80% of customers affected
- Revenue impact (SLA credits)
- Competitor gains ground

**Scenario 3: Executive Misconduct**:
- CEO accused of harassment
- Internal investigation underway
- Board considering action
- Media requesting comment

**Scenario 4: Product Defect**:
- Safety issue discovered (injury risk)
- 50K units in field
- Recall required
- Regulatory investigation

**Drill Evaluation Criteria**:
- Time to activate team (< 30 minutes?)
- Time to first statement (< 2 hours Level 3?)
- Message consistency across channels
- Stakeholder notification completeness
- Decision-making clarity
- Communication tool effectiveness

### Crisis Communication Tools

**Essential Tools**:
- [ ] Mass email platform (tested, verified deliverability)
- [ ] Status page (hosted separately from main site)
- [ ] Secure communication channel (Signal, Slack private channel)
- [ ] Media monitoring service (Cision, Muck Rack, Google Alerts)
- [ ] Social media management (Hootsuite, Sprout Social)
- [ ] Conference call line (dial-in + web for war room)

**Backup Communication**:
- Personal emails (if corporate systems down)
- Personal phone numbers (if company phones compromised)
- Encrypted messaging app (Signal, WhatsApp)

## Post-Crisis Analysis

### Incident Report Template

```markdown
# Crisis Post-Mortem: [Incident Name]

**Crisis ID**: [YYYY-MM-DD-###]
**Severity Level**: [1/2/3/4]
**Duration**: [Start Date/Time] to [End Date/Time]

## Executive Summary
[2-3 paragraph overview of incident, response, outcome]

## Timeline of Events
| Timestamp | Event | Team Member | Action Taken |
|-----------|-------|-------------|--------------|
| [Time] | [Event] | [Who] | [What] |

## Impact Assessment
**Customers**:
- Affected: [Number] ([Percentage]% of base)
- Duration of impact: [Hours/Days]
- Services affected: [List]
- Data exposure: [If applicable]

**Business**:
- Revenue impact: $[Amount] ([Explanation])
- SLA credits: $[Amount]
- Support costs: $[Amount]
- Legal/regulatory: $[Amount]
- **Total**: $[Amount]

**Reputation**:
- Media mentions: [Number] ([Positive/Neutral/Negative])
- Social sentiment: [Percentage positive]
- Customer churn: [Percentage] ([Baseline vs crisis period])

## Root Cause Analysis
**Primary Cause**: [Technical/Process/Human error description]
**Contributing Factors**:
1. [Factor 1]
2. [Factor 2]
3. [Factor 3]

## Response Evaluation

**What Went Well**:
- [Success 1]
- [Success 2]
- [Success 3]

**What Could Improve**:
- [Gap 1 with proposed fix]
- [Gap 2 with proposed fix]
- [Gap 3 with proposed fix]

**Communication Effectiveness**:
- Time to first statement: [Duration] (Target: [Target])
- Message consistency: [Rating]
- Stakeholder satisfaction: [Survey results if available]

## Preventive Measures
| Measure | Owner | Target Date | Status |
|---------|-------|-------------|--------|
| [Action 1] | [Name] | [Date] | [Complete/In Progress] |
| [Action 2] | [Name] | [Date] | [Status] |

## Lessons Learned
1. [Lesson 1]
2. [Lesson 2]
3. [Lesson 3]

## Crisis Plan Updates
[List of changes made to crisis response plan based on this incident]

**Report Prepared By**: [Name, Date]
**Reviewed By**: [Executive Team, Date]
```

## Related Templates

- **Spokesperson Guide**: PRS-005 (interview preparation)
- **Q&A Document**: PRS-006 (crisis Q&A section)
- **Press Release**: PRS-001 (crisis statement format)
- **Media Kit**: PRS-002 (crisis asset library)
- **Security Incident Response**: SEC-`id` (technical procedures)

## References

- Crisis Communication Best Practices (PRSA)
- GDPR Breach Notification Guidelines
- CCPA Breach Notification Requirements
- SEC Cybersecurity Disclosure Rules
- NIST Cybersecurity Framework
- "Crisis Communications: A Casebook Approach" - Kathleen Fearn-Banks
- Cision Crisis Communication Guide
- PwC Crisis Management Framework
