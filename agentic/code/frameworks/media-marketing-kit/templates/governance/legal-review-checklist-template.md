# Legal Review Checklist Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

---

**Document ID**: GOV-003
**Template Version**: 1.0.0
**Last Updated**: 2025-11-28
**Owner**: Legal Counsel
**Status**: Active

---

## YAML Frontmatter

```yaml
legal_review:
  review_id: "[REVIEW-ID]"
  content_id: "[Associated Content/Campaign ID]"
  reviewer_name: "[Legal Counsel Name]"
  review_date: "[YYYY-MM-DD]"

content_details:
  content_type: "[Blog | Social | Email | Ad | PR | Landing Page | Video | Whitepaper | Other]"
  content_title: "[Title]"
  publication_channel: "[Channel]"
  geographic_reach: "[US | Canada | EU | Global | Other]"

legal_triggers:
  claims_made: "[Yes | No]"
  testimonials: "[Yes | No]"
  sweepstakes: "[Yes | No]"
  regulated_industry: "[Yes | No]"
  third_party_content: "[Yes | No]"
  data_collection: "[Yes | No]"

risk_assessment:
  risk_level: "[Low | Medium | High | Critical]"
  liability_exposure: "[Minimal | Moderate | Significant | Severe]"
  regulatory_concerns: "[None | Low | Medium | High]"

approval_status:
  status: "[Approved | Approved with Conditions | Revision Required | Rejected | Escalated]"
  approved_by: "[Legal Counsel Name]"
  approval_date: "[YYYY-MM-DD]"
  valid_until: "[YYYY-MM-DD or Indefinite]"
```

---

## Purpose

This checklist ensures marketing content complies with applicable laws, regulations, and industry standards, minimizing legal risk and protecting the company from liability.

---

## 1. Legal Review Scope Determination

### 1.1 Review Necessity Assessment

**Does This Content Require Legal Review?**

**AUTO-TRIGGER Legal Review if ANY of the following apply**:
- [ ] Makes product claims (performance, efficacy, comparisons)
- [ ] Includes customer testimonials or endorsements
- [ ] Contains medical, health, or nutritional claims
- [ ] Contains financial advice or investment claims
- [ ] Promotes sweepstakes, contests, or giveaways
- [ ] Uses third-party trademarks or copyrighted material
- [ ] Targets minors (<13 years old, or <16 in EU)
- [ ] Collects personal data (forms, cookies, tracking)
- [ ] Operates in regulated industry (finance, pharma, healthcare, alcohol, tobacco)
- [ ] Published in EU (GDPR compliance)
- [ ] Published in California (CCPA compliance)
- [ ] Partnership or co-marketing content with external company
- [ ] Employment-related content (hiring, recruiting)
- [ ] Crisis communication or apology statement
- [ ] Major product announcement or recall
- [ ] Executive/spokesperson statements

**Legal Review Required**: [ ] Yes | [ ] No

**If No, Provide Justification**:
```text
[Explain why legal review is not necessary despite publication]
```

---

### 1.2 Review Scope and Operator Commitments

**Publication Deadline**: [YYYY-MM-DD]
**Legal Review Requested By**: [YYYY-MM-DD]
**Review Scope**: [Claims, assets, jurisdictions, reviewer roles, and acceptance checks]

**Urgency Level**:
- [ ] **Critical** (regulatory or crisis gate blocked) - Crisis response, time-sensitive regulatory
- [ ] **High** (launch gate blocked) - Press release, major campaign launch
- [ ] **Standard** (normal content review) - Normal marketing content
- [ ] **Low** (strategic document review) - Strategic documents, long-term planning

**Fast-Track Approval Requested**: [ ] Yes | [ ] No
**Reason**: [If yes, explain business justification]

---

## 2. Advertising and Marketing Claims

### 2.1 Product Claims Review

**Claims Assessment**:
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - All product claims substantiated with evidence
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No "best," "fastest," "most," or superlatives without proof
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Comparative claims supported by independent testing
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No misleading or deceptive statements
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Performance data current (not outdated)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No claims outside product's intended use

**Evidence Required**:
| Claim Made | Evidence Type | Evidence Location | Verified |
|------------|---------------|-------------------|----------|
| [Claim 1] | [Study/Test/Report] | [Link/File] | [ ] Yes [ ] No |
| [Claim 2] | [Study/Test/Report] | [Link/File] | [ ] Yes [ ] No |

**Disclaimer Required**:
- [ ] **Yes** - [Specify disclaimer text]
- [ ] **No** - Claims clear and unambiguous

