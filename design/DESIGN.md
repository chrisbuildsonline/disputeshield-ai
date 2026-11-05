# DisputeShield AI: design

An operator console for PayPal chargebacks. It should read like current fintech dashboard work
(soft canvas, floating white cards, one dark pill per screen), not a stock admin kit.

## Foundations
- **Canvas** `#eef0f4`: the page background. Nothing sits on it as a bordered white box.
- **Surface** `#fff`, radius `18px` (cards, grid, panel), `14px` for cards inside a surface,
  shadow `0 1px 2px rgba(15,23,42,.04), 0 8px 24px rgba(15,23,42,.06)`. No borders on surfaces.
- **Inset surface** `#f5f6f8`, radius `14px`, no border: a card inside a white surface (evidence, note).
- **Ink** `#0f172a`; **muted** `#5b6476` for secondary text; hairlines `#e6e8ee` only inside lists.
- **One accent** `#4338ca` (indigo): links, grid selection, focus of charts. Never a button fill.
- **Status tints** (text on 12-15% tint, no border): green `#047857/#d1fae5`, amber `#92400e/#fef3c7`,
  red `#b91c1c/#fee2e2`, blue `#1e40af/#dbeafe`, neutral `#334155/#e2e8f0`.
- **Score bands**: every coloured win probability (grid pill + meter, average-win KPI bar, panel
  score and bar) uses the recommendation's bands, so colour and advice never disagree:
  >= 60 green (fight), 30-59 amber (offer refund), < 30 red (accept). The numbers are FIGHT_AT /
  ACCEPT_BELOW in `app/scoring.py`, mirrored once in `web/src/api.ts` (`winBand`).
- **Focus**: 3px amber outline, 2px offset, on everything focusable.

## Type
Inter / system sans. App title 22px/700. Panel title 20px/700. Page title 34px/800. Big numbers 40px/800, tabular.
Body 14-15px. Section labels 12px uppercase, 0.06em tracking, muted. 20-24px between sections.

## Buttons
- **Primary**: near-black pill `#111827`, white text, 600, radius 999px, 10px 18px. One per screen
  or step (Simulate chargeback in the header, Submit evidence or the recommended settle action in
  the panel, the confirm button of a confirm step).
- **Secondary**: white pill, 1px `#d5d9e2` border, ink text. Sync from PayPal, Close, Cancel.
- **Done**: green fill, disabled, keeps its label ("Evidence submitted", "Claim accepted").
- Disabled: 0.55 opacity, not-allowed cursor. Busy: label changes ("Syncing...", "Sending...").

## Pills
Short tinted pills, 12px/600, radius 999px: grid status, source, win %, Needs review, AI source.
The **recommendation pill** sits next to the score: Fight (green), Offer refund (amber),
Accept (red), with the one-line reason under it in muted text.

## Toast
White surface, 16px radius, the surface shadow, a tinted dot for tone (green ok, amber flag, red
error). Title in 15px/700, detail lines muted. Lives in a `role=status` region that is always in the
DOM. Success hides after 10s; errors stay until dismissed. A Dismiss button closes it.

**Toast zone** (a toast never covers a row or a card):
- Desktop: on the canvas under the grid, right-aligned with the grid's right edge (left of the
  case panel when one is open). While it shows, the grid gives up its height plus a 16px gap
  (`--toast-room`, measured from the toast), so rows end above it; the grid's own body scrolls.
- Phone: in the page flow at the top of the stage, under the header's Simulate button and above
  the page title, full width. It pushes the page down rather than floating over a card.

## Screens
- **Header** (on the canvas, no bar or border): shield mark + title + tagline on the left;
  Demo mode pill, Autopilot switch + threshold, Sync from PayPal (secondary), Simulate chargeback
  (primary, demo only) on the right. Wraps under the title below 700px.
- **Page title**: "Disputes" 34px/800, -0.025em, on the canvas, with a one-line muted subtitle on
  the same baseline (refs 2 and 8: a big plain title over the table, no breadcrumb bar).
