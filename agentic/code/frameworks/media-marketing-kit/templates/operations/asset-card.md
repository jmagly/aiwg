# Asset Card

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- **ID**: `AST-{project}-{number}` (e.g., AST-Q1LAUNCH-112)
- **Type**: Creative Asset Tracking Card
- **Status**: Draft | In-Progress | Review | Approved | Published | Archived
- **Owner**: Designer / Video Producer / Creative Lead
- **Contributors**: Creative Director, Motion Graphics, Copywriter, Photographer, Illustrator
- **Reviewers**: Creative Director, Brand Manager, Legal (for licensing, talent releases)
- **Team**: Creative / Design
- **Stakeholders**: Campaign Manager, Content Lead, Social Media Manager
- **Created**: YYYY-MM-DD
- **Last Updated**: YYYY-MM-DD
- **Publish Date**: YYYY-MM-DD
- **Scheduled Date**: YYYY-MM-DD (if scheduled for future use)
- **Priority**: Critical | High | Medium | Low
- **Asset Type**: Image | Video | Audio | Graphic | Illustration | Animation | Template | Document | Interactive
- **Related**:
  - Campaign: `CAM-{id}`
  - Content: `CNT-{id}` (content piece this asset supports)
  - Creative Brief: `CRE-{id}`
  - Brand Guidelines: `BRD-{id}`
  - Social Posts: `SOC-{id1}`, `SOC-{id2}` (where asset is used)
  - Advertising: `ADS-{id}` (if used in paid ads)
  - Reports: `RPT-{id}`

## Marketing-Specific Metadata

- **KPIs**: [Target metrics: views, engagement, click-through rate, shares, conversions driven]
- **Budget**: $[production cost: creative fees, photography, video production, music licensing, talent, etc.]
- **Scope Units**: [Deliverables, responsible roles, review passes, prerequisites, and completion gates]
- **Channel**: [Where asset will be used: website, social, email, paid ads, print, events, etc.]
- **Distribution**: [How asset will be distributed: organic, paid, owned, earned]
- **Audience**: [Target segment/persona]
- **Brand Compliance**: Pending | Approved | Rejected | Exempt
- **Legal Review**: Pending | Approved | Conditional | Exempt (for music licensing, talent releases, trademark usage)
- **Performance**: [Actual metrics vs targets - populated post-publish]

## Asset Overview

### Asset Description

**Asset Name**: [Official asset name]

**Asset Type**: [Specific type]

- [ ] Static Image (JPG, PNG, WebP)
- [ ] Vector Graphic (SVG, AI, EPS)
- [ ] Video (MP4, MOV, WebM)
- [ ] Audio (MP3, WAV)
- [ ] Animation (GIF, Lottie, After Effects)
- [ ] Infographic
- [ ] Illustration
- [ ] Template (Figma, Canva, PowerPoint)
- [ ] Interactive (HTML5, WebGL)
- [ ] 3D Asset
- [ ] Document (PDF, DOCX)
- [ ] Other: [Specify]

**Purpose**: [Why this asset is being created - business objective]

**Primary Use**: [Main use case - hero image, social graphic, ad creative, email header, etc.]

**Additional Uses**: [Secondary use cases - repurpose opportunities]

### Creative Brief Summary

**Creative Concept**: [High-level creative idea or theme]

**Key Message**: [Primary message the asset communicates]

**Visual Style**: [Photography, illustration, minimalist, bold, technical, lifestyle, etc.]

**Tone/Mood**: [Professional, energetic, calm, urgent, playful, serious, etc.]

**Color Palette**: [Primary colors - link to brand guidelines if applicable]

**Typography**: [Font families, hierarchy - link to brand guidelines if applicable]

**Creative Brief**: [Link to full creative brief: CRE-{id}]

## Target Audience

### Primary Audience

**Persona**: [Name/description of primary persona]

**Profile**:

- **Demographics**: [Age, location, income, job title]
- **Psychographics**: [Values, interests, visual preferences]
- **Channel Preferences**: [Where they consume content - Instagram, LinkedIn, email, etc.]

**Visual Preferences**: [What visual style resonates - data-driven, aspirational, relatable, etc.]

**Audience Size**: [Estimated reach]

**Persona Reference**: [Link to detailed persona: AUD-{id}]

