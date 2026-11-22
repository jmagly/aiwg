---
title: "What's been happening with AIWG since 2026.3.x"
slug: "2026-5-where-things-are"
date: "2026-05-11"
summary: "A retrospective on the quiet stretch since March: what the 2026.5.x line actually means — project-local artifacts, the kernel pivot, discover-first, the Hermes audit — and the work behind it."
hero: "https://docs.aiwg.io/assets/blog/2026-5-where-things-are.png"
reading_time: 6
status: "published"
canonical: "https://aiwg.io/blog/2026-5-where-things-are"
pillar: "3 retrospective"
audience: "people following AIWG from outside the Discord/Telegram rooms"
tags: ["ai-coding", "open-source", "retrospective", "release"]
---

# What's been happening with AIWG since 2026.3.x

![An AIWG operations timeline with abstract release markers, agent capability panels, documentation cards, and integration nodes arranged across a clean technical control surface.](/assets/blog/2026-5-where-things-are.png)

The last big public post about AIWG was around the `2026.3.x` line in March. The `2026.5.x` line shipped today. People in the Discord and Telegram rooms have watched the whole thing happen in flight, but if you've been following from outside those rooms, the gap probably looks like silence.

## What 2026.5.x actually means

The headline change in `2026.5.0` is "Project-Local + Kernel-Pivot Maturity." Both of those phrases mean something specific, and both of them landed because real usage made the case for them.

**Project-local artifact lifecycle.** You can scaffold a per-project rule, agent, skill, addon, or framework under `.aiwg/{type}/<name>/`, deploy it alongside the upstream artifacts, audit it with `aiwg doctor --project-local`, and graduate it to the upstream corpus or a private corpus path with a hash-verified copy when it's earned its keep. The whole chain — `aiwg new-bundle` → `aiwg use` → `aiwg doctor` → `aiwg remove` → `aiwg promote` — exists because customizing AIWG without forking it was the most common ask from teams running it on real projects. The portability invariant is byte-identical between project-local and upstream form, so promotion is a copy, not a rewrite. There's an ADR explaining why.

**Kernel pivot.** Most of AIWG's surface (something like 380+ skills) is no longer in any provider's always-listed skill set. Only a small kernel — framework quickrefs, the language map, and a handful of self-maintenance ops — is loaded by default. Everything else is reached through `aiwg discover` and `aiwg show`. This isn't a feature for fun; it's the only way the catalog stays usable as it grows past every platform's listing budget. Claude Code defaults to a 25% context cap. OpenClaw has a hard limit at 150. Codex caps `AGENTS.md` at 32 KB. The kernel approach works under all of them.

**Discover-first protocol.** Rule 1.5 in `skill-discovery.md` now mandates `aiwg discover` *before* filesystem search whenever a query mentions AIWG-specific terms. The discoverability system stops being something agents skip in favor of fast grep. This rule landed because of feedback from a Factory droid user who hit exactly the failure mode it prevents: an agent has fast filesystem tools and a literal-string match, so it short-circuits to grep and never realizes a ranked answer was one CLI call away. The fix was to write the rule down and put it in the always-loaded kernel.

**Hermes integration audit.** Hermes is the 9th platform AIWG deploys to, and the integration claims were drifting from the actual Hermes code at HEAD. So I pulled the upstream repo and audited every claim against source. The result: `AGENTS.md` for Hermes went from 30 KB+ down to a 579-byte thin pointer, the `.hermes.md` twin gets the MCP-specific suffix it was missing, `aiwg-orchestrate` auto-installs on first deploy, the slash commands in the docs match the slash commands in the binary, and every claim in the Hermes Capabilities Reference cites a Hermes source file. If you're a Hermes user and you hit anything that doesn't match upstream, file an issue — the bar now is "matches HEAD or it's a bug."

**Per-platform session reload notice.** Every `aiwg use` now ends with a "Session reload required:" section that names the action, rationale, and symptom for whichever provider you deployed to. The "Agent type 'X' not found" symptom that drove people up the wall earlier — when a deploy happened mid-session and the session predated it — gets diagnosed at the source instead of getting blamed on imaginary subagent-isolation bugs.

