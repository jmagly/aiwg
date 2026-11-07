# Media Kit Template

> **Planning basis**: Plan work in scope units, roles, passes, and completion gates. Dates are operator-supplied commitments with a source (leave unset if unknown), or observed chronology; customer/event dates, media lengths, service timings, and measurement windows are separate from work estimates. See [Card Metadata Standard](../card-metadata-standard.md).

## Metadata

- ID: PRS-002
- Owner: PR Manager (agents/pr-manager.md)
- Contributors: Brand Manager (agents/brand-manager.md), Content Strategist (agents/content-strategist.md), Designer (agents/designer.md)
- Reviewers: Executive Orchestrator (agents/executive-orchestrator.md)
- Team: `team`
- Status: `draft/active/archived`
- Dates: created `YYYY-MM-DD` / updated `YYYY-MM-DD` / next-review `YYYY-MM-DD`
- Related: BRA-`id`, PRS-`id`, SOC-`id`
- Links: `newsroom-url`, `cdn-url`, `download-package-url`

## Purpose

Comprehensive evergreen resource for journalists, analysts, and media professionals conducting background research, preparing feature articles, or seeking brand assets. Hosted as web-first experience with self-service asset downloads, optimized for mobile access and WCAG 2.1 AA compliance.

## Media Kit vs Press Kit vs Brand Kit

### Media Kit (This Template)
- **Purpose**: Ongoing journalist/analyst resource
- **Lifespan**: Evergreen with quarterly updates
- **Audience**: Media, analysts, researchers
- **Contents**: Company overview, leadership, press releases, assets, coverage
- **Format**: Web (newsroom) + PDF backup

### Press Kit (PRS-001)
- **Purpose**: Time-sensitive announcement
- **Lifespan**: Event/announcement-specific
- **Audience**: Media covering specific news
- **Contents**: Press release, event assets, supporting docs
- **Format**: ZIP file or email attachment

### Brand Kit (BRA-001)
- **Purpose**: Visual identity consistency
- **Lifespan**: Evergreen with annual updates
- **Audience**: Partners, agencies, vendors, internal teams
- **Contents**: Logos, colors, fonts, brand guidelines
- **Format**: Brand portal + PDF style guide

## Core Components

### 1. Company Overview

**Content Requirements**:
- Company name (with pronunciation guide if non-obvious)
- Legal entity name (if different from brand)
- Founding date and origin story
- Headquarters location(s)
- Number of employees (range acceptable: "500-1000")
- Industry/sector classification
- Primary products/services (3-5 bullet points)
- Target customer/market segments
- Geographic presence (markets/countries served)
- Key differentiators (2-3 unique value propositions)
- Mission/vision statement
- Current significant milestones or achievements

**Format Variations**:
- **Elevator Pitch** (50-75 words): Press release boilerplate
- **Medium Overview** (150-200 words): Media kit homepage
- **Detailed Backgrounder** (300-500 words): Deep-dive section

**Example Structure**:
```markdown
## About [Company Name]

### At a Glance
- **Founded**: [Year] in [City]
- **Headquarters**: [City, State/Country]
- **Employees**: [Number/Range]
- **Markets**: [Regions served]
- **Customers**: [Number] [type of customers]
- **Website**: [URL]

### What We Do
[150-200 word description of company mission, products/services, market position, and impact]

### Key Milestones
- [Year]: [Major achievement]
- [Year]: [Major achievement]
- [Year]: [Major achievement]

### Download Company Fact Sheet
[PDF button - one-page quick reference]
```

**Accessibility Requirements**:
- Clear heading hierarchy (H2 → H3)
- Bullet lists for scannable information
- Descriptive link text ("Download company fact sheet" not "download")

### 2. Executive Leadership Bios

**Required Elements Per Executive**:
- Full name and pronunciation (if non-obvious)
- Current title and role start date
- Professional headshot (multiple formats/orientations)
- Short bio (100-150 words)
- Long bio (300-500 words)
- Notable achievements/credentials (3-5 bullets)
- Education (degrees, institutions, graduation years)
- Previous roles (2-3 most relevant with companies and dates)
- Board positions/affiliations (current)
- Speaking engagements (recent/upcoming)
- Publications/thought leadership (articles, books, patents)
- Social media handles (LinkedIn, Twitter/X)
- Media contact for interview requests