- **KPI strip**: four floating white cards in one row (2x2 on a phone, never a sideways scroll),
  16px gap, 18px radius, 16-20px padding. Anatomy, top to bottom (ref 1): label (12px uppercase,
  muted) with an optional pill top-right; the big number (40px/800, tabular, -0.03em; 30px on a
  phone); a muted 13px foot line that says what the number means. Cards, all from `/api/summary`:
  - *Open disputes*: the count; a red "N due in 48 h" pill top-right when any are.
  - *Money at risk*: one line per currency, never converted or summed across currencies (no FX
    rate we can stand behind). Up to two currencies at 26px side by side; three or more drop to a
    2-column grid at 18px (stacked on a phone). Foot: "in 4 currencies, open cases only".
  - *Average win chance*: "59%" and a 6px bar tinted by score band (see Score bands).
  - *Next deadline*: urgency pill top-right ("1d 5h left" or "5m left", the grid's own countdown text: red under 48 h, amber under 96 h,
    neutral after); body is a quiet button with that case's amount (28px) and reason + id (id in
    the indigo accent); it opens the case.
  - **F28, win chance cap:** a win chance never displays above 95% (a raw score of 96-100 shows "95%") in the grid, phone card, case sheet, Recommended copy, KPI average (of the capped values), audit lines and toasts; the raw score stays in the API. When raw > 95 the factor ledger ends with a muted "Capped at 95%" row ("No chargeback is a sure win", value "−N", N = raw − 95) so it adds up to the headline; no row at 95 or below.
  - Empty values are an em dash, counts are 0. Never "null", "NaN" or a blank card.
  - **F25, phone (up to 700px):** *Money at risk* shows the first currency as the one main total
    (26px/800) and a muted 13px "+N currencies" native `<details>` under it that opens the rest at
    16px; the desktop strip is unchanged and lists every currency. *Next deadline*'s reason line
    wraps instead of cutting off with an ellipsis.
  - **F25, one win chance everywhere:** a case with no documents has no score, so the grid, the phone
    card and the case sheet all show a muted em dash. In the sheet it is the 40px "—" with the muted
    line "Upload evidence to score" beside it (no bar); the rulebook baseline is not shown as a
    percentage. The number appears in all three once evidence is added.
- **Money** (ref 3): `Intl.NumberFormat` in the dispute's own currency (en-US): `€128.00`,
  `£86.40`, `NOK 1,299.00`. Whole units in ink 700; the decimals and a multi-letter code muted 500,
  so a column of amounts reads by magnitude. Right-aligned, tabular figures.
- **Grid** (refs 3, 5, 8): one white surface, 18px radius, soft shadow, no border, no column
  lines. Header white, 11px uppercase muted, 0.06em tracking, 44px high. Rows 56px with hairline
  `#eef0f4` separators, hover `#f7f8fb`. Dispute id in monospace 13px/600. Status pills carry a
  6px dot in their own colour. Win % is a tinted pill plus a 52px x 4px meter. Respond-within is
  two lines: the countdown (a red tinted pill under 48 h, 600 ink text otherwise) over a muted
  12px "by 1 Nov, 15:13". Open rows: white with a 3px red bar on the left edge (a pink row fill
  on every open case was too loud and hid the pills). Answered/closed rows: `#fbfbfd`, muted text.
  Rows jump straight to their new place (no row animation): a sliding row drew over the one
  inserted into its slot.
- **Grid with the panel open** (>= 1100px): the grid stops 16px left of the panel instead of
  running under it, and drops the columns the panel already says, in this order, until the rest
  fit: Source, Reason, Amount, Respond within, Win %. Status pills are never cut off. At 1440 the
  grid keeps Dispute, Status, Win % and Respond within. Every column comes back on Close.
