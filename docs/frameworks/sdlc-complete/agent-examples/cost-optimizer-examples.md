# Cost Optimizer — Worked Examples

Externalized from the agent definition per the few-shot-examples rule (#1587).

## Process Sample Blocks

These are the illustrative command/code sample blocks for each step of the Cost Optimizer process. The agent definition retains the capability summary for each step; the full sample blocks live here.

### 1. Bundle Size Analysis and Optimization

```bash
# Webpack Bundle Analyzer — visualize bundle composition
npm install --save-dev webpack-bundle-analyzer

# Generate stats file
npx webpack --profile --json > webpack-stats.json

# Open interactive visualization
npx webpack-bundle-analyzer webpack-stats.json

# CLI summary of top contributors
node -e "
const stats = require('./webpack-stats.json');
const chunks = stats.chunks || [];
const assets = stats.assets || [];

assets
  .sort((a, b) => b.size - a.size)
  .slice(0, 20)
  .forEach(a => console.log(
    (a.size / 1024).toFixed(1) + 'KB', a.name
  ));
"
```

```bash
# size-limit — enforce performance budgets in CI
npm install --save-dev @size-limit/preset-app

# package.json size-limit config
cat > size-limit-config.json << 'EOF'
[
  {
    "path": "dist/main.js",
    "limit": "200 KB",
    "gzip": true
  },
  {
    "path": "dist/vendor.js",
    "limit": "150 KB",
    "gzip": true
  },
  {
    "path": "dist/main.css",
    "limit": "50 KB",
    "gzip": true
  }
]
EOF

# Run check (fails CI if over budget)
npx size-limit --config size-limit-config.json

# Analyze what contributes to a specific limit
npx size-limit --why --config size-limit-config.json
```

```javascript
// Identify unused exports for tree-shaking opportunities
// vite-bundle-visualizer for Vite projects
import { visualizer } from 'rollup-plugin-visualizer';

export default {
  plugins: [
    visualizer({
      filename: './bundle-analysis/stats.html',
      open: true,
      gzipSize: true,
      brotliSize: true,
      template: 'treemap', // or 'sunburst', 'network'
    }),
  ],
};
```

### 2. Docker Image Optimization

```dockerfile
# BEFORE: Naive single-stage build (image: ~1.2GB)
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

```dockerfile
# AFTER: Multi-stage build with layer caching (image: ~85MB)
# Stage 1: Dependencies (cached unless package.json changes)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Build (cached unless source changes)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 3: Runtime (minimal final image)
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV production

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodeuser

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .

USER nodeuser
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

```bash
# Measure image size reduction
docker build -t app:optimized .
docker images app --format "{{.Repository}}:{{.Tag}}\t{{.Size}}"

# Dive: layer-by-layer analysis tool
# Install: https://github.com/wagoodman/dive
dive app:optimized

# Check for large layers
docker history app:optimized --format "{{.Size}}\t{{.CreatedBy}}" | sort -rh | head -10

# Remove unused Docker images and layers
docker system prune --all --volumes --force
docker system df  # Show space usage
```

### 3. CI Pipeline Cost Optimization

```yaml
# GitHub Actions: Comprehensive caching strategy
name: Build and Test

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Cache npm dependencies (key on package-lock.json hash)
      - name: Cache node_modules
        uses: actions/cache@v4
        id: npm-cache
        with:
          path: ~/.npm
          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-node-

      # Cache build outputs (key on source file hash)
      - name: Cache build artifacts
        uses: actions/cache@v4
        with:
          path: |
            dist/
            .next/cache/
          key: ${{ runner.os }}-build-${{ hashFiles('src/**', 'package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-build-

      # Cache Docker layers
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Cache Docker layers
        uses: actions/cache@v4
        with:
          path: /tmp/.buildx-cache
          key: ${{ runner.os }}-buildx-${{ github.sha }}
          restore-keys: |
            ${{ runner.os }}-buildx-

      - name: Install (only if cache miss)
        if: steps.npm-cache.outputs.cache-hit != 'true'
        run: npm ci

      - name: Build
        run: npm run build

      # Run tests in parallel to reduce wall clock time
      - name: Test (unit)
        run: npx vitest run --reporter=verbose &

      - name: Test (integration)
        run: npx vitest run --config vitest.integration.ts &

      - name: Wait for tests
        run: wait
```

```bash
# Analyze CI build time breakdown
# GitHub CLI: fetch workflow run timing
gh api repos/{owner}/{repo}/actions/runs \
  --jq '.workflow_runs[:10] | map({
    id: .id,
    name: .name,
    duration_seconds: ((.updated_at | fromdateiso8601) - (.run_started_at | fromdateiso8601)),
    conclusion: .conclusion
  })' > ci-timing.json

# Identify slowest steps across recent runs
gh api repos/{owner}/{repo}/actions/runs/RUNID/jobs \
  --jq '.jobs[] | {
    job: .name,
    steps: [.steps[] | {step: .name, duration_seconds: ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601))}] | sort_by(-.duration_seconds) | .[0:5]
  }'
```

### 4. Dependency Deduplication and License Audit

```bash
# Find duplicate packages in node_modules
npm dedupe --dry-run 2>&1 | grep "^would deduplicate"

# Actually deduplicate
npm dedupe

# Find multiple versions of the same package (bundle cost)
npm ls --all 2>/dev/null | grep -E "^\S" | grep -oE "[a-z@][a-z0-9/@_-]*" | \
  sort | uniq -d | head -20

# Analyze package cost with bundlephobia data
node -e "
const { execSync } = require('child_process');
const pkg = require('./package.json');
const deps = Object.keys({...pkg.dependencies, ...pkg.devDependencies});

// Check import cost via bundlephobia API
deps.slice(0, 10).forEach(dep => {
  try {
    const result = execSync(
      'curl -s https://bundlephobia.com/api/size?package=' + dep,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const data = JSON.parse(result);
    if (data.gzip) {
      console.log(dep + ': ' + (data.gzip / 1024).toFixed(1) + 'KB gzipped');
    }
  } catch {}
});
"
```

```bash
# License audit — identify non-permissive licenses
npx license-checker --production --json > license-report.json

# Find restrictive licenses (GPL, AGPL, LGPL, SSPL)
node -e "
const licenses = require('./license-report.json');
const restrictive = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'EUPL', 'CDDL'];

Object.entries(licenses)
  .filter(([pkg, info]) =>
    restrictive.some(r => (info.licenses || '').includes(r))
  )
  .forEach(([pkg, info]) => {
    console.log(pkg + ': ' + info.licenses);
  });
" 2>/dev/null

# Generate CSV for legal review
npx license-checker --production --csv > license-report.csv
```

### 5. Cloud Cost Analysis

```bash
# AWS: Find underutilized EC2 instances
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '-30 days' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[0].Groups[*].{Service:Keys[0],Cost:Metrics.UnblendedCost.Amount}' \
  --output table

# Find resources without cost tags
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Environment \
  --query 'length(ResourceTagMappingList)' 2>/dev/null

# AWS Compute Optimizer recommendations
aws compute-optimizer get-ec2-instance-recommendations \
  --query 'instanceRecommendations[*].{
    Instance: instanceArn,
    Finding: finding,
    CurrentType: currentInstanceType,
    RecommendedType: recommendationOptions[0].instanceType,
    SavingsPercent: recommendationOptions[0].estimatedMonthlySavings.value
  }' \
  --output table

# S3 lifecycle — identify objects older than 90 days without lifecycle rules
aws s3api list-buckets --query 'Buckets[*].Name' --output text | \
  tr '\t' '\n' | while read bucket; do
    lc=$(aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" 2>/dev/null)
    if [ -z "$lc" ]; then
      size=$(aws s3 ls s3://"$bucket" --recursive --summarize 2>/dev/null | grep "Total Size" | awk '{print $3}')
      echo "No lifecycle: $bucket ($size bytes)"
    fi
  done
```

```bash
# GCP: BigQuery cost attribution by user and dataset
bq query --use_legacy_sql=false '
SELECT
  user_email,
  SUM(total_bytes_billed) / POW(10, 12) AS TB_billed,
  SUM(total_bytes_billed) / POW(10, 12) * 5 AS estimated_cost_usd,
  COUNT(*) AS query_count
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time BETWEEN TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND CURRENT_TIMESTAMP()
GROUP BY user_email
ORDER BY TB_billed DESC
LIMIT 20
'
```

### 6. ROI Calculation Framework

```javascript
// cost-roi-calculator.js
function calculateOptimizationROI(opportunity) {
  const {
    currentMonthlyCost,
    projectedMonthlyCost,
    implementationHours,
    hourlyRate = 150,  // USD, adjust per team
    riskMultiplier = 1.0,
  } = opportunity;

  const monthlySavings = currentMonthlyCost - projectedMonthlyCost;
  const annualSavings = monthlySavings * 12;
  const implementationCost = implementationHours * hourlyRate * riskMultiplier;
  const paybackMonths = implementationCost / monthlySavings;
  const firstYearROI = ((annualSavings - implementationCost) / implementationCost * 100).toFixed(1);

  return {
    monthlySavings: monthlySavings.toFixed(2),
    annualSavings: annualSavings.toFixed(2),
    implementationCost: implementationCost.toFixed(2),
    paybackMonths: paybackMonths.toFixed(1),
    firstYearROI: firstYearROI + '%',
    recommendation: paybackMonths < 3 ? 'Do immediately'
      : paybackMonths < 6 ? 'Schedule in next quarter'
      : paybackMonths < 12 ? 'Plan for H2'
      : 'Defer — long payback period',
  };
}

// Example: Docker image optimization
const dockerOptimization = calculateOptimizationROI({
  currentMonthlyCost: 2400,    // ECR storage + data transfer
  projectedMonthlyCost: 800,   // After multi-stage build
  implementationHours: 8,      // Engineer time
  riskMultiplier: 1.0,         // Well-tested approach
});

console.log('Docker Optimization ROI:', dockerOptimization);
// { monthlySavings: '1600.00', annualSavings: '19200.00',
//   implementationCost: '1200.00', paybackMonths: '0.8',
//   firstYearROI: '1500.0%', recommendation: 'Do immediately' }
```

## Few-Shot Examples

### Example 1: Bundle Audit Report (Simple)

**Input:**
Our Webpack bundle is 2.3MB gzipped and users are complaining about load times. Audit the bundle and identify the top opportunities to reduce it.

**Output:**
```markdown
# Bundle Audit Report
**Date**: 2026-02-27
**Current Size**: 2.3MB gzipped (target: < 800KB)
**Tool**: webpack-bundle-analyzer + size-limit

## Top Bundle Contributors

| Package | Size (gzip) | Why It's Large | Action |
|---------|-------------|----------------|--------|
| moment.js | 67KB | All locales bundled | Replace with date-fns (tree-shakable) |
| lodash | 72KB | Entire library imported | Use `lodash-es` with named imports |
| recharts | 89KB | Full charting library | Lazy-load chart components |
| draft-js | 143KB | Rich text editor | Lazy-load on /editor route only |
| @mui/material | 198KB | All MUI components | Use component-level imports |

## Projected Savings

| Optimization | Current | After | Savings |
|--------------|---------|-------|---------|
| moment → date-fns | 67KB | 8KB | 59KB |
| lodash → lodash-es | 72KB | 12KB | 60KB |
| Lazy-load recharts | 89KB | 0KB initial | 89KB (deferred) |
| Lazy-load draft-js | 143KB | 0KB initial | 143KB (deferred) |
| MUI tree-shaking | 198KB | 45KB | 153KB |
| **Total** | **569KB** | **65KB** | **504KB** |

Estimated final bundle after changes: ~1.8MB → ~1.3MB gzipped (43% reduction).

## Implementation Priority

1. MUI tree-shaking (153KB saved, 4 hours, no behavior change)
2. moment → date-fns (59KB saved, 2 hours, API-compatible migration available)
3. Lazy-load draft-js (143KB deferred, 3 hours, significant LCP improvement for non-editor routes)
4. lodash → lodash-es (60KB saved, 2 hours, identical API)
5. Lazy-load recharts (89KB deferred, 2 hours, only needed on dashboard routes)

Total effort: 13 hours. Estimated bundle reduction: 43%.
```

---

### Example 2: CI Cost Reduction (Moderate)

**Input:**
We're spending $4,200/month on GitHub Actions. Analyze our workflow and find the biggest savings opportunities.

**Output:**
```markdown
# CI Cost Analysis
**Current Spend**: $4,200/month (42,000 minutes @ $0.10/min)
**Target**: < $2,000/month

## Timing Breakdown (last 30 days average)

| Job | Avg Duration | Runs/Day | Monthly Minutes | Monthly Cost |
|-----|-------------|----------|-----------------|--------------|
| test-unit | 12 min | 48 | 17,280 | $1,728 |
| test-integration | 18 min | 48 | 25,920 | $2,592 |
| lint | 4 min | 48 | 5,760 | $576 |
| build | 8 min | 48 | 11,520 | $1,152 |

## Root Cause: No Caching, Sequential Jobs

- npm install runs from scratch on every job (3-4 minutes each)
- Unit and integration tests run sequentially (could be parallel)
- Lint runs even when only docs changed
- No path filtering — all jobs trigger on all pushes

## Optimization Plan

### 1. Add Dependency Caching (-$900/month)
Cache node_modules on package-lock.json hash.
Expected cache hit rate: 85%. Saves 3 minutes per job × 4 jobs × 48 runs/day.

### 2. Parallelise Unit and Integration Tests (-$600/month)
Run both test suites concurrently instead of sequentially.
Reduces wall-clock time but doesn't reduce minutes — use matrix strategy wisely.
Actual saving: integration now unblocks faster, reducing rerun rate.

### 3. Path-Based Job Filtering (-$480/month)
Skip lint on non-source changes. Skip build on test-only changes.
Use `paths` filter in workflow triggers.

### 4. Self-Hosted Runners for Integration Tests (-$800/month)
Integration tests are predictably heavy (18 min each). A $40/month EC2 t3.medium
running 8 hours/day handles 48 runs × 18 min easily.
Break-even: month 1.

## Projected Outcome

| Optimization | Monthly Savings | Effort |
|--------------|-----------------|--------|
| Dependency caching | $900 | 2 hours |
| Path filtering | $480 | 3 hours |
| Self-hosted integration runner | $800 | 8 hours |
| **Total** | **$2,180** | **13 hours** |

Projected monthly spend: $4,200 → $2,020 (52% reduction).
```

---

### Example 3: Cloud Right-Sizing Audit (Complex)

**Input:**
Our AWS bill is $28,000/month. Run a full right-sizing analysis and identify the top savings opportunities.

**Output:**
```markdown
# AWS Cost Optimization Audit
**Period**: January 2026 | **Current Spend**: $28,000/month
**Data Sources**: AWS Cost Explorer, Compute Optimizer, CloudWatch

## Spend Breakdown

| Service | Monthly Cost | % of Total | Trend |
|---------|-------------|------------|-------|
| EC2 + EBS | $12,400 | 44% | +8%/month |
| RDS | $6,200 | 22% | Stable |
| Data Transfer | $4,100 | 15% | +15%/month |
| S3 | $2,800 | 10% | Stable |
| ElastiCache | $1,400 | 5% | Stable |
| Other | $1,100 | 4% | Stable |

## Opportunity Register

### OPT-001: EC2 Right-Sizing (Savings: $3,200/month)
Compute Optimizer analysis shows 14 instances running at <10% average CPU utilization.

| Instance | Current Type | Recommended | Current Cost | Projected Cost | Savings |
|----------|-------------|-------------|--------------|----------------|---------|
| api-prod-3 | m5.4xlarge | m5.xlarge | $556 | $139 | $417 |
| worker-prod-[1-8] | c5.2xlarge | c5.large | $272×8 | $68×8 | $1,632 |
| ml-batch-[1-3] | p3.2xlarge | Spot + m5.4xlarge | $2,189×3 | $890×3 | $3,897 |

Action: Schedule right-sizing during next maintenance window. Use Spot Instances
for batch workloads that can tolerate interruption.

### OPT-002: Data Transfer — CDN Gap (Savings: $2,100/month)
$4,100/month data transfer: 76% is outbound to end users, bypassing CloudFront.
Adding CloudFront for static assets and API responses (with 5-minute TTL) reduces
direct EC2→internet transfer.

Current: 41TB/month direct EC2 egress @ $0.09/GB = $3,690
With CloudFront: 41TB × 85% cache hit rate = 6TB EC2 egress + 41TB CloudFront
CloudFront cost: $0.0085/GB × 41TB = $348
EC2 egress: $0.09/GB × 6TB = $540
New total: $888 vs $3,690. Savings: $2,802/month.

### OPT-003: S3 Lifecycle Policies (Savings: $700/month)
11 buckets have no lifecycle rules. 68% of S3 spend is on objects >90 days old
that are accessed fewer than once per month.

Recommended lifecycle:
- Standard → Standard-IA after 30 days (60% cost reduction for infrequent access)
- Standard-IA → Glacier Instant Retrieval after 90 days (75% cost reduction)

### OPT-004: Reserved Instance Purchases (Savings: $1,800/month)
Stable baseline load (always-on RDS, core EC2): $8,200/month on-demand.
1-year reserved instances for stable load: $5,200/month (37% discount).
Implementation: Purchase 1-year partial upfront RI for 12 instances identified
as always-on via CloudWatch utilization data.

## Prioritized Roadmap

| Priority | Opportunity | Monthly Savings | Effort | Payback |
|----------|-------------|-----------------|--------|---------|
| 1 | Reserved Instances | $1,800 | 2 hours | Immediate |
| 2 | CloudFront CDN | $2,802 | 12 hours | <1 month |
| 3 | EC2 Right-Sizing | $3,200 | 16 hours | 1 month |
| 4 | S3 Lifecycle | $700 | 4 hours | <1 month |
| **Total** | | **$8,502** | **34 hours** | **<2 months** |

Projected monthly spend: $28,000 → $19,498 (30% reduction).
Annual savings: $102,024.
```
