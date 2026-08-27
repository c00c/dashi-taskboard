# Upgrading the Copilot canvas overlay

The customization checkout is the durable source for the user-scoped
`~/.copilot/extensions/taskboard` link. Keep that checkout in place after
installation. The extension resolves the additive canvas adapter, the existing
Taskboard server, and the rebuilt web application from that one checkout; it
does not contain copied server or `dist/web` source.

## Merge an upstream revision

Configure the original repository once, then merge its history into a clean
customization branch. Do not rebase, squash, or force-push the overlay across an
upstream update.

```bash
git remote add upstream https://github.com/chuspeeism/dashi-taskboard.git
git fetch upstream
git switch <customization-branch>
git merge --no-ff upstream/main
```

If `upstream` already exists, verify it with `git remote get-url upstream`
instead of adding it again. Resolve conflicts only at intentional overlay seams:
`copilot/taskboard-canvas`, the server host-action boundary, web host
capabilities, installation scripts, and their focused tests.

## Rebuild and validate

From the merged customization checkout, run:

```bash
npm ci
npm run build:web
npm run copilot:verify-canvas
npm run typecheck
git diff --check
node --check copilot/taskboard-canvas/extension.mjs
node --check copilot/taskboard-canvas/service.mjs
node --check copilot/taskboard-canvas/host-actions.mjs
node --check scripts/install-copilot-canvas.mjs
node --check scripts/verify-copilot-canvas-install.mjs
```

`copilot:verify-canvas` verifies installation from an unrelated working
directory, loads the installed adapter, checks the returned URL and existing
data API, exercises close/reopen, runs the Canvas service and host-action
contract, and retains the focused Codex host compatibility checks. Run
`npm run copilot:install-canvas` again only if the checkout location changed or
the user-scoped link was removed; normal upstream merges update the linked
runtime in place.
