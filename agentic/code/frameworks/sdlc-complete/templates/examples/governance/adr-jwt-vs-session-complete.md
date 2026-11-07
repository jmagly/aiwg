# Architecture Decision Record: JWT vs Server-Side Sessions (Complete Example)

## Document Metadata

**ADR ID**: ADR-003
**Date**: 2026-01-15
**Status**: Accepted
**Authors**: Software Architect, Security Auditor
**Reviewers**: Technical Lead, DevOps Engineer, Security Team
**Supersedes**: None
**Superseded By**: None

---

## Title

Use JWT (JSON Web Tokens) with Server-Side Session Storage for Authentication

---

## Status

**Accepted** (2026-01-20)

**Decision History**:
- 2026-01-15: Proposed
- 2026-01-18: Reviewed by security team
- 2026-01-20: Accepted by architecture review board
- 2026-01-25: Implementation started

---

## Context

Our e-commerce platform requires a secure, scalable authentication mechanism to support user login, session management, and access control for protected resources. We need to make a decision on session management architecture for our microservices-based system.

### Business Drivers

1. **Scale Requirements**: Support 100,000+ concurrent users during peak traffic (Black Friday, product launches)
2. **Security Requirements**: Prevent session hijacking, CSRF attacks, and comply with PCI DSS 3.2.1
3. **User Experience**: Fast authentication (<2s), seamless navigation across services
4. **Cost Constraints**: Minimize infrastructure costs while maintaining performance

### Technical Context

**Current System**:
- Microservices architecture with 12 backend services
- API Gateway (Kong) routing requests to services
- Existing PostgreSQL database for user accounts
- Redis available for caching

**Constraints**:
- Must support both web (SPA) and mobile app clients
- Services deployed across multiple AWS regions (us-east-1, eu-west-1)
- Cannot share session state via database (too slow)
- Must support horizontal scaling of all services

### Forces in Tension

| Force | JWT Favors | Server-Side Sessions Favor |
|-------|------------|---------------------------|
| **Scalability** | ✅ Stateless, no session storage needed | ❌ Requires shared session store (Redis) |
| **Security** | ❌ Cannot revoke tokens before expiry | ✅ Can immediately revoke sessions |
| **Performance** | ✅ No database/cache lookup per request | ❌ Redis lookup on every authenticated request |
| **Simplicity** | ✅ No infrastructure for session storage | ❌ Requires Redis cluster |
| **Token Size** | ❌ Large tokens (~1KB) increase bandwidth | ✅ Small session ID (~32 bytes) |
| **Logout** | ❌ Complex (requires blacklist) | ✅ Simple (delete session) |
| **Multi-Region** | ✅ Works without cross-region state | ❌ Requires replicated session store |

---

## Decision

We will use **JWT (JSON Web Tokens) signed with RS256** for authentication **combined with server-side session storage in Redis** to track active sessions.

### Hybrid Approach

This hybrid approach combines the benefits of both patterns:

1. **JWT as the authentication token** (stateless verification)
2. **Redis session store** to track active sessions (revocation capability)

### Specific Design

**Token Format**:
```json
{
  "header": {
    "alg": "RS256",
    "typ": "JWT"
  },
  "payload": {
    "sub": "user_id_123",
    "email": "alice@example.com",
    "iat": 1706515200,
    "exp": 1706601600,
    "session_id": "sess_abc123",
    "roles": ["customer"]
  },
  "signature": "..."
}
```

**Session Storage** (Redis):
```
Key: session:{session_id}
Value: {user_id, email, ip_address, user_agent, created_at}
TTL: 24 hours (86400 seconds)
```

**Verification Flow**:
1. Service receives request with JWT in `Authorization: Bearer` header or `session_token` cookie
2. Service verifies JWT signature using public key (cached locally)
3. If signature valid, extract `session_id` from JWT payload
4. Check Redis for session existence: `EXISTS session:{session_id}`
5. If session exists, request is authenticated
6. If session missing, reject request (session revoked)

**Session Revocation**:
- Logout: `DEL session:{session_id}` in Redis
- JWT becomes invalid immediately even though signature is still valid

