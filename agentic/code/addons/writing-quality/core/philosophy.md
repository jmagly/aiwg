# Core Writing Philosophy

## The Fundamental Problem

Some writing patterns can feel formulaic in a particular context; they do not identify human or AI authorship:

- Over-polished and formulaic
- Marketing-speak instead of expertise
- Vague generalities instead of specifics
- Performative helpfulness
- Consistent structure that feels robotic

## The Solution: Write Like a Human Expert

### Principle 1: Accuracy Over Enhancement

**Never invent or embellish.**

Bad:
> "Led a team of 15 engineers to deliver a groundbreaking platform that revolutionized payment processing"

Good:
> "Managed 8 engineers building a payment gateway. Processed $2M daily by launch."

The truth is interesting enough. Don't add fiction to make it "better."

### Principle 2: Technical Authority, Not Sales Pitch

**Write like you built it, not like you're selling it.**

Bad:
> "This cutting-edge solution seamlessly integrates multiple payment providers through an innovative abstraction layer"

Good:
> "The payment abstraction handles Stripe, PayPal, and Square. Same API for all three - saved us from vendor lock-in."

### Principle 3: Specific Beats General

**Source-supported numbers, names and details can improve specificity. They do not prove authorship.**

Bad:
> "Significantly improved system performance"

Good:
> "Cut p95 latency from 800ms to 120ms by switching from REST to gRPC"

### Principle 4: Natural Variation

Let the explanation determine sentence and paragraph length. Keep related facts
together so readers can follow the reason or result. Use the
[shared structural rules](../patterns/common-ai-tells.md) to review fragment runs
and repeated rhetorical frames; do not manufacture irregularity or errors.

### Principle 5: Include the Messy Reality

**Real projects have problems, trade-offs, and context.**

Bad:
> "Successfully implemented microservices architecture"

Good:
> "Broke the monolith into 12 services. Kubernetes complexity nearly killed us, but we needed independent deployments."

## The Voice of Experience

### Show Implementation Scars

Real experts mention:

- What broke
- What took longer than expected
- Why certain decisions were made
- What they'd do differently

Example:
> "We picked Cassandra for scale but didn't anticipate the operational overhead. Three years later, we're still fighting
> consistency issues."

### Include Context and Constraints

Bad:
> "Architected a highly available system"

Good:
> "Built for 99.9% uptime because that's what the SLA required. 99.99% would've tripled our AWS costs."

### Voice Opinions

Experts have perspectives:

- "Kubernetes is overkill for most startups"
- "CQRS sounds good until you debug event sourcing at 3am"
- "Sometimes a boring Rails monolith is the right choice"

## Writing Rhythm

### Natural Transitions

Instead of formal conjunctions, use:

- **Time markers**: "By 2019...", "Initially...", "These days..."
- **Context shifts**: "At Amazon...", "The auth system...", "Production showed..."
- **Questions**: "The problem? Scale.", "Why Redis? Speed."
- **Direct starts**: Just begin with the subject

### Sentence Variety

Mix:

- Short, punchy statements
- Longer explanations with technical detail
- Questions
- Fragments for emphasis
- Lists when appropriate

### Paragraph Flow

Avoid:

- Starting every paragraph the same way
- Consistent paragraph lengths
- Predictable structure
- Summary sentences

## Audience and Voice Review

Read your content aloud. Does it sound like:

1. **A Wikipedia article?** Too formal, no personality
2. **Marketing copy?** Too polished, selling something
3. **A technical paper?** Formal language may be appropriate for the audience
4. **Someone explaining their work?** ✅ This is the goal

## Examples of Authentic Voice

### Generic Example

> "Furthermore, the implementation of advanced caching mechanisms dramatically improved response times, showcasing the
> transformative power of modern optimization techniques. This comprehensive approach underscores the vital role that
> performance tuning plays in contemporary web applications."

### Specific Example (Requires Supporting Facts)

> "Response times sucked - 3 seconds for a simple query. Added Redis caching and got it down to 200ms. Should've done it
> from the start but we were rushing to launch."

## Final Reminder

You're not writing to impress or to be comprehensive. You're sharing knowledge like you would with a colleague. Include
the complexity, the trade-offs, and the reality of building systems.

The goal isn't perfection - it's authenticity.
