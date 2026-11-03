# Phone testing

## Local development

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

Open the link in Expo Go. If tapping does nothing, paste it into "Enter URL manually".

Native changes (splash, icons, permissions) cannot be tested through Expo Go.
Build one with `bun run android` on an attached device or emulator, or install
the APK built by CI.

## CI builds

Every push to `main` builds a release APK for `arm64-v8a` and `x86_64`. Pull
requests build one when a reviewer approves them or when someone adds the
`build-android` label, which is how a solo maintainer asks for a build.

Open the run on GitHub, scroll to Artifacts, and download
`typo-android-<commit sha>`. Artifacts expire after 30 days. `main` keeps only the
newest build running, so pushing several commits cancels the earlier runs.

Main builds are signed with the release keystore from the `KEYSTORE_BASE64`,
`KEYSTORE_PASSWORD`, and `KEY_ALIAS` repository secrets. Pull request builds use
the debug key, so installing one over a release build needs an uninstall.

Releases reuse the APK from the `main` run: bump the version in `app.json`,
push, wait for the workflow, then run `./scripts/release.sh`.
