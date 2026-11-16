# Local Model Deployment Guide

Running LLMs locally for AIWG workflows. Covers Ollama, llama.cpp, and vLLM; quantization trade-offs; hardware sizing; and how to connect local models to AIWG via OpenAI-compatible APIs.

## Endpoint-backed direct workers (#4193)

Declare models under the CLI installation in `.aiwg/aiwg.config`. The executable
must already configure its harness to use this same endpoint, for example an
operator-owned Codex wrapper with a custom `model_providers` entry. AIWG uses the
CLI's existing adapter and passes the exact model selector with `-m` for Codex.
The declaration does not configure or verify the wrapper's backend routing.

```json
{
  "parallelism": {
    "worker_dispatch": true,
    "clis": {
      "local-codex": {
        "adapter": "providers:codex",
        "executable": "/opt/workers/codex-local",
        "accountScope": "self-hosted",
        "quotaScope": "local-gpu",
        "localModels": {
          "endpoint": "http://127.0.0.1:8010/v1",
          "authEnv": "LOCAL_MODEL_API_KEY",
          "timeoutMs": 3000,
          "models": [{
            "id": "my-coder",
            "checkpoint": "my-coder-q4-revision-12",
            "family": "my-coder",
            "contextTokens": 32768,
            "maxOutputTokens": 4096,
            "efforts": ["medium"]
          }]
        }
      }
    },
    "groups": {
      "local": {
        "maxParallel": 1,
        "members": [{ "id": "coder", "cli": "local-codex", "model": "my-coder", "roles": ["coding"] }],
        "execution": { "transport": "shell", "sandbox": "workspace-write", "approval": "never" }
      }
    }
  }
}
```

Omit `authEnv` for an unauthenticated server. Otherwise it names an environment
variable containing a bearer credential; never put the value in configuration or
URLs. AIWG neither reads credential files nor logs the value. The wrapper owns
inference authentication independently. Declare `efforts` only when the wrapper
and checkpoint support those controls; omission reports effort as not applicable.
Limits, family, and checkpoint are operator declarations, not inferred capabilities.

`aiwg models refresh --json` observes declared sources with bounded
`GET <endpoint>/models` requests. CLIs with `localModels` use their endpoints;
other vendor CLIs retain normal discovery. Mixed projects store both kinds of
observation in one catalog cache. A project with only local sources contacts only
those endpoints. `aiwg models sources --json` reads cached observations without
HTTP requests; local instances are reused only while their declaration digest matches.
Discovery records only declared IDs present in the endpoint response as accessible;
missing IDs, downtime, timeouts, unauthorized responses, and malformed payloads
produce typed unavailable observations. Redirects are refused, responses are
limited to 1 MiB, and timeouts default to 3 seconds (maximum 30 seconds).
Loopback hosts are allowed; other self-hosted hosts require an exact hostname in
`localModels.allowedHosts`. URL credentials, queries, and fragments are refused.

Then run `aiwg doctor --probe-workers --qualify --yes --cli local-codex` to observe
again and approve accessible `(cli, model, role)` tuples through the existing signed
installation receipts. Configure `models.json` role guidance for group `local`,
then use `aiwg models resolve --role coding --task implementation --group local
--brief /absolute/brief.txt --workdir /absolute/tree --final-output /absolute/result.json
--transport shell --format shell`. Changing a declaration requires requalification.
No inference or model benchmark is performed by observation or qualification.

Observations carry source `local-endpoint`, endpoint URL, checkpoint label, and
`dataUse.processing: "local"`. Locality means the operator declares this CLI path
self-hosted. `/models` proves presence; it does not attest checkpoint bytes,
backend identity, offline operation, telemetry, retention, or wrapper routing.
Audit the wrapper/server configuration before declaring local processing.
Product-improvement and retention facts remain unknown. For unknown facts, the
existing `dataPolicy.allowUnknown` policy still applies. With
`dataPolicy.allowedProcessing: ["local"]`, only local-processing observations
are eligible. Qualified local observations also satisfy the local-only path
preflight; unavailable or unqualified observations cannot authorize dispatch.


---

## When to Use This Guide

Use this guide if you are:

