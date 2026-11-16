---
namespace: aiwg
name: security-audit
platforms: [all]
description: Perform comprehensive security assessment
commandHint:
  category: security-quality
---

# Security Audit Command

Perform comprehensive security assessment

## Output template

Required for each human-readable security finding: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/security-finding.md. Fill every required section; explain non-applicable fields and unrun checks.

## Instructions

Perform a systematic security audit following these steps:

1. **Environment Setup**
   - Identify the technology stack and framework
   - Check for existing security tools and configurations
   - Review deployment and infrastructure setup

2. **Dependency Security**
   - Scan all dependencies for known vulnerabilities
   - Check for outdated packages with security issues
   - Review dependency sources and integrity
   - Use appropriate tools: `npm audit`, `pip check`, `cargo audit`, etc.

3. **Authentication & Authorization**
   - Review authentication mechanisms and implementation
   - Check for proper session management
   - Verify authorization controls and access restrictions
   - Examine password policies and storage

4. **Input Validation & Sanitization**
   - Check all user input validation and sanitization
   - Look for SQL injection vulnerabilities
   - Identify potential XSS (Cross-Site Scripting) issues
   - Review file upload security and validation

5. **Data Protection**
   - Identify sensitive data handling practices
   - Check encryption implementation for data at rest and in transit
   - Review data masking and anonymization practices
   - Verify secure communication protocols (HTTPS, TLS)

6. **Secrets Management**
   - Scan for hardcoded secrets, API keys, and passwords
   - Check for proper secrets management practices
   - Review environment variable security
   - Identify exposed configuration files

7. **Error Handling & Logging**
   - Review error messages for information disclosure
   - Check logging practices for security events
   - Verify sensitive data is not logged
   - Assess error handling robustness

8. **Infrastructure Security**
   - Review containerization security (Docker, etc.)
   - Check CI/CD pipeline security
   - Examine cloud configuration and permissions
   - Assess network security configurations

9. **Security Headers & CORS**
   - Check security headers implementation
   - Review CORS configuration
   - Verify CSP (Content Security Policy) settings
   - Examine cookie security attributes

10. **Reporting**
    - Document all findings with severity levels (Critical, High, Medium, Low)
    - Provide specific remediation steps for each issue
    - Include code examples and file references
    - Create an executive summary with key recommendations

Use automated security scanning tools when available and provide manual review for complex security patterns.

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Identify technology stack and existing security controls before scanning
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Report findings with severity levels; await owner authorization before attempting remediation
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/token-security.md — Token security rules that this audit checks for violations
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/security-gate/SKILL.md — Security gate that consumes this audit's findings to produce a pass/fail decision
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/anti-laziness.md — Never reduce audit scope or skip vulnerability categories to complete faster
