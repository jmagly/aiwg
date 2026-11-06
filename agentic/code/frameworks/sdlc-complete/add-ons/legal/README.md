# Legal & Regulatory Compliance Add-On

**Category**: Legal
**Applies To**: Projects with legal obligations, contracts, or regulatory requirements
**Mandatory For**: Enterprise sales, government contracts, regulated industries
**Version**: 1.0

## Overview

The Legal add-on extends the core SDLC with requirements, templates, and gate criteria to manage legal obligations, regulatory compliance, contract commitments, and intellectual property.

**Apply this add-on if:**
- You have customer SLA or contract commitments
- You must comply with industry regulations (SOC 2, HIPAA, ISO 27001, PCI DSS)
- You use open source or commercial software requiring license compliance
- You export software/technology internationally
- You need to protect intellectual property
- You have data residency/sovereignty requirements

## What This Add-On Provides

### 1. Legal & Regulatory Requirements
- Regulatory compliance tracking (SOC 2, HIPAA, ISO 27001, PCI DSS, FedRAMP)
- Contract obligation management (SLAs, SOWs, MSAs, DPAs)
- License compliance (OSS and commercial)
- Intellectual property protection
- Export control compliance (ITAR, EAR)
- Data sovereignty and residency
- Legal risk assessment and mitigation

### 2. Templates (9 templates)

Located in `templates/`:

**Regulatory Compliance:**
- `regulatory-compliance-framework-template.md` - SOC 2, HIPAA, ISO 27001, PCI DSS, etc.

**Contract Management:**
- `contract-management-template.md` - Customer contracts, vendor agreements
- `contract-requirements-traceability-matrix.md` - Contract → requirements tracing

**License Compliance:**
- `license-compliance-template.md` - OSS and commercial license tracking

**Risk Assessment:**
- `legal-risk-assessment-template.md` - IP, regulatory, contractual risks

**Export Controls:**
- `export-control-assessment-template.md` - ITAR/EAR compliance

**Data Sovereignty:**
- `data-sovereignty-template.md` - Data residency requirements

**IP Management:**
- `ip-management-template.md` - Patents, trademarks, copyrights, trade secrets

**Approval Workflows:**
- `legal-approval-workflow-template.md` - Legal review SLAs and escalation

### 3. Gate Criteria Additions

**Inception Gate:**
- [ ] Regulatory requirements identified (SOC 2, HIPAA, etc.)
- [ ] Customer contract obligations captured
- [ ] Export control classification initiated
- [ ] IP ownership clarified (employee agreements, contractor IP assignment)

**Elaboration Gate:**
- [ ] Regulatory compliance approach validated
- [ ] Contract requirements traced to system requirements
- [ ] OSS licenses reviewed and approved
- [ ] Legal risks assessed and mitigated
- [ ] Data sovereignty constraints incorporated into architecture

**Construction Gate:**
- [ ] Contract SLA commitments implemented
- [ ] License compliance verified (SBOM generated)
- [ ] Export control classification completed
- [ ] IP properly attributed and assigned
- [ ] Regulatory evidence collected

**Transition Gate:**
- [ ] Regulatory audit passed (or on track)
- [ ] Customer contracts fulfilled (SLA compliance verified)
- [ ] License obligations met (attribution, notices)
- [ ] Legal sign-off obtained
- [ ] Export control documentation complete

## Sub-Add-Ons

The Legal add-on can be further specialized:

### Export Control (`legal/export-control/`)
**Apply if**: International customers, encryption, defense/dual-use technology
**Templates**: ITAR/EAR classification, restricted party screening, country restrictions

### IP Management (`legal/ip-management/`)
**Apply if**: Patents, trademarks, proprietary technology, trade secrets
**Templates**: Patent portfolio, trademark registration, copyright management, NDA tracking

### Contract Compliance (`legal/contract-compliance/`)
**Apply if**: Customer SLAs, vendor dependencies, MSAs
**Templates**: Contract management, SLA tracking, contract-requirements traceability

### License Compliance (`legal/license-compliance/`)
**Apply if**: Using OSS or commercial software
**Templates**: License inventory, compatibility assessment, SBOM integration

### Data Sovereignty (`legal/data-sovereignty/`)
**Apply if**: Multi-region operations, data localization laws
**Templates**: Residency requirements, cloud region selection, transfer mechanisms

## Integration with Core SDLC

### Project Intake
**Add to `project-intake-template.md`:**