- Running AIWG in an air-gapped or on-premises environment
- Reducing API costs for high-volume, repetitive SDLC tasks
- Experimenting with open-weight models alongside Claude or GPT
- Setting up a local fallback for when API providers are unavailable

---

## Quick Start

```bash
# Install Ollama (macOS / Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model that supports tool use (required for AIWG agents)
# Minimum recommended: qwen2.5-coder:14b or qwen3.5:9b on 8GB+ VRAM
ollama pull qwen2.5-coder:14b

# Install OpenCode (the recommended agentic platform for local model use)
npm install -g opencode-ai

# Configure OpenCode to use your local Ollama instance
# Create opencode.json in your project root:
cat > opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen2.5-coder:14b": { "name": "Qwen 2.5 Coder 14B" }
      }
    }
  },
  "model": "ollama/qwen2.5-coder:14b"
}
EOF

# Deploy AIWG agents and commands for OpenCode
aiwg use sdlc --provider opencode
```

> **Important**: AIWG requires tool use (function calling) support. Not all local models support this reliably. See [Tool Use Requirements](#tool-use-requirements-for-aiwg) below before selecting a model.

---

## Choosing Your Agentic Platform for Local Models

AIWG requires an **agentic platform** — a tool with file editing, shell execution, and tool use capabilities — not just a model API. Two platforms work well with local models:

### OpenCode (Recommended for Local Models)

OpenCode natively supports multiple model backends including Ollama and any OpenAI-compatible endpoint. No proxy required.

The direct worker adapter supports two distribution lines: npm `opencode-ai` versions `>=1.18.0 <2.0.0` (including 1.19.x), and the official installer/GitHub releases versions `>=2.0.26 <3.0.0`. The official installer places the 2.x binary at `~/.opencode/bin/opencode`; npm supplies the separate 1.x line. Check `command -v opencode` and `opencode --version` to identify the selected installation.

Effort uses `--model provider/model --variant <effort>` on 1.x and `--model provider/model#<effort>` on 2.x. The 1.19.0 help was captured on titan on 2026-11-15; the 2.0.26 help was captured on noodle on 2026-10-10. Version support does not establish installation qualification: existing model, permission and sandbox checks still apply.

```bash
# Install
npm install -g opencode-ai

# Configure with Ollama in opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen2.5-coder:14b": { "name": "Qwen 2.5 Coder 14B" }
      }
    }
  },
  "model": "ollama/qwen2.5-coder:14b"
}

# Deploy AIWG
aiwg use sdlc --provider opencode
```

See [OpenCode + Ollama Configuration Template](#opencode--ollama-configuration) for a complete template.

### Claude Code (via API Proxy)

Claude Code talks to the Anthropic API by default. To use local models, run a translation proxy (such as LiteLLM) that exposes an Anthropic-compatible API backed by your local model.

```bash
# Install LiteLLM
pip install litellm

# Start a proxy that routes Anthropic calls to Ollama
litellm --model ollama/qwen2.5-coder:14b \
        --api_base http://localhost:11434 \
        --port 4000 \
        --drop_params

# Point Claude Code at the proxy
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_API_KEY="local"

# Deploy AIWG
aiwg use sdlc --provider claude
```

> **Note**: Proxy-based setups add latency and an extra failure point. OpenCode's native Ollama integration is more reliable for local model use. Use the proxy approach when you want to stay in the Claude Code interface.

---

## Tool Use Requirements for AIWG

AIWG agents rely heavily on tool use (function calling) — reading files, editing code, running shell commands. **This is non-negotiable**: a model without reliable tool use cannot run AIWG workflows.

### Minimum Requirements

| Requirement | Why It Matters |
|-------------|----------------|
| Tool use / function calling | All AIWG agents use tools to read/edit files and run tests |
| Structured JSON output | Commands, agents, and skills require valid JSON for tool calls |
| Instruction following | AIWG prompts contain multi-constraint rules agents must follow |
| Context window ≥ 8K | AIWG sessions with multiple files easily exceed smaller windows |
| Context window ≥ 32K (recommended) | Comfortable headroom for SDLC orchestration workflows |

### Model Capability Matrix

| Model | Size | Tool Use | AIWG Compatible | Tier | Notes |
|-------|------|----------|-----------------|------|-------|
| qwen2.5-coder:14b | 14B | Yes | Yes | sonnet | Best coding quality/VRAM ratio of validated local models |
| qwen3.5:9b | 9B | Yes | Partial | sonnet | Strong coding, vision support (256K context), reasoning degrades on long chains |
| hermes-3-llama-3.1:8b | 8B | Yes | Partial | haiku | Good instruction following, limited multi-step planning |
| llama3.3:70b | 70B | Partial | Partial | opus | Closest to cloud quality; requires 48GB+ VRAM |
| codellama:34b | 34B | No | No | — | Strong code gen but no tool use; cannot run AIWG agents |
| llama3.1:8b | 8B | No | No | — | No tool use support |
| llama3.2:3b | 3B | No | No | — | Summaries/formatting only via direct prompting |

> **The 9B–14B sweet spot**: Models in the 9B–14B range running on 8–12GB VRAM (RTX 3080/4070 class) can now run AIWG workflows reliably. This is the recommended entry point for local use on consumer hardware.

---

## Decision Tree: Is Local Worth It?

```
Do you have GPU hardware with >= 16GB VRAM?
  No → Cloud API is almost certainly cheaper. Stop here.
  Yes → Continue.

Are your tasks highly repetitive (batch processing, summaries, formatting)?
  Yes → Local is likely cost-effective for the haiku/efficiency tier.
  No → Cloud API may still be cheaper when you factor in GPU time.

Do you have data residency or air-gap requirements?
  Yes → Local is required regardless of cost.

Are you running > 10,000 requests/month on the efficiency tier?
  Yes → Calculate break-even point (see Cost Comparison section).
```

---

## Ollama

Ollama is the fastest path to a working local model. It handles model download, quantization selection, and serving.

### Installation

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows (PowerShell)
winget install Ollama.Ollama

# Verify
ollama --version
```

### Recommended Models by Use Case

| Use Case | Model | Size | VRAM Required |
|----------|-------|------|---------------|
| Code generation (sonnet-tier) | codellama:34b | ~20GB | 24GB |
| Code generation (budget) | codellama:13b | ~8GB | 10GB |
| General reasoning | llama3.3:70b | ~40GB | 48GB |
| General reasoning (budget) | llama3.1:8b | ~5GB | 6GB |
| Fast summaries (haiku-tier) | llama3.2:3b | ~2GB | 4GB |
| Code completion | qwen2.5-coder:14b | ~9GB | 12GB |
| Code + reasoning (community) | qwen3.5:9b | ~6.6GB | 8GB |
| Instruction following (community) | hermes-3-llama-3.1:8b | ~5GB | 6GB |

```bash
# Pull models
ollama pull codellama:34b
ollama pull llama3.3:70b
ollama pull llama3.2:3b

# List running models
ollama ps

# Check available models
ollama list
```

### OpenAI-Compatible Endpoint

Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1`. No extra configuration is required.

```bash
# Test the endpoint
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "llama3.1:8b",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Persistent Service

```bash
# macOS: Ollama runs as a background service after install
# Linux: Enable and start the systemd service
sudo systemctl enable ollama
sudo systemctl start ollama

# Check status
sudo systemctl status ollama
```

---

## llama.cpp

For maximum control over inference parameters, quantization, and hardware utilization, use llama.cpp directly.

### Installation

```bash
# Clone and build (requires cmake and a C++ compiler)
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DLLAMA_CUDA=ON   # Add -DLLAMA_CUDA=ON for NVIDIA GPU
cmake --build build --config Release -j $(nproc)
```

### Starting the Server

```bash
# Serve a GGUF model on OpenAI-compatible API
./build/bin/llama-server \
  --model models/codellama-34b-instruct.Q5_K_M.gguf \
  --host 0.0.0.0 \
  --port 8080 \
  --n-gpu-layers 40 \
  --ctx-size 8192 \
  --parallel 4
```

Key flags:

| Flag | Description |
|------|-------------|
| `--n-gpu-layers` | Layers to offload to GPU (higher = faster, more VRAM) |
| `--ctx-size` | Context window size (larger = more VRAM) |
| `--parallel` | Concurrent request slots |
| `--n-predict` | Max tokens per response |

### Finding GGUF Models

```bash
# Download from Hugging Face using huggingface-cli
pip install huggingface_hub
huggingface-cli download \
  TheBloke/CodeLlama-34B-Instruct-GGUF \
  codellama-34b-instruct.Q5_K_M.gguf \
  --local-dir ./models/
```

---

## vLLM

vLLM provides production-grade serving with continuous batching and high throughput. Use it when serving multiple concurrent AIWG agent sessions.

### Installation

```bash
pip install vllm
```

### Starting the Server

```bash
# Serve with OpenAI-compatible API
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.3-70B-Instruct \
  --host 0.0.0.0 \
  --port 8000 \
  --tensor-parallel-size 2 \  # Number of GPUs
  --dtype bfloat16 \
  --max-model-len 32768
```

### When to Use vLLM vs. Ollama vs. llama.cpp

| Scenario | Recommended Tool |
|----------|-----------------|
| Personal/dev use, 1 user | Ollama |
| Maximum control, embedded use | llama.cpp |
| Team deployment, multiple concurrent users | vLLM |
| Production serving with SLAs | vLLM |
| Air-gapped workstation | Ollama or llama.cpp |

---

## Quantization Impact on Agent Performance

Quantization compresses model weights, reducing VRAM requirements at the cost of some quality. The trade-off is well-characterized for coding and reasoning tasks.

### Quantization Levels

| Format | Quality vs. F16 | Size vs. F16 | VRAM vs. F16 | Notes |
|--------|----------------|--------------|--------------|-------|
| F16 | Baseline (100%) | 100% | 100% | Maximum quality, most VRAM |
| Q8_0 | ~99% | 50% | 50% | Near-lossless, recommended if VRAM allows |
| Q5_K_M | ~97% | 31% | 31% | Best size/quality balance |
| Q4_K_M | ~95% | 25% | 25% | Good for coding tasks, some degradation on reasoning |
| Q4_0 | ~93% | 23% | 23% | Faster inference, more quality loss |
| Q2_K | ~87% | 13% | 13% | Useful only for low-complexity tasks |

### Quantization Recommendations by AIWG Tier

| AIWG Tier | Task Type | Minimum Quantization | Recommended |
|-----------|-----------|---------------------|-------------|
| opus (reasoning) | Architecture, security review | Q5_K_M | Q8_0 or F16 |
| sonnet (coding) | Code generation, debugging | Q4_K_M | Q5_K_M |
| haiku (efficiency) | Summaries, formatting | Q4_0 | Q4_K_M |

For security-critical tasks (threat modeling, vulnerability review), use Q8_0 or F16. Quality loss in lower quantizations can cause subtle reasoning errors that are difficult to detect.

---

## Hardware Requirements by Model Size

### Minimum VRAM for Full GPU Inference

| Model Size | Q4_K_M | Q5_K_M | Q8_0 | F16 |
|------------|--------|--------|------|-----|
| 3B | 2GB | 2.5GB | 4GB | 6GB |
| 7B | 4GB | 5GB | 8GB | 14GB |
| 13B | 8GB | 10GB | 14GB | 26GB |
| 34B | 20GB | 25GB | 38GB | 68GB |
| 70B | 40GB | 50GB | 75GB | 140GB |

### GPU Hardware Reference

| GPU | VRAM | Usable Models |
|-----|------|---------------|
| RTX 4060 | 8GB | 7B Q4, 13B partial offload |
| RTX 4070 Ti | 12GB | 13B Q4, 7B Q8 |
| RTX 4090 | 24GB | 34B Q4, 13B Q8, 7B F16 |
| 2x RTX 4090 | 48GB | 70B Q4, 34B Q8 |
| A100 80GB | 80GB | 70B Q8, 34B F16 |
| 2x A100 80GB | 160GB | 70B F16 |

### CPU Fallback

llama.cpp supports CPU inference for machines without sufficient VRAM. Expect 5–20x slower throughput than GPU. Acceptable for low-volume efficiency-tier tasks.

```bash
# CPU-only (no GPU flags)
./build/bin/llama-server \
  --model models/llama3.2-3b.Q5_K_M.gguf \
  --ctx-size 4096
```

---

## Cost Comparison: Local vs. API

### Example: Efficiency-Tier Agent at Scale

Scenario: Running 50,000 requests/month with average 500 input + 200 output tokens each.

| Approach | Monthly Cost | Notes |
|----------|-------------|-------|
| codex-mini-latest (API) | ~$52 | $1.50/1M input + $6/1M output |
| claude-haiku-3-5 (API) | ~$25 | $0.25/1M input + $1.25/1M output |
| Ollama on RTX 4070 Ti | ~$15 | Electricity at $0.15/kWh, 80W GPU load |
| Ollama on A100 (cloud) | ~$300 | $2/hr instance, 6 hrs/day at batch |

At 50,000 requests/month, local inference on owned hardware is competitive only when:
- The GPU is already paid for and sitting idle
- Electricity costs are low
- Requests are batchable (no interactive latency requirement)

For interactive SDLC workflows, cloud API almost always wins on effective cost per hour of developer time saved.

### Break-Even Calculation

```
GPU cost: $1,500 (RTX 4090)
Monthly electricity: $20
API cost avoided: $100/month (efficiency-tier at medium volume)

Break-even: $1,500 / ($100 - $20) = 18.75 months

If you plan to run for > 19 months AND have data residency needs: local wins.
Otherwise: cloud API is more practical.
```

---

## AIWG Integration: Configuring Local Model Providers

### OpenCode + Ollama Configuration

The recommended setup. Create `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen2.5-coder:14b": { "name": "Qwen 2.5 Coder 14B" },
        "qwen3.5:9b": { "name": "Qwen 3.5 9B" },
        "llama3.3:70b": { "name": "Llama 3.3 70B" }
      }
    }
  },
  "model": "ollama/qwen2.5-coder:14b",
  "mcp": {
    "aiwg": {
      "type": "local",
      "command": ["npx", "aiwg", "mcp", "serve"]
    }
  },
  "instructions": [
    "AGENTS.md",
    ".aiwg/instructions.md"
  ]
}
```

For LM Studio (OpenAI-compatible on port 1234):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1"
      },
      "models": {
        "qwen2.5-coder-14b-instruct": { "name": "Qwen 2.5 Coder 14B Instruct" }
      }
    }
  },
  "model": "lmstudio/qwen2.5-coder-14b-instruct"
}
```