- **Empty state** (inside the grid surface, never AG Grid's "No Rows To Show"): a small two-tone
  SVG (indigo tints: a receipt card with the shield mark), "No disputes yet" 22px/800, one muted
  sentence, then in demo mode "Simulate your first chargeback" (the dark pill) and "Load sample
  disputes" (secondary). While it shows, the header's Simulate steps back to a secondary pill so
  there is one dark pill on screen. Outside demo mode: a hint to Sync from PayPal.
- **Loading**: while the list (or a seed/simulate from empty) is in flight and there are no rows,
  shimmering skeleton rows (32px bars, 10px radius) with "Loading disputes..." replace the grid
  body. Never an empty grid, never the empty state before the first answer.
- **Detail panel**: a white sheet floating 12px in from the right edge on desktop (18px radius,
  580px wide); full screen, no radius, on mobile. Head: dispute id, reason/amount/status, Close.
  A Needs review banner sits at the top of the scrolling body and scrolls away with it (never pinned
  over the cards). Body sections: Win probability (big number, bar, recommendation pill + reason, factors),
  Extracted evidence, Dossier preview, Audit trail. Sticky foot: result banner (live region),
  then the actions.
- **Panel foot actions**: score >= 60 (Fight): Submit evidence is the dark pill. Score < 60:
  Offer refund and Accept claim sit side by side; the recommended one is the dark pill and Submit
  evidence drops to a quiet text button under them (still a real button, to fight anyway). Offer refund opens an inline form (amount with currency, max = the
  disputed amount; it starts at half of it when the advice is Offer refund, else at all of it; note to
  the buyer). A bad amount is caught before sending: `aria-invalid`, a red tint on the box and a small
  red hint pill under it, like the threshold. Accept claim opens a confirm step that
  names the amount going back. Results say "Demo mode: nothing was sent to PayPal" or "Sent to
  PayPal sandbox".
- **Mobile 375px**: one job per screen: the case cards, or the full-screen panel. Header wraps; the
  panel foot stays at the bottom so the primary action is in thumb reach. Large type kept.
- **Mobile case cards** (<= 700px, instead of the grid): one white card per case on the canvas
  (18px radius, the surface shadow, 16-18px padding, 12px apart), in the grid's order, made from the
  same rows and the same renderers. Anatomy: dispute id (mono 13px, muted) with the status pills
  (dot, tinted) beside it or wrapped under it; the amount big (30px/800, decimals and code muted);
  the reason muted 14px; then a hairline and two columns with 11px uppercase labels: *Win chance*
  (pill + meter) and *Respond within* (the countdown, a red pill under 48 h, over "by 4 Nov, 09:45").
  Closed cases mute the amount. Each card is a real `<button>` named "Dispute <id>, <amount>,
  <status>, win chance N%, <time left>"; tap or Enter opens the full-screen panel, Close returns
  focus to the card. Loading and empty states become white cards of their own.

- **Add evidence** (panel, "Extracted evidence" section): a secondary pill above the cards, accessible
  name "Add evidence", that opens a hidden `input[type=file][accept="application/pdf"]`. The whole
  evidence area is a drop zone (`data-drop`, inset 16px radius): while a file is dragged over it gets
  `is-over` (indigo tint plus a 2px indigo-light ring); it clears on dragleave and drop. The empty state
  reads "No documents uploaded yet. Drop a PDF here, or use Add evidence." Busy: the pill is disabled,
  `aria-busy="true"`, shows the spinner and reads "Reading…". Done: cards, panel score, grid row and
  phone card repaint with no reload; the audit trail gets "Document added: <name>". Errors are a
  `.banner-bad` under the pill in plain words ("That file isn't a PDF." checked on the first bytes before
  anything is sent, "That PDF is over the 10 MB limit.", "Could not reach the server."); the next
  upload clears it. On a phone (<= 700px) the pill is full width and at least 44px tall. Evidence
  badges: "AI · model · live", "AI · model · recorded", or "Text parser" (title: no model answered).
- **Autopilot** (header): one floating white pill holding a switch (the real `role=switch` checkbox
  drawn as a 40x24 track, grey off, indigo on) and the threshold as a 999px pill input without spin
  arrows. A bad threshold gets `aria-invalid`, a red tint and a small red hint pill under it; it is
  not sent until it is a whole number 0-100.
- **Banners** (result, Needs review): tinted cards, 14px radius, no border.
- **Busy buttons**: Simulate chargeback reads "Reading the receipt…" with a small spinning ring.

## Token gate
A sign-in card, the only thing on the canvas until the server accepts a token (the header, stage and
footer status line are hidden; the status stays for screen readers). The page calls no protected
`/api` route without a token, so a first visit logs no 401.
- **Card**: white, 20px radius (18px on a phone), a slightly deeper surface shadow, 32px padding
  (24px 20px on a phone), `min(440px, 100% - 24px)` wide, centred on the canvas both ways.
- **Anatomy**: 36px indigo-tint tile with the shield mark + "DisputeShield AI" 15px/700; title
  28px/800, -0.025em, balanced wrap; one muted 15px line on what the console is.
- **Demo mode** (`/api/config` returns a `demo_token`): title "Open the operator console", then
  "Open demo console" as the one dark pill, full width; it stores the token and opens the console.
  Under it a muted 13px note: sandbox only, anyone who can reach the port can open it, and
  `DISPUTESHIELD_DEMO_MODE=0` (inset code chip) turns it off. The paste form follows under a hairline
  with a "Have an operator token?" section label, quieter hint text, and Use token as a secondary pill.
- **Demo off**: title "Operator token needed", the hint, and the paste form with Use token as the
  dark pill. No demo button.
- **Form**: "Token" label 13px/600; a 999px pill input and the button side by side.
- **Refused** (a link or a pasted token got a 401): "That token was not accepted." in a red-tint
  12px-radius strip under the form; the demo button stays on offer.