**Headshot Specifications**:
- **Resolution**: 300 DPI minimum for print
- **Formats**: JPG (web), PNG (transparent if needed), TIFF (print)
- **Dimensions**: Minimum 2000x2000px (square crop baseline)
- **Variations**: Horizontal (16:9), vertical (4:5), square (1:1)
- **Backgrounds**: Professional office or neutral studio
- **Dress**: Business or business casual (consistent with brand)
- **Expression**: Approachable, confident, natural smile
- **Lighting**: Professional (no harsh shadows, even exposure)
- **Delivery**: Color + black/white versions

**Bio Structure Template**:
```markdown
## [Full Name], [Title]

![Headshot alt text: Professional photo of [Name], [Title] at [Company]](headshot-url.jpg)

[Download: [Square JPG](link) | [Horizontal JPG](link) | [Vertical JPG](link) | [All Formats ZIP](link)]

### Short Bio (100-150 words)
[Name] is the [Title] of [Company], where [he/she/they] [primary responsibility].
[He/She/They] brings [X] years of experience in [domain], having previously served
as [role] at [company]. [Name] holds a [degree] from [institution] and has been
recognized by [award/publication/honor].

### Full Bio (300-500 words)
[Opening paragraph: Current role and top 1-2 achievements with metrics]

[Second paragraph: Career history with notable accomplishments at previous companies]

[Third paragraph: Industry expertise, speaking engagements, publications, awards]

[Fourth paragraph: Education, board positions, personal interests if appropriate]

### Key Credentials
- [Credential/Achievement 1 with year]
- [Credential/Achievement 2 with year]
- [Credential/Achievement 3 with year]

### Connect
- LinkedIn: [URL]
- Twitter/X: [@handle](URL)

### Media Inquiries
Contact: [PR contact email] for interview requests
Typical lead time: [timeframe]
Available for: [phone/video/in-person/email Q&A]
```

**Accessibility**:
- Alt text for headshots (descriptive, not "headshot.jpg")
- Screen reader friendly download links
- Proper heading levels (H2 for name, H3 for sections)

### 3. Visual Asset Library

**Logo Package**:

File Formats Required:
- **Vector**: SVG (web), EPS (print), AI (Adobe source)
- **Raster**: PNG (transparent), JPG (white background)
- **Resolutions**: 72 DPI (web), 300 DPI (print)

Logo Variations:
- Primary logo (horizontal)
- Stacked logo (vertical)
- Icon/mark only (square)
- Wordmark only (text)
- Monochrome versions (black, white, grayscale)

File Naming Convention:
```
company-logo-[variation]-[color]-[resolution].[ext]

Examples:
company-logo-primary-full-color-72dpi.png
company-logo-stacked-black-300dpi.png
company-logo-icon-white-transparent.svg
```

Logo Usage Guidelines (Separate PDF):
- Clear space requirements (minimum padding)
- Minimum size specifications (never smaller than X)
- Acceptable color variations
- Prohibited modifications (DO NOT: stretch, rotate, recolor)
- Background requirements (minimum contrast)
- Examples of correct/incorrect usage

**Photography Library**:

Categories:
- Product photography (white background, lifestyle, detail shots)
- Team/culture (office environment, meetings, candid)
- Customers/users (diverse representation, authentic scenarios)
- Events (conferences, launches, speaking engagements)
- Facilities/offices (headquarters, manufacturing, retail)

Specifications:
- **Resolution**: 300 DPI, minimum 4000px width
- **Format**: JPG (sRGB color space)
- **Metadata**: Embedded IPTC (title, description, keywords, copyright, credit)
- **Releases**: Model releases for recognizable people, property releases for private locations

File Naming:
```
YYYYMMDD-[subject]-[context]-[photographer]-[sequence].jpg

Example: 20241128-product-lifestyle-kitchen-jsmith-001.jpg
```

Asset Organization:
```
/brand-assets/
├── logos/
│   ├── svg/
│   ├── eps/
│   ├── png-web/
│   ├── png-print/
│   └── logo-usage-guidelines.pdf
├── photography/
│   ├── products/
│   ├── team/
│   ├── events/
│   ├── facilities/
│   └── customers/
├── video/
│   ├── b-roll/
│   ├── product-demos/
│   ├── interviews/
│   └── testimonials/
├── infographics/
└── templates/
```

**Video Assets**:

Categories:
- B-roll footage (no audio, general shots for editorial use)
- Product demonstrations (how-to, features)
- Executive interviews (soundbites, full interviews)
- Customer testimonials
- Event highlights

