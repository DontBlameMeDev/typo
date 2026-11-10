# TypoQuickNote

Android-only local Expo module for the "New note" Quick Settings tile. Expo autolinking finds it in `modules` without a package dependency or config plugin.

`QuickNoteTileService` opens `QuickNoteActivity` over the keyguard. API 34 and newer use `startActivityAndCollapse(PendingIntent)`, older versions the deprecated `Intent` overload. The tile reads `typo-vault.json` from the app's files directory, the same selection `src/vault.ts` owns, and reports `STATE_UNAVAILABLE` until a vault is selected. Taps do nothing until a vault is selected.

`QuickNoteActivity` is a translucent `ReactActivity` that renders the `quickNote` component registered in `index.ts`, so it shares the app's React host and JS runtime. Back and `finish()` close it once the note is written.

Rebuild the Android app after changing this module. Expo Go does not include it.
