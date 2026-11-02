# Typo

An Android-first, local-folder companion for Typst notes. Open a folder synced by
Syncthing, find an idea, write a note, and take its PDF with you. Your `.typ` files
stay the source of truth. No account, server, or application-specific sync layer.

## Features

- Choose a local folder through Android's system picker and remember it across
  restarts.
- Search names, titles, and source lines with case-insensitive fuzzy matching.
  Literal matches rank first, and content results include the best matching line
  and snippet. Search indexes are reused while typing.
- Browse note folders, open nested notes, and create notes in the folder you are
  viewing. Long press a note to move it or create a destination folder. Edit source
  in an offline CodeMirror editor with Tree-sitter highlighting.
- Update PDFs automatically on the device with a bundled Typst compiler.
- View and share PDFs, or share Typst source including the current unsaved buffer.
- Use Catppuccin Latte in light mode and Frappe, Macchiato, or Mocha in dark mode,
  with all accents, system appearance, AMOLED, and persisted settings.
- Detect external source changes before saving rather than silently overwriting
  them. Confirm before discarding unsaved changes, and let the note index refresh
  automatically.

## On-device compilation

`@myriaddreamin/typst-ts-web-compiler` is pinned at `0.8.0-rc3` and runs as
WebAssembly in a worker inside a hidden WebView, separate from the editor's JavaScript
thread. Its engine supports Typst 0.15. This release
candidate is pinned because the stable 0.7 release, with compiler 0.14.2, could not
compile the user's packages.

The bundled JetBrains Mono text subset, Libertinus Serif regular, bold, and italic,
and New Computer Modern Math cover basic notes without a network connection. Font
files found in the vault are also available to the compiler.

Public `@preview` packages are fetched from `packages.typst.org` by exact version on
first use and cached in private app storage. Notes are not uploaded. Later
compilations can use the cache offline. A note that imports an uncached package
needs a connection once. Portable packages stored under
`packages/<namespace>/<name>/<version>` in the vault are resolved locally, including
`packages/local/...` packages.

Saved notes compile in the background after the library loads, without opening a
note or its PDF. One shared compiler stays warm, and editor requests take priority
over queued library work. The compiler loads only when a cache miss needs it.
Background work pauses when the app leaves the foreground. This is in-app work,
not an Android service that runs after the app closes. Work is silent, with no
PDF badges, progress text, or spinners.

The library shows notes as they are read instead of waiting for the full scan.
A private library snapshot shows cached notes on later opens while a background
scan checks for changes. Scanning avoids per-file timestamps and size queries,
reads notes before output folders, and batches list updates. It yields to UI events
without pausing after every file. The overview does not overscroll beyond its rows.
Saving still checks the actual source bytes before writing, including when opened
from a cached index. The file is checked in the background when opened. Changed
disk contents replace the cached text only if editing has not started.

The source editor stays mounted behind the library with its parser and bundled font
loaded, including during the first scan. Touching a note row prepares its cached text
before the press opens the screen. Opening a note reuses the WebView and parser.
Each note session gets fresh undo history, and late changes from older sessions are
ignored. The hidden editor cannot take input or start PDF work. Syntax colors do not
change font metrics or wrapping. Highlight queries cover the viewport and reuse the
parse tree when scrolling. The PDF viewer still starts after the first paint.

Screens use insets from the root safe-area provider on their first render, with
initial window metrics supplied at startup. Opening a screen does not mount another
native safe-area view or animate its appearance. New-note options load ahead of time,
and the template row keeps its space while fresh options are checked.

Android back gestures and the toolbar buttons use the same close checks in notes,
new notes, and appearance settings. Unsaved notes require confirmation before closing.

Private PDF caches persist across app restarts. Versioned content fingerprints
cover the source, fonts, and files each note actually reads, including missing
paths and shared-style fallbacks. Unrelated note edits do not rebuild every PDF.
The compiler retains its font database and unpacked packages. Input snapshots cross
the WebView bridge once, with only changed or removed files sent later. Output
folder listings are cached briefly during a batch to avoid rescanning the vault
for every PDF.
The app checks vault inputs every 15 seconds and on resume. Edits use the last
completed input snapshot while a new check runs. Large input hashes yield to UI
events. Missing private PDFs are rebuilt, and missing or changed output PDFs are
restored from the private cache.

