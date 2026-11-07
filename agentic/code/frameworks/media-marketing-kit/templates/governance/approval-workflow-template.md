# Content Approval Workflow Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

---

**Document ID**: GOV-001
**Template Version**: 1.0.0
**Last Updated**: 2025-11-28
**Owner**: Governance Lead
**Status**: Active

---

## YAML Frontmatter

```yaml
approval_workflow:
  workflow_id: "[WORKFLOW-ID]"
  content_type: "[Blog Post | Social Media | Email Campaign | Press Release | Advertisement | Video | Landing Page | Other]"
  created_date: "[YYYY-MM-DD]"
  created_by: "[Name]"

content:
  title: "[Content Title]"
  description: "[Brief description]"
  campaign_id: "[Associated Campaign ID]"
  target_publish_date: "[YYYY-MM-DD]"
  channel: "[Website | Social | Email | Paid Media | PR | Other]"

priority:
  level: "[Critical | High | Medium | Low]"
  business_impact: "[Revenue | Brand | Compliance | Competitive]"
  deadline_type: "[Fixed | Flexible | Date-Driven]"

status:
  current_stage: "[Draft | In Review | Legal Review | Final Approval | Approved | Rejected | On Hold]"
  last_updated: "[YYYY-MM-DD HH:MM]"
  next_action: "[Description of next required action]"
```

---

## Purpose

This template establishes a standardized approval process for marketing content to ensure brand consistency, legal compliance, and quality control before publication.

---

## 1. Content Overview

### 1.1 Content Details

**Content Title**: [Full title or headline]

**Content Type**:
- [ ] Blog Post / Article
- [ ] Social Media Post
- [ ] Email Campaign
- [ ] Press Release
- [ ] Advertisement (Paid Media)
- [ ] Video / Multimedia
- [ ] Landing Page
- [ ] White Paper / eBook
- [ ] Case Study
- [ ] Presentation
- [ ] Other: [Specify]

**Content Description**: [2-3 sentence summary of content purpose and message]

```text
[Detailed description of what this content is, who it targets, and what action it should drive]
```

**Campaign Association**: [Link to campaign brief or campaign ID]

**Business Objective**:
- [ ] Brand Awareness
- [ ] Lead Generation
- [ ] Customer Retention
- [ ] Thought Leadership
- [ ] Product Launch
- [ ] Crisis Response
- [ ] Other: [Specify]

### 1.2 Publication Details

**Target Publish Date**: [YYYY-MM-DD]

**Publication Channel(s)**:
- [ ] Company Website
- [ ] Company Blog
- [ ] LinkedIn
- [ ] Twitter/X
- [ ] Facebook
- [ ] Instagram
- [ ] YouTube
- [ ] Email (Newsletter)
- [ ] Email (Promotional)
- [ ] Paid Search (Google Ads)
- [ ] Display Advertising
- [ ] External Media Outlet
- [ ] Other: [Specify]

**Geographic Reach**:
- [ ] Global
- [ ] North America
- [ ] EMEA
- [ ] APAC
- [ ] Specific Country/Region: [Specify]

**Language(s)**: [English, Spanish, French, etc.]

### 1.3 Content Creator Information

**Primary Author**: [Name, email, department]

**Content Team**:
| Role | Name | Email | Contribution |
|------|------|-------|--------------|
| Writer | [Name] | [Email] | [Primary copy] |
| Designer | [Name] | [Email] | [Visual assets] |
| Video Producer | [Name] | [Email] | [Video editing] |
| Project Manager | [Name] | [Email] | [Coordination] |

**External Contributors** (if applicable):
- Agency: [Agency name, contact]
- Freelancer: [Name, specialty]
- Partner: [Partner company, contact]

---

## 2. Approval Workflow Path

### 2.1 Workflow Tier Selection

**Tier 1: Expedited Approval (pre-approved scope)**
- Pre-approved content types (e.g., social posts using existing assets)
- Minor updates to existing content
- Time-sensitive responses
- **Required Approvers**: Content Lead + Brand Manager

**Tier 2: Standard Approval (new content scope)**
- New blog posts, emails, landing pages
- Original creative campaigns
- External publication submissions
- **Required Approvers**: Content Lead → Brand Manager → Legal Review (if claims made) → Final Sign-off

**Tier 3: Extended Approval (cross-functional scope)**
- Press releases
- Executive thought leadership
- Paid advertising campaigns
- Partnership/co-marketing content
- **Required Approvers**: Content Lead → Brand Manager → Legal → Executive Sponsor → Final Sign-off

**Tier 4: Critical Approval (full approval scope)**
- Crisis communications
- Major product announcements
- Regulatory/compliance content
- M&A announcements
- **Required Approvers**: Full approval chain + Executive Team + Legal + PR + Compliance