### Claude Code + Local Models (via LiteLLM Proxy)

```bash
# Start LiteLLM routing Anthropic API calls to Ollama
litellm --model ollama/qwen2.5-coder:14b \
        --api_base http://localhost:11434 \
        --port 4000 \
        --drop_params

# Configure Claude Code to use the proxy
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_API_KEY="local"

# Deploy AIWG for Claude Code
aiwg use sdlc --provider claude
```

### models.json for Local Models

Create `models.json` in your project root to map AIWG tiers to local model names:

```json
{
  "ollama": {
    "reasoning": {
      "model": "llama3.3:70b",
      "description": "Local 70B for complex reasoning (requires 48GB+ VRAM)"
    },
    "coding": {
      "model": "qwen2.5-coder:14b",
      "description": "Best coding quality per VRAM among local models"
    },
    "efficiency": {
      "model": "qwen3.5:9b",
      "description": "9B model with tool use, vision, and 256K context on consumer hardware"
    }
  },
  "shorthand": {
    "opus": "llama3.3:70b",
    "sonnet": "qwen2.5-coder:14b",
    "haiku": "qwen3.5:9b"
  }
}
```

### Consumer Hardware Configurations

**8GB VRAM (RTX 3070/4060)**:
```json
{ "shorthand": { "sonnet": "qwen3.5:9b", "haiku": "qwen3.5:9b" } }
```

