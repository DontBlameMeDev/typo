# Performance

Includes main's continuous PDF preview and pinch zoom.

## Changes

- Search runs in an isolated WebView. Names is the default and sends only titles and paths. Content adds source bodies. Everywhere also matches titles and paths. Later requests send only changes.
- Editor parsing and highlighting run in a worker. Text can become ready before highlighting finishes. Stale results cannot replace another document.
- Compiler scheduling yields after an 8 ms work budget instead of after every file.
- Android vault reads use an async local Expo module. A single directory cursor supplies type and size metadata, and file reads avoid repeated provider queries. Expo Go keeps the async Expo filesystem fallback.
- The PDF viewer renders visible pages before overscan, evicts only published canvases, and coalesces pinch updates through animation frames.

Every vault refresh still reads fresh content. Compiler collection retains complete metadata preflight, the 32 MiB per-file and 100 MiB total limits, and actual-byte checks. Directory traversal, cancellation draining, errors, and missing-PDF repair remain in place. Source and metadata concurrency stays at 24. Compiler reads allow two pending requests and one native encoder to limit allocation spikes when files grow after preflight. There is no timestamp cache or polling change.

## Latest vault measurements

The async cap-24 implementation and the native implementation ran against the same unchanged synthetic vault: 1,000 notes, 20 folders, and 9,397,890 source bytes. Each operation used six alternating-order iterations, excluding the first, for five warm paired samples per variant. Scan and first-callback timings come from the original run. Compiler-input timings come from a later paired run that keeps at most two pending reads and one native encoder, after large-file checks showed that concurrent encoders could exhaust a 192 MiB Java heap. Do not compare absolute timings between the runs.

| Operation                    | Approved pass median | Native median | Speedup |
| ---------------------------- | -------------------: | ------------: | ------: |
| Full note scan               |           5,118.0 ms |    3,469.5 ms |   1.48× |
| Compiler-input collection    |           9,545.8 ms |    3,585.8 ms |   2.66× |
| First nonempty note callback |             166.2 ms |       36.3 ms |   4.58× |

Every relative path, source, base64 value, and title matched. The compiler fixture also included three 32 MiB binary files and eight small boundary files. Five consecutive collections were byte-identical, no out-of-memory error occurred, and smaller read caps rejected. [Raw samples, source hashes, and separate test conditions](performance-data/vault-io.json) retain the evidence without source snapshots or discarded experiments.

These are subsystem timings on a shared Ryzen 7 5800X host and a disposable Android 17/API 37 `x86_64` emulator, with two cores, 2,048 MiB RAM, and SwiftShader. The native debug APK used Hermes bytecode with `dev=false` and `minify=true`. The two runs used different APKs and processes. They are not whole-app, painted-row, physical-phone, release-build, or peak-memory measurements. Earlier Expo Go runs used a different binary and emulator memory size, so their absolute times are not comparable.

## Validation and limits

Native checks covered exact UTF-8 BOM, CRLF, Unicode and binary preservation, nested `.typ` directories, empty directories, denied access, and both compiler size limits. The app detected a same-size/same-timestamp external edit after returning to the library and repaired deleted PDF output without another source change.

The continuous viewer displayed a 21-page demo. A two-finger gesture doubled page width from 387 to 774 CSS pixels, preserved the page-relative anchor within 0.001, and retained four canvases near the viewport. Switching notes then displayed one page and one canvas. Tests also cover mixed page sizes, stale rasters, final pinch flushing, and source switching. These checks do not establish an FPS or raster-time improvement. All-page metadata enumeration still scales with document length.

Physical ARM phones, SD cards, peak memory, battery use, thermal behavior, and full input-to-paint latency remain unmeasured.

## CI performance audit

On every pull request, CI runs the host benchmark three times against the PR and three times against its base commit, alternating on the same runner. It uploads the best result per workload. After CI succeeds, a trusted workflow compares the PR with that base and updates one comment. Workloads of at least 10 ms warn above 2% and fail the check above 5% only when the PR's best run is slower than the base's worst run. Smaller workloads are reported but not gated because their run-to-run noise exceeds those thresholds. Setup-dominated first-content, no-match search, and workloads whose three runs vary by more than 10% are also reported but not gated. A missing PR measurement also fails. Missing baseline metrics fail so they cannot be dropped silently. New metrics are reported. Improvements become the floor when they land on `main`.

The audit covers the host search, syntax, compiler, and workspace workloads. It does not measure the native Android vault path, painted frames, or whole-app startup. The `Performance audit` check is required in the `main` branch ruleset.

## Reproduce

Run the host subsystem benchmarks:

```sh
bun install --frozen-lockfile
bun scripts/benchmark.ts
```

For native storage and search measurements, use a disposable demo vault and temporarily replace `index.ts` with:

```ts
import './scripts/benchmark-mobile'
```

Build the web resources and a native Android app with `bun run android`. Stop its default Metro server, then start the measured configuration:

```sh
bun expo start --dev-client --no-dev --minify --clear
```

Reconnect the development client before collecting timings. Read `[benchmark]` JSON from logcat or the app. Restore `index.ts` afterward. Expo Go can test the fallback, but it cannot measure the native I/O improvement. See [phone testing](mobile-testing.md) for device setup.

The benchmark scripts measure the checked-out implementation. The scan and first-callback rows were measured at `a3a2e2a`. The compiler row was measured after the bounded-read changes on top of `254199d`. [The original paired inputs](https://github.com/DontBlameMeDev/typo/pull/9#issuecomment-6629881889) and [the compiler read-memory follow-up](https://github.com/DontBlameMeDev/typo/pull/9#issuecomment-6631402962) reproduce both without keeping source snapshots in the repository.