```markdown
## Legal & Regulatory Requirements

**Regulatory Compliance:**
- [ ] SOC 2 (SaaS vendors) → Apply `regulatory-compliance-framework`
- [ ] HIPAA (healthcare data) → Apply + HIPAA add-on
- [ ] PCI DSS (payment cards) → Apply + PCI DSS add-on
- [ ] ISO 27001 (information security) → Apply `regulatory-compliance-framework`
- [ ] FedRAMP (US government) → Apply + FedRAMP add-on

**Contract Obligations:**
- [ ] Customer SLAs → Apply `contract-management-template`
- [ ] Vendor dependencies → Apply `contract-management-template`

**License Compliance:**
- [ ] Using OSS → Apply `license-compliance-template`
- [ ] Commercial licenses → Apply `license-compliance-template`

**Export Controls:**
- [ ] International customers → Apply `export-control-assessment`
- [ ] Encryption → Apply `export-control-assessment`

**Data Sovereignty:**
- [ ] Multi-region operations → Apply `data-sovereignty-template`
- [ ] Data localization laws → Apply `data-sovereignty-template`

**IP Protection:**
- [ ] Patents/trademarks → Apply `ip-management-template`
- [ ] Trade secrets → Apply `ip-management-template`
```

### Requirements Template
**Add to requirements templates:**

```markdown
## Contract Obligations (Legal Add-On)

**If customer contracts exist, trace contract commitments to requirements:**

| Contract | Clause | Obligation | Requirement ID |
|----------|--------|------------|----------------|
| CustomerA SLA | 3.1 | 99.9% uptime | NFR-REL-001 |
| CustomerA SLA | 4.2 | Data in EU only | NFR-SEC-012 |
| VendorB MSA | 2.1 | License attribution | REQ-LEGAL-003 |

Use `./templates/contract-requirements-traceability-matrix.md`
```

### Architecture Template
**Add to `software-architecture-doc-template.md`:**

```markdown
## Legal Constraints (Legal Add-On)

**Export Control Constraints:**
- Encryption classification: [ENC] or [ERN] or N/A
- ITAR-controlled technology: Yes/No
- Restricted countries: [List if applicable]

**Data Sovereignty Constraints:**
- Data residency requirements: [EU only, US only, etc.]
- Cross-border transfer mechanisms: [SCCs, adequacy, etc.]
- Cloud region restrictions: [List allowed regions]

**License Constraints:**
- OSS licenses used: [List with compatibility assessment]
- Copyleft obligations: [GPL requires, etc.]
- Commercial license limits: [Seat limits, usage restrictions]
```

## Common Scenarios

### Scenario 1: Enterprise SaaS Product
**Apply:**
- SOC 2 compliance (`regulatory-compliance-framework`)
- Customer SLA management (`contract-management`)
- License compliance (`license-compliance`)
- Legal risk assessment (`legal-risk-assessment`)

### Scenario 2: Healthcare Application
**Apply:**
- HIPAA compliance (HIPAA add-on + `regulatory-compliance-framework`)
- BAA tracking (Business Associate Agreements)
- PHI data sovereignty
- Legal risk assessment (breach liability)

### Scenario 3: Open Source Project
**Apply:**
- License compliance (`license-compliance`)
- IP management (contributor agreements, copyright)
- Export control (if encryption)

### Scenario 4: Government Contract
**Apply:**
- FedRAMP compliance (FedRAMP add-on)
- Export control (`export-control-assessment`)
- Contract compliance (`contract-management`)
- Data sovereignty (US-only)

## Legal + Other Add-Ons

### Legal + GDPR
- Data Processing Agreements (DPAs) link GDPR and contract management
- Data sovereignty overlaps with GDPR cross-border transfers
- Both require legal approval workflows

### Legal + SOC 2
- SOC 2 is a regulatory framework in `regulatory-compliance-framework`
- SOC 2 controls map to legal requirements
- Both require audit evidence collection

### Legal + Technical Add-Ons
- Export control may restrict encryption algorithms (technical constraint)
- License compliance may restrict cloud providers (deployment constraint)
- Data sovereignty may require specific cloud regions (infrastructure constraint)

## Resources

- [SOC 2 Trust Services Criteria](https://www.aicpa.org/interestareas/frc/assuranceadvisoryservices/trustdataintegritytaskforce)
- [HIPAA](https://www.hhs.gov/hipaa/index.html)
- [ISO 27001](https://www.iso.org/isoiec-27001-information-security.html)
- [PCI DSS](https://www.pcisecuritystandards.org/)
- [SPDX License List](https://spdx.org/licenses/)
- [US Export Controls (BIS)](https://www.bis.doc.gov/)

## Version History

- **1.0** (2025-10-15): Initial legal add-on with 9 templates

---

**Maintained By**: Legal Liaison
**Last Reviewed**: 2025-10-15
**Next Review**: 2026-04-15 (or when regulations change)
