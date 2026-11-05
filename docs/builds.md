# Builds and releases

## Android builds

The Android workflow builds an APK for `arm64-v8a` and `x86_64` on every push to
`main`, on an approving review, when a pull request gets the `build-android`
label, and when the Release workflow asks for one. Use the label when you cannot
approve your own pull request.

Download `typo-android-<commit sha>` from the run's Artifacts section. For an
approved pull request the name is the PR head SHA, but the APK was built from the
PR merge commit. Artifacts expire after 30 days, and a newer push cancels an
older `main` build.

Main builds are signed with the `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, and
`KEY_ALIAS` repository secrets. Pull request builds use the debug key, so
installing one over a release build needs an uninstall.

## Releases

Run the **Release** workflow from the Actions tab and pick `patch`, `minor`, or
`major`. The workflow:

1. Bumps `version` and `android.versionCode` in `app.json` and pushes the
   commit to `main`.
2. Builds the signed APK with the Android workflow.
3. Checks the APK version code.
4. Creates the tag and publishes `typo-<version>.apk`.

The body comes from `docs/releases/<version>.md`. Commit that file for the
version the bump will produce before running the workflow. Without the file,
GitHub generates the notes from the merged pull requests.

If a run stops after pushing the bump, run it again. It releases the version
already in `app.json` instead of bumping twice.
