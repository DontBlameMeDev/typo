# Performance

The performance is a CI job which makes sure the app follows our performance
standards.

## Reproduce

If you want to create the benchmarks locally, use:

```sh
bun install --frozen-lockfile
bun scripts/benchmark.ts
```

Native storage and search benchmarks (Expo Go cannot measure native I/O):

1. Use a disposable demo vault.

2. Temporarily replace `index.ts` with:
   
   ```ts
   import "./scripts/benchmark-mobile";
   ```

3. Build the web resources and native app: `bun run android`.

4. Stop its default Metro server, then run:
   
   ```sh
   bun expo start --dev-client --no-dev --minify --clear
   ```

5. Reconnect the development client and read `[benchmark]` JSON from logcat or
   the app.

6. Restore `index.ts`.

## Startup

Cold start is the time from the process starting to the first painted library
frame, which is what the user spends looking at the launch screen. It is
measured on an emulator by `scripts/startup.ts`: the probe build logs its marks
once, and the script reads them next to the process start event from logcat.

Probe marks come from `EXPO_PUBLIC_TYPO_STARTUP=1`, so release builds stay
silent. To measure locally:

```sh
bun run build:web
bunx expo prebuild -p android --clean
export EXPO_PUBLIC_TYPO_STARTUP=1
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64)
adb install -r android/app/build/outputs/apk/release/app-release.apk
bun scripts/startup-seed.ts
bun scripts/startup.ts
```

`startup-seed.ts` writes a fixture vault and points the app at it through the
system folder picker, so every measurement covers the same saved folder and
cached library.

The `Startup` workflow runs the same steps on a pull request. The `Audit`
workflow compares the result with `.github/startup-floor.json` from the `floors`
branch, which also holds the performance ceilings. The headline number is the
fastest of the launches, because contention can only add time. A run fails the
`Startup audit` check when that number grows past the floor by more than 25%
plus 50 ms. Pushes to `main` record a new floor.