**Issues Identified**:
```text
[List unsubstantiated claims, required edits, or evidence needed]
```

**Severity**: [ ] Critical | [ ] Moderate | [ ] Minor | [ ] None

---

### 2.2 Testimonials and Endorsements (FTC Compliance)

**Testimonials Used**: [ ] Yes | [ ] No

**If Yes, Review**:
- [ ] **PASS** | [ ] **FAIL** - Written consent obtained from customer/endorser
- [ ] **PASS** | [ ] **FAIL** - Testimonial reflects genuine experience (not scripted/fabricated)
- [ ] **PASS** | [ ] **FAIL** - Testimonial results are typical (or disclaimer states "results not typical")
- [ ] **PASS** | [ ] **FAIL** - Material connections disclosed (paid endorsement, free product, affiliate)
- [ ] **PASS** | [ ] **FAIL** - No misleading editing or context removed
- [ ] **PASS** | [ ] **FAIL** - Endorser is actual user of product (not actor unless disclosed)

**Influencer/Affiliate Marketing**:
- [ ] **PASS** | [ ] **FAIL** - #ad or #sponsored hashtag present if paid
- [ ] **PASS** | [ ] **FAIL** - Disclosure visible without "read more" expansion
- [ ] **PASS** | [ ] **FAIL** - Contract with influencer includes FTC compliance clause

**Required Disclosure**:
```text
[If testimonial results not typical, add disclaimer: "Results not typical. Individual results may vary."]
```

**Issues Identified**:
```text
[List issues with testimonials or endorsements]
```

**Severity**: [ ] Critical | [ ] Moderate | [ ] Minor | [ ] None

---

### 2.3 Comparative and Competitive Claims

**Competitor Comparisons**: [ ] Yes | [ ] No

**If Yes, Review**:
- [ ] **PASS** | [ ] **FAIL** - Comparison factually accurate and verifiable
- [ ] **PASS** | [ ] **FAIL** - Comparison based on like-for-like features (apples-to-apples)
- [ ] **PASS** | [ ] **FAIL** - No disparagement of competitor's product
- [ ] **PASS** | [ ] **FAIL** - Competitor trademark used nominatively (to identify product, not confuse)
- [ ] **PASS** | [ ] **FAIL** - No implication of endorsement or partnership with competitor
- [ ] **PASS** | [ ] **FAIL** - Supporting data for comparison available

**Third-Party Rankings/Awards**:
- [ ] **PASS** | [ ] **FAIL** - Award/ranking current and accurate
- [ ] **PASS** | [ ] **FAIL** - Source credible and independent
- [ ] **PASS** | [ ] **FAIL** - Award not expired or rescinded

**Issues Identified**:
```text
[List issues with competitive claims]
```

**Severity**: [ ] Critical | [ ] Moderate | [ ] Minor | [ ] None

---

## 3. Industry-Specific Regulations

### 3.1 Financial Services (SEC, FINRA, CFPB)

**Applies if**: Financial products, investment services, banking, insurance

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No guarantees of investment returns
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Risk disclosures prominent and clear
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - All rates, fees, and terms disclosed
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No misleading or deceptive practices (e.g., teaser rates)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Compliance with CAN-SPAM (emails)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Equal Credit Opportunity Act compliance (no discriminatory language)

**Required Disclosures**:
```text
[Example: "Past performance does not guarantee future results." or "Member FDIC"]
```

**Issues**: [Describe]

---

### 3.2 Healthcare and Pharmaceuticals (FDA, FTC)

**Applies if**: Medical devices, pharmaceuticals, supplements, health services

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No disease claims for non-approved products
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Structure/function claims for supplements appropriately worded
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - FDA disclaimer present for supplements ("not evaluated by FDA")
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No off-label promotion of drugs or devices
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Clinical trial data cited accurately
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - HIPAA compliance for patient testimonials (authorization obtained)

**Required Disclosures**:
```text
[Example: "These statements have not been evaluated by the FDA. This product is not intended to diagnose, treat, cure, or prevent any disease."]
```

**Issues**: [Describe]

---

### 3.3 Alcohol and Tobacco (TTB, State Laws)

**Applies if**: Alcohol, tobacco, vaping products

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Age gate present on digital content (21+)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No targeting minors (content, imagery, influencers)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Health warning labels present (if required)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No health claims (e.g., "low-calorie" alcohol may be restricted)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Responsible consumption messaging included
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - State-specific regulations reviewed (vary widely)

**Issues**: [Describe]

---

### 3.4 Food and Beverage (FDA, USDA)

