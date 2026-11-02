# Design direction

Typo is a compact productivity tool for finding and capturing ideas, not a
dashboard. The primary flow is folder selection, search, note, then PDF or source.
Returning users see their notes immediately. Onboarding appears only without a
connected folder.

## Visual system

Light mode uses Catppuccin Latte. Dark mode offers Frappe, Macchiato, and Mocha.
Invalid saved palette combinations are migrated to valid defaults.
All 14 Catppuccin accents are available. The default is Latte with Mauve in light
mode and Mocha with Mauve in dark mode. Appearance can follow the system setting or
force light or dark mode, and dark mode can use an AMOLED black background.
Appearance settings are persisted privately on the device.

The app icon uses a Mocha base, Mauve page, and solid Mocha letter. The same
high-contrast icon appears in the library header.

The layout is compact. Controls use a 4/8-point spacing rhythm, clear grouping,
subtle dividers, and restrained elevation. Text uses Newsreader for editorial
headings and DM Sans for controls and lists. Source code uses JetBrains Mono Nerd
Font in the editor.

The design incorporates the relevant productivity and interaction guidance from
[Mobile App UI/UX Design](https://github.com/ceorkm/mobile-app-ui-design).

## Editing and files

The source editor is CodeMirror running in an offline WebView. Syntax highlighting
uses a real Tree-sitter Typst grammar. The editor and compiler do not need a network
connection after their bundled resources are loaded.

Source and PDF are parallel views of the same note. Sharing source includes the full
current buffer, including unsaved changes, without writing the file implicitly. A
themed in-app discard dialog protects unsaved changes when closing a note or
canceling note creation. Switching between source and PDF retains the draft.

PDF generation runs automatically on opening a note and after a 450 ms typing pause.
A worker keeps the compiler off the editor's JavaScript thread. A serial queue drops
superseded results and serves only the latest buffer. Input bytes are checked every
15 seconds, on resume, and when entering the PDF view. These checks run in the
background, so edits can compile against the last completed snapshot. Changed
resources trigger another compilation after the check finishes.

The preview can be newer than the saved file. The app writes a compiled PDF to `out/`
only after the source is saved and still matches the compiled buffer. Save waits for
that output. A failed compilation shows diagnostics and leaves the previous PDF on
disk. The viewer and share action do not present that old PDF as the current result.
Folder, discard, and directory dialogs share the same themed modal surface and
full-window scrim without overlay elevation shadows.

The folder index refreshes automatically every 15 seconds while the app is in the
foreground and when the app returns to the foreground or resumes. There is no manual
refresh control. This is polling, not a filesystem watcher. Android storage access
framework writes are not atomic, so a race with Syncthing or another writer remains
possible.

## Interaction

- A thumb-reachable new-note action creates a note in the folder currently being
  browsed. Folders appear as entries beside notes, with a parent-folder row and a
  tappable breadcrumb outside the list. The root has no parent entry.
- Long press a note to open a move sheet. It lists every other folder, indents
  nested destinations, marks the chosen one, and confirms with "Move here". A
  "New folder" row creates a destination at the current location, including when
  no other folders exist. This keeps the horizontal row gesture free for the
  swipe-to-trash flow.
- Search covers the whole vault, shows matching source snippets, and hides folder
  entries while a query is active. Clearing the query returns to the current folder.
  There is no empty search screen or unnecessary recommendation.
- Indexing, empty, error, disabled, compiling, and compile-error states are shown.
  The editor has no saved-status label or line-count footer. Save sits at bottom right.
- The header identifies the app and folder without a redundant local-status badge.
- At least 44-point targets are used for icon buttons, folder selection, and segment
  tabs.
- Motion is restrained: press feedback and modal transitions, rather than attention-
  grabbing effects.

The emulator pass covers the compact library, source editing and highlighting,
template selection, discard confirmation, source/PDF sharing, PDF generation, theme
changes, and appearance persistence. The four palettes and AMOLED black were also
checked against rendered background colors. Validate on a physical phone, including
large text, screen readers, the touch keyboard, and shorter screens. An emulator
pass is not a complete accessibility assessment.