Editor previews update after a 450 ms typing pause and can include unsaved changes.
Newer edits supersede old results. The last successful preview stays visible during
updates. Compile errors remain visible, and
sharing waits for the current preview rather than sharing a failed or stale draft.
A PDF is written to `out/<relative source path>.pdf` only when the saved source
still matches the compiled buffer. Save writes the source and returns without
waiting for PDF generation. Compilation and output writes continue after the editor
closes. A compile failure preserves the previous PDF on disk. Each file is limited
to 32 MiB and total compiler inputs to 100 MiB. Movie and MP4 assets that cannot be
compiled are skipped.

All 484 notes in a disposable copy of the current vault compiled in the corpus
harness, using 543 input files and 11 public preview packages. This checks successful
compilation, not pixel-for-pixel equivalence with the desktop compiler. Android emulator checks cover source editing,
full-buffer source sharing, template selection, draft previews, saved PDF output,
failed-compilation preservation, nested shared styles and output folders, package
downloads, and offline cache reuse. The standalone ARM64/x86-64 APK was run on the
x86-64 emulator with Metro stopped. Physical-phone testing is still needed.

## Templates and folder layout

Note creation uses shared template files at the vault root: `template.typ` and
`templates/*.typ`. Templates use `{{title}}` and `{{body}}` placeholders. Desktop
note creation and the app use the same files. The phone does not evaluate Nix.
Examples and placeholder rules are in [the template guide](docs/templates.md).

```text
notes/
  template.typ
  templates/
  atomic_notes.typ
  bibliography.yml
  style/
    lib.typ
  assets/
  packages/
    preview/
      example/
        1.0.0/
    local/
      example/
        1.0.0/
  uni/
    math/
      example.typ
  out/
    atomic_notes.pdf
    uni/
      math/
        example.pdf
```

New notes use lowercase underscore-separated filenames and are created in the
folder currently open in the library. Folders appear as entries beside notes.
Opening one shows its notes and subfolders, with a parent-folder row and breadcrumb
to go back. Long press a note to open a destination sheet and move it. The sheet
can create a new folder at the current location, including when no other folders
exist. Search still covers the whole vault. The app creates only the folders you
name, not directories for notes. `style`, `assets`, `templates`, `packages`, `out`,
the root `template.typ`, and hidden directories are excluded from note indexing and
folder browsing.

Choose the actual shared folder Syncthing writes to, rather than an imported copy.
Android's folder picker must grant access to that folder. This build supports
Internal storage and SD-card folders through Android's standard external-storage
provider, not cloud or third-party document providers. Protected storage roots and
app-private directories are not selectable. Syncthing remains responsible for
synchronization and conflict copies.

Android's storage access framework does not provide atomic writes. Saving uses a
truncating write after checking that the file still matches the opened version, but
a race with another writer is still possible, and a failed write can leave a partial
file. The index refreshes every 15 seconds while the app is in the foreground, including
while a note is open, and when it returns to the foreground. Unchanged scans reuse
the existing index without rerendering rows or rewriting its cache. New and saved
notes update the index and its private cache without waiting for a full scan. It is
polling, not a filesystem watcher.

## Development

Project setup is based on the TypeScript template in `project_templates`, generated
with `new_project`, then adapted for Expo. It retains Bun, Biome, strict TypeScript,
Nix/direnv, Git hooks, the license, and Forgejo issue/PR templates.

```sh
nix develop
bun install --frozen-lockfile
bun run build:web
bun run typecheck
bun test
bun run lint
bun run android
```

`bun run build:web` creates the offline editor, compiler, and PDF.js browser bundles
in the ignored `dist/` directory. Run it before Gradle or an Expo export.
`bun run dev` and `bun run android` run it automatically. Metro treats `.txt` and
`.wasm` as assets. PDF.js fonts, CMaps, image decoders, and their licenses come from
`pdfjs-dist` and are bundled locally. Editor and compiler fonts and their licenses
are vendored under `assets/`.

`bun run dev` starts Metro in Expo Go mode. Use **Expo Go for SDK 58**. An installed
Expo Go app for another SDK cannot open it. The PDF viewer uses the WebView already
included in Expo Go. Android emulator checks cover local files, WebView workers,
WASM compilation, folder permissions, and PDF rendering in Expo Go 58.0.5. Physical
phone testing is still needed.

