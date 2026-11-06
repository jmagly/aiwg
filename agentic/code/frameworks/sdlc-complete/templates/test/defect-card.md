# Defect Card

## Purpose

Track defects from discovery through resolution and verification. Defect cards document bugs, link them to failing tests and requirements, capture root cause analysis, and ensure regression tests prevent recurrence.

## Ownership

- Owner: Test Engineer (discovery and verification)
- Contributors: Software Implementer (fix), Test Architect (triage)
- Reviewers: Product Owner (prioritization), Technical Lead (root cause review)

## Metadata

- ID: DEF-{project}-{number} (e.g., DEF-SHOP-042)
- Reporter: {name}
- Assigned To: {developer name}
- Team: {team}
- Status: new | assigned | in-progress | fixed | verified | closed | deferred | duplicate | wont-fix
- Dates: reported {YYYY-MM-DD} / assigned {YYYY-MM-DD} / fixed {YYYY-MM-DD} / verified {YYYY-MM-DD}
- Related: TC-{id}, REQ-{id}, US-{id}, UC-{id}, DEF-{id} (duplicates/related)
- Tags: #{component}, #{feature}, #{defect-type}
- Links: {failing test, code change, screenshots, logs}

## Defect Classification

### Severity

**How critical is this defect?**

Select one:

- [ ] **Critical (P0)**: System unusable, data loss, security breach, complete feature failure
  - **Examples**: Cannot log in at all, payment processing fails 100%, data corruption, security vulnerability
  - **SLA**: Fix immediately (hotfix within hours)
  - **Impact**: Blocks all users or creates legal/security risk

- [ ] **High (P1)**: Major feature broken, significant user impact, no workaround
  - **Examples**: Search returns no results, checkout fails 50% of time, admin panel inaccessible
  - **SLA**: Fix this iteration/sprint (within days)
  - **Impact**: Blocks key workflows for many users

- [ ] **Medium (P2)**: Feature degraded, workaround exists, minor user impact
  - **Examples**: Slow page load, UI glitch, error message unclear, minor data inconsistency
  - **SLA**: Fix next iteration (within weeks)
  - **Impact**: Annoys users but doesn't block workflows

- [ ] **Low (P3)**: Cosmetic issue, minor inconvenience, edge case
  - **Examples**: Typo, alignment issue, tooltip incorrect, rare edge case
  - **SLA**: Backlog (fix when convenient)
  - **Impact**: Minimal, affects few users or rare scenarios

**Assigned Severity**: {Critical | High | Medium | Low}

**Severity Justification**: {Why this severity level? Include user impact, frequency, and business impact.}

**Example**: High - Checkout fails for 30% of users (those using Safari browser). Workaround: use Chrome. Affects revenue directly.

### Priority

**How urgently should this be fixed?**

Select one:

- [ ] **P0 (Immediate)**: Drop everything, fix now (hotfix)
- [ ] **P1 (This Iteration)**: Fix before iteration ends
- [ ] **P2 (Next Iteration)**: Fix in upcoming iteration
- [ ] **P3 (Backlog)**: Fix when capacity permits

**Assigned Priority**: {P0 | P1 | P2 | P3}

**Priority Justification**: {Why this priority? Include business context, user pain, and urgency.}

**Example**: P1 - While workaround exists (use Chrome), Safari users represent 25% of our traffic. Fix before next release to prevent revenue loss.

### Defect Type

**What category of defect is this?**

- [ ] **Functional**: Feature doesn't work as specified
- [ ] **Performance**: Unacceptable slowness or resource usage
- [ ] **Security**: Vulnerability, unauthorized access, data exposure
- [ ] **Usability**: Confusing UI, poor user experience
- [ ] **Compatibility**: Doesn't work in specific browser, OS, or device
- [ ] **Data**: Incorrect calculation, data loss, data corruption
- [ ] **Integration**: Fails to integrate with external system or service
- [ ] **Regression**: Previously working feature now broken
- [ ] **Documentation**: Incorrect or missing documentation

