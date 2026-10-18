---
namespace: aiwg
name: deploy-gen
platforms: [all]
description: Generate deployment configurations (Docker, Kubernetes) for the current project
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# Deploy Generator

Generate production-ready deployment configurations based on project analysis.

## Research Foundation

**REF-001**: BP-8 - Containerized Deployment

> "Production-grade agentic workflows require containerized deployment with proper isolation, resource management, and orchestration."

## Usage

```bash
/deploy-gen docker [options]
/deploy-gen k8s [options]
/deploy-gen compose [options]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| type | Yes | Deployment type: docker, k8s, compose |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| --output | ./deploy/ | Output directory for generated files |
| --app-name | (from package.json) | Application name |
| --port | 3000 | Application port |
| --multi-stage | true | Use multi-stage Dockerfile |
| --health-check | true | Include health check endpoints |

## Process

### 1. Project Analysis

Detect project characteristics:

```
Analyzing project...
- Runtime: [node/python/go/java]
- Package manager: [npm/yarn/pip/go mod]
- Entry point: [detected or ask]
- Dependencies: [count]
- Build required: [yes/no]
```

### 2. Template Selection

Choose appropriate templates based on analysis:

| Runtime | Template |
|---------|----------|
| Node.js | `templates/deploy/docker/node.Dockerfile` |
| Python | `templates/deploy/docker/python.Dockerfile` |
| Go | `templates/deploy/docker/go.Dockerfile` |

### 3. Configuration Generation

Generate deployment files with project-specific values.

## Output: Docker

```
deploy/
├── Dockerfile           # Multi-stage build
├── .dockerignore        # Exclude dev files
└── docker-build.sh      # Build helper script
```

### Dockerfile Features

- Multi-stage build (build → production)
- Non-root user
- Health check
- Proper signal handling
- Layer caching optimization

## Output: Kubernetes

```
deploy/k8s/
├── deployment.yaml      # Pod specification
├── service.yaml         # Service exposure
├── configmap.yaml       # Environment configuration
├── hpa.yaml            # Horizontal Pod Autoscaler
└── kustomization.yaml  # Kustomize base
```

### Kubernetes Features

- Resource limits and requests
- Liveness and readiness probes
- ConfigMap for environment
- HPA for auto-scaling
- Kustomize for environment overlays

## Output: Docker Compose

```
deploy/
├── docker-compose.yml       # Service definition
├── docker-compose.dev.yml   # Development overrides
└── .env.example             # Environment template
```

## Examples

```bash
# Generate Dockerfile for Node.js project
/deploy-gen docker

# Generate full Kubernetes manifests
/deploy-gen k8s --app-name my-api --port 8080

# Generate Docker Compose for local development
/deploy-gen compose --output ./

# Generate all deployment types
/deploy-gen docker && /deploy-gen k8s && /deploy-gen compose
```

## Template Variables

Templates use these variables:

| Variable | Source |
|----------|--------|
| `{{APP_NAME}}` | --app-name or package.json |
| `{{PORT}}` | --port option |
| `{{NODE_VERSION}}` | .nvmrc or latest LTS |
| `{{PYTHON_VERSION}}` | .python-version or 3.11 |
| `{{ENTRY_POINT}}` | Detected from project |

## CLI Equivalent

```bash
aiwg deploy-gen <type> [options]
```

## Related Commands

- `project-health-check` - Analyze project before deployment
- `security-audit` - Security review before production
- `flow-deploy-to-production` - Full deployment workflow

## Success Metrics

From Unified Plan:

| Metric | Target |
|--------|--------|
| Zero to containerized | <2 minutes |
| Generated configs | Production-ready |
| Security baseline | Non-root, minimal image |

Generate deployment for: $ARGUMENTS

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/README.md — aiwg-utils addon overview
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC framework context for deployment workflows
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference including deploy-related commands
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Analyze project before generating configs