### Context and Usage

**Campaign Context**: [How this asset supports campaign - CAM-{id}]

**Content Context**: [Content piece this asset supports - CNT-{id}]

**Placement**: [Where asset appears - hero image, inline graphic, thumbnail, banner, background, etc.]

**Viewing Environment**: [Desktop, mobile, print, large screen/event display, etc.]

## Asset Specifications

### Technical Requirements

**Format**: [File format(s) required]

**Dimensions**: [Size in pixels, inches, aspect ratio]

**File Size**: [Maximum file size - for web performance]

**Resolution**: [DPI/PPI - 72 for web, 300 for print]

**Color Space**: [RGB for digital, CMYK for print]

**Compression**: [Lossless, lossy, quality settings]

### Versions and Variations

| Version | Platform | Dimensions | Format | File Size | Status |
|---------|----------|------------|--------|-----------|--------|
| Hero (desktop) | Website | 1920x1080 | JPG | <500KB | [ ] |
| Hero (mobile) | Website | 750x1334 | JPG | <300KB | [ ] |
| Social (Instagram) | Instagram | 1080x1080 | JPG/PNG | <1MB | [ ] |
| Social (LinkedIn) | LinkedIn | 1200x627 | JPG | <5MB | [ ] |
| Social (Twitter) | Twitter | 1200x675 | JPG | <5MB | [ ] |
| Email header | Email | 600x200 | JPG | <100KB | [ ] |
| Display ad | Google Display | 300x250 | JPG/PNG | <150KB | [ ] |
| Print | Collateral | 8.5x11in | PDF | 300 DPI | [ ] |

**Additional Formats Needed**:

- [ ] [Platform/use] - [specs] - [due date]
- [ ] [Platform/use] - [specs] - [due date]

### Video/Audio Specifications (if applicable)

**Video**:

- **Duration**: [Length in seconds/minutes]
- **Aspect Ratio**: [16:9, 9:16, 1:1, 4:5]
- **Resolution**: [1080p, 4K, etc.]
- **Frame Rate**: [24fps, 30fps, 60fps]
- **Codec**: [H.264, H.265, ProRes, etc.]
- **Audio**: [Stereo, mono, sample rate, bitrate]
- **Captions/Subtitles**: Required | Not Required | [Format - SRT, VTT]

**Audio**:

- **Duration**: [Length]
- **Sample Rate**: [44.1kHz, 48kHz]
- **Bit Depth**: [16-bit, 24-bit]
- **Format**: [MP3, WAV, AAC]
- **Stereo/Mono**: [Stereo | Mono]

## Production Details

### Production Gates

| Milestone | Completion Gate | Owner | Status |
|-----------|------|-------|--------|
| Concept/sketches | [Acceptance checks for Concept/sketches pass] | [name] | [ ] |
| First draft | [Acceptance checks for First draft pass] | [name] | [ ] |
| Internal review | [Acceptance checks for Internal review pass] | [name] | [ ] |
| Revisions | [Acceptance checks for Revisions pass] | [name] | [ ] |
| Brand review | [Acceptance checks for Brand review pass] | [name] | [ ] |
| Legal review (if req) | [Acceptance checks for Legal review (if req) pass] | [name] | [ ] |
| Final approval | [Acceptance checks for Final approval pass] | [name] | [ ] |
| Delivery | [Acceptance checks for Delivery pass] | [name] | [ ] |

### Source Files

**Working Files**: [Location of editable source files - PSD, AI, Figma, AE, Premiere, etc.]

**Final Files**: [Location of final, export-ready files]

**Archive Location**: [Long-term storage location for completed assets]

**File Naming Convention**: [Format - e.g., CAM001-AST112-hero-desktop-v3.jpg]

### Production Budget

**Total Asset Budget**: $[amount]

| Line Item | Cost | Vendor/Person | Notes |
|-----------|------|---------------|-------|
| Design/Creative | $[amount] | [name/agency] | [hours, rate] |
| Photography/Video | $[amount] | [name/agency] | [shoot days, crew] |
| Stock Assets | $[amount] | [platform] | [license type] |
| Music Licensing | $[amount] | [platform/artist] | [license details] |
| Talent/Models | $[amount] | [talent agency] | [usage rights] |
| Post-Production | $[amount] | [editor/studio] | [editing, color, sound] |
| Revisions | $[amount] | [name/agency] | [hourly rate] |
| **TOTAL** | **$[amount]** | | |

