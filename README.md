# Typo

An Android-first, local-folder companion for Typst notes. Open a folder synced by
Syncthing, find an idea, write a note, and take its PDF with you. Your `.typ` files
stay the source of truth. No account, server, or application-specific sync layer.

## Proof of concept

- Choose a local folder through Android's system picker; remember it across restarts.
- Search names and titles using the fzf matching algorithm, or search source content
  with matching lines and snippets.
- Create notes using the existing shared Typst template and edit their source.
- Detect external source changes before saving rather than silently overwriting them.
- View existing PDFs inside the app and share them through Android's share sheet.
- Refresh the folder after Syncthing updates it.

**This proof of concept does not compile Typst on the phone.** After creating or
editing a note, compile it on your desktop and sync the generated `out` folder.
Existing PDFs may be older than their source. On-device PDF generation is a
requirement for the first full version, not a completed feature of this build.

## Folder layout

```text
notes/
  atomic_notes.typ
  bibliography.yml
  style/
    lib.typ
  assets/
  uni/
    math/
      example.typ
  out/
    atomic_notes.pdf
    uni/
      math/
        example.pdf
```

New notes are created at the vault root, with lowercase underscore-separated
filenames and this skeleton:

```typst
#import "style/lib.typ": *
#show: template

#title[My Note]

Your note goes here.
```

Nested existing notes can be searched and edited. Creating nested notes is deferred
until shared-resource imports can work without desktop filesystem symlinks.
`style`, `assets`, `out`, and hidden directories are excluded from note indexing.

Choose the actual shared folder Syncthing writes to, rather than an imported copy.
Android's folder picker must grant access to that folder. This build supports
Internal storage and SD-card folders through Android's standard external-storage
provider, not cloud or third-party document providers. Protected storage roots
and app-private directories are not selectable. Syncthing remains responsible for
synchronization and conflict copies. Saving checks for changes since opening a
note, but is not a distributed lock or an atomic compare-and-swap with Syncthing.

## Development

Project setup is based on the TypeScript template in `project_templates`, generated
with `new_project`, then adapted for Expo. It retains Bun, Biome, strict TypeScript,
Nix/direnv, Git hooks, the license, and Forgejo issue/PR templates.

```sh
nix develop
bun install --frozen-lockfile
bun run typecheck
bun test
bun run lint
bun run android
```

Use a development build, **not Expo Go**: the embedded PDF viewer uses native code.
`bun run android` generates the Android project and builds/installs the app. After
the initial native build, `bun run dev` starts Metro for fast JavaScript iteration.
Rebuild when changing native dependencies or Expo configuration.

The Android build requires JDK 21, an Android SDK, accepted SDK licenses, and an
emulator or physical device. The Nix shell supplies the JDK and JavaScript tools;
it uses `ANDROID_HOME`, defaulting to `$HOME/Android/Sdk`. Expo SDK 58 currently
uses Android platform/build-tools 37 and NDK 27.1.12297006. Gradle may download
missing SDK components when their licenses have been accepted. SDK installations
using the newer versioned folder names are supported by the Android tools. The
initial Nix checks and development shell target x86-64 Linux.

```sh
# Choose a connected device or emulator:
bun run android --device

# Dependency-backed source checks, without an Android build:
nix flake check
```

Native Android/iOS build directories, vault contents, PDFs, signing material,
local environment files, and build outputs are not committed. Never add your real
vault to the repository or bundle it into the application.

## Architecture

- `App.tsx`: onboarding, library/search, source editing, PDF viewer, and creation UI.
- `src/core.ts`: filename validation, Typst note skeleton, title extraction, search.
- `src/vault.ts`: Android folder permissions, enumeration, persistence, reads/writes,
  and private PDF copies for viewing/sharing.
- `src/types.ts`: small shared data contracts.
- `test/`: synthetic tests; no personal vault content.

The app uses React Native with an Expo development build. The local folder is
canonical; the in-memory search index is disposable. Keep platform integration
separate from the pure search/template logic, without a backend or plugin system.

See [the roadmap](docs/roadmap.md) for first-version requirements and
[the design direction](docs/design.md) for UI decisions.

When updating JavaScript dependencies, regenerate `bun.lock` and update the
fixed-output dependency hash in `flake.nix`. Set it to an empty string, run
`nix build .#checks.x86_64-linux.test`, and use the reported actual hash.

For a standalone emulator proof of concept, generate Android with `bunx expo prebuild --platform android`, then run:

```sh
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64
```

This embeds JavaScript and fonts, so Metro is not required. The generated Expo
project signs this build with its development key: it is a test artifact, **not a
production-signed release**, and an x86-64 build does not run on ARM phones.
Production signing and multi-ABI distribution remain release work.