Specifications:
- **Resolution**: 4K (3840x2160), 1080p (1920x1080), 720p (1280x720)
- **Format**: MP4 (H.264 codec), MOV (ProRes for high-quality)
- **Frame Rate**: 24fps (cinematic), 30fps (standard), 60fps (smooth motion)
- **Aspect Ratios**: 16:9 (landscape), 9:16 (vertical), 1:1 (square), 4:5 (portrait)
- **Audio**: 48kHz stereo
- **Captions**: VTT or SRT subtitle files (required for accessibility)
- **Transcripts**: Full text transcript (required for accessibility)

**Brand Colors & Typography**:

Color Palette Documentation:
```markdown
### Primary Brand Blue
- **HEX**: #0066CC
- **RGB**: 0, 102, 204
- **CMYK**: 100, 50, 0, 20
- **Pantone**: 286 C
- **Usage**: Primary brand color, CTAs, headers

### Secondary Accent Orange
- **HEX**: #FF6600
- **RGB**: 255, 102, 0
- **CMYK**: 0, 60, 100, 0
- **Pantone**: 1645 C
- **Usage**: Accents, highlights, notifications

[Download Color Swatches: [Adobe Swatch](link) | [Sketch](link) | [Figma](link)]
```

Typography Specifications:
```markdown
### Primary Typeface: [Font Name]
- **Weights Available**: Light (300), Regular (400), Bold (700)
- **Usage**: Headlines in Bold, body text in Regular
- **Web Font**: [Google Fonts URL or CDN]
- **Desktop Font**: [Download TTF/OTF](link)
- **Fallback**: "Font Name", Arial, sans-serif

### Secondary Typeface: [Font Name]
- **Usage**: Subheadings, callouts
```

### 4. Press Release Archive

**Organization Structure**:

By Date (Primary Navigation):
```
/press-releases/
├── 2024/
│   ├── november/
│   ├── october/
│   └── september/
├── 2023/
└── 2022/
```

By Category (Secondary Filter):
- Product Launches
- Funding & Financial
- Partnerships & Collaborations
- Executive Announcements
- Awards & Recognition
- Research & Reports
- Events & Webinars

**Press Release Card Format**:
```markdown
### [Headline]
**[Date]** | Category: [Category]

[150-character excerpt or lead paragraph]

[Read Full Release →] [Download PDF →]

Related: [Product Page] | [Media Kit] | [Assets]
```

**Features**:
- Search functionality (full-text across all releases)
- Filter by date range, category, keywords
- Sort by date (newest first default)
- RSS feed (auto-updates)
- Email alerts (subscribe to categories)

### 5. Media Coverage Showcase

**Organization**:

By Publication Tier:
- Tier 1 Media (WSJ, NYT, Forbes, TechCrunch, etc.)
- Industry Trade Publications
- Regional/Local Media
- Podcasts & Video Interviews
- Awards & Recognition

By Topic:
- Product Coverage
- Executive Profiles
- Thought Leadership
- Customer Stories
- Company Culture

**Coverage Display Format**:
```markdown
### [Publication Logo - linked to article]

**"[Article Headline]"**
By [Author Name]
Published: [Month DD, YYYY]

[50-100 word excerpt or pull quote]

[Read Full Article →] [Download PDF →]

**Reach**: [Publication circulation/unique visitors if known]
```

**Metrics** (Internal tracking, not public display):
- Advertising Value Equivalency (AVE)
- Estimated reach/impressions
- Sentiment (positive/neutral/negative)
- Key message pull-through

### 6. Company Fact Sheet

**One-Page Quick Reference** (PDF + Web):

```markdown
# [Company Name] Fact Sheet

**Last Updated**: [Month YYYY]

## Company Overview
- **Founded**: [Year]
- **Headquarters**: [City, State/Country]
- **CEO**: [Name]
- **Employees**: [Number or range]
- **Website**: [URL]

## Products & Services
- [Primary product/service with brief description]
- [Primary product/service with brief description]
- [Primary product/service with brief description]

## Market Presence
- **Customers**: [Number] [type]
- **Markets**: [Regions/countries served]
- **Partners**: [Number] strategic partners
- **Revenue**: [If public or willing to share]

## Key Differentiators
- [Unique value proposition 1]
- [Unique value proposition 2]
- [Unique value proposition 3]

## Notable Achievements
- [Award/recognition with date]
- [Major milestone with metric]
- [Industry leadership indicator]

## Recent News
- [Month YYYY]: [Brief headline/description]
- [Month YYYY]: [Brief headline/description]
- [Month YYYY]: [Brief headline/description]

## Contact Information
**Media Relations**: [Name], [Email], [Phone]
**General Inquiries**: [Email]
**Social Media**: [Platform handles]

[Download PDF Version →]
```

