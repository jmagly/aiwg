# Test Case Card

## Purpose

Specify an individual test that validates a single behavior, requirement, or scenario. Test cases are the atomic unit of verification and form the foundation of test traceability.

## Ownership

- Owner: Test Engineer
- Contributors: Software Implementer (for unit tests), Requirements Analyst (for acceptance criteria)
- Reviewers: Test Architect

## Metadata

- ID: TC-{project}-{number} (e.g., TC-SHOP-042)
- Owner: {name/team}
- Contributors: {list}
- Reviewers: {list}
- Team: {team}
- Status: draft | approved | automated | passing | failing | skipped | deprecated
- Priority: P0 (critical) | P1 (high) | P2 (medium) | P3 (low)
- Test Type: unit | integration | system | acceptance | performance | security | accessibility
- Automation Status: manual | automated | partially-automated | not-automatable
- Dates: created {YYYY-MM-DD} / updated {YYYY-MM-DD} / last_executed {YYYY-MM-DD}
- Related: REQ-{id}, US-{id}, UC-{id}, DES-{id}, DEF-{id}
- Tags: #{domain}, #{feature}, #{technology}
- Links: {file paths to test code, test data, or related documentation}

## Test Definition

### Subject Under Test

**What is being tested**: {Specific function, API endpoint, user flow, component, or system behavior}

**Example**: User authentication service login method

### Test Objective

**Why this test exists**: {Describe what quality attribute or requirement this test validates}

**Example**: Verify that users can successfully authenticate with valid credentials and receive a session token

### Test Classification

**Type**: {unit | integration | system | acceptance | performance | security | accessibility}

**Scope**: {happy path | edge case | error case | boundary condition | negative test}

**Level**: {smoke | regression | release | exploratory}

## Test Specification

### Preconditions

State that must exist before test execution:

- System configuration (feature flags, environment variables)
- Data prerequisites (user accounts, database records)
- Service dependencies (APIs available, databases seeded)
- User state (logged in, permissions granted)

**Example**:

- Test database seeded with user: email="test@example.com", password_hash=bcrypt("ValidPassword123")
- Authentication service running on port 8080
- Session store (Redis) available

### Test Steps

Structured as **Arrange → Act → Assert** or **Given → When → Then**:

#### Arrange (Given)

Prepare the test environment and inputs:

- Create test data
- Configure mocks/stubs
- Set initial state

**Example**:

- Create authentication request payload: `{ email: "test@example.com", password: "ValidPassword123" }`
- Initialize authentication service client

#### Act (When)

Execute the behavior under test:

- Invoke method/function
- Send HTTP request
- Trigger user action
- Simulate event

**Example**:

- Send POST request to `/auth/login` with credentials payload

#### Assert (Then)

Verify expected outcomes:

- Return values match expectations
- State changes occurred correctly
- Side effects observed (database writes, events emitted)
- Error conditions handled appropriately

**Example**:

- Response status: 200 OK
- Response body contains: `{ user: { id, email }, token: <valid JWT> }`
- Session record created in session store with user_id

### Expected Results

#### Primary Outcomes

**Return Value/Response**: {Describe the expected return value, HTTP response, or observable output}

**State Changes**: {Describe expected changes to system state: database records, cache updates, file modifications}

**Side Effects**: {Events emitted, notifications sent, external API calls, logs written}

**Example**:

- **Return**: HTTP 200 with JSON body `{ user: {...}, token: "jwt.token.here" }`
- **State**: Session record inserted with TTL=3600s
- **Side Effects**: Login event logged to audit log

#### Secondary Outcomes

**Performance**: {Expected execution time, resource usage}

**Example**: Login completes in < 500ms

**Observability**: {Expected logs, metrics, traces}

**Example**: INFO log: "User test@example.com authenticated successfully"

### Test Data

#### Input Data

Specify test inputs with realistic examples:

- Valid input samples
- Invalid input samples (for negative tests)
- Edge case values (boundary conditions)

**Example**:

```json
{
  "email": "test@example.com",
  "password": "ValidPassword123"
}
```

#### Test Fixtures

References to reusable test data sets:

- Fixture files (JSON, YAML, SQL dumps)
- Data factories (generators for dynamic data)
- Mock responses (stubbed external API responses)

**Example**: `fixtures/users/valid_user.json`

#### Data Privacy

If using production-like data:

- [ ] PII anonymized
- [ ] GDPR compliant (consent not required for test data)
- [ ] No real credentials (passwords, API keys)