### Licensing and Rights

**Stock Assets Used**:

- **Image/Video**: [Source - e.g., Shutterstock, Adobe Stock, Unsplash]
- **License**: [License type - e.g., Standard, Extended, Editorial]
- **License Number**: [ID for tracking]
- **Usage Rights**: [Allowed usage - digital, print, time limit, geographic limit]
- **Attribution Required**: Yes | No | [Details]

**Music/Audio**:

- **Track**: [Title, artist]
- **Source**: [Epidemic Sound, AudioJungle, original composition, etc.]
- **License**: [License type and number]
- **Usage Rights**: [Platforms, duration, exclusivity]

**Talent Releases**:

- **Models/Actors**: [Names]
- **Release Forms**: [Status - signed | pending]
- **Usage Rights**: [Platforms, duration, geographic, exclusivity]

**Trademark/Logo Usage**:

- **Third-Party Logos**: [If using partner/vendor logos]
- **Approval**: [Status - approved by trademark owner]

**Copyright**: [Who owns copyright - company, agency, contractor]

**Usage Duration**: [Perpetual | Time-limited | [End date]]

## Creative Elements

### Visual Composition

**Primary Subjects**: [What/who is featured - product, people, abstract, etc.]

**Background**: [Background style - solid color, gradient, photography, illustration]

**Foreground Elements**: [Text overlays, graphics, logos, CTAs]

**Visual Hierarchy**: [What draws the eye first, second, third]

**White Space**: [Use of negative space for clarity and breathing room]

### Typography (if applicable)

**Headline**: [Text, font family, size, weight, color]

**Subheadline**: [Text, font family, size, weight, color]

**Body Copy**: [Text, font family, size, weight, color]

**CTA**: [Text, font family, size, weight, color, button style]

**Brand Logo**: [Placement, size, version - full color, white, black]

### Copy and Messaging

**Headline**: [Main text on asset]

**Subheadline**: [Supporting text]

**Body Copy**: [Longer copy if applicable]

**Call to Action**: [CTA text - e.g., "Learn More", "Get Started", "Download Now"]

**Disclaimer/Legal Text**: [If required - fine print, disclosures]

**Voiceover Script** (for video/audio):

```
[Full script or key talking points]
```

## Brand Compliance

### Brand Guidelines Check

- [ ] Colors align with brand palette (BRD-{id})
- [ ] Typography uses approved brand fonts
- [ ] Logo usage follows brand guidelines (size, placement, clear space)
- [ ] Visual style aligns with brand identity
- [ ] Tone and messaging align with brand voice
- [ ] CTA style matches brand standards
- [ ] Overall asset feels "on-brand"

**Brand Guidelines Reference**: [Link to brand guidelines: BRD-{id}]

**Off-Brand Elements** (if any - requires justification):

- [Element] - [Reason for deviation]

### Legal and Compliance Check

- [ ] All stock assets properly licensed
- [ ] Music properly licensed
- [ ] Talent releases signed
- [ ] Third-party logos/trademarks approved
- [ ] Product claims substantiated
- [ ] Regulatory disclaimers included (if required)
- [ ] Copyright attribution included (if required)
- [ ] Accessibility requirements met

**Legal Review Required**: Yes | No

**Legal Approval**: [Status] - [Date] - [Reviewer]

## Distribution and Usage

### Primary Channel

**Channel**: [Where asset will be used first - website, Instagram, YouTube, email, etc.]

**Publish Date**: YYYY-MM-DD

**Publish Location**: [Specific URL or platform]

### Additional Channels

| Channel | Platform | Format/Version | Publish Date | Owner | Status |
|---------|----------|----------------|--------------|-------|--------|
| Social | Instagram | 1080x1080 | [date] | [name] | [ ] |
| Social | LinkedIn | 1200x627 | [date] | [name] | [ ] |
| Email | Newsletter | 600x200 | [date] | [name] | [ ] |
| Paid Ads | Google Display | 300x250 | [date] | [name] | [ ] |
| Website | Homepage hero | 1920x1080 | [date] | [name] | [ ] |