**Design Requirements**:
- Branded template (company colors/fonts)
- File size under 500KB (email-friendly)
- Accessible (searchable text, proper structure)
- Print-ready (if PDF)

### 7. Media Contacts Directory

**Contact Structure**:

```markdown
## General Media Inquiries

**[Name], [Title]**
- **Phone**: [Direct line]
- **Mobile**: [Cell if available]
- **Email**: [Direct email]
- **Hours**: [Availability and timezone]
- **Languages**: [If multilingual]

## Regional Contacts

### North America
[Name], [Title] | [Email] | [Phone]

### Europe, Middle East, Africa (EMEA)
[Name], [Title] | [Email] | [Phone]

### Asia-Pacific (APAC)
[Name], [Title] | [Email] | [Phone]

## Topic-Specific Contacts

### Product/Technology Inquiries
[Name], [Title] | [Email]

### Financial/Investor Relations
[Name], [Title] | [Email]

### Partnership Inquiries
[Name], [Title] | [Email]

## Executive Interview Requests
**Coordinator**: [Name], [Email]
**Lead Time**: [Typical timeframe - e.g., 5-7 business days]
**Formats Available**: Phone, video, in-person (by arrangement)

## Emergency/After-Hours Contact
**For urgent breaking news inquiries**:
- Phone: [24/7 hotline]
- Email: [Monitored email]

## Social Media Newsroom
- Twitter/X: [@handle](URL)
- LinkedIn: [Company Page](URL)
- Facebook: [Page](URL)
- Instagram: [@handle](URL)
- YouTube: [Channel](URL)
```

## Advanced Components

### 8. Interactive Timeline

**Company History Visualization**:

Content Elements:
- Founding date and origin story
- Funding rounds (if applicable)
- Product launches
- Key partnerships
- Acquisitions or mergers
- Geographic expansion
- Awards and recognition
- Leadership changes
- Strategic pivots

Implementation Options:
- Web-based interactive (Timeline.js, Tiki-Toki)
- Scrollytelling (Scrollama.js)
- Static infographic (PDF)

### 9. Customer Success Stories

**Case Study Format**:

```markdown
## [Customer Company Name] Case Study

**Industry**: [Sector]
**Size**: [Employees/revenue/relevant metric]
**Location**: [HQ]

### Challenge
[150-200 words: problem customer faced]

### Solution
[200-250 words: how product/service implemented]

### Results
- [Metric 1]: [Improvement with %/number]
- [Metric 2]: [Improvement with %/number]
- [Metric 3]: [Improvement with %/number]

### Customer Quote
"[Testimonial, 50-100 words]"
— [Name, Title, Company]

[Download Full Case Study PDF] [Watch Video Testimonial]
```

### 10. Expert Source Database

**Executive Expertise Directory**:

```markdown
## [Executive Name]
**Title**: [Position]
**Expertise**: [3-5 topic areas]

### Available for Commentary On
- [Topic 1: Specific industry aspect]
- [Topic 2: Technology/trend]
- [Topic 3: Market dynamics]

### Recent Media Appearances
- [Publication/Show]: "[Title]" ([Date]) [Link]
- [Publication/Show]: "[Title]" ([Date]) [Link]

### Published Works
- [Article title], [Publication] ([Date]) [Link]

**Interview Availability**: [Lead time]
**Contact for Booking**: [Email]
```

## Web Implementation

### Homepage Layout

**Hero Section**:
```
┌─────────────────────────────────────────────┐
│  [Company Logo]                  [Search 🔍]│
│                                              │
│  [Company Name] Media Center                │
│  Your source for news, assets, and          │
│  background on [Company]                    │
│                                              │
│  [Download Full Media Kit]                  │
└─────────────────────────────────────────────┘
```

**Quick Links Section**:
```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Latest News  │ │ Brand Assets │ │ Leadership   │
│              │ │              │ │              │
│ [Icon]       │ │ [Icon]       │ │ [Icon]       │
└──────────────┘ └──────────────┘ └──────────────┘

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Media Contact│ │ Fact Sheet   │ │ Coverage     │
│              │ │              │ │              │
│ [Icon]       │ │ [Icon]       │ │ [Icon]       │
└──────────────┘ └──────────────┘ └──────────────┘
```

