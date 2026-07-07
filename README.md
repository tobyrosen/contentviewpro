# ContentViewPro

ContentViewPro is a local-first desktop app for reviewing AI-generated content drafts paragraph by paragraph. It gives a human reviewer a focused workspace to approve good paragraphs, leave revision notes, reorder sections, and submit structured feedback that an external writing agent can read.

The app does not call an AI model. Drafts, review state, and submitted feedback stay on your filesystem.

## Features

- Paragraph-level approve/revise workflow for Markdown drafts
- Drag-and-drop paragraph reordering
- Autosaved in-progress review state
- Submitted JSON review files for agent handoff
- First-run workspace selection in the desktop app
- Optional local review server from the desktop app

## How It Works

```text
Agent writes draft -> workspace/drafts/article.md
Reviewer opens ContentViewPro
Reviewer approves, annotates, and reorders paragraphs
ContentViewPro saves progress in workspace/state/
Reviewer submits
ContentViewPro writes workspace/reviews/article.json
Agent reads the feedback and writes the next draft round
```

Drafts are Markdown files with YAML frontmatter. Paragraphs are split on blank lines.

```markdown
---
title: "Your Article Title"
client: "Demo Project"
type: "blog-post"
date: 2026-04-27
round: 1
---

First paragraph goes here.

Second paragraph goes here.
```

## Install

Download the latest release from this repository's Releases page, open ContentViewPro, and choose a workspace folder on first launch.

Your workspace should contain these folders:

```text
workspace/
+-- drafts/
+-- reviews/
`-- state/
```

The app creates missing folders as needed.

## Development

Requirements:

- Node.js 22, matching `.nvmrc`
- Rust stable
- Tauri 2 platform prerequisites for your operating system

```bash
git clone <repository-url>
cd contentviewpro
npm ci
npm run tauri:dev
```

For browser-mode development, run:

```bash
npm run dev
```

Browser mode starts the local Express API on `127.0.0.1:3033` and Vite on `localhost:5173`.
By default, the Express API reads and writes `data/drafts/`, `data/state/`,
and `data/reviews/`; set `CVP_DATA_DIR` to use another workspace folder.

## Scripts

- `npm run dev` - start the browser-mode API and Vite dev server
- `npm run tauri:dev` - start the Tauri desktop app in development mode
- `npm run build` - build the Vite frontend
- `npm run lint` - run ESLint
- `npm test` - run TypeScript type checking
- `npm run tauri:build` - build the desktop app

## Agent Integration

See [PROTOCOL.md](./PROTOCOL.md) for the file formats and review-cycle contract used by writing agents.

## License

MIT License. Copyright (c) 2026 Rosen Advertising.
