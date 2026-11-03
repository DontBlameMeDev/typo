# Builds and releases

## Android builds

The Android workflow builds an APK for `arm64-v8a` and `x86_64` on every push to
`main`, on an approving review, and when a pull request gets the `build-android`
label. Use the label when you cannot approve your own pull request.

Download `typo-android-<commit sha>` from the run's Artifacts section. For an
approved pull request the name is the PR head SHA, but the APK was built from the
PR merge commit. Artifacts expire after 30 days, and a newer push cancels an
older `main` build.

Main builds are signed with the `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, and
`KEY_ALIAS` repository secrets. Pull request builds use the debug key, so
installing one over a release build needs an uninstall.

## Releases

1. Bump `version` and `android.versionCode` in `app.json`.
2. Commit and push to `main`.
3. Wait for the Android workflow.
4. Run `./scripts/release.sh`.

The script downloads the APK built for HEAD, checks the version code and the
signature, then creates the tag and release with `gh`. Release notes come from
`docs/releases/<version>.md`.