**12GB VRAM (RTX 3080/4070)**:
```json
{ "shorthand": { "sonnet": "qwen2.5-coder:14b", "haiku": "qwen3.5:9b" } }
```

**24GB VRAM (RTX 4090)**:
```json
{ "shorthand": { "opus": "qwen2.5-coder:32b", "sonnet": "qwen2.5-coder:14b", "haiku": "qwen3.5:9b" } }
```

**48GB+ VRAM (2x 4090 / A100)**:
```json
{ "shorthand": { "opus": "llama3.3:70b", "sonnet": "qwen2.5-coder:14b", "haiku": "qwen3.5:9b" } }
```

### Testing the Connection

```bash
# OpenCode + Ollama: verify models are available
curl http://localhost:11434/v1/models -H "Authorization: Bearer ollama"

# Test a tool call directly
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "qwen2.5-coder:14b",
    "messages": [{"role": "user", "content": "List 3 programming languages"}],
    "tools": [{"type": "function", "function": {"name": "list_items", "parameters": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "string"}}}}}}]
  }'
# If the response includes a tool_calls field, the model supports tool use with AIWG
```

### Prompt Format Considerations

Some open-weight models require specific prompt formats. Ollama handles this automatically. If using llama.cpp or vLLM directly, specify the correct template:

