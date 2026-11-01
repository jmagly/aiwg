# Verbalized Sampling Addon

Evidence status: paper-reported ([arXiv:2510.01171](https://arxiv.org/abs/2510.01171)), not measured in AIWG.

Training-free prompting technique. The paper reports it improves output diversity by 1.6-2.1x (paper-reported, not measured in AIWG) by asking models to generate probability distributions over responses rather than single outputs.

## Research

Based on [Verbalized Sampling: How to Mitigate Mode Collapse and Unlock LLM Diversity](https://arxiv.org/abs/2510.01171) (arXiv:2510.01171v3).

The paper reports RLHF alignment reduces output diversity by 40-60% (paper-reported, not measured in AIWG). Verbalized Sampling is designed to recover this diversity without retraining by asking models to explicitly reason about response probabilities.

## Installation

```bash
aiwg use verbalized-sampling
```

## Components

| Type | Name | Description |
|------|------|-------------|
| Prompt | vs-standard | Standard VS with probability distribution |
| Prompt | vs-cot | Chain-of-thought variant for deep ideation |
| Prompt | vs-multi | Multi-response with diversity filtering |
| Agent | verbalized-content-diversifier | Applies VS techniques to generation tasks |
| Skill | diversity-tuning | Interactive parameter tuning with presets |
| Rule | diversity-awareness | Detects when VS should be suggested |

## Quick Start

```
# Generate diverse tagline alternatives
"Generate 5 diverse taglines for our product launch"

# Tune diversity level
"tune diversity to creative"

# Compare presets
"compare diversity: moderate vs maximum for naming ideas"
```

## Presets

| Preset | k | Threshold | Best For |
|--------|---|-----------|----------|
| conservative | 3 | 1.0 | Minor variation |
| moderate | 5 | 0.1 | General use (default) |
| creative | 8 | 0.05 | Ideation sessions |
| maximum | 12 | 0.01 | Full exploration |

## Integration with Voice Framework

When the voice-framework addon is also installed, VS layers before voice application:

1. Generate k diverse alternatives via VS
2. Apply voice profile to each output
3. Result: diverse AND voice-consistent options

## Configuration

In `.aiwg/config.yaml`:

```yaml
addons:
  verbalized-sampling:
    k: 5
    diversityThreshold: 0.1
    outputFormat: json
    autoApply: false
```
