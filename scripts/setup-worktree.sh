#!/usr/bin/env bash
# Install dependencies for a new worktree, before the agent needs them.
#
# The dev shell installs a pre-commit hook in the shared git dir and links
# .pre-commit-config.yaml into the checkout it starts in. Leaving the git tree
# first keeps that out of worktree creation, then bun installs by path.
set -euo pipefail

worktree="$(git rev-parse --show-toplevel)"
cd /tmp
nix develop "$worktree" -c bun install --frozen-lockfile --cwd "$worktree"