### Postconditions

State that must be true after test execution:

- System returned to clean state (for isolation)
- Resources released (database connections, file handles)
- Temporary data cleaned up

**Example**:

- Test user session deleted from session store
- Test database transaction rolled back

## Test Execution

### Execution Environment

**Where this test runs**:

- Local development machine (developer testing)
- CI pipeline (automated testing)
- Dedicated test environment (integration testing)
- Staging environment (release validation)

**Example**: CI pipeline (on every commit to main branch)

### Execution Dependencies

**Prerequisites to run this test**:

- Runtime environment (Node.js 18+, Python 3.11+, etc.)
- Test framework (Jest, Pytest, JUnit, etc.)
- Test doubles (mocking library, in-memory database)
- External services (real APIs, containerized dependencies)

**Example**:

- Node.js 18+
- Jest test runner
- Supertest HTTP client
- Dockerized Redis for session store

### Execution Procedure

**How to run this test manually**:

1. Setup command (install dependencies, start services)
2. Execution command (run test)
3. Cleanup command (stop services, clear data)

**Example**:

```bash
# Setup
docker-compose up -d redis
npm install

# Execute
npm test -- tests/auth/login.test.js

# Cleanup
docker-compose down
```

### Execution Frequency

**When this test runs**:

- On commit (pre-push hook, CI trigger)
- On pull request (PR gate)
- Nightly (regression suite)
- On-demand (manual execution)
- Before release (release qualification)

**Example**: On every pull request (PR gate)

## Pass/Fail Criteria

### Pass Criteria

Test passes when **all** of the following are true:

- [ ] All assertions pass
- [ ] No unexpected exceptions thrown
- [ ] Expected state changes verified
- [ ] Performance thresholds met (if applicable)
- [ ] No resource leaks (memory, connections)

### Fail Criteria

Test fails when **any** of the following occur:

- [ ] Assertion failure
- [ ] Unexpected exception/error
- [ ] Timeout exceeded
- [ ] State inconsistency detected
- [ ] Performance degradation (slower than threshold)

### Flakiness Indicators

Signs that this test is unstable:

- [ ] Intermittent failures (passes sometimes, fails sometimes)
- [ ] Timing-dependent (fails under load or slow network)
- [ ] Environment-dependent (passes locally, fails in CI)
- [ ] Order-dependent (passes alone, fails in suite)

**Action if flaky**: Quarantine test (skip in CI), investigate root cause, stabilize or remove

## Traceability

### Requirements Linkage

**What requirement does this test validate?**

- Requirement ID: REQ-{id}
- User Story ID: US-{id}
- Use Case ID: UC-{id}
- Acceptance Criteria: {specific criterion from requirement}

**Example**:

- REQ-042: "Users must authenticate with email and password"
- US-017: "As a user, I want to log in so that I can access my account"
- Acceptance Criteria: "Given valid credentials, user receives session token"

### Design Linkage

**What design decision does this test verify?**

- Architecture Decision Record: ADR-{id}
- Component Design: COMP-{id}
- Interface Contract: API-{id}

**Example**:

- ADR-003: "Use JWT for session management"

### Code Linkage

**What code does this test exercise?**

- Source module: `src/auth/AuthService.js`
- Function/method: `AuthService.login(email, password)`
- Code coverage: lines covered, branches covered

**Example**:

- Source: `src/auth/AuthService.js` (lines 42-67)
- Coverage: 25 lines, 4 branches

### Test Linkage

**How does this test relate to other tests?**

- Prerequisites: Tests that must pass before this test (dependencies)
- Related: Tests that verify related behavior
- Regression: Defect ID this test prevents (if regression test)

**Example**:

- Regression for: DEF-123 "Login fails with special characters in password"

## Automation Metadata

### Test Framework

**What test framework executes this test?**

- Framework: {Jest, Pytest, JUnit, RSpec, etc.}
- Test file: {path to test file}
- Test identifier: {function name, class name, test name}

**Example**:

- Framework: Jest
- File: `tests/unit/auth/AuthService.test.js`
- Test: `describe('AuthService.login') > it('returns session token for valid credentials')`

### Test Doubles

**What components are mocked/stubbed?**

- External APIs (third-party services)
- Database (in-memory or containerized)
- File system
- Time/date (for deterministic testing)

**Example**:

- Redis session store: Dockerized container
- Email service: Mocked (no real emails sent)

### CI/CD Integration

**How does this test integrate with CI pipeline?**

