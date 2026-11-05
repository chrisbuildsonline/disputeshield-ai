import {
  api,
  ApiError,
  esc,
  money,
  needsAction,
  postFile,
  reasonLabel,
  statusLabel,
  type ActResult,
  type AuditRow,
  type Dispute,
  type Dossier,
  type Evidence,
  type InvoiceResult,
  type Money,
  type RecAction,
  type Score,
  type SubmitResult,
  winBand,
} from "./api";

const DEMO_LABEL = "Demo mode: nothing was sent to PayPal";
const DEFAULT_OFFER_NOTE = "We're sorry this order didn't work out for you. We'd like to settle this with the refund offered here.";

const REC: Record<RecAction, [label: string, tone: string]> = {
  fight: ["Fight", "badge-green"],
  offer_refund: ["Offer refund", "badge-amber"],
  accept: ["Accept", "badge-red"],
};

/** A slow step: its plain label (what a screen reader hears) and when it began (what the counter counts from). */
interface Step {
  label: string;
  since: number;
}

const secsSince = (since: number) => Math.floor((Date.now() - since) / 1000);
let ticker = 0;

/** "· 12 s", hidden from assistive tech so the seconds are never announced. One timer updates every counter on the page and stops when none is left. */
function elapsed(since: number): string {
  if (!ticker) {
    ticker = window.setInterval(() => {
      const counters = document.querySelectorAll<HTMLElement>(".elapsed");
      if (!counters.length) stopTicker();
      counters.forEach((c) => (c.textContent = `· ${secsSince(Number(c.dataset.since))} s`));
    }, 1000);
  }
  return `<span class="elapsed" aria-hidden="true" data-since="${since}">· ${secsSince(since)} s</span>`;
}

function stopTicker(): void {
  window.clearInterval(ticker);
  ticker = 0;
}

const stepPill = (s: Step) => `<p class="step"><span class="spinner" aria-hidden="true"></span><span>${esc(s.label)} ${elapsed(s.since)}</span></p>`;

/** The step names the model only when one is called, never a made-up one. */
const withModel = (what: string, model: string | null) => (model ? `${what} with ${model}` : what);

/** Audit actions that hold the one-act-per-dispute claim: after these nothing more can be sent. */
const ANSWERED = new Set(["submitted", "accepted", "accept_unconfirmed", "offer_unconfirmed"]);

/** The newest evidence submission, accept or offer in the audit trail (rows are oldest first). */
function lastAct(rows: AuditRow[]): AuditRow | undefined {
  return [...rows].reverse().find((a) => a.action === "submitted" || a.action === "accepted" || a.action === "offered");
}

const where = (d: Record<string, unknown>) => (d.mode === "paypal" ? " in PayPal sandbox" : " (demo mode, not sent to PayPal)");

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const FIELDS: [keyof Evidence, string][] = [
  ["carrier", "Carrier"],
  ["tracking_number", "Tracking number"],
  ["delivered_at", "Delivered"],
  ["delivered_to", "Delivered to"],
  ["signed_by", "Signed by"],
  ["order_id", "Order ID"],
  ["amount", "Order amount"],
];

/** With autopilot off the agent only checks the case: the trail says a person is needed, not that an autopilot ran. */
function auditText(a: AuditRow): string {
  const d = a.detail;
  if (d.autopilot_off === true) {
    switch (a.action) {
      case "autopilot_flagged":
        return `Waiting for review: ${Array.isArray(d.reasons) ? d.reasons.map(String).join("; ") : ""}`;
      case "autopilot_started":
        return "Checking the case";
      case "autopilot_evidence":
        return `Checked ${String(d.documents ?? 0)} document(s)`;
      case "autopilot_scored":
        return `Scored the case ${String(d.probability)}%`;
    }
  }
  switch (a.action) {
    case "simulated_chargeback":
      return "Chargeback received (simulated)";
    case "document_added":
      return `Document added: ${String(d.name ?? "")}`;
    case "submitted":
      return d.mode === "paypal" ? "Evidence sent to PayPal sandbox" : "Evidence submitted (demo mode, not sent to PayPal)";
    case "submit_refused":
      return `Submit refused: ${String(d.reason ?? "")}`;
    case "submit_failed":
      return `Submit failed: ${String(d.error ?? "")}`;
    case "synced":
      return "Synced from PayPal";
    case "accepted":
      return `Claim accepted${where(d)}`;
    case "offered": {
      const amt = (d.amount ?? {}) as { value?: string; currency_code?: string };
      return `Refund offer of ${money(amt.value ?? null, amt.currency_code ?? null) || "an amount"} made${where(d)}`;
    }
    case "accept_failed":
      return `Accept failed: ${String(d.error ?? "")}`;
    case "offer_failed":
      return `Offer failed: ${String(d.error ?? "")}`;
    case "accept_unconfirmed":
    case "offer_unconfirmed":
      return "Sent to PayPal but not confirmed: run Sync from PayPal to check";
    case "autopilot_started":
      return "Autopilot started";
    case "autopilot_evidence":
      return `Autopilot read ${String(d.documents ?? 0)} document(s)`;
    case "autopilot_scored":
      return `Autopilot scored the case ${String(d.probability)}% (threshold ${String(d.threshold)}%)`;
    case "autopilot_submitted":
      return "Autopilot submitted the evidence";
    case "autopilot_flagged":
      return `Autopilot flagged for review: ${Array.isArray(d.reasons) ? d.reasons.map(String).join("; ") : ""}`;
    case "autopilot_awaiting":
      return `Auto-check: scored ${String(d.probability)}%, waiting for your review`;
    case "autopilot_skipped":
      return "Autopilot skipped (closed or already submitted)";
    case "invoice_recorded": {
      const num = String(d.invoice_number ?? d.invoice_id ?? "");
      return d.mode === "paypal"
        ? `Recorded on PayPal as draft invoice ${num}${d.debug_id ? ` · debug id ${String(d.debug_id)}` : ""}`
        : `Demo: invoice fixture ${num} recorded, nothing sent to PayPal`;
    }
    case "invoice_failed":
      return `Invoice not recorded: ${String(d.error ?? "")}${d.debug_id ? ` · debug id ${String(d.debug_id)}` : ""}`;
    default:
      return a.action.replace(/_/g, " ");
  }
}

