# Phone testing

Expo Go and Tailscale let you test each worktree on the phone without a native build.

## Agent

```sh
./scripts/dev-mobile.sh start
```

Send the printed `exp://` link. Stop it with:

```sh
./scripts/dev-mobile.sh stop
```

`status`, `restart`, and `rebuild` do what they say. Logs are in
`~/.cache/typo-dev/logs/`. Use `start --dev-client` for native changes.

## Phone

Open the link in Expo Go. If tapping does nothing, paste it into "Enter URL manually".

Run `bun test` before starting, because it rebuilds `dist/`.