**Selected Tier**: [ ] Tier 1 | [ ] Tier 2 | [ ] Tier 3 | [ ] Tier 4

**Rationale for Tier Selection**: [Explain why this tier is appropriate]

### 2.2 Approval Chain

| Stage | Approver Name | Role | Approval Type | Completion Gate | Status | Observed Approval Date | Notes |
|-------|---------------|------|---------------|-----|--------|------|-------|
| 1 | [Name] | Content Lead | Required | Reviewer sign-off recorded | [ ] Pending<br>[ ] Approved<br>[ ] Changes Requested<br>[ ] Rejected | [Date] | [Comments] |
| 2 | [Name] | Brand Manager | Required | Reviewer sign-off recorded | [ ] Pending<br>[ ] Approved<br>[ ] Changes Requested<br>[ ] Rejected | [Date] | [Comments] |
| 3 | [Name] | Legal Review | Required/Optional | Reviewer sign-off recorded | [ ] Pending<br>[ ] Approved<br>[ ] Changes Requested<br>[ ] Rejected | [Date] | [Comments] |
| 4 | [Name] | Subject Matter Expert | Optional | Reviewer sign-off recorded | [ ] Pending<br>[ ] Approved<br>[ ] Changes Requested<br>[ ] Rejected | [Date] | [Comments] |
| 5 | [Name] | Executive Sponsor | Required | Reviewer sign-off recorded | [ ] Pending<br>[ ] Approved<br>[ ] Changes Requested<br>[ ] Rejected | [Date] | [Comments] |
| 6 | [Name] | Final Sign-off | Required | Reviewer sign-off recorded | [ ] Pending<br>[ ] Approved<br>[ ] Changes Requested<br>[ ] Rejected | [Date] | [Comments] |

**Required Approval Gates**: [Required roles and sign-offs, parallel review groups, and correction passes]

### 2.3 Parallel vs. Sequential Approval

**Approval Flow Type**:
- [ ] **Sequential**: Each approver reviews after previous approval (slower, but builds on feedback)
- [ ] **Parallel**: All approvers review simultaneously (faster, but may have conflicting feedback)
- [ ] **Hybrid**: Some stages parallel, some sequential

**Flow Diagram**:

```text
[If parallel]:
Draft → [Brand Manager + Legal + SME] → Final Sign-off → Publish

[If sequential]:
Draft → Content Lead → Brand Manager → Legal → SME → Executive → Publish
```

---

## 3. Review Checklists

### 3.1 Content Quality Review

**Reviewer**: [Content Lead / Editor]
**Date**: [YYYY-MM-DD]

**Writing Quality**:
- [ ] Clear, concise, and audience-appropriate
- [ ] Free of grammatical and spelling errors
- [ ] Consistent tone and voice (matches brand guidelines)
- [ ] Proper formatting and structure
- [ ] Headings/subheadings follow hierarchy
- [ ] Scannable (bullet points, short paragraphs)

**Content Accuracy**:
- [ ] All facts verified and sourced
- [ ] Statistics current and cited
- [ ] Quotes attributed correctly
- [ ] Links functional and point to correct destinations
- [ ] Product/feature descriptions accurate

**SEO Optimization** (if applicable):
- [ ] Target keyword included naturally
- [ ] Meta title optimized (50-60 characters)
- [ ] Meta description compelling (150-160 characters)
- [ ] Alt text for all images
- [ ] Internal links to related content
- [ ] Structured data / schema markup applied

**Call-to-Action (CTA)**:
- [ ] Clear CTA present
- [ ] CTA aligns with content objective
- [ ] Link/button functional
- [ ] Tracking parameters applied (UTM codes)

**Comments / Feedback**:
```text
[Detailed feedback for author]
```

**Status**: [ ] Approved | [ ] Approved with Minor Changes | [ ] Changes Required | [ ] Rejected

---

### 3.2 Brand Compliance Review

**See**: `brand-compliance-checklist-template.md` (GOV-002)

**Reviewer**: [Brand Manager]
**Date**: [YYYY-MM-DD]

**Quick Checklist** (full checklist in GOV-002):
- [ ] Brand voice and tone consistent
- [ ] Logo usage correct
- [ ] Color palette adhered to
- [ ] Typography standards followed
- [ ] Imagery aligned with brand style
- [ ] Messaging framework followed

**Status**: [ ] Approved | [ ] Approved with Minor Changes | [ ] Changes Required | [ ] Rejected

---

### 3.3 Legal Review

**See**: `legal-review-checklist-template.md` (GOV-003)

**Reviewer**: [Legal Counsel / Compliance Officer]
**Date**: [YYYY-MM-DD]