const START_OLLAMA = "Start Ollama for live reads.";

/** "recorded": no model was reachable, so this is what a real model run wrote earlier for these exact inputs. */
function sourceBadge(source: string, model?: string | null): string {
  const recorded = source === "recorded";
  const ai = recorded || source === "ollama" || source === "claude";
  if (source === "template") return `<span class="badge badge-muted">Template</span>`;
  if (!ai) return `<span class="badge badge-muted" title="No model answered, so the text parser read this PDF">Text parser</span>`;
  const name = esc(model || (source === "claude" ? "Claude" : recorded ? "the model" : "Ollama"));
  if (!recorded) return `<span class="badge badge-ai">AI &middot; ${name} &middot; live</span>`;
  return `<span class="badge badge-ai badge-recorded" title="Recorded from a real ${name} run. ${START_OLLAMA}">AI &middot; ${name} &middot; recorded</span>`;
}

/** One quiet line per panel when anything in it was recorded rather than read live. */
function recordedLine(score: Score, dossier: Dossier | null): string {
  const docs = score.documents.filter((d) => d.evidence.source === "recorded");
  const note = dossier?.note_source === "recorded";
  if (!docs.length && !note) return "";
  // the read and the note can come from different models: name each one that was used
  const models = [...new Set([...docs.map((d) => d.evidence.model), note ? dossier.note_model : null].filter((m): m is string => !!m))];
  const runs = models.length > 1 ? `real ${models.map(esc).join(" and ")} runs` : `a real ${esc(models[0] ?? "model")} run`;
  const pdfs = docs.length === 1 ? "this exact PDF" : docs.length ? "these exact PDFs" : "";
  const what = note ? (pdfs ? `${pdfs} and these case facts` : "these exact case facts") : pdfs;
  return `<p class="recorded-line">Recorded from ${runs} on ${what}. ${START_OLLAMA}</p>`;
}

/** A fact as read from the receipt; the order amount is money in the case's currency, like every other amount. */
function factText(e: Evidence, k: keyof Evidence, currency: string | null): string {
  const v = String(e[k]);
  return k === "amount" ? money(v, currency) || v : v;
}

function renderEvidence(score: Score, currency: string | null): string {
  if (!score.documents.length) return `<p class="muted drop-hint">No documents uploaded yet. Drop a PDF here, or use Add evidence.</p>`;
  return score.documents
    .map((doc) => {
      const e = doc.evidence;
      const rows = FIELDS.filter(([k]) => e[k]).map(([k, label]) => `<dt>${label}</dt><dd>${esc(factText(e, k, currency))}</dd>`);
      for (const m of e.customer_messages) rows.push(`<dt>Customer message</dt><dd>${esc(m)}</dd>`);
      return `<div class="card"><div class="card-head"><strong>${esc(doc.name)}</strong>
        <span class="by"><span class="muted">Read by</span> ${sourceBadge(e.source, e.model)}</span></div>
        <dl class="facts">${rows.join("") || `<dt>Nothing found</dt><dd>No facts could be read from this file.</dd>`}</dl></div>`;
    })
    .join("");
}

function renderScore(score: Score): string {
  const { band } = winBand(score.probability);
  const tone = { fight: "good", offer: "warn", accept: "bad" }[band];
  const factors = score.factors
    .map(
      (f) => `<li class="factor ${f.met ? "met" : "unmet"}">
        <span class="mark" aria-hidden="true">${f.met ? "&#10003;" : "&#10005;"}</span>
        <span class="factor-text"><span>${esc(f.label)}</span><span class="muted">${esc(f.reason)}</span></span>
        <span class="points">${f.met ? "+" : ""}${f.points}<span class="sr-only"> points</span></span></li>`,
    )
    .join("");
  const [recLabel, recTone] = REC[score.recommendation.action];
  // no documents: the grid and the phone card show a dash, so the sheet does too (the rulebook's 9% is only a baseline)
  const unscored = score.documents.length === 0;
  const head = unscored
    ? `<div class="score score-none">
      <div class="score-num muted" aria-label="Win probability not scored yet">&mdash;</div>
      <p class="score-hint muted">Upload evidence to score</p>
    </div>`
    : `<div class="score">
      <div class="score-num ${tone}" aria-label="Win probability ${score.probability} percent">${score.probability}%</div>
      <div class="score-bar" aria-hidden="true"><span class="${tone}" data-band="${band}" style="width:${score.probability}%"></span></div>
    </div>`;
  return `${head}
    <div class="rec"><span class="rec-label">Recommended</span><span class="badge rec-pill ${recTone}">${recLabel}</span>
      <p class="rec-reason muted">${esc(unscored ? "No evidence yet, so there is no score. Upload a receipt to see how strong the case is." : score.recommendation.reason)}</p></div>
    <ul class="factors"><li class="factor base"><span class="mark" aria-hidden="true">&#8226;</span>
      <span class="factor-text"><span>Starting point</span><span class="muted">Baseline for this kind of dispute</span></span>
      <span class="points">${score.base}</span></li>${factors}</ul>`;
}

