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

Native changes (splash, icons, permissions) cannot be tested through Expo Go.
Install an APK from CI or build one with `bun run android` on an attached device
or emulator. See [builds and releases](builds.md).
