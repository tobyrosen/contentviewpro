# ContentViewPro

[![Release](https://img.shields.io/github/v/release/tobyrosen/contentviewpro?sort=semver&display_name=tag&label=release&style=flat-square)](https://github.com/tobyrosen/contentviewpro/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/tobyrosen/contentviewpro/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/tobyrosen/contentviewpro/actions/workflows/ci.yml) [![License](https://img.shields.io/github/license/tobyrosen/contentviewpro?label=license&style=flat-square)](LICENSE) [![Type](https://img.shields.io/badge/type-standalone--software-3776ab?style=flat-square)](#) [![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](#)

Local-first desktop review for AI-generated drafts, built for paragraph-level human feedback.

ContentViewPro gives reviewers a focused workspace to approve good paragraphs, leave revision notes, reorder sections, and submit structured feedback that an external writing agent can read.

The app does not call an AI model. Drafts, review state, and submitted feedback stay on your filesystem.

## Why ContentViewPro

Content review often breaks down when feedback lives in chat threads, comments, and one-off notes. ContentViewPro keeps the review loop file-based and repeatable: drafts go in, paragraph decisions and revision notes come out as structured JSON.

## Features

- Paragraph-level approve/revise workflow for Markdown drafts
- Drag-and-drop paragraph reordering
- Autosaved in-progress review state
- Submitted JSON review files for agent handoff
- First-run workspace selection in the desktop app
- Optional bearer-authenticated local review API from the desktop app
- Browser-only Insights for your own edit-pattern reports and voice guide

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
By default, the Express API reads and writes repository-root `drafts/`, `state/`,
and `reviews/`. Set `CVP_DATA_DIR` to use another workspace folder;
`CVP_DATA_DIR=data` preserves the older browser workspace location.

Local browser use on loopback works without authentication. Set `CVP_TOKEN`
to enable bearer authentication; it is required when `HOST` is not loopback
or Insights is configured. Enter the same token at browser sign-in. The token
is kept only for the current tab and cleared after an unauthorized response.

To enable Insights, set `CVP_INSIGHTS_ROOT` to an absolute directory containing
your own reports, then set `CVP_MINER_DIR` to a relative directory of
`run-*.json` files and/or `CVP_VOICE_SPEC` to a relative Markdown filename.
No reports are bundled. Paths must stay inside the Insights root; symlinks
and non-regular files are rejected. Workspace directories and files must also
be regular, non-symlink paths.

The desktop local API requires `CVP_LAN_TOKEN` in the app process environment
and starts on `127.0.0.1`. To bind all interfaces, select **Allow other devices**
and confirm the dashboard warning. Requests use bearer authentication. This
mode uses plaintext HTTP: use a trusted network because a network observer
can capture the token. The desktop API does not serve the browser frontend.

## Scripts

- `npm run dev` - start the browser-mode API and Vite dev server
- `npm run tauri:dev` - start the Tauri desktop app in development mode
- `npm run build` - build the Vite frontend
- `npm run lint` - run ESLint
- `npm test` - run Node security tests, TypeScript type checking, and the frontend build
- `npm run test:gate` - run Node and Rust tests, type checking, the frontend build, and
  a Rust library compile check
- `npm run tauri:build` - build the desktop app

## Agent Integration

See [PROTOCOL.md](./PROTOCOL.md) for the file formats and review-cycle contract used by writing agents.

## Releases

Versions are cut automatically by release-please after Conventional Commit messages are merged to `main`. Download built desktop apps from the [Releases](https://github.com/tobyrosen/contentviewpro/releases) page.

## Roadmap

- Packaged, installer-based desktop builds for macOS and Windows, distributed alongside the existing releases
- A mobile companion app for on-the-go review

## Contributing

Issues and pull requests are welcome. Use Conventional Commits for PR titles and commits because release-please uses them to determine version bumps and changelog entries.

## License

MIT License. Copyright (c) 2026 Rosen Advertising.
