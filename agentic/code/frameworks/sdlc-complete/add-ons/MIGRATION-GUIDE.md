# Add-On Architecture Migration Guide

**Date**: 2025-10-15
**Purpose**: Explain the reorganization from embedded compliance/legal templates to modular add-ons

## What Changed

### Before: Mixed Compliance in Core Templates
Previously, privacy/legal templates were embedded in core SDLC directories:
- `docs/sdlc/templates/security/` - Mixed security + GDPR templates
- `docs/sdlc/templates/governance/` - Mixed governance + legal templates

**Problem**: Core SDLC was bloated with context-specific requirements that don't apply to all projects.

### After: Modular Add-On Architecture
Now, compliance and legal templates are organized as optional add-ons:
- `docs/sdlc/add-ons/compliance/gdpr/` - GDPR-specific templates
- `docs/sdlc/add-ons/legal/` - Legal and regulatory templates

**Benefit**: Core SDLC remains simple and universal. Teams apply only relevant add-ons.

## File Relocations

### GDPR Templates (10 files moved)

**From** `docs/sdlc/templates/security/` **To** `docs/sdlc/add-ons/compliance/gdpr/templates/`:

1. `privacy-impact-assessment-template.md`
2. `dpia-trigger-assessment-checklist.md`
3. `consent-management-template.md`
4. `lawful-basis-assessment-template.md`
5. `data-subject-rights-workflow-template.md`
6. `data-retention-deletion-policy-template.md`
7. `cross-border-transfer-assessment-template.md`
8. `privacy-by-design-checklist.md`
9. `data-processing-agreement-template.md`
10. `breach-notification-plan-template.md`

### Legal Templates (9 files moved)

**From** `docs/sdlc/templates/governance/` **To** `docs/sdlc/add-ons/legal/templates/`:

1. `regulatory-compliance-framework-template.md`
2. `contract-management-template.md`
3. `license-compliance-template.md`
4. `legal-risk-assessment-template.md`
5. `export-control-assessment-template.md`
6. `data-sovereignty-template.md`
7. `ip-management-template.md`
8. `legal-approval-workflow-template.md`
9. `contract-requirements-traceability-matrix.md`

### Core Security Templates (Stayed in Place)

These templates remain in `docs/sdlc/templates/security/` because they apply universally:
- `threat-model-template.md` - All projects need threat modeling
- `security-requirements-template.md` - All projects need security requirements
- `security-design-review-checklist.md` - All projects need security reviews
- `data-classification-template.md` - All projects classify data (not just GDPR)

## How to Use the New Structure

### For New Projects

**Step 1**: During project intake, identify applicable add-ons
- Processing EU data? → Apply `add-ons/compliance/gdpr/`
- Customer contracts? → Apply `add-ons/legal/` (contract management)
- Using OSS? → Apply `add-ons/legal/` (license compliance)
- Exporting internationally? → Apply `add-ons/legal/` (export control)

**Step 2**: Read add-on README for integration guidance
- `add-ons/compliance/gdpr/README.md`
- `add-ons/legal/README.md`

**Step 3**: Apply add-on templates as needed throughout SDLC

### For Existing Projects Using Old Paths

**If your project references old paths:**

**Option 1: Update References (Recommended)**
Update your project references to use new add-on paths:
- Old: `<project>/docs/sdlc/templates/security/privacy-impact-assessment-template.md`
- New: `agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/privacy-impact-assessment-template.md`

**Option 2: Symlinks (Temporary Compatibility)**
If you can't update references immediately, create symlinks (Git doesn't support this, so local only):
```bash
ln -s "$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/privacy-impact-assessment-template.md" "$PROJECT_ROOT/docs/sdlc/templates/security/privacy-impact-assessment-template.md"
```

**Option 3: Copy Templates (Not Recommended)**
Copy templates from add-ons to your project-specific directory. This defeats the purpose of modular add-ons but may be necessary for legacy projects.

## Benefits of Add-On Architecture