**Legal Triggers** (requires review):
- [ ] Product claims or comparisons
- [ ] Testimonials or endorsements
- [ ] Medical/health claims
- [ ] Financial claims or advice
- [ ] Sweepstakes, contests, promotions
- [ ] Use of third-party trademarks
- [ ] Partnership/co-marketing content
- [ ] Regulatory industry (finance, pharma, etc.)
- [ ] International markets (GDPR, local laws)

**Quick Checklist** (full checklist in GOV-003):
- [ ] No unsubstantiated claims
- [ ] Required disclosures present
- [ ] Trademark symbols used correctly
- [ ] Copyright attributions included
- [ ] Privacy policy linked (if data collected)
- [ ] Compliance with advertising laws (FTC, ASA, etc.)

**Status**: [ ] Approved | [ ] Approved with Minor Changes | [ ] Changes Required | [ ] Rejected

---

### 3.4 Accessibility Review

**See**: `accessibility-checklist-template.md` (GOV-004)

**Reviewer**: [Accessibility Specialist / QA]
**Date**: [YYYY-MM-DD]

**Quick Checklist** (full checklist in GOV-004):
- [ ] WCAG 2.1 AA compliance
- [ ] Alt text for images
- [ ] Captions/transcripts for video
- [ ] Color contrast ratios met
- [ ] Keyboard navigation functional
- [ ] Screen reader tested

**Status**: [ ] Approved | [ ] Approved with Minor Changes | [ ] Changes Required | [ ] Rejected

---

### 3.5 Technical/Platform Review (if applicable)

**Reviewer**: [Web Developer / Marketing Ops]
**Date**: [YYYY-MM-DD]

**Technical Validation**:
- [ ] Renders correctly on mobile (responsive)
- [ ] Renders correctly on tablet
- [ ] Renders correctly on desktop
- [ ] Browser compatibility tested (Chrome, Firefox, Safari, Edge)
- [ ] Load time acceptable (<3 seconds)
- [ ] Forms functional (if applicable)
- [ ] Tracking/analytics implemented correctly
- [ ] A/B test variants configured (if applicable)

**Platform-Specific** (Email):
- [ ] Email client testing (Outlook, Gmail, Apple Mail)
- [ ] Unsubscribe link present and functional
- [ ] CAN-SPAM / GDPR compliant
- [ ] Plain-text version generated

**Platform-Specific** (Paid Media):
- [ ] Ad specs met (dimensions, file size, duration)
- [ ] Landing page experience score acceptable
- [ ] Conversion tracking implemented
- [ ] Remarketing pixels installed

**Status**: [ ] Approved | [ ] Approved with Minor Changes | [ ] Changes Required | [ ] Rejected

---

## 4. Revision Tracking

### 4.1 Version History

| Version | Date | Author | Changes Made | Approver | Status |
|---------|------|--------|--------------|----------|--------|
| 0.1 | [Date] | [Name] | Initial draft | - | Draft |
| 0.2 | [Date] | [Name] | Incorporated brand feedback | [Name] | In Review |
| 0.3 | [Date] | [Name] | Legal edits applied | [Name] | In Legal Review |
| 1.0 | [Date] | [Name] | Final approved version | [Name] | Approved |

### 4.2 Consolidated Feedback Log

| Date | Reviewer | Feedback Type | Feedback Summary | Resolution | Resolved By |
|------|----------|---------------|------------------|------------|-------------|
| [Date] | [Name] | Brand | Logo size too small | Increased to 120px | [Name] |
| [Date] | [Name] | Legal | Add disclaimer for claim | Disclaimer added to footer | [Name] |
| [Date] | [Name] | Accessibility | Missing alt text on hero image | Alt text added | [Name] |

### 4.3 Content Location

**Draft Location**: [Link to Google Doc, Figma file, CMS draft, etc.]

**Final Approved Version**: [Link to final file]

**Published URL** (post-publication): [URL]

---

## 5. Escalation and Exception Handling

### 5.1 Escalation Triggers

**Escalate to Executive Sponsor if**:
- Approval delayed >2 business days beyond SLA
- Conflicting feedback between approvers
- Legal risk identified (high liability)
- Missed publication deadline imminent
- Budget approval required for production

**Escalation Path**:
1. Content Lead contacts delayed approver (reminder)
2. If no response in 24 hours, escalate to approver's manager
3. If still no response, escalate to Executive Sponsor
4. Executive Sponsor has authority to bypass or expedite

**Escalation Contact**: [Name, email, phone]

### 5.2 Approval Exceptions

**Emergency Publication Process** (Crisis/Time-Sensitive):
- Approver: [Executive Sponsor or designated crisis lead]
- Process: Verbal approval followed by written confirmation within 24 hours
- Post-Publication Review: Conduct full review after publication to capture learnings

