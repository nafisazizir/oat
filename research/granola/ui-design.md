# Granola UI — layout & interaction notes

Source: Granola's public help-center screenshots (docs.granola.ai), studied 2026-11-20. Behaviour and layout
descriptions only — no assets, strings, icons or visual identity copied (clean room, D-33 "layout/flow
inspiration is fine; visual identity is ours").

## Overall feel
- One warm off-white canvas; almost no borders or dividers. Hierarchy comes from spacing, type weight and
  one slightly darker tint for the sidebar, not from boxes, shadows or colour.
- Very little chrome: no page header bars, no breadcrumbs bar, no toolbars on the canvas. Controls appear
  as a few small pills in the window corners.
- Content lives in a narrow centred column (~620–680px) with generous vertical whitespace.
- Colour is reserved: near-black primary buttons, muted grey secondary text, a single accent used sparingly
  (live/recording state, today marker).
- Page titles use a distinctive display face; everything else is a neutral sans at small sizes (13–14px UI,
  15–16px body). Mono only for tiny uppercase eyebrow labels and timers.

## Shell
- Left sidebar (~200px, collapsible via a single icon at the top next to the window controls):
  search pill with ⌘K hint → 3 primary nav items (Home, Shared with me, Chat) → small "Spaces" label →
  space/folder rows with a tiny square avatar/icon each. Bottom: a row of 4–5 small muted icon buttons
  (templates, integrations, people, trash…) and the workspace switcher (avatar + name + chevron) that opens
  a popover menu (invite, workspaces, templates, help, settings ⌘,).
- Top-right of the main area: two quiet outlined pills ("Invite", "+ New note"). No title bar text.
- Floating "Ask anything" composer pinned to the bottom of the content column: rounded pill, subtle shadow,
  with one suggested-action chip on the right. On note pages a round recording control (waveform icon +
  chevron) sits to its left; a small floating "Cancel"/status pill appears above it while working.

## Home
- Display heading "Coming up" with tiny prev/next chevrons on the right.
- One soft white card listing upcoming events grouped by day: big day number + month/weekday on the left,
  thin coloured rule + event title + time range per event.
- Below: notes grouped under small muted date labels ("Thu 2 Jul"). Each row: 28px rounded icon tile,
  title (regular weight), muted one-line subtitle (participants), time right-aligned. No borders between
  rows, hover = soft tint. Row actions (folder, more) appear on hover only.
- Empty state: centred one-liner + quiet button.

## Note page
- Top-left: back + home in one small pill. Top-right: a compact segmented toggle (raw notes vs AI notes),
  a dark "Share" pill with a link icon, and a "…" overflow. Nothing else.
- Display-face title, then a row of small outlined meta chips (date, attendees count, + add to folder).
- Body is the plain editor; placeholder "Add your thoughts…". Status (e.g. analysing transcript) is a
  floating rounded card with a spinner, not a banner.
- Transcript opens as a floating bottom sheet over the page (rounded top, search + copy + collapse icons in
  its header; chat-bubble style lines, own speaker tinted on the right; footer with resume/mic control and
  language picker). It is hidden by default.

## Dialogs / onboarding
- Single centred card on the canvas: tiny uppercase mono eyebrow, display-face heading, muted paragraph,
  a bordered group of rows each with a label on the left and a pill button on the right, and one primary
  button bottom-right (disabled = pale grey).

## Takeaways for Oat
1. Remove persistent headers/toolbars; push secondary actions into hover, overflow menus and the sidebar
   footer.
2. Narrow centred column + whitespace everywhere; borders only on cards that group content.
3. Pill-shaped quiet buttons; one dark primary per view.
4. Floating bottom composer (Ask) + recording control; transcript as a dismissible sheet.
5. Date-grouped, borderless note lists.
6. Our own display face and palette — don't reuse Granola's serif or green.