### 1. Core SDLC Simplicity
Core templates focus on universal processes:
- How to gather requirements (not GDPR-specific DSRs)
- How to design systems (not HIPAA-specific controls)
- How to test (not SOC 2-specific evidence collection)

### 2. Apply Only What's Relevant
- Startup without EU customers? Skip GDPR add-on.
- Open source project? Apply license compliance, skip contract management.
- Government contract? Apply export control, skip CCPA.

### 3. Independent Evolution
- GDPR add-on updates when EU regulations change
- Legal add-on updates when contract law evolves
- Core SDLC remains stable

### 4. Reduced Cognitive Load
- Don't need to understand HIPAA if not in healthcare
- Don't need to understand ITAR if not exporting defense technology
- Focus on add-ons relevant to your project

### 5. Easier to Create Custom Add-Ons
- Company-specific compliance (internal policies)
- Industry-specific requirements (niche regulations)
- Tech stack-specific patterns (React, PostgreSQL)

## Add-On Categories

### Current Add-Ons
1. **Compliance** (`add-ons/compliance/`)
   - `gdpr/` - EU General Data Protection Regulation

2. **Legal** (`add-ons/legal/`)
   - Regulatory, contract, license, IP, export, sovereignty

### Planned Add-Ons
3. **Technical** (`add-ons/technical/`)
   - React patterns, PostgreSQL design, Kubernetes deployment

4. **Architecture** (`add-ons/architecture/`)
   - Microservices, event-driven, serverless, monolith

5. **Industry** (`add-ons/industry/`)
   - Healthcare (HIPAA, FHIR), Finance (PCI DSS, SOX), Government (FedRAMP)

6. **Compliance** (Additional)
   - `ccpa/` - California Consumer Privacy Act
   - `hipaa/` - Health Insurance Portability and Accountability Act
   - `soc2/` - Service Organization Control 2
   - `pci-dss/` - Payment Card Industry Data Security Standard

## Migration Checklist

**If you have existing projects using old template paths:**

- [ ] Inventory which templates your project uses
- [ ] Identify which are now add-ons (GDPR, legal)
- [ ] Update references to new add-on paths
- [ ] Verify templates still render correctly
- [ ] Update project documentation with applicable add-ons
- [ ] Add add-on selection to project intake process

**If you're creating new projects:**

- [ ] Start with core SDLC only
- [ ] During intake, select applicable add-ons
- [ ] Reference add-on templates from the start
- [ ] Document which add-ons apply in project README

## FAQ

### Q: Why not keep everything in core templates?
**A**: Core SDLC would become bloated. Most projects don't need GDPR, HIPAA, export controls, etc. Separating into add-ons keeps core simple.

### Q: Can I use multiple add-ons together?
**A**: Yes! Most projects use several add-ons. Example: GDPR + SOC 2 + License Compliance + Microservices.

### Q: What if add-ons conflict?
**A**: Add-on READMEs document known conflicts and resolutions. Example: GDPR vs CCPA data subject rights → Apply most restrictive.

### Q: Can I create my own add-ons?
**A**: Yes! Copy the structure from existing add-ons. Create company-specific or industry-specific add-ons as needed.

### Q: Do I have to use add-ons?
**A**: No. Add-ons are optional. If you don't process EU data, skip GDPR. If you don't export, skip export control.

### Q: Will old template paths be removed?
**A**: They're already moved (in this commit). Use new add-on paths going forward.

## Timeline

- **2025-10-15**: Add-on architecture introduced, templates reorganized
- **2025-10-15**: GDPR and Legal add-ons created
- **Future**: Additional add-ons (CCPA, HIPAA, SOC 2, technical, architecture, industry)

## Support

**Questions about add-on architecture?**
- Read `docs/sdlc/add-ons/README.md` for full add-on catalog and usage guide
- Read add-on-specific READMEs for integration guidance
- Consult Executive Orchestrator for add-on selection advice

---

**Version**: 1.0
**Last Updated**: 2025-10-15
**Owner**: Executive Orchestrator