**Applies if**: Food products, nutritional claims

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Nutritional claims comply with FDA definitions ("low-fat," "organic," etc.)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Allergen information disclosed prominently
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No misleading health claims
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Certified claims verified (USDA Organic, Non-GMO Project, etc.)

**Issues**: [Describe]

---

### 3.5 Children's Content (COPPA - USA, GDPR-K - EU)

**Applies if**: Targeting children under 13 (US) or under 16 (EU)

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Parental consent obtained for data collection
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Privacy policy specifically addresses children's data
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No tracking cookies for children without consent
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No collection of personal information from children without parental consent
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Content appropriate for age group (no violence, adult themes)

**Issues**: [Describe]

---

## 4. Sweepstakes, Contests, and Promotions

### 4.1 Promotion Legality

**Promotion Type**:
- [ ] Sweepstakes (chance-based, no purchase necessary)
- [ ] Contest (skill-based)
- [ ] Lottery (chance + consideration = ILLEGAL without license)

**Legal Requirements**:
- [ ] **PASS** | [ ] **FAIL** - No purchase necessary clearly stated (for sweepstakes)
- [ ] **PASS** | [ ] **FAIL** - Alternate method of entry (AMOE) provided
- [ ] **PASS** | [ ] **FAIL** - Official rules linked/available
- [ ] **PASS** | [ ] **FAIL** - Eligibility restrictions stated (age, geography)
- [ ] **PASS** | [ ] **FAIL** - Void where prohibited by law
- [ ] **PASS** | [ ] **FAIL** - Start and end dates clear
- [ ] **PASS** | [ ] **FAIL** - Prize value disclosed
- [ ] **PASS** | [ ] **FAIL** - Odds of winning disclosed (if calculable)
- [ ] **PASS** | [ ] **FAIL** - Sponsor identified
- [ ] **PASS** | [ ] **FAIL** - State registrations filed (if required - FL, NY, RI for prizes >$5k)

**Official Rules Review**:
- [ ] Rules drafted by legal counsel
- [ ] Rules posted publicly and accessible

**Issues Identified**:
```text
[List issues with promotion structure or disclosures]
```

**Severity**: [ ] Critical | [ ] Moderate | [ ] Minor | [ ] None

---

## 5. Intellectual Property

### 5.1 Trademark Usage

**Company Trademarks**:
- [ ] **PASS** | [ ] **FAIL** - ® or ™ symbol used on first prominent mention
- [ ] **PASS** | [ ] **FAIL** - Trademark used as adjective, not noun/verb
- [ ] **PASS** | [ ] **FAIL** - Trademark capitalized correctly
- [ ] **PASS** | [ ] **FAIL** - Trademark attribution in footer/legal line

**Third-Party Trademarks**:
- [ ] **PASS** | [ ] **FAIL** - Used nominatively (to identify product) only
- [ ] **PASS** | [ ] **FAIL** - No suggestion of endorsement or partnership
- [ ] **PASS** | [ ] **FAIL** - No alteration or combination with company mark
- [ ] **PASS** | [ ] **FAIL** - Permission obtained if used beyond fair use

**Issues Identified**:
```text
[List trademark issues]
```

**Severity**: [ ] Critical | [ ] Moderate | [ ] Minor | [ ] None

---

### 5.2 Copyright Compliance

**Original Content**:
- [ ] **PASS** | [ ] **FAIL** - Copyright notice present (© Year Company Name)
- [ ] **PASS** | [ ] **FAIL** - Copyright ownership clear (work-for-hire agreements with creators)

**Third-Party Content**:
- [ ] **PASS** | [ ] **FAIL** - All images, videos, music properly licensed
- [ ] **PASS** | [ ] **FAIL** - Attribution provided where required
- [ ] **PASS** | [ ] **FAIL** - No use of unlicensed stock photos or graphics
- [ ] **PASS** | [ ] **FAIL** - Fair use doctrine applied correctly (if claiming fair use)

**User-Generated Content (UGC)**:
- [ ] **PASS** | [ ] **FAIL** - Rights granted by user to repost (terms of service or explicit permission)
- [ ] **PASS** | [ ] **FAIL** - UGC attribution provided (credit user)
- [ ] **PASS** | [ ] **FAIL** - No use of copyrighted music in UGC without license

**Issues Identified**:
```text
[List copyright issues and licensing gaps]
```

**Severity**: [ ] Critical | [ ] Moderate | [ ] Minor | [ ] None

---

### 5.3 Right of Publicity (Name, Image, Likeness)

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Signed release obtained for any person depicted
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Model release includes commercial use rights
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No use of celebrity name/likeness without permission
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Employee consent obtained for internal/external use

**Issues**: [Describe]