/** The recorded line sits under the evidence cards, or under the note when only the note was recorded. */
function renderDossier(d: Dossier | null, noteError: boolean, score: Score, writing: Step): string {
  if (!d) {
    // the step is read out once, by the live region (announce); this line is for the eyes
    return noteError
      ? `<p class="muted note-pending" role="status">The rebuttal note could not be loaded. Submit still sends it.</p>`
      : `<p class="muted loading note-pending" aria-hidden="true"><span class="spinner" aria-hidden="true"></span>${esc(writing.label)} ${elapsed(writing.since)}</p>`;
  }
  const docLine = score.documents.some((x) => x.evidence.source === "recorded");
  const line = docLine ? "" : recordedLine(score, d);
  const files = d.files.length
    ? `<ul class="files">${d.files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
    : `<p class="muted">No files will be attached.</p>`;
  return `<div class="card"><div class="card-head"><strong>Rebuttal note</strong><span class="by"><span class="muted">Written by</span> ${sourceBadge(d.note_source, d.note_model)}</span></div>
    <p class="note">${esc(d.note)}</p></div>${line}
    <h4>Attached documents</h4>${files}`;
}

function renderAudit(rows: AuditRow[]): string {
  if (!rows.length) return `<p class="muted">Nothing has happened yet.</p>`;
  return `<ol class="audit">${rows
    .map((a) => `<li><time datetime="${esc(a.at)}">${esc(new Date(a.at).toLocaleTimeString())}</time><span>${esc(auditText(a))}</span></li>`)
    .join("")}</ol>`;
}

const INVOICE_LINE =
  "Creates a draft invoice in the PayPal sandbox (nothing is sent to the buyer) as a PayPal-side record of the sale. Simulated cases get a labelled demo record.";

/** What the invoice banner shows, from the POST answer or from the invoice_recorded audit row on a reload. */
interface InvoiceView {
  demo: boolean;
  simulated: boolean;
  number: string;
  id: string;
  total: Money | null;
  debugId: string | null;
  already: boolean;
}

function invoiceFromResult(r: InvoiceResult): InvoiceView {
  return {
    demo: r.demo,
    simulated: r.simulated_case,
    number: r.invoice_number,
    id: r.invoice_id,
    total: r.fields.total,
    debugId: r.debug_id,
    already: r.already_recorded,
  };
}

function invoiceFromAudit(d: Record<string, unknown>): InvoiceView {
  const total = d.total as Money | undefined;
  return {
    demo: d.mode !== "paypal",
    simulated: d.simulated_case === true,
    number: String(d.invoice_number ?? ""),
    id: String(d.invoice_id ?? ""),
    total: total && typeof total === "object" ? total : null,
    debugId: typeof d.debug_id === "string" ? d.debug_id : null,
    already: false,
  };
}

function renderInvoiceBanner(v: InvoiceView): string {
  const total = v.total ? money(v.total.value, v.total.currency_code) : "";
  const lines = [
    `${v.demo ? "Demo invoice" : "Draft invoice"} ${esc(v.number)}${total ? ` · ${esc(total)}` : ""}${v.demo ? "" : " · not sent to the buyer"}`,
    `Invoice id <span class="mono">${esc(v.id)}</span>${v.debugId ? ` · debug id <span class="mono">${esc(v.debugId)}</span>` : ""}`,
  ];
  if (v.already) lines.push("Recorded earlier: nothing new was created.");
  if (v.simulated) lines.push(`<span class="banner-note">Simulated case · invoice call live on sandbox</span>`);
  const title = v.demo ? DEMO_LABEL : "Recorded on PayPal sandbox";
  return `<div class="banner banner-${v.demo ? "info" : "good"}" tabindex="-1"><strong>${esc(title)}</strong>${lines.map((l) => `<span>${l}</span>`).join("")}</div>`;
}

/** Half the disputed amount, to the cent: where a partial refund offer starts. */
function half(value: string): string {
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) ? (Math.round(cents / 2) / 100).toFixed(2) : value;
}

/** Why an offer amount can't be sent, or null when it can: the server's rules, checked before any request. */
function offerProblem(raw: string, badInput: boolean, max: string | null, currency: string | null): string | null {
  const v = raw.trim();
  if (badInput || !/^-?(\d+\.?\d*|\.\d+)$/.test(v)) return "Enter the refund amount as a number, like 25.00.";
  if (Number(v) <= 0) return "The refund has to be more than 0.";
  if (/\.\d{3,}$/.test(v)) return "Use at most two decimals.";
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return "Enter the refund amount as a number, like 25.00."; // the server's own rule: ".5" and "5." are refused
  if (max !== null && Number(v) > Number(max)) return `The refund can't be more than ${money(max, currency)}, the disputed amount.`;
  return null;
}

export type Act = "submit" | "accept" | "offer" | "sync" | "invoice";

