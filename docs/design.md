# Design direction

Typo is a productivity tool for finding and capturing ideas, not a dashboard.
The primary flow is folder selection → search → note → PDF or source. Returning
users see their notes immediately; onboarding appears only without a connected
folder.

The design incorporates the relevant productivity and interaction guidance from
[Mobile App UI/UX Design](https://github.com/ceorkm/mobile-app-ui-design):

- Neutral parchment surfaces, dark ink, and a restrained sage accent for actions.
- Newsreader for editorial headings; DM Sans for controls and lists. Interface
  text uses four sizes (12, 14, 18, and 36), with regular and semibold weights.
  The wordmark is a separate decorative element; source uses system monospace.
- A 4/8-point spacing rhythm, clear grouping, subtle dividers, and soft elevation.
- A thumb-reachable new-note action and a bottom creation button.
- At least 44-point targets for icon buttons, folder selection, and segment tabs.
- Explicit indexing, empty, error, disabled, unsaved, and saved states.
- Search shows the library before a query and matching source snippets afterward.
  No empty search screen or unnecessary recommendations.
- Unsaved-change confirmation and conflict messages protect the editing flow.
- The header identifies the app and folder without a redundant local-status badge.

Motion is restrained: press feedback and modal transitions, rather than attention-
grabbing effects. The useful outcome—finding the note and opening its PDF—takes
priority over decorative status indicators or gamification.

Validate the design on the Android emulator and a physical phone, including large
text, screen readers, the real keyboard, and shorter screens. A polished emulator
screen alone is not a complete accessibility assessment.