---

## 6. Privacy and Data Protection

### 6.1 Data Collection Disclosure

**Does Content Collect Personal Data?**
- [ ] Forms (name, email, phone)
- [ ] Cookies/tracking pixels
- [ ] Account creation
- [ ] Purchase information
- [ ] Geolocation
- [ ] Other: [Specify]

**Privacy Requirements**:
- [ ] **PASS** | [ ] **FAIL** - Privacy policy linked prominently
- [ ] **PASS** | [ ] **FAIL** - Opt-in consent obtained (required for EU/GDPR)
- [ ] **PASS** | [ ] **FAIL** - Purpose of data collection explained
- [ ] **PASS** | [ ] **FAIL** - Data sharing practices disclosed
- [ ] **PASS** | [ ] **FAIL** - User rights explained (access, deletion, portability)

**Issues Identified**:
```text
[List privacy compliance issues]
```

**Severity**: [ ] Critical | [ ] Moderate | [ ] Minor | [ ] None

---

### 6.2 GDPR Compliance (EU)

**Applies if**: Targeting EU residents or processing EU data

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Explicit opt-in consent for data collection (pre-checked boxes prohibited)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Cookie consent banner present (not just notice)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Granular consent options (accept/reject specific cookies)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Privacy policy GDPR-compliant (DPO contact, legal basis, etc.)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Data processing agreement (DPA) with third-party vendors
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Right to erasure / right to be forgotten mechanism in place

**Issues**: [Describe]

---

### 6.3 CCPA Compliance (California)

**Applies if**: Targeting California residents

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - "Do Not Sell My Personal Information" link present
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Privacy policy discloses categories of data collected
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Privacy policy discloses data sharing/selling practices
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Opt-out mechanism functional

**Issues**: [Describe]

---

### 6.4 CAN-SPAM Act (Email)

**Applies if**: Commercial email

- [ ] **PASS** | [ ] **FAIL** - Accurate "From" name and email address
- [ ] **PASS** | [ ] **FAIL** - Accurate subject line (not misleading)
- [ ] **PASS** | [ ] **FAIL** - Email identified as advertisement (if applicable)
- [ ] **PASS** | [ ] **FAIL** - Valid physical postal address included
- [ ] **PASS** | [ ] **FAIL** - Unsubscribe link present and functional
- [ ] **PASS** | [ ] **FAIL** - Unsubscribe requests honored within 10 business days

**Issues**: [Describe]

---

## 7. Accessibility Compliance

### 7.1 ADA Compliance (Digital Accessibility)

**See**: `accessibility-checklist-template.md` (GOV-004) for full checklist

**Legal Risk Assessment**:
- [ ] **PASS** | [ ] **FAIL** - WCAG 2.1 AA compliance met (legal safe harbor)
- [ ] **PASS** | [ ] **FAIL** - Alt text provided for all images
- [ ] **PASS** | [ ] **FAIL** - Captions provided for video content
- [ ] **PASS** | [ ] **FAIL** - Color contrast ratios sufficient
- [ ] **PASS** | [ ] **FAIL** - Keyboard navigation functional

**Risk Level**: [ ] Low (compliant) | [ ] Medium (minor issues) | [ ] High (significant accessibility barriers)

**Issues**: [Describe]

---

## 8. Employment and Recruiting

### 8.1 Equal Employment Opportunity (EEO)

**Applies if**: Job postings, recruiting content

- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - No discriminatory language (age, race, gender, religion, disability)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Job requirements are bona fide occupational qualifications
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - EEO statement included (if required by company policy)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Salary range disclosed (if required by state - CA, CO, NY, WA)

**Issues**: [Describe]

---

## 9. Disclosures and Disclaimers

### 9.1 Required Disclaimers

**Financial Disclosures**:
```text
[Example: "Past performance is not indicative of future results." or "Investing involves risk, including loss of principal."]
```

**Health/Medical Disclaimers**:
```text
[Example: "These statements have not been evaluated by the FDA. Not intended to diagnose, treat, cure, or prevent any disease."]
```

**Legal Disclaimers**:
```text
[Example: "This content is for informational purposes only and does not constitute legal advice."]
```

**General Disclaimers**:
```text
[Example: "Results may vary." or "Individual experiences not typical."]
```

**Placement Review**:
- [ ] **PASS** | [ ] **FAIL** - Disclaimers clearly visible (not hidden in fine print)
- [ ] **PASS** | [ ] **FAIL** - Disclaimers in close proximity to claims
- [ ] **PASS** | [ ] **FAIL** - Font size legible (not microscopic)
- [ ] **PASS** | [ ] **FAIL** - Hyperlinked disclaimers appear before claim, not after