### Content Integration

**Content Pieces Using This Asset**:

- CNT-{id}: [Content title] - [Role - featured image, inline graphic, thumbnail]
- CNT-{id}: [Content title] - [Role]

**Social Posts Using This Asset**:

- SOC-{id}: [Platform] - [Date]
- SOC-{id}: [Platform] - [Date]

**Campaigns Using This Asset**:

- CAM-{id}: [Campaign name] - [Role in campaign]

## Success Metrics

### Primary KPIs

**KPI 1**: [Metric - e.g., Click-Through Rate]

- **Target**: [Percentage or number]
- **Baseline**: [Historical average for similar assets]
- **Measurement**: [Tool - Google Analytics, Facebook Ads Manager, etc.]
- **Timeframe**: [First 30 days, campaign duration, etc.]

**KPI 2**: [Metric - e.g., Engagement Rate]

- **Target**: [Percentage or number]
- **Baseline**: [Benchmark]
- **Measurement**: [Tool]
- **Timeframe**: [Period]

**KPI 3**: [Metric - e.g., Conversions Driven]

- **Target**: [Number]
- **Baseline**: [Benchmark]
- **Measurement**: [Tool]
- **Timeframe**: [Period]

### Performance Tracking

| Metric | Target | Actual | Variance | Status |
|--------|--------|--------|----------|--------|
| Views/Impressions | [number] | [TBD] | [TBD] | [ ] |
| Click-through rate | [%] | [TBD] | [TBD] | [ ] |
| Engagement rate | [%] | [TBD] | [TBD] | [ ] |
| Shares | [number] | [TBD] | [TBD] | [ ] |
| Conversions | [number] | [TBD] | [TBD] | [ ] |
| Video completion rate | [%] | [TBD] | [TBD] | [ ] |
| Cost per result | $[amount] | [TBD] | [TBD] | [ ] |

**Analytics Dashboard**: [Link to performance tracking dashboard]

### Asset Performance vs Alternatives

**A/B Testing** (if applicable):

- **Variant A**: [This asset] - [Performance]
- **Variant B**: [Alternative asset: AST-{id}] - [Performance]
- **Winner**: [Which performed better and why]

## Review and Approval

### Review Checklist

**Creative Quality**:

- [ ] Meets creative brief requirements
- [ ] Visual concept executed effectively
- [ ] Composition and layout balanced
- [ ] Typography clear and legible
- [ ] Colors aligned with brand and concept
- [ ] Resolution and quality meet technical specs
- [ ] All versions exported correctly

**Technical**:

- [ ] File formats correct
- [ ] Dimensions/aspect ratios correct
- [ ] File sizes optimized
- [ ] Color space correct (RGB/CMYK)
- [ ] Resolution correct (web/print)
- [ ] Compression settings appropriate
- [ ] File naming convention followed

**Brand/Legal**:

- [ ] Brand guidelines followed
- [ ] Logo usage correct
- [ ] Messaging aligned with brand voice
- [ ] Licensing/rights secured
- [ ] Legal review passed (if required)
- [ ] Accessibility requirements met

### Approval Process

| Reviewer | Role | Review Focus | Status | Date | Comments |
|----------|------|--------------|--------|------|----------|
| [Name] | Creative Director | Creative execution | [ ] | [date] | |
| [Name] | Brand Manager | Brand compliance | [ ] | [date] | |
| [Name] | Legal (if req) | Licensing, claims | [ ] | [date] | |
| [Name] | Campaign Manager | Campaign alignment | [ ] | [date] | |

**Final Approval**: [Name] - [Date]

### Revision History

| Version | Date | Changes Made | Reviewer Feedback | Status |
|---------|------|--------------|-------------------|--------|
| v0.1 | [date] | Initial concept | [feedback] | Draft |
| v0.2 | [date] | [Changes] | [feedback] | Revision |
| v1.0 | [date] | Final approved version | Approved | Final |

## Accessibility

### Image Accessibility

