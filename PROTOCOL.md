# ContentViewPro — Agent Protocol

Version: 1.0
Date: 2026-04-27

This document defines the contract between AI writing agents and ContentViewPro. It is platform-agnostic — any agent (Claude, GPT, Gemini, or otherwise) that follows this protocol can integrate with ContentViewPro.

ContentViewPro is a human review layer, not an AI tool. The agent writes, the human judges. This protocol defines what the agent must do before, during, and after each review cycle.

---

## The Review Loop

```text
Agent writes draft
  → Self-critique pass (required)
  → Fact-check pass (required)
  → Drop to drafts/
Human reviews in ContentViewPro
  → Approves or annotates each paragraph
  → Submits review
Agent reads feedback from reviews/
  → Revises flagged paragraphs
  → Drops revised draft (round + 1) to drafts/
Repeat until all paragraphs approved
  → Final markdown compiled and delivered
```

---

## Subagent Writing Rules

Before any draft is dropped to `drafts/`, the writing agent must complete two internal passes. These are not optional and are not visible to the human reviewer — they happen before the draft enters the review queue.

### Pass 1 — Self-Critique

After completing the draft, re-read it with fresh eyes and apply these criteria. Flag any paragraph that fails — rewrite before dropping.

#### Voice and tone

- Does this sound like a human wrote it?
- Is the language direct, or is it hedging, over-explaining, or padding?
- Does the opening line earn attention, or does it start with context the reader doesn't need yet?

#### Structure

- Does each paragraph make one clear point?
- Are transitions natural, or do paragraphs feel pasted together?
- Is the conclusion doing actual work, or is it just restating the intro?

#### Specificity

- Has any claim been left vague when it could be specific?
- Are there statistics, examples, or names that would strengthen a weak assertion?
- Has anything been overpromised ("always," "never," "the best") without evidence?

#### Length and density

- Is every sentence earning its place?
- Are there run-on sentences that should be split?
- Are there two-sentence paragraphs that should be merged with neighbors?

### Pass 2 — Fact-Check

Before dropping, verify any factual claims in the draft. For each claim, the agent must either:

- Confirm it from a known reliable source, OR
- Mark it in the notes field as unverified so the human reviewer can check

#### What to check

- Statistics and numbers: source, recency, accuracy
- Product names, feature names, URLs: spelled correctly, still accurate
- Procedural claims ("to do X, go to Settings > Y"): verify the navigation path
- Named people or organizations: name spelled correctly, role/affiliation accurate
- Legal or regulatory claims: flag for professional review if outside the agent's confidence

**How to handle unverified claims**
Do not remove claims you cannot verify. Instead, add a note to that paragraph:

```text
[FACT-CHECK NEEDED: "X statistic" — source unknown. Please verify before publishing.]
```

This note becomes visible to the reviewer in the notes panel and can be addressed before the round is submitted.

---

## Draft Format

Markdown files with YAML frontmatter. Filename should be slug-style, descriptive, with round suffix.

```text
{slug}-r{round}.md
```

Example: `negative-keywords-law-firms-r1.md`

### Frontmatter

```yaml
---
title: "Full article title"
client: "Client name or 'internal'"
type: "content type (e.g. blog-post, short-form, long-form)"
date: YYYY-MM-DD
round: 1
---
```

### Body

Paragraphs separated by blank lines. No heading hierarchy required — the app treats each double-newline-separated block as one reviewable unit. Short consecutive lines (e.g. a bullet list) should be grouped as a single block by wrapping them together with no internal blank line.

---

## Review Output Format

After the human submits, ContentViewPro writes a JSON file to `reviews/` with the same filename stem:

```json
{
  "source": "negative-keywords-law-firms-r1.md",
  "reviewedAt": "2026-04-27T06:00:00Z",
  "round": 1,
  "paragraphs": [
    {
      "index": 0,
      "original": "Paragraph text.",
      "status": "approved",
      "notes": null
    },
    {
      "index": 1,
      "original": "Another paragraph.",
      "status": "revised",
      "notes": "Too vague. Here's a rewrite direction: focus on the cost of not doing this."
    }
  ],
  "order": [0, 1]
}
```

- `status`: `"approved"` or `"revised"`
- `notes`: `null` for approved; reviewer's note, rewrite direction, or full rewrite for revised
- `order`: paragraph index array reflecting any drag-and-drop reordering. Respect this order in the revision.

---

## Reading Feedback and Revising

On receiving a review JSON:

1. **Approved paragraphs**: carry forward unchanged (preserving reviewer's intended order)
2. **Revised paragraphs**: treat the `notes` field as instruction. If it contains a full rewrite, clean and polish it. If it contains direction only, rewrite the paragraph to satisfy that direction.
3. **Fact-check notes from Pass 2**: these appear in `notes` — resolve them or escalate to the reviewer
4. **Order**: assemble the final draft in the sequence defined by `order`, not the original paragraph order
5. **Round increment**: write the revision as `{slug}-r{round+1}.md`

Do not ask clarifying questions between rounds. The review JSON contains all instructions. If a note is ambiguous, make your best interpretation and flag it in your Pass 1 critique of the revision.

---

## Filesystem Interface

ContentViewPro watches the filesystem. There are no API calls required.

| Action                  | Path                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| Drop draft              | `{app_root}/drafts/{filename}.md`                                       |
| Check review status     | `{app_root}/state/{filename}.json` — present = in progress or submitted |
| Pull completed feedback | `{app_root}/reviews/{filename}.json` — present = review submitted       |
| Drop revision           | `{app_root}/drafts/{slug}-r{round+1}.md`                                |

`app_root` is configured per deployment. Set it to the directory where you installed ContentViewPro.

---

## Chunking Large Articles

For articles over ~800 words, use parallel subagents:

- Each subagent receives: outline, voice guide, section assignment, prior sections (for continuity)
- Each subagent completes Pass 1 and Pass 2 before returning output
- Orchestrator assembles sections, runs a final Pass 1 across the full assembled draft, then drops to `drafts/`
- Maximum section size: 600 words

Do not drop partial drafts. The file in `drafts/` should always represent a complete, self-critique-passed article.

---

## Round Conventions

- `round: 1` — first submission
- `round: 2+` — revisions
- Old round files remain in `drafts/` (reviewed versions auto-archived by the app)
- Never overwrite a previous round file

---

## What This Protocol Does Not Cover

- How the agent generates its initial outline (out of scope — use your own process)
- Voice, tone, or style guides (supply these separately; they don't belong in this protocol)
- Distribution or publishing (ContentViewPro outputs clean markdown; publishing is downstream)
- AI-assisted fact-checking tools (the agent is responsible for Pass 2; tooling is the agent's choice)
