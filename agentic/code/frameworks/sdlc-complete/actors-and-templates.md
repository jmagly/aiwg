# Lifecycle Actors & Template Suite

## Purpose

Provide PLAN → ACT agents with a ready catalogue of lifecycle roles and artifact templates. Use this document to assign
responsibilities, seed prompts, and ensure every discipline produces the expected work products.

## Core Workers and Responsibilities

| Lifecycle Worker | Key Responsibilities | Primary Artifacts | Repository Template | Agent Definition |
| --- | --- | --- | --- | --- |
| Business Process Analyst | Capture business context, processes, and actors | Vision, business use-case/assets, organizational assessments | `agentic/code/frameworks/sdlc-complete/templates/business-modeling/business-vision-template.md`, `agentic/code/frameworks/sdlc-complete/templates/business-modeling/supplementary-business-spec-template.md`, `agentic/code/frameworks/sdlc-complete/templates/business-modeling/business-use-case-spec-template.md`, `agentic/code/frameworks/sdlc-complete/templates/business-modeling/business-use-case-realization-template.md`, `agentic/code/frameworks/sdlc-complete/templates/business-modeling/business-glossary-template.md`, `agentic/code/frameworks/sdlc-complete/templates/business-modeling/business-rules-template.md`, `agentic/code/frameworks/sdlc-complete/templates/business-modeling/target-organization-assessment-template.md` | `docs/agents/business-process-analyst.md` |
| System Analyst | Elaborate system requirements and maintain traceability | Use-case specs, supplementary/SRS artifacts, req management assets | `agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-spec-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-spec-informal-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/supplementary-spec-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/requirements-management-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/srs-traditional-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/srs-use-case-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/stakeholder-requests-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/glossary-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/context-free-interview-template.md` | `docs/agents/system-analyst.md` |
| Requirements Reviewer | Validate coverage and prioritize scope with stakeholders | Vision, risk list, iteration plan inputs | `agentic/code/frameworks/sdlc-complete/templates/requirements/vision-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/vision-informal-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/risk-list-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-informal-template.md` | `docs/agents/requirements-reviewer.md` |
| Software Architect | Define architecture, non-functional strategies, system decomposition | Architecture docs, realizations, SRS views | `agentic/code/frameworks/sdlc-complete/templates/analysis-design/software-architecture-doc-template.md`, `agentic/code/frameworks/sdlc-complete/templates/analysis-design/use-case-realization-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/srs-traditional-template.md`, `agentic/code/frameworks/sdlc-complete/templates/requirements/srs-use-case-template.md` | `docs/agents/architecture-designer.md` |
| Designer | Refine component design, update models, prepare for implementation | Detailed design models, component guidelines | `agentic/code/frameworks/sdlc-complete/templates/analysis-design/use-case-realization-template.md`, `agentic/code/frameworks/sdlc-complete/templates/environments/design-guidelines-template.md` | `docs/agents/product-designer.md` |
| Implementer | Build components, unit tests, integrate builds | Integration plan, coding standards, implementation notes | `agentic/code/frameworks/sdlc-complete/templates/implementation/integration-build-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/environments/programming-guidelines-template.md` | `docs/agents/software-implementer.md` |
| Integrator | Manage builds, resolve integration issues, package releases | Build plans, BOM, release inventories | `agentic/code/frameworks/sdlc-complete/templates/implementation/integration-build-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/deployment/bill-of-materials-template.md` | `docs/agents/integration-engineer.md` |
| Test Architect | Define test strategy, plan suites, ensure coverage | Test strategy, master plan, metrics, QA alignment | `agentic/code/frameworks/sdlc-complete/templates/test/test-strategy-template.md`, `agentic/code/frameworks/sdlc-complete/templates/test/master-test-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/measurement-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/quality-assurance-plan-template.md` | `docs/agents/test-architect.md` |
| Test Engineer | Design and execute test cases, log defects | Iteration test plans, evaluation summaries, defect evidence | `agentic/code/frameworks/sdlc-complete/templates/test/iteration-test-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/test/test-evaluation-summary-template.md` | `docs/agents/test-engineer.md` |
| Deployment Manager | Coordinate release activities, rollout, and training | Deployment collateral, release notes, acceptance/support materials | `agentic/code/frameworks/sdlc-complete/templates/deployment/deployment-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/deployment/release-notes-template.md`, `agentic/code/frameworks/sdlc-complete/templates/deployment/product-acceptance-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/deployment/support-runbook-template.md`, `agentic/code/frameworks/sdlc-complete/templates/deployment/bill-of-materials-template.md` | `docs/agents/deployment-manager.md` |
| Configuration Manager | Baseline artifacts, manage change requests, automate builds | CM plan, problem resolution, baselines | `agentic/code/frameworks/sdlc-complete/templates/configuration/configuration-management-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/configuration/problem-resolution-plan-template.md` | `docs/agents/configuration-manager.md` |
| Project Manager | Plan iterations, track metrics, manage risks | SDP, iteration plans, assessments, risk/quality management, business case | `agentic/code/frameworks/sdlc-complete/templates/management/software-development-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-informal-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/iteration-assessment-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/status-assessment-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/risk-list-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/risk-management-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/measurement-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/business-case-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/business-case-informal-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/quality-assurance-plan-template.md`, `agentic/code/frameworks/sdlc-complete/templates/management/development-organization-assessment-template.md` | `docs/agents/project-manager.md` |
| Environment Engineer | Tailor process assets, guidelines, toolchain | Development case, discipline guidelines | `agentic/code/frameworks/sdlc-complete/templates/environments/development-case-template.md`, `agentic/code/frameworks/sdlc-complete/templates/environments/business-modeling-guidelines-template.md`, `agentic/code/frameworks/sdlc-complete/templates/environments/use-case-modeling-guidelines-template.md`, `agentic/code/frameworks/sdlc-complete/templates/environments/design-guidelines-template.md`, `agentic/code/frameworks/sdlc-complete/templates/environments/programming-guidelines-template.md`, `agentic/code/frameworks/sdlc-complete/templates/environments/test-guidelines-template.md` | `docs/agents/environment-engineer.md` |