**Assigned Type**: {Functional | Performance | Security | etc.}

## Problem Description

### Defect Summary

**Title**: {One-line description of the defect}

**Example**: Checkout fails with "Payment processor timeout" error for Safari users

### Detailed Description

**What is the problem?**

Describe the defect in detail:

- What feature/component is affected?
- What specific behavior is broken?
- What is the impact on users or system?
- How was this defect discovered? (test failure, user report, monitoring alert)

**Example**:

When users attempt to complete checkout using Safari browser, the payment processing step fails with error message "Payment processor timeout." The checkout flow works correctly in Chrome, Firefox, and Edge. This defect was discovered during E2E testing on Safari 17.

Affected component: Payment integration (Stripe payment SDK)

### Steps to Reproduce

Provide detailed, repeatable steps to trigger the defect:

1. {Step 1}
2. {Step 2}
3. {Step 3}
4. {Observe defect}

**Example**:

1. Open Safari 17 (macOS Sonoma)
2. Navigate to https://shop.example.com
3. Add item to cart
4. Proceed to checkout
5. Enter shipping information
6. Enter payment information (test card: 4242 4242 4242 4242)
7. Click "Place Order"
8. **Observe**: Error message "Payment processor timeout" appears, order not created

**Reproducibility**: {Always | Frequently (X%) | Intermittent | Once}

**Example**: Always (100% reproducible in Safari 17)

### Expected Behavior

**What should happen?**

Describe the correct behavior according to requirements or user expectations.

**Example**:

User should see order confirmation page with:

- Order number
- Itemized receipt
- Estimated delivery date
- Confirmation email sent

Payment should be processed successfully via Stripe API.

### Actual Behavior

**What actually happens?**

Describe the observed incorrect behavior.

**Example**:

User sees error message: "Payment processor timeout. Please try again."

- No order created in database
- No charge on credit card
- No confirmation email sent
- User stuck on checkout page

## Technical Details

### Environment

**Where does this defect occur?**

- Environment: {dev | test | staging | production}
- Operating System: {Windows/macOS/Linux + version}
- Browser: {Chrome/Firefox/Safari/Edge + version} (if web application)
- Device: {Desktop/Mobile/Tablet, model if relevant}
- Application Version: {version number or commit hash}
- Configuration: {Any special configuration details}

**Example**:

- Environment: Staging
- OS: macOS Sonoma 14.1
- Browser: Safari 17.0
- Device: MacBook Pro M1
- App Version: v2.3.1-rc2 (commit abc123f)
- Configuration: Default (no special flags)

### Failed Test

**Which test detected this defect (if applicable)?**

