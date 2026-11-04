# Performance

Includes main's continuous PDF preview and pinch zoom.

## Changes

- Search runs in an isolated WebView. Names is the default and sends only titles and paths. Everywhere adds source content. Later requests send only changes.
- Editor parsing and highlighting run in a worker. Text can become ready before highlighting finishes. Stale results cannot replace another document.
- Compiler scheduling yields after an 8 ms work budget instead of after every file.
- Android vault reads use an async local Expo module. A single directory cursor supplies type and size metadata, and file reads avoid repeated provider queries. Expo Go keeps the async Expo filesystem fallback.
- The PDF viewer renders visible pages before overscan, evicts only published canvases, and coalesces pinch updates through animation frames.

Every vault refresh still reads fresh content. Compiler collection retains complete metadata preflight, the 32 MiB per-file and 100 MiB total limits, and actual-byte checks. Directory traversal, cancellation draining, errors, and missing-PDF repair remain in place. Read concurrency stays at 24. There is no timestamp cache or polling change.

## Latest vault measurements

The approved async cap-24 implementation and the native implementation ran in one APK against the same unchanged synthetic vault: 1,000 notes, 20 folders, and 9,397,890 source bytes. Six iterations alternated variant order. The table excludes the first iteration and uses five warm samples per variant.

| Operation                    | Approved pass median | Native median | Speedup |
| ---------------------------- | -------------------: | ------------: | ------: |
| Full note scan               |           5,118.0 ms |    3,469.5 ms |   1.48× |
| Compiler-input collection    |          15,432.8 ms |    1,811.4 ms |   8.52× |
| First nonempty note callback |             166.2 ms |       36.3 ms |   4.58× |

Every source, title, path, URI, and compiler base64 value matched. [Raw samples and test conditions](performance-data/vault-io.json) retain the measurement details without source snapshots or discarded experiments.

These are subsystem timings on a shared Ryzen 7 5800X host and a disposable Android 17/API 37 `x86_64` emulator, with two cores, 2,048 MiB RAM, and SwiftShader. The native debug APK used Hermes bytecode with `dev=false` and `minify=true`. They are not whole-app, painted-row, physical-phone, or release-build timings. Earlier Expo Go runs used a different binary and emulator memory size, so their absolute times are not comparable.

## Validation and limits

Native checks covered exact UTF-8 BOM, CRLF, Unicode and binary preservation, nested `.typ` directories, empty directories, denied access, and both compiler size limits. The app detected a same-size/same-timestamp external edit after returning to the library and repaired deleted PDF output without another source change.

The continuous viewer displayed a 21-page demo. A two-finger gesture doubled page width from 387 to 774 CSS pixels, preserved the page-relative anchor within 0.001, and retained four canvases near the viewport. Switching notes then displayed one page and one canvas. Tests also cover mixed page sizes, stale rasters, final pinch flushing, and source switching. These checks do not establish an FPS or raster-time improvement. All-page metadata enumeration still scales with document length.

Physical ARM phones, SD cards, peak memory, battery use, thermal behavior, and full input-to-paint latency remain unmeasured. A trusted per-PR timing gate is still a follow-up. These emulator samples do not justify a 3% regression threshold.

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

The benchmark scripts measure the checked-out implementation. The table was measured at `a3a2e2a`, before the later streaming read-limit fix. [The paired harness, exact baseline, and fixture generator](https://github.com/DontBlameMeDev/typo/pull/9#issuecomment-6629881889) reproduce that comparison, including first-note callbacks and output equality checks, without keeping source snapshots in the repository.
