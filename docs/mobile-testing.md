# Phone testing

Expo Go and Tailscale let you test a worktree on the phone without a native build.

```sh
./scripts/dev-mobile.sh start
```

Send the printed `exp://` link. Stop it with:

```sh
./scripts/dev-mobile.sh stop
```

`status`, `restart`, and `rebuild` do what they say. Logs are in
`~/.cache/typo-dev/logs/`.

Open the link in Expo Go. If tapping does nothing, paste it into
"Enter URL manually".

Native changes (splash, icons, permissions, and `modules/typo-vault`) cannot be
tested through Expo Go. Expo Go uses the async filesystem fallback, so it cannot
verify the native vault I/O speedup. Install an APK from CI or build one with
`bun run android` on an attached device or emulator. Rebuild the APK after changing
the native module. See [builds and releases](builds.md).

For the native performance pass, use a disposable demo vault with nested folders,
a folder ending in `.typ`, and a CRLF note. Check Names and Everywhere search,
source highlighting and saving, continuous PDF scrolling and pinch zoom, external
edits after returning to the library, and repair after deleting a generated PDF.
Do not use private notes in screenshots or recordings.

Run `bun test` before starting. The start script rebuilds `dist/` when needed.
After rebuilding web bundles, fully reload the app to load the new runtime files.
