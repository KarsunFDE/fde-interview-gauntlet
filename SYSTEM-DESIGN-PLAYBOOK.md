# System Design Playbook — how to spend your time

A field guide for the **System Design Simulator**. The full exercise (scope → design → explain → adapt) runs about **45 minutes**, so time management *is* the skill being tested. The single most common reason people underperform a system-design interview isn't lack of knowledge — it's failing to deliver a coherent design in the time given. Drive the clock; don't let it drive you.

> **This is a 20-minute *design* phase, then you explain and adapt.** High-level and minimal is *correct*. You are not expected to detail everything — you *are* expected to scope, reason, handle the hard parts, and flag the rest.

---

## The shape of the session

| Phase | Where, in this tool | Target time |
|-------|---------------------|-------------|
| 1. Scope the problem | Clarify-chat with the client | ~5 min |
| 2. High-level design | The Excalidraw canvas | ~10 min |
| 3. Deep-dive the hard parts | Still on the canvas | ~5 min |
| **(Done → Explain)** | | |
| 4. Explain the WHY | Spoken narration | up to ~10 min |
| 5. Adapt | The re-think follow-ups | ~5–10 min |

Phases 1–3 are your **20-minute design budget**. Running long costs a few points, so converge.

---

## The five moves

### 1. Scope first — ask before you draw (~5 min)
Never design before you know what you're designing for. Ask the client about:
- **Functional** — "users should be able to…" — the 1–3 core features. Prioritize; don't list ten.
- **Non-functional** — scale, latency/SLA, availability, consistency, security/tenancy. These *shape the architecture*.
- **Numbers** — users, requests/sec, data size, growth. Quantify before you design.

Asking even **2–3 sharp questions** before drawing is the win. Jumping straight to boxes is the #1 thing this program is correcting.

### 2. Name core entities + the interface (~2–3 min)
A quick bulleted list of the key entities (the data your system exchanges and stores) and the main API/operations. Keep it minimal — a first draft, not a schema.

### 3. High-level design — boxes and arrows (~10 min)
Sketch the **major components** (clients, API/gateway, services, datastore, cache, queue, etc.) and the **core workflow end-to-end**. Keep entities minimal. Talk as you draw — state *why* each piece is there. Get "buy-in" with yourself the way you would with an interviewer.

### 4. Deep-dive the hard parts (~5 min)
Pick the **1–2 riskiest pieces** — the bottleneck, the failure mode, the consistency or scale challenge — and go deeper there. **Deep dives carry the most weight (~40% of the score)**, yet most candidates burn their time polishing the high-level diagram and rush this. Don't gold-plate the easy parts. Design for failure, not the happy path.

### 5. Explain & defend the WHY (the narration)
For every major choice: **why this, what alternative you considered, what it costs.** Name at least one alternative per major component. This is where you show judgment, not just recall.

### 6. Adapt — the re-think round
When a constraint changes ("now it needs 99.9% uptime", "now 100× the traffic"), **rework live and narrate the tradeoff.** Composure and reasoning beat a perfect answer.

---

## What earns points (and what loses them)

**Earns it**
- Scoped first; named the non-functional requirements.
- Drove the design; kept it high-level and coherent.
- Named tradeoffs and an alternative for major choices.
- Handled at least one failure/scale concern.
- Flagged what you'd detail with more time.

**Loses it**
- Jumped straight to drawing with no scoping.
- Happy-path only — no failure modes, no scale story.
- Gold-plated the easy parts; rushed the deep dive.
- Asserted choices with no WHY.
- Tried to detail *everything* and ran long.

---

## Go deeper (resources)

- **Hello Interview — Delivery Framework** (the timings above, built by FAANG staff): https://www.hellointerview.com/learn/system-design/in-a-hurry/delivery
- **ByteByteGo / Alex Xu — A Framework for System Design Interviews** (the canonical 4-step framework): https://bytebytego.com/courses/system-design-interview/a-framework-for-system-design-interviews
- **Hello Interview — Core Concepts**: https://www.hellointerview.com/learn/system-design/in-a-hurry/core-concepts
- **Exponent — System Design Interview Guide**: https://www.tryexponent.com/blog/system-design-interview-guide
- **IGotAnOffer — System Design Interviews (from FAANG experts)**: https://igotanoffer.com/blogs/tech/system-design-interviews

*Sources researched via /web-research (Firecrawl) on 2026-06-25.*