**Exception Request Form**:

**Requester**: [Name]
**Date**: [YYYY-MM-DD]
**Reason for Exception**: [Explain why standard process cannot be followed]
**Risk Assessment**: [What are the risks of bypassing standard approval?]
**Mitigation**: [How will risks be minimized?]
**Approval**: [Executive Sponsor signature/email confirmation]

### 5.3 Rejection and Rework

**If Content Rejected**:
1. Reviewer provides detailed feedback in writing
2. Author addresses feedback and submits revised version
3. Approval process restarts at rejection stage (not from beginning)
4. If rejected twice, schedule meeting with all stakeholders to align

**Rejection Reasons** (Common):
- [ ] Off-brand (tone, messaging, visual)
- [ ] Factual inaccuracies
- [ ] Legal/compliance issues
- [ ] Poor quality (writing, design)
- [ ] Misaligned with campaign strategy
- [ ] Accessibility issues
- [ ] Technical/platform incompatibilities
- [ ] Other: [Specify]

---

## 6. Post-Approval Process

### 6.1 Pre-Publication Checklist

- [ ] All approvals received and documented
- [ ] Final version matches approved version (no changes post-approval)
- [ ] Metadata finalized (publish date, author, categories, tags)
- [ ] Tracking/analytics configured
- [ ] Social sharing configured (OG tags, Twitter cards)
- [ ] Internal stakeholders notified of publication
- [ ] Distribution plan ready (email blast, social posts, etc.)

### 6.2 Publication Authorization

**Authorized to Publish**: [Name, role]
**Publication Date/Time**: [YYYY-MM-DD HH:MM timezone]
**Publication Platform**: [CMS, social media scheduler, email platform]

**Final Sign-Off**:

**I confirm that**:
- All required approvals have been obtained
- Content matches final approved version
- No changes made post-approval without re-approval
- Publication schedule and distribution plan are accurate

**Name**: [Signature or email confirmation]
**Date**: [YYYY-MM-DD]

### 6.3 Post-Publication Verification

**Within 1 Hour of Publication**:
- [ ] Content live and displaying correctly
- [ ] All links functional
- [ ] Tracking/analytics capturing data
- [ ] Social sharing working correctly
- [ ] No typos or errors introduced during publication
- [ ] Mobile rendering verified

**Verified By**: [Name]
**Verification Date**: [YYYY-MM-DD HH:MM]

---

## 7. Performance Tracking and Reporting

### 7.1 Performance Metrics (Post-Publication)

**Content Performance** (30-day window):
- Page Views/Impressions: [Target: X | Actual: Y]
- Engagement Rate: [Target: X% | Actual: Y%]
- Conversion Rate: [Target: X% | Actual: Y%]
- Leads/Sales Generated: [Target: X | Actual: Y]
- Social Shares: [Target: X | Actual: Y]
- Time on Page: [Target: X min | Actual: Y min]

**Approval Process Metrics**:
- Time from Draft to Approval: [X business days]
- Number of Revisions: [X]
- Average Approval Time per Reviewer: [X days]
- Approvals Meeting SLA: [X%]

### 7.2 Lessons Learned

**What Worked Well**:
```text
[What made the approval process smooth? What accelerated approvals?]
```

**What Could Improve**:
```text
[What bottlenecks occurred? What caused delays or rework?]
```

**Process Improvements**:
```text
[Actionable recommendations for future content approval workflows]
```

---

## 8. Compliance and Audit Trail

### 8.1 Document Retention

**Retention Period**: [2 years | 5 years | Indefinite]

**Stored Locations**:
- Approval Emails: [Email archive, project management tool]
- Draft Versions: [Google Drive, SharePoint, CMS]
- Final Approved Version: [Asset management system, CMS]
- Performance Reports: [Analytics platform, data warehouse]

### 8.2 Audit Trail

**For Compliance Purposes, This Workflow Documents**:
- [ ] Who created the content
- [ ] Who reviewed the content
- [ ] Who approved the content
- [ ] When approvals were granted
- [ ] What changes were made and why
- [ ] When content was published
- [ ] Where content was published

**Audit Contact**: [Compliance Officer name, email]

---

## 9. Approval Workflow Contacts

**Process Owner**: [Name, email]
**Content Lead**: [Name, email]
**Brand Manager**: [Name, email]
**Legal Contact**: [Name, email]
**Accessibility Lead**: [Name, email]
**Technical Contact**: [Name, email]
**Executive Sponsor**: [Name, email]

**Questions or Issues**: [Slack channel, email alias]

---

## Template Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-28 | MMK Framework Team | Initial template creation |

---

**END OF TEMPLATE**