**Alt Text**: [Descriptive alt text for screen readers - describe what's in the image, not "image of..."]

**Long Description** (if complex image): [Extended description for screen readers]

**Text in Image**: [If text is part of image, ensure sufficient color contrast - WCAG 2.1 AA minimum]

### Video/Audio Accessibility

**Captions**: [Status - included | in-progress | N/A]

**Transcript**: [Link to full text transcript]

**Audio Description**: [For video - description of visual elements for visually impaired - included | N/A]

**Sign Language Interpretation**: [If required - included | N/A]

## Repurpose and Reuse

### Successful Elements

**High-Performing Aspects** (post-publish):

- [Element that resonated - e.g., "Color palette drove 30% higher engagement"]
- [Element that resonated]

### Repurpose Opportunities

**Planned Variations**:

- [ ] [New format/use] - [Description] - [Owner] - [Due date]
- [ ] [New format/use] - [Description] - [Owner] - [Due date]

**Examples**:

- Hero image → Social graphics, email header, presentation slide
- Video → Social clips, GIFs, thumbnail images, audio podcast
- Infographic → Blog post, social carousel, presentation slides

**Evergreen Potential**: [Can this asset be reused for future campaigns? - Yes | No | [Conditions]]

## Notes & Attachments

### Conversation Log

Track key decisions and revisions:

- **YYYY-MM-DD**: [Decision - e.g., "Changed background to gradient per brand feedback"]
- **YYYY-MM-DD**: [Decision]
- **YYYY-MM-DD**: [Decision]

### Attachments

- **Creative Brief**: [Link to brief: CRE-{id}]
- **Concept Sketches**: [Links to early concepts]
- **Source Files**: [Links to working files - PSD, AI, Figma, etc.]
- **Final Files**: [Links to deliverable files]
- **Stock Assets**: [Links to stock downloads]
- **Licenses**: [Links to license agreements]
- **Performance Data**: [Link to analytics]

### Open Questions

- [ ] [Question 1] - Assigned: [name] - Due: [date]
- [ ] [Question 2] - Assigned: [name] - Due: [date]
- [x] [Resolved question] - Resolution: [answer] - Date: [date]

## Agent Notes

### For Designer/Creative Lead

- Ensure asset aligns with creative brief and campaign strategy
- Follow brand guidelines rigorously unless approved deviation
- Optimize file sizes for web performance without sacrificing quality
- Plan for variations and multi-platform usage from the start
- Document design decisions for future reference
- Maintain organized source files for easy revisions

### For Creative Director

- Review against creative brief and campaign objectives
- Ensure visual concept is differentiated and compelling
- Validate brand consistency across all campaign assets
- Provide constructive, actionable feedback
- Balance creative excellence with practical constraints
- Approve only when asset meets quality standards

### For Brand Manager

- Verify strict adherence to brand guidelines
- Check logo usage, colors, typography, tone
- Flag any off-brand elements for revision
- Ensure asset strengthens brand perception
- Approve before asset goes to production/publish

### For Legal/Compliance

- Verify all licensing and rights secured
- Check talent releases signed
- Validate product claims are substantiated
- Ensure regulatory disclaimers included
- Approve copyright and trademark usage

### For Campaign Manager

- Ensure asset aligns with campaign timeline
- Coordinate asset with related content and campaigns
- Track asset performance against campaign KPIs
- Identify high-performing assets for additional use
- Document learnings for future asset creation

## Quality Gates

**Asset is Ready for Review When**:

- [ ] Draft meets creative brief requirements
- [ ] All technical specs met (format, dimensions, file size)
- [ ] All required versions created
- [ ] Source files organized and accessible
- [ ] Licensing/rights secured
- [ ] Self-review complete

**Asset is Ready to Publish When**:

- [ ] All reviewers approved
- [ ] Final revisions incorporated
- [ ] Brand compliance verified
- [ ] Legal review passed (if required)
- [ ] All formats exported and tested
- [ ] Accessibility requirements met
- [ ] Files delivered to appropriate channels

## Related Templates

- `/templates/operations/campaign-card.md` - Parent campaign tracking
- `/templates/operations/content-card.md` - Content this asset supports
- `/templates/creative/creative-brief-template.md` - Creative direction
- `/templates/brand/brand-guidelines-template.md` - Brand standards
- `/templates/operations/vendor-brief-template.md` - External vendor coordination

## Version Control

**Version**: 1.0
**Last Updated**: 2025-01-28
**Owner**: Creative Team + Creative Director
**Change History**:

- 2025-01-28: Initial template created (v1.0)