There's more in the `2026.5.0` entry — the publish pipeline got rewritten because the old one had been silently failing for many rcs before I caught it on a token rotation, the `inferType()` reclassifier moved 380+ artifacts out of the silent `document` bucket where they'd been hiding, the architecture overview docs landed with 8 mermaid diagrams, and the Claude Code plugin marketplace went from 7 plugins to 13 so every framework is `/plugin install <name>@aiwg`. [Read the CHANGELOG](https://github.com/jmagly/aiwg/blob/main/CHANGELOG.md) if you want the full sweep.

Note that we're retiring RC versioning going forward — straight to stable cuts, multiple updates a week when warranted. If you need to control when you take upgrades for a key process, pin a specific version. As always I'll try to get bugs and issues addressed quickly, so if you hit a problem please don't hesitate to file one.

Filing is easier than it used to be. The repo has issue templates in `.github/ISSUE_TEMPLATE/` — bug report, feature request, tester report, and imported report. There are kernel skills (`aiwg-issue` and `aiwg-pr`) that walk an agent through filing one correctly, and `docs/contributing/filing-issues.md` + `filing-pull-requests.md` cover the same ground for humans.

## What I've been using AIWG for, since you asked

I've been heads-down on the work, and the work has mostly been AIWG building things with AIWG, yes it sounds as strange said as it does read. Integro Labs ships a wider open-source layer called the Agentic Operating System — AOS for short — and AIWG is the cognitive part of it. The runtime part has been getting attention too.

I want to take a moment to thank the people using AIWG and pushing on it. The range surprises me every time I look at it — individuals who've told me this is the first time they've sat at a computer to seriously make something, all the way through to entire teams running it on production work. It's amazing to me. Every gap, every misclick, every "why doesn't this just work" has come from people willing to keep showing up and tell me what's not working. The framework is what it is because of that, and the cadence in the rooms is the proof.

And on that note — there's a thread of community testing I want to flag. People in those rooms have been running AIWG against local models, including some as small as 9B, and reporting back that the framework holds up better than I'd have guessed at that scale. They've been pushing me to test against local stacks more myself, and they've been right to push. I've started doing it. If that direction matures, it means more places AIWG can run and (quietly) maybe better sleep. The local-runtime side of AOS — agentic-sandbox below — is part of the same picture.

The piece I'd point at if you want to see where this is going is **agentic-sandbox**: run your agent in its own VM, for hours, on your hardware. No hosted control plane, no shared kernel, no session tied to your terminal. Long-running coding sessions. Overnight refactors. Multi-day research runs. Agents that need to keep working while you sleep, on data that can't leave your network, on hardware you control.

agentic-sandbox is MIT, in the open, and the code is at [github.com/jmagly/agentic-sandbox](https://github.com/jmagly/agentic-sandbox). It's a sibling to AIWG, not downstream of it — they're meant to compose.

## Where to find me

The Discord and Telegram rooms have been the daily channel for the whole `2026.3.x` → `2026.5.x` stretch and they're going to stay that way. If you want to ask questions, see what's about to land, or just lurk, those are the places.

- **Discord:** [discord.gg/nyFRDqQR89](https://discord.gg/nyFRDqQR89)
- **Telegram:** [AIWG Telegram foyer](https://t.me/joinaiwg): verify there, then get an invite to the group
- **GitHub:** [github.com/jmagly/aiwg](https://github.com/jmagly/aiwg)
- **Site:** [aiwg.io](https://aiwg.io)
- **Issues:** [github.com/jmagly/aiwg/issues](https://github.com/jmagly/aiwg/issues)

If you're already running AIWG, the quickest way to pick up `2026.5.x` is `aiwg refresh`. Doctor the install with `aiwg doctor` after. If you hit anything that doesn't square with the docs, file the bug — `flow-release` is fast enough now that fixes turn around in hours, not weeks.

That's where things stand. Thanks to everyone who's been in the rooms keeping the cadence honest.

— Joe

---

## Tools & transparency

AIWG is open about how its content is made.

- **Words:** mostly AI-generated, then fact-checked and edited by a human.
- **Facts and claims:** every detail reflects the actual 2026.5.x work — human-verified, nothing model-invented left unchecked.
- **Imagery:** hero image AI-generated with ChatGPT from a post-specific prompt; no readable text or brand logos are AI-rendered.
- **Final pass:** human.

Net: AI-drafted, human-fact-checked.
