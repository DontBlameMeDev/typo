# Typo

Typo is a minimal, modern Typst document viewer/editor focused on performance
and ease of use.

## Things without compromise

### 1\. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have
not, and we're proud of the performance of Typo. We regularly audit for
performance regressions, often caused by slow rendering of code highlighting,
css animations causing gpu spikes, lists being hard to render, and more. Make
sure all changes are considerate of performance impact.

## A note from DontBlameMe

I like ambitious ideas, simple systems, and software that feels obvious. Do not
preserve complexity just because it already exists. Do not introduce machinery
because it looks architecturally impressive. Understand the real constraint,
then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to
honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make
changes effectively. Think of these instructions less as "hard rules", more as
"good defaults". The developer's preferences should be able to override anything
here.

## A small glossary

We need to be on the same page with terminology. When communicating, use this
language:

- **you** means the agent reading this file and changing Typo.
- **we, us, and maintainers** mean DontBlameMe and the people building Typo.
  These are who you are talking to now.
- **user** means the person using Typo to manage their Typst notes.
- **vault** means a collection or folder of notes which the user opens.

## Documentation

Read the relevant files only when you need them:

- `docs/*` - These hold only information that is not self-explanatory or
  discoverable in the repository.

## Ground Rules

- Use an own emulator to verify and test your changes. If using your own
  emulator device, clean it up once you are done.
- Prefer simple approaches and small changes.
- When anything will become public, be it explaining GIFs in PRs or other
  sources of media, **always** use fabricated demo data.

## PR Rules

Attach screenshots/videos/gifs to PRs descriptions, to help explain your changes
and reasoning.

## Response Rules

If it would help if a user tests the change, set it up using
`docs/mobile-testing.md` and ask the user to do so.