**Latest Press Releases** (3-5 most recent):
```
┌─────────────────────────────────────────────┐
│ [Thumbnail] [Headline]                      │
│             [Date] | [Category]             │
│             [Excerpt...]                    │
│             [Read More →]                   │
├─────────────────────────────────────────────┤
│ [Thumbnail] [Headline]                      │
│             [Date] | [Category]             │
│             [Excerpt...]                    │
│             [Read More →]                   │
└─────────────────────────────────────────────┘

[View All Press Releases →]
```

### Navigation Structure

```
Company Media Center
├── Home
├── News & Updates
│   ├── Press Releases (all)
│   ├── Blog Posts
│   └── Media Coverage
├── About [Company]
│   ├── Company Overview
│   ├── Leadership Team
│   ├── Company History
│   └── Fact Sheet
├── Brand Assets
│   ├── Logos
│   ├── Photography
│   ├── Video
│   ├── Infographics
│   └── Usage Guidelines
├── Resources
│   ├── Case Studies
│   ├── Research Reports
│   ├── White Papers
│   └── Data & Statistics
├── Events
│   ├── Upcoming Events
│   ├── Past Events
│   └── Speaking Engagements
├── Media Contacts
│   ├── Press Inquiries
│   ├── Regional Contacts
│   └── Interview Requests
└── Subscribe
    ├── Email Alerts
    └── RSS Feeds
```

### Search Functionality

**Requirements**:
- Full-text search across all content
- Autocomplete suggestions
- Faceted filters (date, category, content type)
- Typo tolerance (fuzzy matching)
- Synonym handling ("CEO" finds "Chief Executive")

**Implementation**:
- Algolia (hosted search API)
- ElasticSearch (self-hosted)
- Lunr.js (client-side for smaller sites)

### Mobile Optimization

**Responsive Breakpoints**:
- Mobile: 320px - 768px
- Tablet: 769px - 1024px
- Desktop: 1025px+

**Mobile-Specific Features**:
- Sticky navigation (always accessible)
- Hamburger menu (collapsible)
- Touch-friendly buttons (44x44px minimum)
- Click-to-call phone numbers
- Native share sheet integration
- Optimized image loading (lazy load, WebP)

**Performance Targets**:
- Load time: < 3 seconds on 3G
- Largest Contentful Paint (LCP): < 2.5s
- First Input Delay (FID): < 100ms
- Cumulative Layout Shift (CLS): < 0.1

## Accessibility (WCAG 2.1 AA)

### Perceivable

**Text Alternatives**:
- Alt text for all images (descriptive, not generic)
- Captions for all video content (VTT/SRT)
- Transcripts for audio content
- Text alternatives for infographics

**Color Contrast**:
- Body text: 4.5:1 minimum
- Large text (18px+): 3:1 minimum
- Interactive elements: 3:1 minimum
- Test with WebAIM Contrast Checker

### Operable

**Keyboard Navigation**:
- All interactive elements accessible via Tab
- Logical tab order (top to bottom, left to right)
- Skip links (jump to main content)
- No keyboard traps

**Focus Indicators**:
- Visible outline on focused elements (2px minimum)
- High contrast (not low-opacity)
- Consistent across site

### Understandable

**Heading Hierarchy**:
- H1 for page title (only one per page)
- H2 for major sections
- H3 for subsections
- No skipped levels (H2 → H4)

**Link Text**:
- Descriptive ("Download company fact sheet" not "click here")
- Unique text for links to different destinations
- Indicate file type/size ("PDF, 2.5 MB")

**Form Labels**:
- All input fields have labels
- Error messages clear and specific
- Success confirmation messages

### Robust

**Semantic HTML**:
- `<nav>` for navigation
- `<main>` for primary content
- `<article>` for press releases
- `<aside>` for related content
- `<header>`, `<footer>` appropriately

**ARIA Labels** (when semantic HTML insufficient):
- `aria-label` for icon buttons
- `aria-describedby` for additional context
- `aria-live` for dynamic content updates

## Asset Download System

### Self-Service Portal

**User Journey**:
1. Discover asset (search or browse)
2. Preview (thumbnail, metadata)
3. Select format/resolution
4. Download (one-click, no registration)
5. Attribution auto-copied (optional)

