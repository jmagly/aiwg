// Guard scope-based planning fields and their worked examples in shipped templates.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { missingTemplateSections } from '../../../src/delivery/template-sections.js';

const templates = new URL('../../../agentic/code/frameworks/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, templates), 'utf8');

const sdlc = [
  ['configuration/flow-command-parameters-template.md', '**Scope Units**', /Typical Duration|estimated time|target timeline|Adjust timeline/i],
  ['deployment/deployment-plan-template.md', '**Deployment Gates**', /expected duration|Timeline with milestones/i],
  ['governance/adr-template.md', '**Implementation Gates**', /\(Week \d|\*\*Timeline\*\*|Implementation start:|months training/i],
  ['examples/governance/adr-jwt-vs-session-complete.md', '**Completion Gate**', /\(\d weeks?\)|Total Timeline|waits 3 days|timeline \(6 weeks/i],
  ['flow-patterns/requirements-sop-example.md', '### 3. Prerequisite Gates', /estimated_duration|Expected Timeline|Total Elapsed|review: 2-3 days/i],
  ['intake/option-matrix-template.md', '**Operator commitments**', /___ weeks\/months|3 months:|6 months:|12 months:|6 months to major refactor/i],
  ['management/epic-card.md', '## Scope and Delivery Gates', /Estimated Duration|Estimated Effort|Estimated Time Remaining|% Complete|\(Week \d|additional sprint|person-months/i],
  ['management/work-package-card.md', '## Delivery Gates', /## Timeline|Start\/end|\/ due /i],
  ['test/regression-report.md', '**Completion Gate**', /\*\*Timeline\*\*|Recommendations have assigned owners and timelines/i],
] as const;

describe('scope-based SDLC planning templates (#3957)', () => {
  it.each(sdlc)('%s converts planning fields and examples', (path, required, forbidden) => {
    const body = read(`sdlc-complete/templates/${path}`);
    expect(body).toContain(required);
    expect(body).not.toMatch(forbidden);
  });

  it.each(['management/epic-card.md', 'management/work-package-card.md'])(
    '%s still validates required sections', path => {
      const body = read(`sdlc-complete/templates/${path}`);
      expect(missingTemplateSections(body, body)).toEqual([]);
      const heading = body.match(/^## (?:Scope and Delivery Gates|Delivery Gates)$/m)![0];
      expect(missingTemplateSections(body.replace(heading, ''), body)).toEqual([heading.slice(3)]);
    });

  it('retains measured service timings and observed regression chronology', () => {
    expect(read('sdlc-complete/templates/deployment/deployment-plan-template.md')).toContain('startup time measurement');
    expect(read('sdlc-complete/templates/test/regression-report.md')).toContain('Mean Time to Detect');
    expect(read('sdlc-complete/templates/examples/governance/adr-jwt-vs-session-complete.md')).toContain('**Token Expiry**: 24 hours');
  });
});

describe('research and investigation planning templates (#3957)', () => {
  it('pairs research proposals and example milestones with evidence gates', () => {
    const body = read('research-complete/templates/gap-report.md');
    expect(body).toContain('Scope and evidence gate:');
    expect(body).toContain('| Metric | Current | Target | Completion Gate |');
    expect(body).not.toMatch(/Timeline|Short-Term \(0-6 months\)|Medium-Term \(6-12 months\)|Long-Term \(12-24 months\)|Q[1-4] 202[67]/i);
    expect(body).toContain('resolution time');
  });

  it('plans investigation phases and reporting by scope while retaining event chronology', () => {
    const body = read('forensics-complete/templates/investigation-plan.md');
    expect(body).toContain('| Phase | Description | Scope Units | Status | Completion Gate |');
    expect(body).toContain('| Deliverable | Format | Recipient | Handoff Gate |');
    expect(body).not.toMatch(/Est\. Time|est_triage|due_date|Due Date|retrospective calibration/);
    expect(body).toContain('Investigation Start Time');
    expect(body).toContain('Build chronological event timeline');
  });
});

const marketing = [
  ['card-metadata-standard.md', '- Scope Units:'],
  ['intake/campaign-intake-template.md', '## 2. Scope and Gates'],
  ['intake/project-scope-template.md', '## 3. Scope and Gates'],
  ['intake/audience-profile-template.md', '**Decision Timeline**'],
  ['operations/agency-brief-template.md', '## 6. Scope and Gates'],
  ['operations/vendor-brief-template.md', '## 4. Scope and Gates'],
  ['operations/asset-card.md', '### Production Gates'],
  ['operations/content-card.md', '**Scope Units**'],
  ['operations/campaign-card.md', '## Scope and Gates'],
  ['operations/budget-tracker-template.md', '**Campaign Timeline**'],
  ['creative/asset-request-template.md', '### Scope Units and Passes'],
  ['creative/creative-brief-template.md', '## Scope and Gates'],
  ['creative/photography-brief-template.md', '| Stage | Who Selects | Completion Gate |'],
  ['creative/video-production-brief-template.md', '| Stage | Reviewers | Completion Gate |'],
  ['advertising/ad-campaign-brief-template.md', '### Scope and Gates'],
  ['advertising/ppc-audit-template.md', '| Completion Gate |'],
  ['analytics/attribution-model-template.md', '- Scope Units:'],
  ['analytics/kpi-dashboard-spec-template.md', '- Scope Units:'],
  ['analytics/measurement-plan-template.md', '- Scope Units:'],
  ['analytics/competitive-tracking-template.md', '- Scope Units:'],
  ['analytics/campaign-report-template.md', '- Observed Campaign Window:'],
  ['analytics/monthly-report-template.md', '- Observed Reporting Window:'],
  ['governance/content-audit-template.md', '### 1.4 Audit Gates'],
  ['governance/legal-review-checklist-template.md', '**Review Scope**'],
  ['governance/approval-workflow-template.md', '**Required Approval Gates**'],
  ['events/event-planning-template.md', '### Promotional Gates'],
  ['events/event-sponsorship-template.md', '| Activity | Completion Gate | Owner |'],
  ['events/tradeshow-playbook-template.md', '### Promotion Gates'],
  ['events/webinar-brief-template.md', '### Promotional Gates'],
  ['product-marketing/feature-release-brief-template.md', '### Scope and Gates'],
  ['product-marketing/product-launch-plan-template.md', '### Scope and Gates'],
  ['sales-enablement/proposal-template.md', '### Project Gates'],
  ['sales-enablement/sales-deck-template.md', '| Completion Gate |'],
  ['sales-enablement/sales-playbook-template.md', '| Stage | Definition | Exit Criteria | Scope Units |'],
  ['sales-enablement/roi-calculator-template.md', '| Timeline | Bar chart | Value over 3 years |'],
  ['social/influencer-brief-template.md', '### Scope and Gates'],
  ['social/ugc-brief-template.md', '### Scope and Gates'],
  ['strategy/content-calendar-template.md', '**Planning basis**'],
  ['strategy/audience-segmentation-template.md', '**Decision Timeline**'],
  ['pr-communications/press-briefing-template.md', '**Implementation gates**'],
  ['pr-communications/media-kit-template.md', '### Key Milestones'],
  ['pr-communications/crisis-response-plan-template.md', '## Timeline of Events'],
] as const;

describe('marketing scope fields and supplied constraints (#3957)', () => {
  it.each(marketing)('%s separates work planning from dates and measurements', (path, field) => {
    const body = read(`media-marketing-kit/templates/${path}`);
    expect(body).toContain(field);
    expect(body).toContain('**Planning basis**');
    expect(body).toContain('operator-supplied');
    expect(body).not.toMatch(/Estimated Hours|duration_weeks|Total Estimated Approval Time|\{Weeks\}|\{Hours\}|\[X hours\/weeks\]|Total Duration\*\*: \[(?:Number of weeks|Weeks\/months)\]/i);
    const heading = body.match(/^## (.+)$/m)!;
    expect(missingTemplateSections(body, body)).toEqual([]);
    expect(missingTemplateSections(body.replace(heading[0], ''), body)).toContain(heading[1]);
  });

  it('converts card metadata examples as well as the blank header', () => {
    const body = read('media-marketing-kit/templates/card-metadata-standard.md');
    expect(body.match(/^- Scope Units:/gm)).toHaveLength(7);
    expect(body).not.toMatch(/^- Timeline:/m);
    expect(body).toContain('Operator Commitments:');
    expect(body).toContain('Observed Campaign Window:');
  });

  it('keeps production gates concrete in the briefs and cards', () => {
    for (const path of ['creative/asset-request-template.md', 'creative/creative-brief-template.md',
      'operations/asset-card.md', 'operations/campaign-card.md']) {
      const body = read(`media-marketing-kit/templates/${path}`);
      expect(body).toMatch(/Completion Gate|Acceptance Gate/);
      expect(body).not.toMatch(/\| (?:Milestone|Phase|Stage) \| (?:Date|Start Date) \|/);
    }
  });

  it.each([
    ['operations/agency-brief-template.md', /within \[X\] (?:business )?days|\[Deadline\]|Time Allocation/],
    ['operations/vendor-brief-template.md', /implements revisions within \[timeframe\]|impact assessment \(time, cost\)/],
    ['operations/content-card.md', /Immediate \(Day 1-7\)|Ongoing \(Week 2-4\)|Long-Term \(30\+ days\)/],
    ['analytics/measurement-plan-template.md', /implement within|\(Weeks \d/],
    ['analytics/competitive-tracking-template.md', /Next 30 Days|90-Day Strategic|Initiatives \(6-12 Months\)/],
    ['pr-communications/crisis-response-plan-template.md', /Resolution timeline|Recovery \((?:Days|Weeks|Months)/],
  ] as const)('%s also converts secondary planning sections', (path, forbidden) => {
    expect(read(`media-marketing-kit/templates/${path}`)).not.toMatch(forbidden);
  });
});
