# ContentViewPro Spec

This spec is a public snapshot of the current architecture. More detailed product and protocol documentation is WIP; see `PROTOCOL.md` for the agent-facing file contract.

## Purpose

ContentViewPro is a local-first desktop app for paragraph-by-paragraph review of AI-generated content drafts. An external agent writes Markdown drafts into a workspace, a human reviewer approves or annotates each paragraph, and the app writes structured JSON feedback for the agent to consume.

## Current Architecture

- **Desktop shell**: Tauri 2.
- **Primary app logic**: Rust Tauri commands in `src-tauri/src/lib.rs` read drafts, persist review state, submit review JSON, and manage the optional local review server.
- **Frontend**: Vite + React + TypeScript in `src/`.
- **Browser/dev API**: Express + TypeScript in `server/index.ts`, bound to loopback by default and proxied by Vite during browser-mode development.
- **Optional local access**: Rust `axum` server started from the desktop dashboard. It is off by default and binds to `127.0.0.1` unless `CVP_BIND_ADDR` is set.
- **Storage**: Filesystem only. No database and no cloud account.

## Workspace Layout

The desktop app asks the user to choose a workspace folder on first launch and stores that path in the Tauri app store. The workspace contains:

```text
workspace/
+-- drafts/          # Markdown drafts from an external agent
+-- reviews/         # Submitted review JSON files
`-- state/           # Autosaved in-progress review state
```

The browser-mode server uses `CVP_DATA_DIR` as its workspace root, defaulting to repo-local `data/`.

## Draft Input

Drafts are Markdown files with YAML frontmatter:

```markdown
---
title: "Example Article"
client: "Demo Project"
type: "blog-post"
date: 2026-04-27
round: 1
---

First paragraph text.

Second paragraph text.
```

Paragraphs are separated by blank lines after frontmatter is parsed.

## Review Output

Submitted reviews are written to `reviews/{article-id}.json`:

```json
{
  "source": "example-article.md",
  "reviewedAt": "2026-04-27T06:00:00Z",
  "round": 1,
  "paragraphs": [
    {
      "index": 0,
      "original": "First paragraph text.",
      "status": "approved",
      "notes": null
    },
    {
      "index": 1,
      "original": "Second paragraph text.",
      "status": "revised",
      "notes": "Tighten the opening and add a source for the claim."
    }
  ],
  "order": [0, 1]
}
```

## Main User Flow

1. Reviewer chooses a workspace folder.
2. Agent writes a Markdown draft into `drafts/`.
3. Dashboard lists available drafts and review progress.
4. Reviewer opens a draft, approves or annotates each paragraph, and optionally reorders paragraphs.
5. App autosaves state to `state/`.
6. Reviewer submits when all paragraphs are addressed.
7. App writes review JSON to `reviews/` and marks the state as submitted.

## API Surface

The desktop app uses Tauri commands:

- `list_articles`
- `get_article`
- `save_state`
- `submit_review`
- `start_lan_server`
- `stop_lan_server`
- `get_lan_status`

Browser-mode development uses local HTTP endpoints:

```text
GET  /api/articles
GET  /api/articles/:id
PUT  /api/articles/:id/state
POST /api/articles/:id/submit
```

## Public Release Notes

- Product name: ContentViewPro
- Package slug: `contentviewpro`
- Repository: public repository URL
- License: MIT
