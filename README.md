# Typo

Typo is an Android app for [Typst](https://typst.app) notes kept in a folder you
already sync. Open the folder, search your notes, write, and take the compiled PDF
with you. Your `.typ` files are the source of truth. There is no account, server, or
app-specific sync layer.

## Install

Download the APK from the [releases page](https://github.com/DontBlameMeDev/typo/releases)
and install it on a 64-bit ARM Android phone. Android may ask you to allow installs
from your browser or file manager.

## Set up your notes

1. Sync a folder between your computer and phone with [Syncthing](https://syncthing.net)
   or another file sync tool.
2. Open Typo and choose that folder with Android's folder picker.
3. Typo remembers the folder and opens your notes on later launches.

Choose the folder Syncthing writes to, not an imported copy. Typo can open internal
storage and SD-card folders through Android's system picker. Cloud and third-party
document providers are not supported.

## What you can do

- Browse folders, open nested notes, and search names, titles, and source lines
  with fuzzy matching.
- Swipe a note left to move it to a hidden `.trash` folder. A short swipe waits for
  confirmation, while a longer pull shows an open can, gives a short haptic tap,
  and trashes on release.
- Long press a note to move it to another folder. The move sheet can also create a
  new folder inside any existing folder, including when none exist yet.
- Create notes in the folder you are viewing from your templates.
- Edit source in an offline editor with syntax highlighting.
- Compile, view, and share PDFs with continuous scrolling, pinch zoom, and panning.
  Double tap to return to fit width.
- Share Typst source, including the current unsaved buffer.
- Use Catppuccin Latte, Frappe, Macchiato, or Mocha, any accent, system appearance,
  and AMOLED black.
- Work offline. Basic notes compile with bundled fonts.
- Detect changes made outside Typo before saving instead of overwriting them.

## Templates

Typo reads plain Typst files from the vault root:

- `template.typ` is the default template.
- `templates/*.typ` adds more templates.
- A built-in Plain note template is used when neither exists.

Templates use `{{title}}` and `{{body}}`. New notes use lowercase underscore-separated
filenames and are created in the folder currently open in the library. Typo creates
only folders you name, not directories for notes.

## Compilation and PDFs

Typst runs on the phone. Basic notes need no connection. Public `@preview` packages
are downloaded from `packages.typst.org` on first use and cached, so later compiles
work offline. Portable packages in `packages/` in the vault are used locally.

Compile errors appear in both Source and PDF views, with the failing file, line,
column, compiler message, and any hints. Long errors scroll within the banner so
the source stays accessible. Editing retries compilation automatically. Script
failures identify the editor, compiler, or PDF viewer and retain available details.
Opaque Android script errors explain when details are unavailable.

PDFs are written to `out/` next to the matching note path. Compilation runs in the
background while the app is open and pauses when it leaves the foreground. Editor
previews update shortly after you stop typing. A failed compile keeps the previous
PDF.

## Folder layout

```text
notes/
  template.typ
  templates/
  atomic_notes.typ
  bibliography.yml
  style/
  assets/
  packages/
  out/
  uni/
    math/
      example.typ
```

`style`, `assets`, `templates`, `packages`, `out`, the root `template.typ`, and hidden
directories are not treated as notes or browsable folders. Nested notes can be
searched and edited. Trashed notes keep their relative paths under the hidden
`.trash` folder, and Typo verifies the copy before removing the original.

## Limits

- Saving uses Android's storage framework, which does not provide atomic writes. A
  failed write can leave a partial file, and a race with another writer is possible.
  Syncthing remains responsible for sync and conflict copies.
- Typo checks the folder every 15 seconds while in the foreground and when it
  resumes. It does not watch the filesystem.
- A single file is limited to 32 MiB and total compiler input to 100 MiB.
- Password-protected PDFs are not supported. Very large images may be omitted, and
  movie or MP4 assets are skipped during compilation.

## Privacy

Notes stay on the device. Typo only connects to `packages.typst.org` to fetch missing
public packages. Syncing is handled by Syncthing or the file sync tool you choose.

## License

GPL-3.0. See [LICENSE](LICENSE).