## Template Index by Discipline

- **Business Modeling**: `business-vision-template.md`, `supplementary-business-spec-template.md`,
  `business-use-case-spec-template.md`, `business-use-case-realization-template.md`,
  `business-architecture-doc-template.md`, `business-glossary-template.md`, `business-rules-template.md`,
  `target-organization-assessment-template.md`.
- **Requirements**: `vision-template.md`, `vision-informal-template.md`, `use-case-spec-template.md`,
  `use-case-spec-informal-template.md`, `supplementary-spec-template.md`, `requirements-management-plan-template.md`,
  `srs-traditional-template.md`, `srs-use-case-template.md`, `stakeholder-requests-template.md`, `glossary-template.md`,
  `context-free-interview-template.md`.
- **Architecture & Design**: `software-architecture-doc-template.md`, `use-case-realization-template.md`.
- **Implementation**: `integration-build-plan-template.md`.
- **Test**: `master-test-plan-template.md`, `iteration-test-plan-template.md`, `test-strategy-template.md`,
  `test-evaluation-summary-template.md`.
- **Deployment (Production)**: `bill-of-materials-template.md`, `deployment-plan-template.md`,
  `release-notes-template.md`, `product-acceptance-plan-template.md`, `support-runbook-template.md`.
- **Management & Measurement**: `software-development-plan-template.md`, `iteration-plan-template.md`,
  `iteration-plan-informal-template.md`, `iteration-assessment-template.md`, `status-assessment-template.md`,
  `risk-management-plan-template.md`, `risk-list-template.md`, `measurement-plan-template.md`,
  `quality-assurance-plan-template.md`, `business-case-template.md`, `business-case-informal-template.md`,
  `development-organization-assessment-template.md`.
- **Configuration & Change Management**: `configuration-management-plan-template.md`,
  `problem-resolution-plan-template.md`.
- **Environment & Process Assets**: `development-case-template.md`, `business-modeling-guidelines-template.md`,
  `use-case-modeling-guidelines-template.md`, `design-guidelines-template.md`, `programming-guidelines-template.md`,
  `test-guidelines-template.md`.

## Usage Guidance

1. **Assign Roles**: Map each active agent to one or more workers above. Maintain a responsibility matrix
   (`docs/sdlc/artifacts/raci.md`).
2. **Pick Templates**: For every planned artifact, start from the listed template name. When the original format is
   required (Word, FrameMaker, SoDA), capture the content structure in Markdown to keep this repository portable.
3. **Tailor Per Phase**:
   - Inception emphasizes Business Modeling, Requirements, Project Management templates.
   - Elaboration adds Architecture, Configuration, Environment templates to lock the baseline.
   - Construction cycles through Implementation, Test, Management templates each iteration.
   - Transition activates Deployment and Support templates alongside closing Test evidence.
4. **Traceability**: Link each template instance to use cases and risks in the traceability matrix to maintain coverage
   across disciplines.

## Prompt Starters

- **Worker Briefing**: “As the `<worker>`, use the `<template>` structure to produce the artifact for ``use case or
  feature``. Confirm dependencies from the latest iteration plan before drafting.”
- **Template Tailoring**: “Review the standard sections in `<template>`. Indicate which sections are not applicable and
  justify omissions. Add project-specific sections where risks or compliance requirements demand it.”
- **Quality Gate**: “Validate that the `<template>` delivered for `<phase>` satisfies the exit criteria listed in the
  Plan-Act Lifecycle Script. Flag gaps and propose corrective tasks.”

Keep this catalogue synchronized with updates to `docs/sdlc/plan-act-sdlc.md` and expand it whenever new templates or
roles are introduced.

## Strategic & Supporting Roles

| Role | Primary Focus | Key Artifacts | Agent Definition |
| --- | --- | --- | --- |
| Product Strategist | Shape product outcomes, positioning, and success metrics | Business vision, opportunity assessments | `docs/agents/product-strategist.md` |
| Vision Owner | Maintain cohesive product vision and decisions | Vision documents, alignment notes | `docs/agents/vision-owner.md` |
| Domain Expert | Provide subject matter expertise and compliance insight | Business rules, glossary, supplementary specs | `docs/agents/domain-expert.md` |
| UX Lead | Govern user experience standards and research | Design guidelines, usability findings | `docs/agents/ux-lead.md` |
| Legal Liaison | Ensure regulatory and contractual compliance | Supplementary specs, deployment/support plans | `docs/agents/legal-liaison.md` |
| Component Owner | Own technical health of specific modules | Component roadmaps, runbooks | `docs/agents/component-owner.md` |
| Build Engineer | Maintain CI pipeline performance and reliability | Build scripts, CI configs, dashboards | `docs/agents/build-engineer.md` |
| Support Lead | Prepare support teams and manage incident readiness | Support runbooks, FAQs, incident logs | `docs/agents/support-lead.md` |
| Toolsmith | Deliver internal tooling and automation | Tooling scripts, documentation | `docs/agents/toolsmith.md` |
| Metrics Analyst | Define and interpret delivery/product metrics | Measurement plan, dashboards | `docs/agents/metrics-analyst.md` |
