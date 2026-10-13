# ishiki

Event-driven bot core + packages (see `package.json` workspaces). The `docs/` workspace has its own agent context; this file governs the repo root.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/`. See `.agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, label string equals role name. See `.agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `.agents/adr/`. See `.agents/domain.md`.
