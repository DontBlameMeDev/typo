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
