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
demand from the Actions tab. It is the automated twin of `npm run deploy`:
build with Vite, then force-push only `dist-editor/` (plus `.nojekyll`) to the
`gh-pages` branch using the workflow's built-in `GITHUB_TOKEN`.

- No secrets to configure — `GITHUB_TOKEN` is provided by GitHub.
- Works with the existing Pages setup (source: `gh-pages` branch). Live site:
  <https://ysetbon.github.io/OpenStrandJS/>.
- `npm run deploy` still works for manual/local deploys; the workflow just
  makes it happen on every merge.

## Claude review bot — `.github/workflows/claude-review.yml`

Every non-draft PR (on open, new pushes, and ready-for-review) gets an
automatic review from [Claude Code](https://github.com/anthropics/claude-code-action):
inline comments on specific lines plus a summary comment, with a prompt tuned
to this repo (renderer fidelity, oracle drift, store/undo state, hot paths).

**One-time setup (required before it can run):**

1. Create an API key at <https://console.anthropic.com/>.
2. Repo → Settings → Secrets and variables → Actions → New repository secret:
   name `ANTHROPIC_API_KEY`, value = the key.

Notes:

- Without the secret the workflow will fail — it does not block merging
  (reviews are advisory, not required checks).
- To pin a specific model, add `--model <model-id>` to `claude_args` in the
  workflow; by default the action uses its current recommended model.
- You can also get on-demand help by adding an `@claude` mention workflow —
  see the [claude-code-action docs](https://github.com/anthropics/claude-code-action)
  if you want that in addition to automatic reviews.

## CodeRabbit review bot (GitHub App — no workflow file)

[CodeRabbit](https://coderabbit.ai) is an AI code reviewer that runs as a
GitHub App, so it is installed on the repository rather than added to
`.github/workflows/`. **It is free for public/open-source repos** (the full Pro
feature set, same AI models as the paid plan), which is why it's a good fit for
this project.

**Setup (already done for OpenStrandJS):**

1. Install **CodeRabbit** from the GitHub Marketplace
   (<https://github.com/marketplace/coderabbitai>) on the **Open Source (free)**
   plan.
2. Grant it access to the `OpenStrandJS` repository.
3. Finish onboarding in the CodeRabbit wizard (<https://app.coderabbit.ai>).

From then on it reviews each PR automatically: inline comments, a PR summary,
and 40+ built-in linters. It works out of the box with no config, but you can
tune it by committing a `.coderabbit.yaml` at the repo root — see
<https://docs.coderabbit.ai/getting-started/configure-coderabbit>.

CodeRabbit and the Claude workflow are independent and complementary — run
either or both. (Baz, the reviewer we first looked at, is org/team-oriented and
paid, so it isn't used here.)

### Other free options for individuals / public repos

- **Sourcery** — free for public repos and individual use; strong on JS/TS
  refactoring and code smells. <https://sourcery.ai>
- **GitHub Copilot code review** — if you have any Copilot plan (Free tier
  includes 50 review requests/month), add **Copilot** as a reviewer on a PR
  natively; nothing to install.
