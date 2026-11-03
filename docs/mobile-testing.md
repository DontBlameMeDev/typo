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
`~/.cache/typo-dev/logs/`.

Native changes (splash, icons, permissions) need an installed build and cannot
be tested through Expo Go. Build one with `bun run android` on an attached
device or emulator, or download the APK built by CI.

## CI builds

Every push to `main` runs the Android workflow, which builds a release APK for
`arm64-v8a` and `x86_64`. Pull requests build one when a reviewer approves them
or when someone adds the `build-apk` label, which is how a solo maintainer asks
for a build. Open the run on GitHub,
scroll to Artifacts, and download `typo-android-<commit sha>`. Artifacts expire after 14 days. The APK is signed
with the runner's debug keystore, which CI caches so upgrades keep working. If
the keystore is ever regenerated, uninstall the app before installing the new
APK.

`main` keeps only the newest build running, so pushing several commits cancels
the earlier APKs. Releases reuse the APK from the `main` run: bump the version
in `app.json`, push, wait for the workflow, then run `./scripts/release.sh`.

## Phone

Open the link in Expo Go. If tapping does nothing, paste it into "Enter URL manually".

Run `bun test` before starting, because it rebuilds `dist/`.