/** A plain sentence for a failed call. The server's own words are kept where they are already plain. */
export function errorText(e: unknown, act: Act = "submit"): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  const d = e.detail;
  const text = typeof d === "string" ? d : "";
  if (e.status === 409) {
    if (text.startsWith("PayPal keys are not set")) return text;
    if (text === "dispute is closed") return "This dispute is closed, so nothing more can be sent.";
    if (text === "an offer is already waiting for the buyer") return "An offer is already waiting for the buyer's answer, so a second one can't be made.";
    if (text === "already submitted or acted on") return "This dispute was already answered (evidence sent or the claim accepted), so nothing more can be sent.";
    return "This dispute was already submitted or is closed, so nothing more can be sent.";
  }
  if (e.status === 422) {
    if (act === "offer") {
      const why = text.startsWith("amount must be") ? "enter an amount above 0 with at most two decimals" : text || "check the amount and the note";
      return `The offer was not sent: ${why}.`;
    }
    if (act === "accept") return `The claim was not accepted: ${text || "check the note"}.`;
    if (act === "invoice") return `The invoice was not recorded: ${text.replace(/^can't invoice this dispute: /, "") || "the amount can't be invoiced"}.`;
    return `Evidence can't be submitted yet: ${text || "the documents were not accepted"}.`;
  }
  if (e.status === 502 && d && typeof d === "object") {
    const o = d as { message?: string; debug_id?: string };
    return `PayPal turned the request down: ${o.message ?? "unknown error"}${o.debug_id ? ` (debug id ${o.debug_id})` : ""}. Nothing was lost, you can try again.`;
  }
  if (e.status === 0) return "Could not reach the server. Check your connection and try again.";
  return text || "Something went wrong. Please try again.";
}

/** A plain sentence for a refused or failed evidence upload (the server's 422 wording is for developers). */
export function uploadErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  const text = typeof e.detail === "string" ? e.detail : "";
  if (e.status === 0) return text || "Could not reach the server.";
  if (e.status === 413 || text.includes("larger than")) return "That PDF is over the 10 MB limit.";
  if (e.status === 422) {
    if (/not a PDF|does not look like|file type not allowed/.test(text)) return "That file isn't a PDF.";
    if (text.startsWith("duplicate file name")) return "A file with that name is already added. Rename it and try again.";
    if (text.startsWith("file name not allowed")) return "That file name can't be used. Rename the file and try again.";
    return `That PDF can't be added${text ? `: ${text}` : ""}.`;
  }
  return "Something went wrong. Please try again.";
}

/** The first bytes of a real PDF. */
async function looksLikePdf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head) === "%PDF-";
}

export interface Detail {
  open(d: Dispute): void;
  close(): void;
  isOpen(): boolean;
  /** Called by the grid poll so the header and submit button follow the live row; the score reloads when the row's evidence, win chance or status moved. */
  update(d: Dispute): void;
  /** The audit trail is cheap, so it refreshes with every poll (the rebuttal note does not, it can cost a model call). */
  refreshAudit(): void;
}

