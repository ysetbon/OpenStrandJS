# CI / CD / review bots

Three GitHub Actions workflows live in `.github/workflows/`, plus one GitHub
App (Baz) that is installed on the repository rather than configured in code.

## CI — `.github/workflows/ci.yml`

Runs on every pull request and every push to `main`. The full pixel-fidelity
harness (`npm run prove`) needs the Qt reference app next to this repo, so it
stays local; CI runs everything that works on a hosted runner:

| Job | What it checks |
| --- | --- |
| `typecheck` | `npm run build` (tsc) — the whole project typechecks. |
| `build-and-smoke` | `npm run build:editor` (Vite production build), then the Chromium smoke tests below. |

The smoke tests are `tools/ci_smoke.mjs` (new, oracle-free):

- **Renderer smoke** — renders a set of fixtures with the real Paper.js
  renderer (`web/render.html`) in headless Chromium, sizing the canvas from
  each fixture's own bounding box. Fails if a fixture renders nothing or
  throws. The PNGs are uploaded as the `ci-smoke-renders` workflow artifact so
  a reviewer can eyeball what a PR draws.
- **Editor smoke** — serves the built `dist-editor/` under the production
  `/OpenStrandJS/` base path, loads it in Chromium, and fails unless the app
  boots with no page errors, mounts a canvas, and exposes
  `window.renderFixture`.

Run them locally with:

```sh
node tools/ci_smoke.mjs render fixtures/single_strand.json
npm run build:editor && node tools/ci_smoke.mjs editor dist-editor
```

(Set `OSS_CHROMIUM=/path/to/chromium` if your Playwright browser download
doesn't match the pinned Playwright version — same escape hatch as
`tools/js_render.mjs`.)

## CD — `.github/workflows/deploy.yml`

Deploys automatically after every merge to `main` (any push to `main`), and on
demand from the Actions tab. It builds the editor with Vite, then publishes it to
the `gh-pages` branch using the workflow's built-in `GITHUB_TOKEN`.

- No secrets to configure — `GITHUB_TOKEN` is provided by GitHub.
- Works with the existing Pages setup (source: `gh-pages` branch). Live site:
  <https://ysetbon.github.io/OpenStrandJS/>.
- The publish is **non-destructive**: it clones `gh-pages`, replaces only the
  editor's root files (leaving `/fidelity/` untouched), and fast-forward-pushes
  with retry. So the hosted fidelity dashboards (below) survive editor deploys,
  and the editor deploy and a concurrent fidelity publish can't clobber each
  other on a merge to `main`.
- `npm run deploy` still runs the local twin (`tools/deploy-pages.mjs`), which
  force-pushes only `dist-editor/`; prefer the workflow, or fetch `/fidelity/`
  first if you deploy manually.

## Hosted fidelity dashboards (GitHub Pages)

The fidelity workflow publishes the self-contained OSS-vs-JS dashboard to the same
`gh-pages` site as a **gallery**, so you can browse every comparison in a browser
without downloading the artifact zip:

- **Gallery / landing page:** <https://ysetbon.github.io/OpenStrandJS/fidelity/> —
  one card per dashboard (a snapshot thumbnail of one example, the PR number, the
  head branch / worktree name, and the match summary), sorted with `main` first
  then PRs by number descending. Each card links to its full dashboard.
- **Canonical (main):** `…/fidelity/main/` — refreshed on every merge to `main`
  (the fidelity workflow also runs on `push: main`).
- **Per-PR preview:** `…/fidelity/pr-<N>/` — published on each PR run and linked
  at the top of that PR's sticky fidelity comment.

Each run writes only its own `<sub>/` entry (`index.html` + `meta.json` +
`thumb.png` + a `snaps/<fixture>.png` per example, via `tools/fidelity_entry.mjs`),
then rebuilds the landing page from the union of every entry's `meta.json`
(`tools/fidelity_index.mjs`). Publishing is non-destructive (fast-forward push
with retry), so concurrent PRs and the editor deploy coexist.

### Choosing a card's representative example (admin-only)

Every gallery card has a client-side **toggle** (hover for arrows, or click the
dots) that flips its snapshot through each example the run exercised — a preview
only, available to anyone viewing the page. **Persisting** which example a card
shows is admin-only:

- The card shows the exact inputs (`sub=…`, `fixture=…`) and a **"Set as card
  thumbnail (admin)"** button that deep-links to the `fidelity-thumb.yml`
  workflow's *Run workflow* page.
- `.github/workflows/fidelity-thumb.yml` is a `workflow_dispatch` — GitHub only
  shows *Run workflow* to users with write access, and the workflow's first step
  additionally **fails unless the triggering user has `admin` permission** on the
  repo. So only an admin of `ysetbon/OpenStrandJS` can change a card's snapshot.
- It re-points `<sub>/thumb.png` at the chosen `snaps/<fixture>.png`, records
  `meta.selected`, and rebuilds the gallery (non-destructive push). The choice is
  remembered by `fidelity_entry.mjs` across later fidelity re-runs.

GitHub can't pre-fill `workflow_dispatch` inputs from a URL, so the admin enters
the `sub` and `fixture` values shown on the card (the `fixture` field is a
dropdown of the known examples).

## Claude review bot — `.github/workflows/claude-review.yml`

**Opt-in, not automatic.** A review from [Claude Code](https://github.com/anthropics/claude-code-action)
runs only when a PR carries the **`claude-review`** label — inline comments on
specific lines plus a summary comment, with a prompt tuned to this repo
(renderer fidelity, oracle drift, store/undo state, hot paths). It was switched
from run-on-every-PR to opt-in because each automatic run spends real
`ANTHROPIC_API_KEY` tokens; CodeRabbit already reviews every PR, so routine PRs
keep coverage at no Anthropic-API cost.

**How to request a Claude review:**

1. One-time: create the label — repo → Issues → Labels → New label, name it
   exactly `claude-review`.
2. Add the `claude-review` label to the PR. The review runs, and re-runs on
   later pushes while the label stays on. Remove the label to stop.

**One-time setup (required before it can run):**

1. Create an API key at <https://console.anthropic.com/>.
2. Repo → Settings → Secrets and variables → Actions → New repository secret:
   name `ANTHROPIC_API_KEY`, value = the key.

Notes:

- Without the secret a labeled run will fail — it does not block merging
  (reviews are advisory, not required checks).
- To pin a cheaper/specific model, add `--model <model-id>` to `claude_args` in
  the workflow; by default the action uses its current recommended model.
- You can also get on-demand help by adding an `@claude` mention workflow —
  see the [claude-code-action docs](https://github.com/anthropics/claude-code-action)
  if you want that in addition to label-triggered reviews.

## Baz review bot (GitHub App — no workflow file)

[Baz](https://baz.co) is an AI code reviewer that runs as a GitHub App, so it
is installed on the repository rather than added to `.github/workflows/`:

1. Install **Baz AI Code Review** from the GitHub Marketplace
   (<https://github.com/marketplace/baz-review>, app:
   <https://github.com/apps/baz-reviewer>).
2. During installation, grant it access to the `OpenStrandJS` repository
   (choose "Only select repositories").
3. Finish account setup on baz.co when prompted. From then on it reviews each
   PR automatically — it groups big diffs into topics, flags risky changes,
   and learns from your past review comments.

Baz and the Claude workflow are independent; you can enable either or both.