**Issues**: [Describe]

---

### 9.2 Terms and Conditions

**If Applicable**:
- [ ] **PASS** | [ ] **FAIL** - Terms of service linked
- [ ] **PASS** | [ ] **FAIL** - Return/refund policy disclosed
- [ ] **PASS** | [ ] **FAIL** - Warranty terms clear
- [ ] **PASS** | [ ] **FAIL** - Limitation of liability stated

**Issues**: [Describe]

---

## 10. International and Export Compliance

### 10.1 International Marketing

**Geographic Targeting**: [List countries/regions]

**Compliance Requirements by Region**:
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Language requirements met (e.g., Quebec French-language law)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Local advertising regulations reviewed
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Cultural sensitivities considered (imagery, messaging)
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Currency and pricing regulations followed
- [ ] **PASS** | [ ] **FAIL** | [ ] **N/A** - Import/export restrictions considered (if physical product)

**Issues**: [Describe]

---

## 11. Risk Assessment and Recommendation

### 11.1 Overall Legal Risk

**Risk Score Calculation**:

| Risk Category | Score (0-5) | Weight | Weighted Score |
|---------------|-------------|--------|----------------|
| Claims/Misrepresentation | [0-5] | 25% | [X] |
| Intellectual Property | [0-5] | 20% | [X] |
| Privacy/Data Protection | [0-5] | 20% | [X] |
| Industry Regulation | [0-5] | 15% | [X] |
| Disclosures/Disclaimers | [0-5] | 10% | [X] |
| Other Legal Issues | [0-5] | 10% | [X] |
| **Total Risk Score** | | | **[X/5]** |

**Risk Level Interpretation**:
- **0-1.5**: Low Risk - Proceed with approval
- **1.6-3.0**: Medium Risk - Conditional approval with edits
- **3.1-4.0**: High Risk - Significant revision required
- **4.1-5.0**: Critical Risk - Reject or escalate to General Counsel

**Overall Risk Assessment**: [ ] Low | [ ] Medium | [ ] High | [ ] Critical

---

### 11.2 Legal Recommendation

- [ ] **APPROVED** - No legal issues identified, proceed
- [ ] **APPROVED WITH CONDITIONS** - Approve pending specific edits (listed below)
- [ ] **REVISION REQUIRED** - Substantive legal issues must be addressed
- [ ] **REJECTED** - Unacceptable legal risk, do not publish
- [ ] **ESCALATED** - Requires General Counsel or executive review

**Required Edits Before Approval**:
1. [Edit 1]
2. [Edit 2]
3. [Edit 3]

**Conditions for Approval**:
```text
[If conditionally approved, specify exactly what must be changed and how]
```

**Rationale for Decision**:
```text
[Explain the legal reasoning for the recommendation]
```

---

## 12. Approval and Sign-Off

### 12.1 Legal Counsel Approval

**Reviewer Name**: [Name]
**Title**: [Legal Counsel / General Counsel]
**Bar Admission**: [State(s)]
**Email**: [Email]
**Review Date**: [YYYY-MM-DD]

**Approval Status**: [ ] Approved | [ ] Approved with Conditions | [ ] Revision Required | [ ] Rejected | [ ] Escalated

**Signature**: [Digital signature or email confirmation]

**Approval Valid Until**: [YYYY-MM-DD or "Indefinite for approved version only"]

---

### 12.2 Escalation (if needed)

**Escalated To**: [General Counsel / Executive Team]
**Escalation Reason**:
```text
[Describe complex legal issue requiring senior review]
```

**Escalation Date**: [YYYY-MM-DD]

---

## 13. Documentation and Audit Trail

### 13.1 Record Keeping

**Review Stored**: [Location - Legal shared drive, contract management system]
**Content Version Reviewed**: [Version number, date, or link]
**Supporting Documentation**: [Links to evidence, licenses, contracts, consent forms]

**Retention Period**: [7 years recommended for legal records]

---

### 13.2 Post-Publication Monitoring

**If Approved, Monitor For**:
- Competitor legal challenges or cease-and-desist letters
- Regulatory inquiries (FTC, FDA, etc.)
- Consumer complaints about misleading content
- Intellectual property infringement claims

**Monitoring Responsibility**: [Legal team, Marketing Ops, Brand team]

---

## Template Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-28 | MMK Framework Team | Initial template creation |

---

**DISCLAIMER**: This template is for guidance only and does not constitute legal advice. Consult qualified legal counsel for specific legal questions.

---

**END OF TEMPLATE**
