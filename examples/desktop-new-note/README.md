# Desktop new-note example

This is a small desktop command that reads the same `template.typ` file Typo
reads. Typo never evaluates Nix. Nix is only used here to package the desktop
command with Perl available.

```sh
nix-build examples/desktop-new-note
VAULT=~/notes ./result/bin/new-note "A new note" "Body text"
VAULT=~/notes TEMPLATE=~/notes/templates/essay.typ ./result/bin/new-note "An essay"
```

The command:

- reads `$VAULT/template.typ` by default, or `$TEMPLATE`.
- requires `{{title}}` and rejects unknown `{{...}}` placeholders.
- substitutes `{{title}}` (escaped as Typst markup) and `{{body}}` (literal) in
  one pass.
- trims trailing whitespace from the body and does not overwrite an existing
  note.
