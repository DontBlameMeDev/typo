---
name: mobile-testing
description: Use when wanting to test the app via expo go. This may be the user asking, or you needing to use this.
---

## Goal

Get the current worktree running on a phone through Expo Go and Tailscale, or
through a native APK when the change needs it.

## Rules

- Run `bun test` before starting.
- Use a disposable demo vault. Never use private notes in screenshots or
  recordings.
- Do not use Expo Go to verify native changes. Use a native build.
- After rebuilding web bundles, fully reload the app.

## Expo Go

Start the dev server:

```sh
./scripts/dev-mobile.sh start
```

Send the user the printed `exp://` link. The script rebuilds `dist/` when
needed.

Other commands: `status`, `restart`, `rebuild`, `stop`. Logs are in
`~/.cache/typo-dev/logs/`.

Stop the server when done:

```sh
./scripts/dev-mobile.sh stop
```

## Native changes

Splash, icons, permissions, and `modules/typo-vault` cannot be tested through
Expo Go. Expo Go uses the async filesystem fallback, not the native vault I/O.

For these changes:

- Install an APK from CI, or build one with `bun run android` on an attached
  device or emulator.
- Rebuild the APK after changing the native module.
