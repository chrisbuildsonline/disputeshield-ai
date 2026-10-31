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
- **Focus**: 3px amber outline, 2px offset, on everything focusable.

## Type
Inter / system sans. App title 22px/700. Panel title 20px/700. Big numbers 44px/800, tabular.
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
- **KPI strip** (F14, not built yet): a row of 3-4 white cards between header and grid: open
  disputes, amount at risk, due in 48h, win rate. Big number, muted label.
- **Grid**: one white surface, 18px radius, soft shadow, no border. 48px rows, tinted status pills,
  contested rows get a red inset bar. Countdown in red under 48h.
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
- The grid page has no large visible screen title ("Disputes" is sr-only); F14's KPI strip
  should bring a large title and big numbers onto the page.
- The empty state is plain text in the grid; to be redone with the empty-state feature.
- The token gate still uses the bordered info banner style.
