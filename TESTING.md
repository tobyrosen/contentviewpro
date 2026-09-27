# Test gates

Use Node 22 and stable Rust, then run:

```bash
npm ci
npm run test:gate
```

`npm test` runs Node security tests, the TypeScript typecheck, and the Vite build.
The Rust checks run separately because some
hosted runners lack the GTK system libraries the Tauri Rust crate needs to
compile. The full gate (`test:gate`, including `cargo test`) runs locally
on machines where those libraries exist.

The gate unit-tests the Tauri core's Markdown/frontmatter parsing, article ID
validation, review finalization, symlink rejection, bearer authentication, and
LAN startup failure behavior. Node tests cover API auth, contained file access,
tab-scoped browser tokens, and safe submission responses. It also type-checks the
TypeScript frontend and server, builds the Vite frontend, and compile-checks
the Rust library.

## Full harness follow-up

A full desktop harness needs a Tauri WebDriver-compatible runner on each
supported OS, a temporary workspace injected before launch, and deterministic
IPC/LAN fixtures. It should cover first-run folder selection, draft discovery,
autosave and reorder persistence, submission files, unauthorized LAN requests,
and restart recovery. Browser-only component tests cannot prove the native
filesystem permissions or Tauri command wiring.