For a development build, `bun run android` generates the Android project and builds
or installs the app. Use `bunx expo start --dev-client` for later Metro sessions
after running `bun run build:web`. Rebuild when changing native dependencies or
Expo configuration. Regenerate existing native projects after removing the old
PDF viewer plugins.

The Android build requires JDK 21, an Android SDK, accepted SDK licenses, and an
emulator or physical device. The Nix shell supplies the JDK and JavaScript tools. It
uses `ANDROID_HOME`, defaulting to `$HOME/Android/Sdk`. Expo SDK 58 currently uses
Android platform/build-tools 37 and NDK 27.1.12297006. Gradle may download missing
SDK components when their licenses have been accepted. SDK installations using the
newer versioned folder names are supported by the Android tools. The Nix checks and
development shell target x86-64 Linux.

```sh
# Choose a connected device or emulator:
bun run android --device

# Dependency-backed source and offline bundle checks, without an Android build:
nix flake check
```

The Nix checks include an offline browser bundle build. When updating JavaScript
dependencies, regenerate `bun.lock` and update the fixed-output dependency hash in
`flake.nix`. Set it to an empty string, run `nix build .#checks.x86_64-linux.test`, and use the reported actual hash.

Native Android/iOS build directories, vault contents, PDFs, signing material, local
environment files, and build outputs are not committed. Never add your real vault to
the repository or bundle it into the application.

## Architecture

- `App.tsx`: onboarding, library/search, source editing, PDF viewer, and creation UI.
- `src/compiler/`: WebAssembly compiler lifecycle, package cache, protocol, and
  browser bundle entry point.
- `src/editor/`: CodeMirror document bridge, offline Tree-sitter syntax support, and
  browser bundle entry point.
- `src/CompilerHost.tsx`: hidden WebView that hosts the compiler worker.
- `src/compiler/workspace.ts`: shared background queue, dependency fingerprints, and output persistence.
- `src/compiler/pdf-storage.ts`: versioned private PDF caches and manifests.
- `src/usePdfWorkspace.ts`: vault and app lifecycle integration for background compilation.
- `src/useAutoPdf.ts`: debounced editor previews and current-result sharing.
- `src/SourceEditor.tsx`: visible WebView that runs the CodeMirror editor.
- `src/PdfViewer.tsx` and `src/pdf/`: offline PDF.js WebView, page controls, zoom,
  worker parsing, and cancelable single-page rendering.
- `src/library-cache.ts`: private library snapshots for quick reopening.
- `src/theme.tsx` and `src/theme-data.ts`: Catppuccin palettes, appearance modes, and
  persisted settings.
- `src/core.ts`: filename validation, title extraction, and search.
- `src/vault.ts`: Android folder permissions, enumeration, persistence, reads and
  writes, and private PDF copies for viewing or sharing.
- `src/types.ts`: small shared data contracts.
- `test/`: synthetic tests. No personal vault content.

The app uses React Native with Expo Go for SDK 58 or an Expo development build.
The local folder is canonical. Cached indexes and generated PDFs are disposable. Keep
platform integration separate from the pure search and template logic, without a
backend or plugin system.

The PDF viewer reads local files without sending PDF base64 over the React Native
bridge. It renders one page at a time into a back buffer and swaps only completed
frames. Each canvas is capped at 4 million pixels and 4096 pixels per side, with at
most two full-size canvases during rendering. The idle back buffer shrinks to one
pixel. Zoom and resize scale the visible frame immediately while a sharper frame
renders. Document fonts stay loaded until the document closes. It supports page jumps, pinch/button zoom, and panning.
Document metadata still grows with input size. Input is limited to 100 MiB, and
decoded images above 16 million pixels may be omitted. Password-protected PDFs
report an error. The opened note's PDF stays mounted and pre-renders while editing,
so switching views reuses its page and zoom state.

See [the roadmap](docs/roadmap.md) for remaining validation and
[the design direction](docs/design.md) for UI decisions.

For a standalone phone and emulator build, run `bun run build:web`, then generate Android with
`bunx expo prebuild --platform android`, then run:

```sh
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64
```

This embeds JavaScript, fonts, the editor, compiler, and PDF viewer bundles. Metro is not
required. The generated Expo project signs this build with its development key: it
is a test artifact, **not a production-signed release**. The APK includes ARM64 for
modern phones and x86-64 for emulators. Physical ARM64 hardware has not been tested.
Production signing and distribution remain release work.
