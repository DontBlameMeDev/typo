# Typo

An Android-first, local-folder companion for Typst notes. Open a folder synced by
Syncthing, find an idea, write a note, and take its PDF with you. Your `.typ` files
stay the source of truth. No account, server, or application-specific sync layer.

## Features

- Choose a local folder through Android's system picker and remember it across
  restarts.
- Search names and titles with the fzf matching algorithm, or search source content
  with matching lines and snippets.
- Create notes at the vault root or in an existing note folder from shared templates,
  and edit source in an offline CodeMirror editor with Tree-sitter highlighting.
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

The bundled JetBrains Mono Nerd Font, Libertinus Serif regular, bold, and italic,
and New Computer Modern Math cover basic notes without a network connection. Font
files found in the vault are also available to the compiler.

Public `@preview` packages are fetched from `packages.typst.org` by exact version on
first use and cached in private app storage. Notes are not uploaded. Later
compilations can use the cache offline. A note that imports an uncached package
needs a connection once. Portable packages stored under
`packages/<namespace>/<name>/<version>` in the vault are resolved locally, including
`packages/local/...` packages.

Compilation starts automatically when a note opens and after a 450 ms typing pause.
Only one job runs at a time. Newer edits supersede old results. The app checks vault
inputs in the background every 15 seconds while a note is open, on resume, and when
opening the PDF view. Edits use the last completed input snapshot while a new check
runs. External dependency changes appear after that check finishes. Unchanged input
bytes reuse the current result.
The PDF view never falls back to an old PDF when the current input fails to compile.

Compilation uses the current editor buffer, so the preview can include unsaved
changes. A PDF is written to `out/<relative source path>.pdf` only when the source
has been saved and still matches the compiled buffer. Save writes the source, then
waits for the current PDF and stores it. A compile failure leaves the source saved,
reports the error, and preserves the previous PDF on disk. Sharing waits for the
current preview without saving a draft. Each file is limited to 32 MiB and total compiler inputs
to 100 MiB. Movie and MP4 assets that cannot be compiled are skipped.

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

New notes use lowercase underscore-separated filenames. Choose the vault root or an
existing note folder when creating a note. Nested notes can be searched and edited.
The app does not create note directories. `style`, `assets`, `templates`, `packages`, `out`, the root `template.typ`, and hidden
directories are excluded from note indexing.

Choose the actual shared folder Syncthing writes to, rather than an imported copy.
Android's folder picker must grant access to that folder. This build supports
Internal storage and SD-card folders through Android's standard external-storage
provider, not cloud or third-party document providers. Protected storage roots and
app-private directories are not selectable. Syncthing remains responsible for
synchronization and conflict copies.

Android's storage access framework does not provide atomic writes. Saving uses a
truncating write after checking that the file still matches the opened version, but
a race with another writer is still possible, and a failed write can leave a partial
file. The index refreshes every 15 seconds while the app is in the foreground and
when it returns to the foreground or resumes. It is polling, not a filesystem
watcher.

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

`bun run build:web` creates the offline source and compiler browser bundles in the
ignored `dist/` directory. Run it before Gradle or an Expo export. `bun run dev` and
`bun run android` now run it automatically. Metro treats `.txt` and `.wasm` as
assets. Editor and compiler fonts and their licenses are vendored under `assets/`.

Use a development build, **not Expo Go**: the embedded PDF viewer uses native code.
`bun run android` generates the Android project and builds or installs the app.
After the initial native build, `bun run dev` starts Metro for fast JavaScript
iteration. Rebuild when changing native dependencies or Expo configuration.

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
- `src/useAutoPdf.ts`: automatic compilation, current previews, and output persistence.
- `src/SourceEditor.tsx`: visible WebView that runs the CodeMirror editor.
- `src/theme.tsx` and `src/theme-data.ts`: Catppuccin palettes, appearance modes, and
  persisted settings.
- `src/core.ts`: filename validation, title extraction, and search.
- `src/vault.ts`: Android folder permissions, enumeration, persistence, reads and
  writes, and private PDF copies for viewing or sharing.
- `src/types.ts`: small shared data contracts.
- `test/`: synthetic tests. No personal vault content.

The app uses React Native with an Expo development build. The local folder is
canonical. The in-memory search index and generated PDFs are disposable. Keep
platform integration separate from the pure search and template logic, without a
backend or plugin system.

See [the roadmap](docs/roadmap.md) for remaining validation and
[the design direction](docs/design.md) for UI decisions.

For a standalone phone and emulator build, run `bun run build:web`, then generate Android with
`bunx expo prebuild --platform android`, then run:

```sh
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64
```

This embeds JavaScript, fonts, the editor bundles, and the compiler. Metro is not
required. The generated Expo project signs this build with its development key: it
is a test artifact, **not a production-signed release**. The APK includes ARM64 for
modern phones and x86-64 for emulators. Physical ARM64 hardware has not been tested.
Production signing and distribution remain release work.