export function createDetail(opts: { onClose: (id: string) => void; onSubmitted: () => void }): Detail {
  const panel = el<HTMLElement>("detail");
  const body = el<HTMLElement>("detail-body");
  const button = el<HTMLButtonElement>("submit-btn");
  const result = el<HTMLElement>("submit-result");
  let current: Dispute | null = null;
  let score: Score | null = null;
  let dossier: Dossier | null = null; // arrives after the score: a model may write the note
  let noteKey = ""; // the case + documents the note held or being fetched is for
  let noteError = false;
  let scoreJson = "";
  let rowSig = ""; // what the grid row looked like when the score was last fetched
  let loadSeq = 0;
  let audit: AuditRow[] = [];
  let auditJson = "";
  let sending = false;
  let loadError: string | null = null;

  const settle = el("settle");
  const settleActions = el("settle-actions");
  const offerBtn = el<HTMLButtonElement>("offer-btn");
  const acceptBtn = el<HTMLButtonElement>("accept-btn");
  const offerForm = el<HTMLFormElement>("offer-form");
  const offerAmount = el<HTMLInputElement>("offer-amount");
  const offerNote = el<HTMLTextAreaElement>("offer-note");
  const offerSend = el<HTMLButtonElement>("offer-send");
  const confirmBox = el("accept-confirm");
  const acceptYes = el<HTMLButtonElement>("accept-yes");
  let acting: "accept" | "offer" | null = null;
  let acted: "accepted" | "offered" | null = null; // set on success, before the audit poll catches up
  let invoice: InvoiceView | null = null; // the POST answer, before the audit poll catches up
  let invoiceError: string | null = null;
  let invoiceBusy: string | null = null; // the dispute id being recorded, so a switch of case can't unlock another one
  let adding: string | null = null; // the dispute id a PDF is being read for
  let addStep: Step | null = null; // what that read is doing right now
  let evidenceError: string | null = null;
  let submitStep: Step | null = null; // while `sending`: writing the note, then the send
  let noteWriting: Step = { label: "Writing the rebuttal note…", since: Date.now() };
  let noteLoad: Promise<void> = Promise.resolve(); // the /dossier request in flight, shared with a submit that needs the note
  // which model runs the slow steps, and whether a submit really calls PayPal: the server says, the console never guesses
  let llmModel: string | null = null;
  let paypalLive = false;
  void api<{ llm_model?: string | null; paypal?: boolean }>("/api/config")
    .then((c) => {
      llmModel = c.llm_model ?? null;
      paypalLive = !!c.paypal;
    })
    .catch(() => undefined);

  // one polite live region outside every repainted area: it hears each step change once, never the ticking seconds
  const liveRegion = el("progress-live");
  const announce = (text: string) => void (liveRegion.textContent = text);
  const unannounce = (text: string) => liveRegion.textContent === text && announce("");

  /** The evidence section: heading, the Add evidence pill with its hidden file input, any error, the cards or the empty hint. */
  function renderEvidenceBox(sc: Score): string {
    const busy = adding !== null && adding === current?.id;
    const label = busy ? `<span class="spinner" aria-hidden="true"></span>Reading…` : "Add evidence";
    const err = evidenceError ? `<div class="banner banner-bad" role="alert"><span>${esc(evidenceError)}</span></div>` : "";
    const step = busy && addStep ? stepPill(addStep) : "";
    const recorded = sc.documents.some((d) => d.evidence.source === "recorded");
    return `<h3 id="h-evidence">Extracted evidence</h3>
      <div class="add-row"><button id="add-evidence-btn" class="btn add-btn" type="button"${busy ? ' disabled aria-busy="true"' : ""}>${label}</button>
      <input id="evidence-file" type="file" accept="application/pdf" hidden></div>${step}${err}
      ${renderEvidence(sc, current?.currency ?? null)}${recorded ? recordedLine(sc, dossier) : ""}`;
  }

  function paintEvidence(): void {
    const box = document.getElementById("evidence-box");
    if (box && score) box.innerHTML = renderEvidenceBox(score);
  }

  async function addFiles(files: File[]): Promise<void> {
    if (!current || !score || adding || !files.length) return;
    const d = current;
    const here = () => current?.id === d.id;
    adding = d.id;
    evidenceError = null;
    const step = (label: string) => {
      addStep = { label, since: Date.now() };
      if (here()) {
        paintEvidence();
        announce(label);
      }
    };
    paintEvidence();
    let added = false;
    try {
      for (const f of files) {
        if (!(await looksLikePdf(f))) {
          evidenceError = "That file isn't a PDF.";
          break;
        }
        step(withModel(`Reading ${f.name}`, llmModel));
        await postFile(`/api/disputes/${encodeURIComponent(d.id)}/documents?name=${encodeURIComponent(f.name)}`, f);
        added = true;
      }
    } catch (e) {
      if (here()) evidenceError = uploadErrorText(e);
    }
    if (added && here()) {
      step("Scoring the case");
      // the new read and score; if this fails the old ones stay and the next open shows the card
      const s = await api<Score>(`/api/disputes/${encodeURIComponent(d.id)}/score`).catch(() => null);
      if (s && here()) {
        score = s;
        scoreJson = JSON.stringify(s);
      }
    }
    adding = null;
    addStep = null;
    if (here()) {
      announce("");
      paintBody();
      paintHeader(); // the score can cross the fight line, which moves the dark pill
      if (added) void loadDossier(d); // new documents, new note
      document.getElementById("add-evidence-btn")?.focus();
      void refreshAudit(); // its "Document added" line
    }
    if (added) opts.onSubmitted(); // the grid row's and the phone card's win chance
  }

  /** Recorded (from this session or the audit trail on open): the banner. Otherwise the line, the action and any error. */
  function renderInvoice(): string {
    const row = audit.find((a) => a.action === "invoice_recorded"); // the first record wins, like the server
    const view = invoice ?? (row ? invoiceFromAudit(row.detail) : null);
    if (view) return renderInvoiceBanner(view);
    const busy = invoiceBusy !== null && invoiceBusy === current?.id;
    const label = busy ? `<span class="spinner" aria-hidden="true"></span>Recording…` : "Record as PayPal invoice";
    const err = invoiceError
      ? `<div class="banner banner-bad" tabindex="-1"><strong>Invoice not recorded</strong><span>${esc(invoiceError)}</span></div>`
      : "";
    return `<div class="invoice-card"><p class="invoice-line">${INVOICE_LINE}</p>
      <button id="invoice-btn" class="btn" type="button"${busy ? ' disabled aria-busy="true"' : ""}>${label}</button></div>${err}`;
  }

  function paintInvoice(): void {
    const box = document.getElementById("invoice-box");
    if (box) box.innerHTML = renderInvoice();
  }

  async function recordInvoice(): Promise<void> {
    if (!current || invoiceBusy) return;
    const d = current;
    invoiceBusy = d.id;
    invoiceError = null;
    paintInvoice();
    let ok = false;
    try {
      const r = await api<InvoiceResult>(`/api/disputes/${encodeURIComponent(d.id)}/paypal-invoice`, "POST");
      ok = true;
      if (current?.id === d.id) {
        invoice = invoiceFromResult(r);
        // the score is unchanged, but the dossier note now lists a real invoice as the order record
        const s = await api<Score>(`/api/disputes/${encodeURIComponent(d.id)}/score`).catch(() => null);
        if (s && current?.id === d.id) {
          score = s;
          scoreJson = JSON.stringify(s);
          noteKey = ""; // the note changes even though the documents do not
        }
      }
    } catch (e) {
      if (current?.id === d.id) invoiceError = errorText(e, "invoice");
    } finally {
      if (invoiceBusy === d.id) invoiceBusy = null;
      if (current?.id === d.id) {
        paintBody();
        void loadDossier(d);
        paintHeader(); // the score can cross the fight line, which moves the dark pill
        document.querySelector<HTMLElement>("#invoice-box .banner")?.focus();
        void refreshAudit();
      }
    }
    if (ok) opts.onSubmitted(); // the grid row's win probability
  }

  function paintHeader(): void {
    if (!current) return;
    const idEl = document.createElement("span");
    idEl.className = "detail-id"; // one unbreakable token: an id split over two lines can't be read back
    idEl.textContent = current.id;
    el("detail-title").replaceChildren("Dispute ", idEl);
    const amt = money(current.amount_value, current.currency);
    el("detail-sub").textContent = `${reasonLabel(current.reason)}${amt ? ` · ${amt}` : ""} · ${statusLabel(current.status)}`;
    const why = current.review_reasons;
    el("detail-flag").innerHTML = why?.length
      ? `<div class="banner banner-bad" role="status"><strong>Needs review</strong><ul>${why.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`
      : "";
    const last = lastAct(audit);
    const did = acted ?? last?.action;
    const closed = current.status === "RESOLVED" || !!current.outcome;
    const offerWaiting = current.status === "WAITING_FOR_BUYER_RESPONSE" || did === "offered";
    const answered = acted === "accepted" || audit.some((a) => ANSWERED.has(a.action));
    const busy = sending || acting !== null;

    const done = !needsAction(current) || busy || audit.some((a) => a.action === "submitted");
    button.disabled = done || !score;
    button.classList.toggle("btn-done", !needsAction(current) && did !== "offered");
    if (sending) {
      // the step in the button is for the eyes; the live region above it reads each change out once
      button.setAttribute("aria-busy", "true");
      const s = submitStep ?? { label: "Submitting…", since: Date.now() };
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(s.label)} ${submitStep ? elapsed(s.since) : ""}</span>`;
    } else {
      button.removeAttribute("aria-busy");
      button.textContent = !needsAction(current)
        ? did === "accepted"
          ? "Claim accepted"
          : did === "offered" && offerWaiting
            ? "Offer waiting for buyer"
            : closed && did !== "submitted"
              ? "Closed"
              : "Evidence submitted"
        : "Submit evidence";
    }

    // below the fight line the settle actions take over the dark pill; Submit evidence stays as the way to fight anyway
    const rec = score?.recommendation.action;
    const low = !!rec && rec !== "fight";
    settle.hidden = !low;
    button.classList.toggle("btn-primary", !low);
    button.classList.toggle("btn-quiet", low && needsAction(current));
    offerBtn.classList.toggle("btn-primary", rec === "offer_refund");
    acceptBtn.classList.toggle("btn-primary", rec === "accept");
    acceptBtn.disabled = closed || answered || busy;
    offerBtn.disabled = acceptBtn.disabled || offerWaiting;

    if (last && !result.dataset.shown) {
      const demo = last.detail.mode !== "paypal";
      const what = last.action === "accepted" ? " · claim accepted" : last.action === "offered" ? " · refund offered" : "";
      showBanner(demo ? DEMO_LABEL : "Sent to PayPal sandbox", `Status: ${statusLabel(current.status)}${what}`, demo ? "info" : "good");
    }
  }

  function showBanner(title: string, sub: string, tone: "info" | "good" | "bad"): void {
    result.dataset.shown = "1";
    result.innerHTML = `<div class="banner banner-${tone}" tabindex="-1"><strong>${esc(title)}</strong><span>${esc(sub)}</span></div>`;
  }

  function closeSteps(): void {
    showOfferProblem(null);
    offerForm.hidden = true;
    confirmBox.hidden = true;
    settleActions.hidden = false;
  }

  /** Marks the amount box invalid with the reason under it, or clears both. */
  function showOfferProblem(problem: string | null): void {
    const msg = el("offer-error");
    msg.textContent = problem ?? "";
    msg.hidden = !problem;
    if (problem) offerAmount.setAttribute("aria-invalid", "true");
    else offerAmount.removeAttribute("aria-invalid");
  }

  function checkOffer(): boolean {
    const problem = offerProblem(offerAmount.value, offerAmount.validity.badInput, current?.amount_value ?? null, current?.currency ?? null);
    showOfferProblem(problem);
    return !problem;
  }

  function openOffer(): void {
    if (!current) return;
    const d = current;
    const max = d.amount_value ?? "";
    closeSteps();
    settleActions.hidden = true;
    offerForm.hidden = false;
    el("offer-currency").textContent = d.currency ?? "USD";
    // a partial refund is the advice in the middle band, so the form starts at half; otherwise at the full amount
    offerAmount.value = max && score?.recommendation.action === "offer_refund" ? half(max) : max;
    if (max) offerAmount.max = max;
    else offerAmount.removeAttribute("max");
    el("offer-max").textContent = max ? `Up to ${money(max, d.currency)}, the disputed amount` : "";
    offerNote.value = DEFAULT_OFFER_NOTE;
    offerAmount.focus();
  }

  function openConfirm(): void {
    if (!current) return;
    const amt = money(current.amount_value, current.currency) || "the disputed amount";
    closeSteps();
    settleActions.hidden = true;
    confirmBox.hidden = false;
    el("accept-question").innerHTML = `<strong>Accept the claim?</strong> <span>The buyer gets ${esc(amt)} back and the dispute closes. This can't be undone.</span>`;
    acceptYes.textContent = `Accept · ${amt}`; // short so it stays one line; the question above says what it does
    el("accept-cancel").focus(); // the safe choice has focus: Enter alone never gives money back
  }

  async function act(kind: "accept" | "offer", payload: Record<string, string>): Promise<void> {
    if (!current || acting) return;
    const d = current;
    acting = kind;
    result.innerHTML = "";
    delete result.dataset.shown;
    const sendLabel = offerSend.textContent;
    const yesLabel = acceptYes.textContent;
    offerSend.textContent = "Sending...";
    acceptYes.textContent = "Accepting...";
    offerSend.disabled = acceptYes.disabled = true;
    paintHeader();
    let ok = false;
    try {
      const r = await api<ActResult>(`/api/disputes/${encodeURIComponent(d.id)}/${kind}`, "POST", payload);
      ok = true;
      if (current?.id === d.id) {
        current = { ...d, status: r.status };
        acted = kind === "accept" ? "accepted" : "offered";
        closeSteps();
        showBanner(r.label, `Status: ${statusLabel(r.status)} · ${kind === "accept" ? "claim accepted" : "refund offered"}`, r.demo ? "info" : "good");
      }
      opts.onSubmitted();
    } catch (e) {
      if (current?.id === d.id) {
        if (kind === "accept") closeSteps(); // an offer keeps its form so the amount can be fixed
        showBanner(kind === "offer" ? "Offer not sent" : "Claim not accepted", errorText(e, kind), "bad");
      }
    } finally {
      acting = null;
      offerSend.textContent = sendLabel;
      acceptYes.textContent = yesLabel;
      offerSend.disabled = acceptYes.disabled = false;
      if (current?.id === d.id) {
        paintHeader();
        if (ok || kind === "accept") result.querySelector<HTMLElement>(".banner")?.focus();
        else offerAmount.focus();
        void refreshAudit();
      }
    }
  }

  function paintBody(): void {
    if (loadError) {
      body.innerHTML = `<div class="banner banner-bad"><strong>Could not load this dispute</strong><span>${esc(loadError)}</span></div>
        <button class="btn" type="button" id="retry-btn">Try again</button>`;
      el("retry-btn").addEventListener("click", () => current && load(current));
      return;
    }
    if (!score) {
      body.innerHTML = `<p class="muted loading" role="status">Reading the evidence and scoring the case...</p>`;
      return;
    }
    body.innerHTML = `
      <section aria-labelledby="h-score"><h3 id="h-score">Win probability</h3>${renderScore(score)}</section>
      <section aria-labelledby="h-evidence"><div id="evidence-box" class="drop" data-drop>${renderEvidenceBox(score)}</div></section>
      <section aria-labelledby="h-invoice"><h3 id="h-invoice">PayPal invoice</h3><div id="invoice-box" aria-live="polite">${renderInvoice()}</div></section>
      <section id="dossier-sec" aria-labelledby="h-dossier"><h3 id="h-dossier">Dossier preview</h3>${renderDossier(dossier, noteError, score, noteWriting)}</section>
      <section aria-labelledby="h-audit"><h3 id="h-audit">Audit trail</h3><div id="audit-list">${renderAudit(audit)}</div></section>`;
  }

  const sigOf = (d: Dispute) => [d.win_probability, d.status, d.doc_count, d.amount_value, d.reason].join("|");

  function paintDossier(): void {
    const sec = document.getElementById("dossier-sec");
    if (!sec || !score) return;
    sec.querySelectorAll(":scope > :not(h3)").forEach((n) => n.remove());
    sec.insertAdjacentHTML("beforeend", renderDossier(dossier, noteError, score, noteWriting));
  }

  /** The rebuttal note, after the score has painted: a model call can take a minute. Once per case + document set. */
  function loadDossier(d: Dispute): Promise<void> {
    if (!score) return Promise.resolve();
    const key = `${d.id}|${score.documents.map((x) => `${x.name}:${x.size}`).join("|")}`;
    if (noteKey === key) return noteLoad; // a submit that needs the note waits on this same request
    noteKey = key;
    dossier = null;
    noteError = false;
    noteWriting = { label: withModel("Writing the rebuttal note", llmModel), since: Date.now() };
    const writing = noteWriting.label;
    paintDossier();
    announce(writing);
    noteLoad = (async () => {
      try {
        const n = await api<Dossier>(`/api/disputes/${encodeURIComponent(d.id)}/dossier`);
        if (current?.id !== d.id || noteKey !== key) return;
        dossier = n;
      } catch {
        if (current?.id !== d.id || noteKey !== key) return;
        noteError = true;
        noteKey = ""; // the next change of the row tries again
      } finally {
        unannounce(writing);
      }
      paintDossier();
      if (score?.documents.some((x) => x.evidence.source === "recorded")) paintEvidence(); // its recorded line also names the note's model
    })();
    return noteLoad;
  }

  /** quiet: the score is already on screen, so refresh it in place (no loading state, no repaint unless it changed). */
  async function load(d: Dispute, quiet = false): Promise<void> {
    const seq = ++loadSeq;
    rowSig = sigOf(d);
    if (!quiet) {
      loadError = null;
      score = null;
      dossier = null;
      noteKey = "";
      noteError = false;
      paintBody();
      paintHeader();
    }
    let changed = !quiet;
    try {
      const [s, a] = await Promise.all([api<Score>(`/api/disputes/${encodeURIComponent(d.id)}/score`), api<AuditRow[]>(`/api/disputes/${encodeURIComponent(d.id)}/audit`)]);
      if (current?.id !== d.id || seq !== loadSeq) return;
      const json = JSON.stringify(s);
      changed ||= json !== scoreJson;
      scoreJson = json;
      score = s;
      audit = a;
      auditJson = JSON.stringify(a);
    } catch (e) {
      if (current?.id !== d.id || seq !== loadSeq || quiet) return; // a failed refresh keeps what is shown
      loadError = errorText(e);
    }
    if (changed) paintBody();
    paintHeader();
    void loadDossier(d);
  }

  async function refreshAudit(): Promise<void> {
    if (!current || !score) return;
    const id = current.id;
    try {
      const a = await api<AuditRow[]>(`/api/disputes/${encodeURIComponent(id)}/audit`);
      if (current?.id !== id || JSON.stringify(a) === auditJson) return;
      const recorded = (rows: AuditRow[]) => rows.some((r) => r.action === "invoice_recorded");
      const newRecord = !recorded(audit) && recorded(a);
      audit = a;
      auditJson = JSON.stringify(a);
      const list = document.getElementById("audit-list");
      if (list) list.innerHTML = renderAudit(a);
      if (newRecord && !invoice && !invoiceBusy) paintInvoice(); // recorded from elsewhere (another tab, the API)
      paintHeader();
    } catch {
      /* the next poll tries again */
    }
  }

  async function submit(): Promise<void> {
    if (!current || sending) return;
    const d = current;
    sending = true;
    delete result.dataset.shown;
    // the live region (#submit-result) hears each step change once; the counters inside it are aria-hidden
    const step = (label: string) => {
      submitStep = { label, since: Date.now() };
      if (current?.id !== d.id) return;
      result.innerHTML = stepPill(submitStep);
      paintHeader();
    };
    result.innerHTML = "";
    try {
      // the server builds the note and sends in one request, so the note is awaited here first: it is cached, and the submit reuses it
      if (!dossier) {
        step(withModel("Writing the rebuttal note", llmModel));
        await loadDossier(d);
      }
      step(d.source === "paypal" && paypalLive ? "Sending evidence to PayPal" : "Recording the evidence (demo, not sent to PayPal)");
      const r = await api<SubmitResult>(`/api/disputes/${encodeURIComponent(d.id)}/submit`, "POST");
      if (current?.id === d.id) {
        current = { ...d, status: r.status };
        showBanner(r.label, `Status: ${statusLabel(r.status)} · win probability ${r.probability}%`, r.demo ? "info" : "good");
      }
      opts.onSubmitted();
    } catch (e) {
      if (current?.id === d.id) showBanner("Not submitted", errorText(e), "bad");
    } finally {
      sending = false;
      submitStep = null;
      if (current?.id === d.id) {
        paintHeader();
        // the button just went disabled and took focus with it: hand it to the result so it is read out and Escape still works
        result.querySelector<HTMLElement>(".banner")?.focus();
        void refreshAudit();
      }
    }
  }

  button.addEventListener("click", () => void submit());
  // the evidence box is redrawn with the body and after each upload, so listen on the body
  const dropZone = (ev: Event) => (ev.target as Element).closest<HTMLElement>("[data-drop]");
  body.addEventListener("click", (ev) => {
    if ((ev.target as Element).closest("#add-evidence-btn")) document.getElementById("evidence-file")?.click();
  });
  body.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    if (input.id !== "evidence-file") return;
    const files = Array.from(input.files ?? []);
    input.value = ""; // the same file can be picked again
    void addFiles(files);
  });
  for (const type of ["dragenter", "dragover"]) {
    body.addEventListener(type, (ev) => {
      const zone = dropZone(ev);
      if (!zone) return;
      ev.preventDefault(); // allows the drop
      zone.classList.add("is-over");
    });
  }
  body.addEventListener("dragleave", (ev) => {
    const zone = dropZone(ev);
    if (zone && !zone.contains((ev as DragEvent).relatedTarget as Node | null)) zone.classList.remove("is-over");
  });
  body.addEventListener("drop", (ev) => {
    const zone = dropZone(ev);
    if (!zone) return;
    ev.preventDefault();
    zone.classList.remove("is-over");
    void addFiles(Array.from((ev as DragEvent).dataTransfer?.files ?? []));
  });
  // the invoice button is redrawn with the body, so listen on the body
  body.addEventListener("click", (ev) => {
    if ((ev.target as Element).closest("#invoice-btn")) void recordInvoice();
  });
  offerBtn.addEventListener("click", openOffer);
  acceptBtn.addEventListener("click", openConfirm);
  el("offer-cancel").addEventListener("click", () => {
    closeSteps();
    offerBtn.focus();
  });
  el("accept-cancel").addEventListener("click", () => {
    closeSteps();
    acceptBtn.focus();
  });
  acceptYes.addEventListener("click", () => void act("accept", {}));
  offerForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!checkOffer()) {
      offerAmount.focus();
      return; // a bad amount never leaves the browser
    }
    void act("offer", { amount: offerAmount.value.trim(), note: offerNote.value });
  });
  // once marked, the mark follows the typing, so a fixed value clears it at once
  offerAmount.addEventListener("input", () => {
    if (offerAmount.hasAttribute("aria-invalid")) checkOffer();
  });
  el("detail-close").addEventListener("click", () => close());
  // on the document, not the panel: focus can be outside it (a button that went disabled, the toast, the page)
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && current) {
      ev.stopPropagation();
      close();
    }
  });

  // a floating sheet on desktop that starts below the header, so Autopilot, Sync and Simulate stay in reach
  const header = document.querySelector<HTMLElement>("header.top");
  function place(): void {
    if (!current || !header) return;
    panel.style.setProperty("--panel-top", `${Math.max(12, Math.round(header.getBoundingClientRect().bottom) + 12)}px`);
  }
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, { passive: true });

  function close(): void {
    if (!current) return;
    const id = current.id;
    current = null;
    panel.hidden = true;
    stopTicker(); // nothing on screen counts any more; reopening the case repaints its step, which starts the clock again
    announce("");
    opts.onClose(id);
  }

  return {
    open(d) {
      current = d;
      audit = [];
      auditJson = "";
      sending = false;
      submitStep = null;
      announce("");
      acted = null;
      invoice = null;
      invoiceError = null;
      evidenceError = null;
      closeSteps();
      result.innerHTML = "";
      delete result.dataset.shown;
      panel.hidden = false;
      place();
      panel.focus();
      void load(d);
    },
    close,
    isOpen: () => current !== null,
    update(d) {
      if (!current || current.id !== d.id) return;
      current = d;
      paintHeader();
      // documents appeared, the probability or the status moved: the score is cheap, so follow it (the note only if the documents changed)
      if (sigOf(d) !== rowSig) void load(d, !!score);
    },
    refreshAudit: () => void refreshAudit(),
  };
}
