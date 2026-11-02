# Note templates

A template is a plain Typst file shared by the desktop `new-note` command and
Typo. Typo reads the file directly. It does not evaluate `flake.nix` or any other
Nix expression on the phone.

## Discovery

Templates are discovered in this order:

1. `template.typ` in the vault root. This is the normal desktop template and is
   listed first.
2. `templates/*.typ`, sorted by filename.
3. The built-in `Plain note` template (`builtin:plain`), which is always
   available as a fallback.

Template IDs are the vault-relative path (`template.typ`,
`templates/essay.typ`) or `builtin:plain`. The root `template.typ` and the
`templates/` directory are configuration, not notes, so they do not appear in
the note index or search.

## Placeholders

Templates use exactly two placeholders:

- `{{title}}` is required. The title is validated with the normal note filename
  rules and escaped as Typst markup.
- `{{body}}` is optional. The body is inserted unchanged. Trailing whitespace is
  trimmed, matching the previous new-note behavior.

Substitution is a single pass over the template. A title or body that contains
`{{title}}` or `{{body}}` stays literal and is never substituted again. An
unknown placeholder such as `{{date}}` is an error instead of being left in the
note. A template without `{{title}}` is also an error.

Example `template.typ`:

```typst
#import "style/lib.typ": *
#show: template

#title[{{title}}]

{{body}}
```

Example `templates/plain_note.typ`:

```typst
#set page(margin: 2.5cm)

#let title(body) = align(center, text(size: 22pt, weight: "bold", body))
#title[{{title}}]

{{body}}
```

## App contract

`listTemplates(vault)` returns the root template, custom templates, and the
built-in fallback. The UI selects the first item by default, so a vault with a
root `template.typ` uses it for new notes. Typo passes the selected template
source to `createNote(vault, title, body, '', templateSource)`. New notes always go
in the vault root. Opening the creation form reads only the templates, without
walking the note folders. The name `template.typ` is reserved for configuration
and cannot be used for a new root note.

Calling `createNote` without a template source keeps the classic
`#import "style/lib.typ": *` scaffold for compatibility. That default does not
require the vault to contain a template file.

## Desktop example

[`examples/desktop-new-note`](../examples/desktop-new-note) is a small Nix
wrapper around a shell command that reads the same `template.typ` file:

```sh
VAULT=~/notes new-note "A new note" "Body text"
VAULT=~/notes TEMPLATE=~/notes/templates/essay.typ new-note "An essay"
```

The command requires `{{title}}`, rejects unknown placeholders, escapes the
title, inserts the body literally, and refuses to overwrite an existing note.