---

## Rationale

### Why This Decision

1. **Performance**: JWT verification is fast (signature check with cached public key), no database/cache query for authentication
2. **Scalability**: Services can verify JWTs independently without central session store query on every request
3. **Security**: Can revoke sessions immediately via Redis deletion (addresses JWT's main weakness)
4. **Simplicity**: Redis is already deployed for caching; reuse existing infrastructure
5. **Cost**: Redis session storage is cheap (32 bytes × 100K users = 3.2MB), minimal cost impact

### Why Not Pure JWT (Stateless Only)

**Rejected because**:
- Cannot immediately revoke sessions on logout, password change, or account compromise
- Would need JWT blacklist, which negates statelessness benefits
- Token size increases with more user claims (1KB+ impacts bandwidth)
- Security team requires immediate revocation capability (PCI DSS control)

### Why Not Pure Server-Side Sessions (Stateful Only)

**Rejected because**:
- Every authenticated request requires Redis query (adds latency)
- Session data grows with user attributes (30-50 bytes vs 1KB JWT)
- Harder to scale horizontally (all services need Redis access)
- More complex multi-region setup (Redis replication complexity)

### Trade-Offs We're Accepting

| Trade-Off | Impact | Mitigation |
|-----------|--------|------------|
| **Complexity** | Two-step verification (JWT + Redis check) | Encapsulate in auth middleware library |
| **Redis Dependency** | Services depend on Redis availability | Redis cluster with replication, circuit breaker on failure |
| **Dual Storage** | Session data in both JWT and Redis | Keep JWT minimal, Redis stores only session metadata |
| **Token Size** | JWT is still ~500 bytes (HTTP overhead) | Use HTTP compression, consider separate mobile token format |

---

## Consequences

### Positive Consequences

✅ **Performance**:
- JWT verification: ~5ms (signature check)
- Redis session check: ~2ms (simple EXISTS query)
- Total: ~7ms authentication overhead per request

✅ **Security**:
- Immediate session revocation on logout (fixes JWT's main weakness)
- Token forgery prevented by RS256 signature
- CSRF protection via `SameSite=Strict` cookies

✅ **Scalability**:
- Services scale horizontally without session affinity
- Redis cluster scales to 1M+ sessions
- Multi-region support via Redis replication

✅ **Developer Experience**:
- Standard JWT libraries available in all languages
- Middleware abstracts complexity
- Easy to test (mock Redis, use test JWTs)

✅ **Monitoring**:
- Track active sessions via Redis key count
- Detect anomalies (sudden session spike = credential stuffing)
- Audit logout events

### Negative Consequences

❌ **Infrastructure Dependency**:
- Services depend on Redis availability
- **Mitigation**: Redis cluster with 99.95% uptime SLA, circuit breaker fallback

❌ **Complexity**:
- Two-step verification adds cognitive load
- **Mitigation**: Auth middleware library hides complexity, comprehensive documentation

❌ **Token Size**:
- JWT ~500 bytes vs session ID ~32 bytes (15x larger)
- **Impact**: 500 bytes × 1M requests/day = 500MB/day extra bandwidth
- **Mitigation**: HTTP compression reduces to ~200 bytes, acceptable cost

❌ **Eventual Consistency**:
- Multi-region Redis replication has ~50ms lag
- **Impact**: Revoked session might be accepted for brief window in other regions
- **Mitigation**: Use regional logout (redirect to home region for logout)

### Operational Impacts

**Infrastructure**:
- Requires Redis cluster (3 nodes minimum for high availability)
- Estimated cost: $150/month (AWS ElastiCache r6g.medium × 3)
- Public/private key pair for JWT signing (rotate quarterly)

**Monitoring**:
- New metrics: jwt_verification_time, session_check_time, active_session_count
- New alerts: redis_session_store_unavailable, jwt_signature_verification_failed

**Deployment**:
- All services must update auth middleware to hybrid verification
- Rollout plan: canary deployment, monitor error rates
- Rollback plan: revert to old session-only middleware

---

## Alternatives Considered

### Alternative 1: Pure JWT (Stateless Only)

**Description**: Use JWT without server-side session storage. Services verify JWT signature only.

**Pros**:
- Simplest architecture (no session store needed)
- Best performance (no Redis query)
- Natural fit for microservices (fully stateless)

**Cons**:
- ❌ **Cannot revoke sessions immediately** (deal-breaker for security team)
- ❌ Logout requires JWT blacklist (negates statelessness)
- ❌ Larger tokens (1KB+) if storing user attributes
- ❌ Token refresh complexity (refresh tokens need storage anyway)

**Why Rejected**: Security requirement for immediate session revocation (PCI DSS 8.1.8) cannot be met.

---

### Alternative 2: Pure Server-Side Sessions (Stateful Only)

**Description**: Traditional session storage in Redis. Client receives opaque session ID (32-byte random string), server looks up full session data on every request.

**Pros**:
- Simple session revocation (delete Redis key)
- Small session IDs (32 bytes)
- Centralized session management

**Cons**:
- ❌ **Redis query on every request** (adds 2-5ms latency)
- ❌ All services tightly coupled to Redis
- ❌ Scaling challenge: Redis becomes single point of contention
- ❌ Multi-region complexity: session replication across regions

**Why Rejected**: Redis query per request adds measurable latency (5ms × 1M requests/day = 1.4 hours of cumulative latency). Performance requirement is <2s for p95 requests; cannot afford 5ms auth overhead.

---

### Alternative 3: OAuth 2.0 + OpenID Connect (OIDC)

**Description**: Delegate authentication to external identity provider (Auth0, Okta, Keycloak).

**Pros**:
- Industry-standard protocol
- Offload authentication complexity
- Built-in MFA, social login, SSO

**Cons**:
- ❌ **Vendor lock-in** (Auth0 pricing scales with MAU)
- ❌ External dependency (Auth0 downtime = our downtime)
- ❌ Cost: $150/month → $1500/month at 100K MAU
- ❌ Latency: External redirect adds 200-500ms

**Why Rejected**: Cost and vendor lock-in. We have competency to build auth in-house. May revisit for enterprise SSO in future.

---

### Alternative 4: Session Cookies Only (Traditional)

**Description**: Server sets encrypted session cookie, no JWT. Cookie contains encrypted session ID.

**Pros**:
- Simple, proven pattern
- Small cookies (~100 bytes encrypted)
- Native browser support

**Cons**:
- ❌ **Mobile app support harder** (cookies work differently on mobile)
- ❌ CSRF vulnerability (requires additional CSRF tokens)
- ❌ Cross-domain complications (API on api.example.com, app on example.com)

**Why Rejected**: Mobile app requires API token pattern (Authorization header), not cookies. Hybrid JWT+cookie approach supports both web and mobile.

---

## Implementation Notes

### Migration Plan

**Phase 1**: Deploy JWT auth middleware (gate: middleware compatibility tests pass)
- Services support both old session-only and new JWT+session
- Feature flag: `jwt_auth_enabled=false` (default)

**Phase 2**: Enable JWT for 5% traffic (gate: prior phase verified)
- Monitor error rates, latency
- Collect feedback

**Phase 3**: Ramp to 100% (gate: middleware compatibility tests pass)
- Gradual rollout: 5% → 25% → 50% → 100%
- Each ramp requires a representative traffic sample with auth error rate <0.1% and auth latency p95 <50ms before proceeding

**Phase 4**: Remove old session-only code (gate: prior phase verified)
- Cleanup, documentation

**Completion Gate**: Four phases verified; legacy code removed only after full-traffic auth checks pass. Roles: auth implementer, security reviewer, test engineer, deployment owner.

### Key Implementation Decisions

**JWT Signing Algorithm**: RS256 (asymmetric)
- Services only need public key (no secret distribution)
- Key rotation easier (rotate private key, publish new public key)

**Token Expiry**: 24 hours
- Balances security (shorter = better) and UX (longer = fewer re-logins)
- Refresh tokens not needed (user re-authenticates after 24h)

**Session Storage Schema**:
```
Key: session:{session_id}
Value: JSON {user_id, email, ip_address, user_agent, created_at, last_active_at}
TTL: 86400 seconds (24 hours)
```

**Auth Middleware Library** (Node.js example):
```typescript
// @$AIWG_ROOT/src/middleware/auth.ts
export async function authenticateRequest(req: Request): Promise<User> {
  const token = extractToken(req); // From header or cookie
  const claims = verifyJWT(token); // Verify signature
  const sessionExists = await redis.exists(`session:${claims.session_id}`);
  if (!sessionExists) {
    throw new UnauthorizedError('Session revoked');
  }
  return { id: claims.sub, email: claims.email };
}
```

### Testing Strategy

**Unit Tests**:
- JWT signature verification
- Session Redis operations
- Token extraction from headers/cookies

**Integration Tests**:
- Full auth flow (login → JWT → verify → logout)
- Session revocation scenarios
- Expired token handling

**Load Tests**:
- 10,000 concurrent authenticated requests
- Target: p95 < 50ms for auth middleware

---

## Security Considerations

### Threat Model

**T1: Token Theft (XSS)**
- **Mitigation**: HttpOnly cookies (JavaScript cannot access)
- **Mitigation**: Content Security Policy (CSP) headers

**T2: Token Theft (Man-in-the-Middle)**
- **Mitigation**: HTTPS only (Strict-Transport-Security header)
- **Mitigation**: Secure cookie attribute (only sent over HTTPS)

**T3: Session Fixation**
- **Mitigation**: Generate new session_id on login (invalidate old session)

**T4: Session Hijacking**
- **Mitigation**: Bind session to IP address (check in Redis)
- **Mitigation**: Short TTL (24 hours)

**T5: CSRF (Cross-Site Request Forgery)**
- **Mitigation**: SameSite=Strict cookie attribute
- **Mitigation**: Check Origin/Referer headers

**T6: Token Replay**
- **Mitigation**: Short TTL (24 hours)
- **Mitigation**: Session revocation on logout

### Compliance

**PCI DSS 3.2.1**:
- ✅ Requirement 8.1.8: "Session timeout after 15 minutes of inactivity"
  - **Our implementation**: Session TTL refreshed on activity, absolute timeout 24 hours
- ✅ Requirement 8.2.1: "Strong cryptography for authentication credentials"
  - **Our implementation**: RS256 (2048-bit RSA keys), bcrypt password hashing

**GDPR**:
- ✅ Article 32: "Appropriate technical measures"
  - **Our implementation**: Encrypted tokens, secure session storage

---

## Monitoring & Observability

### Metrics

```
# Authentication performance
auth.jwt_verification_time (histogram, p50/p95/p99)
auth.session_check_time (histogram, p50/p95/p99)
auth.total_time (histogram, p50/p95/p99)

# Session metrics
auth.active_sessions (gauge)
auth.sessions_created_total (counter)
auth.sessions_revoked_total (counter)

# Error metrics
auth.jwt_signature_invalid_total (counter)
auth.session_not_found_total (counter)
auth.redis_unavailable_total (counter)
```

### Alerts

```yaml
- name: RedisSessionStoreUnavailable
  condition: auth.redis_unavailable_total > 10 in 5m
  severity: critical
  action: Page on-call engineer

- name: HighJWTSignatureFailures
  condition: auth.jwt_signature_invalid_total > 100 in 5m
  severity: warning
  action: Notify security team (possible attack)

- name: AuthLatencyHigh
  condition: auth.total_time p95 > 50ms
  severity: warning
  action: Notify engineering team
```

---

## Future Considerations

### Items Out of Scope (For Now)

1. **Refresh Tokens**: Current design requires re-login after 24 hours. If user feedback demands longer sessions, we'll add refresh tokens (stored in Redis with 30-day TTL).

2. **Multi-Factor Authentication (MFA)**: Not addressed in this ADR. Separate ADR planned for MFA (likely TOTP-based).

3. **OAuth 2.0 / OpenID Connect**: Not implementing external identity providers now. May revisit for enterprise customers needing SSO.

4. **Biometric Authentication**: WebAuthn support for mobile apps. Future enhancement.

5. **Anonymous/Guest Sessions**: Current design requires authentication. Guest checkout may need separate mechanism.

### Review Triggers

This decision should be reviewed if:
- Active session count exceeds 1M (Redis scaling required)
- User complaints about re-login frequency (consider refresh tokens)
- Security audit identifies weaknesses (immediate review)
- New authentication standards emerge (e.g., Passkeys become mainstream)

**Scheduled Review Date**: 2027-01-15 (1 year from acceptance)

---

## References

**Requirements**:
- @.aiwg/requirements/use-cases/UC-AUTH-001-user-authentication.md - User authentication use case
- @.aiwg/requirements/nfr-modules/security.md - Security requirements (PCI DSS, GDPR)
- @.aiwg/requirements/nfr-modules/performance.md - Performance requirements (<2s login)

**Architecture**:
- @.aiwg/architecture/software-architecture-doc.md#authentication-service - Authentication service design
- @.aiwg/architecture/decisions/ADR-005-bcrypt-password-hashing.md - Password hashing decision
- @.aiwg/architecture/diagrams/authentication-flow.md - Authentication flow diagram

**Security**:
- @.aiwg/security/threat-models/authentication-threat-model.md - Authentication threat model
- @.aiwg/security/controls/CTRL-002-session-management.md - Session management control

**Implementation**:
- @$AIWG_ROOT/src/auth/JWTService.ts - JWT generation and verification
- @$AIWG_ROOT/src/auth/SessionManager.ts - Redis session storage
- @$AIWG_ROOT/src/middleware/AuthMiddleware.ts - Authentication middleware

**Research**:
- [RFC 7519 - JSON Web Token (JWT)](https://tools.ietf.org/html/rfc7519)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Auth0: JWT vs Server-Side Sessions](https://auth0.com/blog/stateless-auth-for-stateful-minds/)

**Standards**:
- PCI DSS 3.2.1 - Payment Card Industry Data Security Standard
- GDPR Article 32 - Security of processing

---

## Why This Example is Effective

### Comprehensive Context
- Explains business drivers, technical constraints, and forces in tension
- Shows we understood the problem space deeply before deciding

### Rigorous Alternative Analysis
- 4 alternatives considered with specific pros/cons
- Clear rejection rationale for each alternative
- Shows we didn't jump to first solution

### Concrete Consequences
- Quantified impacts: 500MB/day bandwidth, $150/month cost, 7ms latency
- Specific monitoring, deployment, and operational plans
- Both positive and negative consequences documented honestly

### Actionable Implementation
- Migration plan with four sequential phases and measurable rollout gates
- Code examples showing actual implementation
- Testing strategy covering unit, integration, load tests

### Security Rigor
- Threat model with 6 specific threats and mitigations
- Compliance mapping (PCI DSS, GDPR)
- Consideration of attack vectors (XSS, MITM, CSRF, etc.)

### Future-Aware
- Explicit items out of scope with rationale
- Review triggers and scheduled review date
- Acknowledged what we don't know yet

---

## Anti-Patterns to Avoid

### ❌ Decision Without Context
**Bad**: "We're using JWT because it's modern."
**Good**: "JWT addresses scalability (stateless) but we need session storage for revocation (security requirement)."

### ❌ No Alternatives Considered
**Bad**: Only explaining chosen solution
**Good**: 4 alternatives analyzed, each with rejection rationale

### ❌ Vague Consequences
**Bad**: "This will improve performance."
**Good**: "JWT verification: ~5ms, Redis check: ~2ms, total: ~7ms per request (quantified performance impact)."

### ❌ Missing Trade-Offs
**Bad**: Only listing benefits
**Good**: "We accept 15x larger tokens (500 bytes vs 32) for immediate revocation capability."

### ❌ No Implementation Guidance
**Bad**: Stopping at high-level decision
**Good**: Code examples, migration plan, testing strategy, monitoring setup

---

**ADR Version**: 1.0
**Template Version**: 1.0
**Example Author**: Software Architect
**Last Updated**: 2026-01-28
**Quality Review**: Passed (Security Auditor, Technical Lead)