```bash
# llama.cpp: use the model's chat template
./build/bin/llama-server \
  --model models/llama3.3-70b.Q5_K_M.gguf \
  --chat-template llama3  # Applies correct <|begin_of_text|> formatting
```

Common templates: `llama2`, `llama3`, `chatml`, `mistral`, `gemma`.

---

## Performance Tuning

### Context Size vs. VRAM

Larger context windows require more VRAM for the KV cache:

```
KV cache ≈ 2 × n_layers × n_heads × head_dim × ctx_size × 2 bytes (fp16)

For Llama 3.1 8B at ctx=8192: ~0.5GB additional VRAM
For Llama 3.1 8B at ctx=32768: ~2GB additional VRAM
```

Set context size to match your actual usage, not the model maximum.

### Parallel Slots

```bash
# llama.cpp: allow 4 concurrent AIWG agents
./build/bin/llama-server --parallel 4

# vLLM handles this automatically via continuous batching
```

### Ollama Concurrency

```bash
# Set concurrency in Ollama environment
export OLLAMA_NUM_PARALLEL=4
export OLLAMA_MAX_LOADED_MODELS=2
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| VRAM OOM error | Model too large for available VRAM | Use lower quantization or smaller model |
| Slow first response | Model loading on first request | Pre-warm with a test request at startup |
| Garbled output | Wrong prompt format/template | Specify `--chat-template` in llama.cpp or use Ollama |
| `connection refused` | Server not running | Verify `ollama serve` or llama-server is active |
| Low throughput on batch ops | Sequential processing | Enable `--parallel` in llama.cpp or use vLLM |
| AIWG sends to wrong endpoint | `OPENAI_BASE_URL` not set | Export variable before running `aiwg` commands |

---

## Community Validated Setups

The following setups have been tested and reported working by community members.

### Qwen 3.5:9B on Ollama

- **Model**: `qwen3.5:9b`
- **Backend**: Ollama
- **Tier mapping**: sonnet
- **Strengths**: Strong coding quality, good tool use support, solid structured output
- **Limitations**: Reasoning quality degrades on multi-step planning tasks; SDLC workflow support is partial
- **VRAM**: ~6GB (default quantization), 8GB recommended
- **Configuration**:

```json
{
  "shorthand": {
    "sonnet": "qwen3.5:9b",
    "haiku": "llama3.2:3b"
  }
}
```

### Hermes 3 (Llama 3.1 8B) on Ollama

- **Model**: `hermes-3-llama-3.1:8b`
- **Backend**: Ollama
- **Tier mapping**: haiku
- **Strengths**: Good instruction following, reliable tool use, consistent output formatting
- **Limitations**: Limited multi-step planning, not recommended for SDLC orchestration workflows
- **VRAM**: ~5GB (default quantization), 6GB recommended
- **Configuration**:

```json
{
  "shorthand": {
    "haiku": "hermes-3-llama-3.1:8b"
  }
}
```

For the full compatibility matrix and more community-tested models, see [Supported Models](supported-models.md).

To contribute your own model test results, see [Community Model Testing Guide](../contributing/model-testing.md).

---

## See Also

- [Supported Models](supported-models.md) — Full compatibility matrix for all tested models
- [Community Model Testing](../contributing/model-testing.md) — How to submit test results
- `docs/models/hybrid-architectures.md` — Routing between local and cloud models
- `docs/models/gpt-optimization.md` — OpenAI-compatible API patterns
- `docs/integrations/codex-quickstart.md` — Codex CLI setup
- `agentic/code/addons/rlm/README.md` — Handling large contexts with local models
