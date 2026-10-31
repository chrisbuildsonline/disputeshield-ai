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
Bottom-right on desktop, bottom full-width (12px gutters) on mobile. White surface, 16px radius,
the surface shadow, a tinted dot for tone (green ok, red error). Title in 15px/700, detail lines
muted. Lives in a `role=status` region that is always in the DOM. Success hides after 10s; errors
stay until dismissed. A Dismiss button closes it.

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
  - *Next deadline*: urgency pill top-right ("Due in 29 h": red under 48 h, amber under 96 h,
    neutral after); body is a quiet button with that case's amount (28px) and reason + id (id in
    the indigo accent); it opens the case.
  - Empty values are an em dash, counts are 0. Never "null", "NaN" or a blank card.
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
  Body sections: Win probability (big number, bar, recommendation pill + reason, factors),
  Extracted evidence, Dossier preview, Audit trail. Sticky foot: result banner (live region),
  then the actions.
- **Panel foot actions**: score >= 60 (Fight): Submit evidence is the dark pill. Score < 60:
  Offer refund and Accept claim sit side by side; the recommended one is the dark pill and Submit
  evidence drops to a quiet text button under them (still a real button, to fight anyway). Offer refund opens an inline form (amount with currency, max = the
  disputed amount, defaulting to it; note to the buyer). Accept claim opens a confirm step that
  names the amount going back. Results say "Demo mode: nothing was sent to PayPal" or "Sent to
  PayPal sandbox".
- **Mobile 375px**: one job per screen: the grid, or the full-screen panel. Header wraps; the
  panel foot stays at the bottom so the primary action is in thumb reach. Large type kept.

## Where the current CSS differs (left for later features)
- The token gate still uses the bordered info banner style.
- The Status column is too narrow for "Open" + "Needs review" side by side (clips).
- The header's Autopilot checkbox and threshold input are still browser defaults.
