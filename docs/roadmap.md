# Roadmap

## Proof of concept

The initial Android app establishes local folder access, fzf-based name search,
content search, root-level note creation, source editing, existing-PDF viewing,
and sharing. It does not execute Nix or compile Typst.

## First full version: on-device compilation is required

Treat compilation as a release gate, not an optional enhancement. It must work
without a desktop compilation service or a network connection after dependencies
have been provisioned.

1. Prototype a bundled Typst compiler behind a narrow rendering interface. Compare
   a Rust/native integration with a WebAssembly engine hosted in a suitable runtime;
   do not assume a browser compiler runs directly in Hermes.
2. Mirror the selected vault's required files into private compilation storage.
   Resolve paths inside the vault root, not arbitrary device paths. Android's
   document URIs are not POSIX paths, and desktop symlinks are not portable.
3. Include the actual fonts used by the shared styles, not just the font named by
   the desktop development shell. Respect each font's redistribution license.
4. Provision pinned Typst packages and their transitive dependencies, including
   packages with WebAssembly plugins, and verify offline behavior.
5. Render representative plain-text, math, image, bibliography, diagram, and plot
   notes; compare output against the pinned desktop compiler. Test nested notes.
6. Present actionable compiler errors, cancellation, and progress. Write completed
   PDFs to the matching `out/<relative-source-path>.pdf` through folder permissions.
   Preserve the previous PDF if compilation or writing fails.
7. Track freshness using compiler version, source, imports, assets, bibliography,
   fonts, and package versions. The desktop source-only hash is not sufficient to
   prove the output is current after shared dependencies change.

Measure cold compile time, memory, binary size, and UI responsiveness on a real
Android phone as well as the emulator before selecting the compiler integration.

## Portable vault configuration

Once the concrete workflow is stable, extract only the necessary settings into a
small declarative vault configuration: template source, filename policy, shared
resource paths, fonts/packages, and output directory. Preserve `.typ` compatibility
with desktop editors. Do not build a template marketplace or arbitrary code plugin
system ahead of a second real use case.

Nix should continue to pin desktop/compiler and development environments. Mobile
should consume explicit configuration and packaged resources rather than evaluate
an arbitrary vault's `flake.nix`.

## Further validation

- Persisted directory grants across app and device restarts, revocation recovery.
- Syncthing updates, conflict files, failed/partial writes, and large folders.
- Screen-reader labels, large text, keyboard behavior, and a physical-device pass.
- Native PDF library compatibility, offline use, and malformed-document handling.
- Release signing, standalone builds, and distribution without a development server.
