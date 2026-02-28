#!/bin/bash
set -euo pipefail

WORKSPACE_DIR="/home/rodrigo/Workspace/openclaw-workspace"
INSTALL_DIR="/home/rodrigo/Workspace/openclaw"

cd "$WORKSPACE_DIR"

# Branches to rebase onto main and compose into runtime.
# Order matters: branches with shared commits should be adjacent
# so git can skip already-applied commits cleanly.
BRANCHES=(
  feat/whatsapp-reply-activation
  feat/whatsapp-quote-reply
  plugin/memory-qdrant
)

# Fork-only files that live on main but not upstream.
# These are preserved across resets to upstream.
FORK_ONLY_FILES=(
  update-openclaw.sh
  create-runtime-branch.sh
)

UPSTREAM_REMOTE="origin"
FORK_REMOTE="fork"

# Fetch once upfront instead of on every pull --rebase
echo "==> Fetching ${UPSTREAM_REMOTE}/main and ${FORK_REMOTE}..."
git fetch "$UPSTREAM_REMOTE" main
git fetch "$FORK_REMOTE" main "${BRANCHES[@]}"
# runtime may not exist on fork yet (first run); fetch it separately so failure is non-fatal
git fetch "$FORK_REMOTE" runtime 2>/dev/null || true

# Phase 0: Sync local main with upstream and push to fork
# Save fork-only files, reset to upstream, then re-add them.
echo ""
echo "==> Phase 0: Sync main with ${UPSTREAM_REMOTE}/main"
git checkout main

# Save fork-only files to a temp dir before resetting
tmpdir=$(mktemp -d)
for f in "${FORK_ONLY_FILES[@]}"; do
  [[ -f "$f" ]] && cp "$f" "$tmpdir/"
done

git reset --hard "${UPSTREAM_REMOTE}/main"

# Restore fork-only files and commit them
restored=false
for f in "${FORK_ONLY_FILES[@]}"; do
  if [[ -f "$tmpdir/$f" ]]; then
    cp "$tmpdir/$f" "$f"
    git add "$f"
    restored=true
  fi
done
rm -rf "$tmpdir"

if $restored && ! git diff --cached --quiet; then
  git commit -m "chore: add runtime management scripts"
fi

git push --force "$FORK_REMOTE" main

# Phase 1: Rebuild each feature branch on top of main.
# Cherry-pick only feature-specific commits, skipping commits that only
# modify fork-management scripts (left over from earlier rebase cycles).
echo ""
echo "==> Phase 1: Rebuild feature branches on main"
for branch in "${BRANCHES[@]}"; do
  echo "--- ${branch}"
  # Collect SHAs unique to the fork's feature branch (not on fork/main)
  mapfile -t shas < <(git log --reverse --format=%H "${FORK_REMOTE}/${branch}" --not "${FORK_REMOTE}/main")

  # Start a fresh branch from main
  git checkout -B "$branch" main

  for sha in "${shas[@]}"; do
    # Check if every changed file is a fork-only script; if so, skip it
    files=$(git diff-tree --no-commit-id --name-only -r "$sha")
    non_script=$(echo "$files" | grep -vE '^(update-openclaw\.sh|create-runtime-branch\.sh)$' || true)
    if [[ -n "$non_script" ]]; then
      git cherry-pick "$sha"
    else
      echo "    skip $(git log --format='%h %s' -1 "$sha")"
    fi
  done

  git push --force "$FORK_REMOTE" "$branch"
done

# Phase 2: Compose runtime as main + all branches (linear rebase)
echo ""
echo "==> Phase 2: Build runtime branch"
# Create or switch to runtime; it may not exist locally or remotely on first run
git checkout runtime 2>/dev/null || git checkout -b runtime
git reset --hard main

for branch in "${BRANCHES[@]}"; do
  echo "--- Rebasing ${branch} into runtime"
  git rebase "$branch"
done

# Phase 3: Push
echo ""
echo "==> Phase 3: Push runtime"
# Use --force because runtime is rebuilt from scratch every run
git push --force "$FORK_REMOTE" runtime

echo ""
echo "==> Done! runtime is main + ${BRANCHES[*]}"

cd "$INSTALL_DIR"

# Make runtime the current branch in the main openclaw repository and update it
git fetch "$FORK_REMOTE" runtime
if git checkout runtime 2>/dev/null; then
  :
elif git show-ref --verify --quiet refs/heads/runtime; then
  # Local runtime branch exists but isn't available in this worktree.
  git checkout --detach "$FORK_REMOTE/runtime"
else
  git checkout -b runtime "$FORK_REMOTE/runtime"
fi
git reset --hard "$FORK_REMOTE/runtime"

echo ""
echo "==> Runtime branch is ready in both repositories!"

# Update openclaw installation
echo ""
echo "==> Updating openclaw installation..."

# Rebuild first so the global `openclaw` binary is valid before
# calling gateway commands (the old link may point to a stale path).
pnpm install
pnpm build
pnpm ui:build
pnpm link -g

# Install openclaw-mcp-adapter plugin
echo ""
echo "==> Installing openclaw-mcp-adapter plugin..."
cd /home/rodrigo/Workspace/openclaw-mcp-adapter
git pull
# Remove existing plugin so a fresh install picks up changes
rm -rf ~/.openclaw/extensions/openclaw-mcp-adapter
python3 - <<'PY' 2>/dev/null || true
import json
import pathlib

p = pathlib.Path.home() / ".openclaw/openclaw.json"
if not p.exists():
    raise SystemExit(0)

c = json.loads(p.read_text())
plugins = c.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
    c["plugins"] = plugins

entries = plugins.get("entries")
if isinstance(entries, dict):
    entries.pop("openclaw-mcp-adapter", None)

installs = plugins.get("installs")
if isinstance(installs, dict):
    installs.pop("openclaw-mcp-adapter", None)

load = plugins.get("load")
if isinstance(load, dict):
    paths = load.get("paths")
    if isinstance(paths, list):
        filtered = [entry for entry in paths if "openclaw-mcp-adapter" not in str(entry)]
        if filtered:
            load["paths"] = filtered
        else:
            load.pop("paths", None)
    if not load:
        plugins.pop("load", None)

p.write_text(json.dumps(c, indent=2) + "\n")
PY
openclaw plugins install .

# Configure MCP servers for the adapter plugin
openclaw config set plugins.entries.openclaw-mcp-adapter.config.servers '[{"name":"playwright","transport":"http","url":"http://192.168.3.53:8932/sse"},{"name":"windows","transport":"http","url":"http://localhost:8000/sse"}]'

# Now that the binary works, cycle the gateway service.
cd "$INSTALL_DIR"
openclaw gateway stop  || true
openclaw gateway uninstall || true
openclaw gateway install
openclaw gateway start

echo ""
echo "==> OpenClaw is up to date and running!"
echo "Version: $(openclaw --version)"
