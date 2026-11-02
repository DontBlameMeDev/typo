# Roadmap

## Current foundation

The Android app now includes local folder access, fzf-based name search, content
search, root and nested note creation from shared templates, source editing,
automatic on-device PDF updates, PDF viewing, and sharing of source or PDF.

Compilation uses `@myriaddreamin/typst-ts-web-compiler` `0.8.0-rc3` as WebAssembly
in a worker inside a hidden WebView. Its engine supports Typst 0.15. The bundled JetBrains Mono
Nerd Font, Libertinus Serif regular, bold, and italic, and New Computer Modern Math
make basic compilation work offline. Portable packages under
`packages/<namespace>/<name>/<version>` resolve from the vault. Public `@preview`
packages are fetched by exact version from `packages.typst.org` on first use, cached
privately, and then available offline.

Templates are shared files at the vault root: `template.typ` and `templates/*.typ`
with `{{title}}` and `{{body}}` placeholders. Desktop note creation and the app use
the same files. The phone does not evaluate Nix. See
[the template guide](templates.md).

The source editor is CodeMirror with offline Tree-sitter highlighting. The interface
supports all Catppuccin flavors and accents, system, light, dark, and AMOLED modes,
and persisted appearance settings. Folder indexing is automatic rather than manually
refreshed.

## Verification status

All 484 notes in a disposable copy of the current vault compiled successfully in
the corpus harness, using 543 input files and 11 public preview packages. This does
not establish pixel-for-pixel agreement with the desktop compiler.

The Android emulator pass covers source editing and highlighting, full unsaved-buffer
sharing without a save, shared-template creation, draft PDF previews, storing a
matching preview after saving, failed-compilation preservation, nested imports and
new output folders, public package downloads, and offline package-cache reuse.
All four Catppuccin palettes, accent changes, system appearance updates, AMOLED
black, and settings persistence were checked. The standalone ARM64/x86-64 APK runs
on the x86-64 emulator with Metro stopped. Physical hardware remains untested.

Android storage access framework writes remain non-atomic, with races against
Syncthing or another writer still possible. The live folder refresh polls every 15
seconds in the foreground and on return or resume. It is not a filesystem watcher.

## Remaining work

1. Compare compiled output with the pinned desktop compiler and expand beyond the
   current vault corpus.
2. Validate compilation and editing on a physical phone. Expand emulator and phone
   checks for large text, screen readers, touch-keyboard behavior, memory use, and
   cold compile time.
3. Measure input polling and consider a persistent freshness manifest. Current
   previews compare source and all supported vault input bytes in memory, including
   imports, assets, bibliography, fonts, and local packages. Public packages use
   pinned versions. External changes are detected on the next check, and Android
   cannot atomically validate every dependency while writing a PDF.
4. Exercise failed and partial writes, conflict copies, revoked folder grants, and
   large folders. Reduce or document the remaining write races where Android's
   storage access framework allows it.
5. Check nested shared-template imports on more desktop vault layouts. The app can
   create notes in existing nested folders, but it does not create directories or
   desktop resource symlinks.
6. Measure compiler memory, binary size, package cache growth, and UI responsiveness
   before selecting release defaults.

## Portable vault configuration

Once the workflow is stable, extract only the necessary settings into a small
declarative vault configuration: template source, filename policy, shared resource
paths, fonts or packages, and output directory. Preserve `.typ` compatibility with
desktop editors. Do not build a template marketplace or arbitrary code plugin system
ahead of a second real use case.

Nix should continue to pin desktop and compiler development environments. Mobile
should consume explicit configuration and packaged resources rather than evaluate an
arbitrary vault's `flake.nix`.

## Release work

- Verify persisted directory grants across app and device restarts and revocation.
- Verify the offline PDF.js viewer in SDK 58 Expo Go on a physical phone, including
  page navigation, pinch zoom, large-document memory, and malformed-document
  handling.
- Add production signing and distribution. The development-signed standalone build
  already includes ARM64 and x86-64 and runs without a development server.
- Keep the offline browser bundle check in Nix and update the fixed-output
  dependency hash when JavaScript dependencies change.