- Test Case ID: {TC-###}
- Test Suite: {TS-###}
- Test Type: {unit | integration | system | acceptance | etc.}
- Failure Date: {YYYY-MM-DD}

**Example**:

- Test Case: TC-SHOP-215 (E2E Checkout Flow - Safari)
- Test Suite: TS-SHOP-010 (Cross-Browser E2E Tests)
- Type: System (E2E)
- Failure: 2025-10-12

### Component

**What system component is affected?**

- Module/Service: {name}
- File/Class: {path to source code}
- Function/Method: {specific function if known}

**Example**:

- Module: Payment Service
- File: `src/payment/StripePaymentProcessor.js`
- Function: `processPayment(order, paymentMethod)`

### Stack Trace or Error Logs

**Include error messages, stack traces, or relevant log excerpts:**

```text
[2025-10-12 14:32:18] ERROR PaymentService: Stripe API timeout
  at StripePaymentProcessor.processPayment (src/payment/StripePaymentProcessor.js:127)
  at CheckoutController.completeOrder (src/checkout/CheckoutController.js:89)
  Error: Request timeout after 5000ms
    Payment Intent: pi_3NqZ2K2eZvKYlo2C0m8Qxyz
    Browser: Safari/17.0
```

### Test Data

**What data was used when the defect occurred?**

- User account: {test user ID or email}
- Input data: {specific values that triggered the defect}
- Database state: {relevant records or state}

**Example**:

- User: test+safari@example.com (ID: user_123)
- Cart: 1 item (product_456, quantity 1, price $99.99)
- Payment: Stripe test card 4242 4242 4242 4242 (Visa)
- Coupon: None

### Configuration

**Any special configuration that affects this defect?**

- Feature flags: {enabled/disabled flags}
- Environment variables: {relevant config}
- Third-party service versions: {API versions, SDK versions}

**Example**:

- Feature flag: `stripe_payment_intents_enabled` = true
- Stripe SDK: v3.2.0 (client-side JavaScript)
- API timeout: 5000ms (default)

### Attachments

**Include supporting materials:**

- Screenshots: {links or embedded images}
- Video: {screen recording link}
- Network logs: {HAR file, network inspector output}
- Database dumps: {relevant data snapshots}
- Console logs: {browser console output}

**Example**:

- Screenshot: `attachments/def-042-error-message.png`
- Video: `https://drive.example.com/defect-042-repro.mp4`
- Network log: `attachments/def-042-safari-network.har`

## Impact Analysis

### Users Affected

**How many users experience this defect?**

- [ ] All users (100%)
- [ ] Many users (>50%)
- [ ] Some users (10-50%)
- [ ] Few users (<10%)
- [ ] Edge case (specific conditions only)

**Estimate**: {percentage or count}

**Example**: 25% of users (all Safari users, approx. 250 users/day)

### Business Impact

**How does this defect affect the business?**

- [ ] **Critical**: Revenue loss, legal liability, regulatory violation, brand damage
- [ ] **High**: Customer dissatisfaction, support burden, competitive disadvantage
- [ ] **Medium**: Operational inefficiency, minor customer friction
- [ ] **Low**: Negligible impact

**Impact Description**: {Explain business consequences}

**Example**:

**High** - Estimated $5,000/day revenue loss (25% of daily transactions). Increased support tickets (15 tickets/day). Customer frustration evident in support conversations.

### Workaround Available

**Is there a way to avoid this defect?**

- [ ] Yes - workaround exists
- [ ] No - no workaround

**If yes, describe workaround**:

**Example**:

**Yes** - Users can complete checkout using Chrome, Firefox, or Edge browsers. Support team instructed to recommend browser switch when Safari users report issue.

**Workaround Impact**: {Does workaround mitigate business impact?}

**Example**: Partial mitigation. Some users willing to switch browsers, but others may abandon purchase.

## Root Cause Analysis

**Completed after investigation, before fix**

### Root Cause

**What underlying issue caused this defect?**

Describe the technical root cause:

- Code defect (logic error, null pointer, race condition)
- Configuration error (incorrect setting, missing environment variable)
- Dependency issue (library bug, API change)
- Design flaw (architecture limitation, missing requirement)
- Data issue (corrupt data, migration error)

**Example**:

**Dependency issue**: Stripe JavaScript SDK v3.2.0 has a known bug on Safari 17 where the `confirmCardPayment()` method times out when third-party cookies are blocked (Safari's default). SDK does not gracefully handle this case and throws timeout error instead of prompting user to enable cookies or providing fallback.

### Analysis Details

**How was the root cause identified?**

- Investigation steps taken
- Tests performed
- Code reviewed
- External references (vendor bug reports, Stack Overflow, etc.)

**Example**:

1. Reproduced defect in local Safari 17 environment
2. Inspected network traffic: Stripe API request sent but no response received
3. Checked browser console: "Blocked a frame with origin from accessing a cross-origin frame" warning
4. Researched Stripe SDK issue tracker: Found reported bug #3421 matching symptoms
5. Tested with Safari third-party cookie setting enabled: Defect resolved
6. Confirmed: Safari's third-party cookie blocking causes SDK timeout

### Why-Why Analysis (5 Whys)

**Drill down to fundamental cause:**

1. **Why did checkout fail?** Stripe SDK timed out waiting for payment confirmation.
2. **Why did SDK timeout?** SDK could not access third-party cookie required for 3D Secure authentication.
3. **Why was cookie blocked?** Safari 17 blocks third-party cookies by default.
4. **Why didn't we detect this earlier?** E2E tests run in Chrome and Firefox, not Safari.
5. **Why no Safari testing?** CI pipeline lacks Safari test environment (Safari requires macOS runner).

**Fundamental Cause**: Insufficient cross-browser test coverage, specifically lack of Safari testing in CI.

### Contributing Factors

**What other factors contributed?**

- Incomplete requirements (missing browser compatibility criteria)
- Inadequate testing (no Safari in test matrix)
- Lack of monitoring (no alert when Safari checkout failures spike)
- Poor error handling (SDK timeout not handled gracefully)

## Resolution

### Fix Description

**How was the defect resolved?**

Describe the fix implementation:

- Code changes (what was modified)
- Configuration changes (what settings were updated)
- Dependency updates (libraries upgraded)
- Data repairs (records corrected)

**Example**:

**Code Change**: Updated Stripe payment integration to use Stripe Payment Element (newer SDK component) which gracefully handles third-party cookie restrictions. Added fallback to redirect-based authentication flow when cookies blocked.

**Files Changed**:

- `src/payment/StripePaymentProcessor.js` (lines 120-145)
- `src/payment/components/PaymentForm.jsx` (integrated Payment Element UI)

**Configuration**: Enabled Stripe Payment Element in Stripe Dashboard settings.

### Related Code Changes

**Which commits/pull requests contain the fix?**

- Pull Request: {PR number and link}
- Commit: {commit hash and message}
- Branch: {feature branch name}

**Example**:

- PR: #3421 "Fix Safari checkout by migrating to Stripe Payment Element"
- Commit: `def456a` - "Replace confirmCardPayment with Payment Element"
- Branch: `fix/def-042-safari-checkout`

### Regression Test

**What test ensures this defect doesn't recur?**

- Test Case ID: {TC-###}
- Test Type: {unit | integration | system}
- Test Description: {what the test validates}

**Example**:

- Test Case: TC-SHOP-250 (new test)
- Type: System (E2E)
- Description: "Verify checkout succeeds in Safari 17 with third-party cookies blocked"
- Added to Suite: TS-SHOP-010 (Cross-Browser E2E Tests)

### Fix Deployment

**Where has the fix been deployed?**

- [ ] Deployed to test environment (verified)
- [ ] Deployed to staging environment (verified)
- [ ] Deployed to production environment
- [ ] Hotfix: {if expedited deployment}

**Deployment Date**: {YYYY-MM-DD}

**Example**:

- Deployed to test: 2025-10-13 (verified by TC-SHOP-250)
- Deployed to staging: 2025-10-14 (verified by QA team)
- Deployed to production: 2025-10-15 (hotfix release v2.3.2)

## Verification

### Verification Steps

**How was the fix verified?**

1. {Verification step 1}
2. {Verification step 2}
3. {Verification step 3}

**Example**:

1. Ran regression test TC-SHOP-250 in Safari 17: **PASS**
2. Manually tested checkout in Safari 17 with cookies blocked: **SUCCESS** (checkout completed, order created, payment charged)
3. Ran full E2E suite (TS-SHOP-010): **PASS** (no regressions introduced)
4. Verified monitoring: Safari checkout success rate increased from 0% to 98%

### Verified By

**Who verified the fix?**

- Name: {tester name}
- Date: {YYYY-MM-DD}
- Environment: {where verification performed}

**Example**:

- Verified by: Jane Doe (QA Lead)
- Date: 2025-10-14
- Environment: Staging

### Verification Results

**What was the outcome of verification?**

- [ ] **Pass**: Defect resolved, no regressions
- [ ] **Fail**: Defect persists or new issues introduced
- [ ] **Partial**: Defect partially resolved or workaround needed

**Outcome**: {Pass | Fail | Partial}

**Notes**: {Any observations during verification}

**Example**:

**Pass** - Checkout now succeeds in Safari 17 with third-party cookies blocked. No regressions detected in Chrome, Firefox, or Edge. Production monitoring confirms Safari checkout success rate restored to expected 98%.

## Process Improvements

### Prevention Measures

**How can we prevent similar defects in the future?**

- Process changes (add review step, update checklist)
- Testing improvements (expand test coverage, add test environment)
- Tooling enhancements (add linter rule, enable static analysis)
- Documentation updates (add browser compatibility requirements)

**Example**:

1. **Add Safari to CI test matrix**: Provision macOS GitHub Actions runner for Safari E2E tests
2. **Update browser compatibility requirements**: Explicitly list Safari 16+ in requirements for all payment features
3. **Enable cross-browser smoke tests on every PR**: Expand TS-SHOP-001 to include Safari
4. **Monitor checkout success rate by browser**: Add Grafana dashboard with browser-specific metrics

### Lessons Learned

**What did we learn from this defect?**

**Example**:

- Safari's aggressive privacy features (third-party cookie blocking) can break common payment integrations
- Cross-browser testing must include Safari, not just Chrome-based browsers
- Stripe SDK has browser-specific quirks; consult SDK documentation for compatibility notes
- Production monitoring should segment by browser to detect browser-specific issues early

## Related Templates

- `agentic/code/frameworks/sdlc-complete/templates/test/test-case-card.md` - Create regression test for defect
- `agentic/code/frameworks/sdlc-complete/templates/test/test-suite-card.md` - Add regression test to appropriate suite
- `agentic/code/frameworks/sdlc-complete/templates/configuration/change-request-card.md` - Link defect to requirement change
- `agentic/code/frameworks/sdlc-complete/templates/implementation/task-slice-card.md` - Track fix implementation

## Defect Lifecycle

### Status Definitions

- **New**: Defect reported, not yet triaged
- **Assigned**: Defect assigned to developer, not started
- **In Progress**: Developer actively working on fix
- **Fixed**: Fix implemented and deployed to test environment
- **Verified**: Fix verified by tester, ready for production
- **Closed**: Fix deployed to production, defect resolved
- **Deferred**: Decided not to fix now, moved to backlog
- **Duplicate**: Duplicate of another defect (link to original)
- **Won't Fix**: Decided not to fix (document rationale)

### Typical Workflow

```text
New → Assigned → In Progress → Fixed → Verified → Closed
     ↓
   Deferred/Duplicate/Won't Fix
```

### Reopening a Defect

**If defect recurs after closure:**

1. Change status from Closed to In Progress
2. Document recurrence date and environment
3. Update root cause analysis (why did fix fail?)
4. Implement improved fix
5. Re-verify

## Checklist: Defect Card Completeness

Before marking defect as "verified" and deploying to production, confirm:

- [ ] Metadata complete (ID, reporter, assignee, severity, priority, status)
- [ ] Problem description clear and detailed
- [ ] Steps to reproduce documented (100% reproducible or frequency noted)
- [ ] Expected vs. actual behavior specified
- [ ] Technical details captured (environment, stack trace, logs)
- [ ] Impact analysis completed (users affected, business impact)
- [ ] Root cause identified and documented
- [ ] Fix implemented and code reviewed
- [ ] Regression test created and added to suite
- [ ] Fix verified in test/staging environment
- [ ] Prevention measures identified
- [ ] Defect reviewed by Test Architect or Technical Lead

This defect is ready for production deployment when all checklist items are complete.

## Automation Outputs

For agents automating defect tracking and reporting:

### Input Requirements

- Failing test details (test case ID, failure logs)
- Environment information (OS, browser, app version)
- Steps to reproduce (manual or automated)

### Output Artifacts

- Defect card (markdown or issue tracker format)
- Linked regression test case
- Root cause documentation
- Fix verification report

### Integration Points

- Issue tracker (Jira, GitHub Issues, Linear)
- Test management system (TestRail, Zephyr)
- CI/CD pipeline (auto-create defect on test failure)
- Monitoring system (link defect to alert or incident)