**Download Interface**:
```
┌─────────────────────────────────────────────┐
│ [Preview Thumbnail]                         │
│                                              │
│ [Asset Title]                               │
│ Published: [Date]                           │
│                                              │
│ [Description, 1-2 sentences]                │
│                                              │
│ Available Formats:                          │
│ ☐ High-Res (4000x3000px, JPG, 5.2 MB)     │
│ ☐ Web (1200x900px, JPG, 850 KB)           │
│ ☐ Thumbnail (400x300px, JPG, 120 KB)      │
│                                              │
│ License: Editorial use permitted            │
│ Attribution: Photo courtesy of [Company]    │
│                                              │
│ [Download Selected] [Download All]         │
│                                              │
│ Related Assets: [Link] [Link] [Link]       │
└─────────────────────────────────────────────┘
```

### Licensing & Terms

**License Types**:

1. **Editorial Use**:
   - Permitted: News, blog posts, reviews
   - Restricted: Advertising, merchandise
   - Attribution: Required

2. **Commercial Use Allowed**:
   - Permitted: Editorial + advertising, presentations
   - Restricted: Logo modification, asset resale
   - Attribution: Recommended

3. **Restricted** (Request Required):
   - Contact media relations for approval

**Terms Display** (Before Download):
```markdown
### Asset Usage Terms

**License**: Editorial Use

**You May**:
✓ Use in news articles and editorial content
✓ Crop/resize for publication
✓ Publish online and in print

**You May Not**:
✗ Use in advertisements
✗ Alter image (basic edits acceptable)
✗ Imply endorsement

**Attribution Required**: "Photo courtesy of [Company]"

Questions? [media@company.com]
```

## Analytics & Tracking

### Key Metrics

**Traffic**:
- Page views (unique/total)
- Time on page
- Bounce rate
- Traffic sources (organic, social, referral)
- Geographic distribution

**Engagement**:
- Asset downloads (by type, format)
- Press release views
- Video plays (completion rate)
- Search queries
- Outbound link clicks

**Media Pickup**:
- Number of articles/mentions
- Tier distribution (T1 vs T2/T3)
- Sentiment analysis
- Estimated reach

### Event Tracking

```javascript
// Download tracking
gtag('event', 'asset_download', {
  'asset_type': 'logo',
  'file_format': 'svg',
  'asset_id': 'company-logo-primary'
});

// Press release engagement
gtag('event', 'press_release_view', {
  'release_id': 'PRS-001',
  'category': 'product-launch'
});

// Contact inquiry
gtag('event', 'media_contact', {
  'contact_type': 'email',
  'contact_person': 'PR_manager'
});
```

## Distribution & Promotion

### Launch Checklist

**Content Preparation**:
- [ ] All company information current
- [ ] Executive bios/headshots updated
- [ ] Logo package complete (all formats)
- [ ] Brand guidelines documented
- [ ] Press release archive populated (12+ months)
- [ ] Fact sheet designed and verified
- [ ] Media contacts tested (phone/email)

**Technical Setup**:
- [ ] Domain/subdomain configured
- [ ] SSL certificate installed
- [ ] CMS/platform configured
- [ ] CDN for asset hosting
- [ ] Search functionality tested
- [ ] RSS feeds active
- [ ] Email subscription working
- [ ] Analytics installed
- [ ] Mobile responsiveness verified
- [ ] Accessibility audit passed (WCAG 2.1 AA)
- [ ] SEO optimization complete

**Post-Launch**:
- [ ] Announce to media database
- [ ] Social media promotion
- [ ] Internal team training
- [ ] Monitor analytics (first week)
- [ ] Fix any issues/bugs

### Maintenance Schedule

**Weekly**:
- Add new press releases
- Monitor download activity
- Respond to media inquiries

**Monthly**:
- Review top content
- Update featured news
- Check broken links

**Quarterly**:
- Update company statistics
- Refresh executive headshots (if needed)
- Audit asset library
- Review brand guidelines

**Annually**:
- Comprehensive content audit
- Platform evaluation
- Legal/compliance review
- Accessibility re-audit
- Competitive benchmarking

## Related Templates

- **Press Release**: PRS-001 (AP Style announcement format)
- **Media Pitch**: PRS-003 (journalist outreach email)
- **Press Briefing**: PRS-004 (background document)
- **Brand Guidelines**: BRA-001 (visual identity rules)
- **Social Media Kit**: SOC-001 (social asset package)

## References

- HubSpot Media Kit Guide (2024)
- Cision 2024 State of the Media Report
- Shopify Newsroom (best practice example)
- WCAG 2.1 AA Standards
- Google Search Central SEO Guidelines