- Pipeline stage: {unit-tests, integration-tests, smoke-tests, regression-tests}
- Execution trigger: {on-commit, on-PR, nightly, on-release}
- Failure action: {block-merge, notify-team, create-issue}

**Example**:

- Stage: unit-tests
- Trigger: on-PR
- Failure: Block merge until fixed

## Maintenance

### Stability

**Test reliability**:

- Pass rate (last 30 days): {percentage}
- Flakiness score: {stable | intermittent | unreliable}
- Last failure: {date and reason}

**Example**:

- Pass rate: 98% (1 failure in 50 runs)
- Flakiness: Stable
- Last failure: 2025-10-10 (timeout due to CI resource contention)

### Review Cadence

**When to review this test**:

- When requirement changes
- When implementation changes significantly
- When test becomes flaky
- Quarterly review (prune obsolete tests)

**Example**: Next review: 2026-01-15 (quarterly)

### Notes

**Additional context**:

- Known limitations
- Special considerations
- Historical context (why this test was added)
- Future improvements

**Example**:

- This test uses a simplified password (no special characters) for readability. Real production passwords must meet complexity requirements validated in TC-SHOP-043.

## Related Templates

- `agentic/code/frameworks/sdlc-complete/templates/test/test-suite-card.md` - Group related test cases
- `agentic/code/frameworks/sdlc-complete/templates/test/defect-card.md` - Track test failures
- `agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-acceptance-template.md` - Acceptance criteria source
- test data fields on the test case card - Test data management (if separate card needed)

## Examples

### Example: Unit Test Card

**ID**: TC-SHOP-101
**Type**: Unit
**Subject**: `ProductService.calculateDiscount(product, coupon)`
**Objective**: Verify discount calculation applies percentage correctly
**Preconditions**: Product with price $100, coupon with 20% discount
**Steps**: Call `calculateDiscount(product, coupon)`
**Expected**: Returns $20 discount, final price $80
**Related**: REQ-210 "Apply coupon discounts to cart total"

### Example: Integration Test Card

**ID**: TC-SHOP-201
**Type**: Integration
**Subject**: Order checkout flow (cart → payment → confirmation)
**Objective**: Verify end-to-end order creation and payment processing
**Preconditions**: Cart with 3 items, payment method configured, inventory available
**Steps**: Submit order → process payment → verify inventory decrement → send confirmation email
**Expected**: Order record created, payment charged, inventory updated, email sent
**Related**: UC-005 "Checkout and payment", REQ-301 "Process credit card payments"

### Example: Acceptance Test Card

**ID**: TC-SHOP-301
**Type**: Acceptance
**Subject**: User can add item to cart and view cart
**Objective**: Verify core shopping experience
**Preconditions**: User logged in, product page displayed
**Steps**: Click "Add to Cart" → Navigate to cart page → Verify item listed
**Expected**: Cart shows item name, price, quantity=1, subtotal correct
**Related**: US-042 "As a shopper, I want to add items to my cart"

## Automation Guidance

### When to Automate

**Automate if**:

- Test runs frequently (on every commit, PR)
- Test is deterministic (same inputs → same outputs)
- Test provides high value (critical path, regression protection)
- Automation cost < manual execution cost (over test lifetime)

**Keep manual if**:

- Test requires human judgment (visual design, usability)
- Test changes frequently (exploratory, experimental)
- Test is one-time or rare (migration validation)
- Automation is too complex or brittle

### Automation Strategy

**Unit tests**: 100% automated (fast, deterministic, high value)
**Integration tests**: 80%+ automated (moderate speed, moderate complexity)
**System/E2E tests**: 50-70% automated (slow, complex, high maintenance)
**Acceptance tests**: Automate critical paths, manual exploratory testing for edge cases
**Performance tests**: 100% automated (requires consistent baseline)
**Security tests**: Automate scans (SAST, DAST), manual penetration testing
**Accessibility tests**: Automate checks (axe, Lighthouse), manual screen reader testing

## Checklist: Test Case Completeness

Before marking test case as "approved", verify:

- [ ] Metadata complete (ID, owner, type, priority, related)
- [ ] Test objective clear and measurable
- [ ] Preconditions specified
- [ ] Test steps detailed (arrange, act, assert)
- [ ] Expected results explicit
- [ ] Pass/fail criteria unambiguous
- [ ] Traceability to requirements established
- [ ] Automation metadata provided (framework, file path)
- [ ] Test reviewed by peer or Test Architect

This test case is ready for implementation when all checklist items are complete.
