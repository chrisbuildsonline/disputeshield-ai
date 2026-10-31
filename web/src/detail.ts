import {
  api,
  ApiError,
  esc,
  money,
  needsAction,
  reasonLabel,
  statusLabel,
  type ActResult,
  type AuditRow,
  type Dispute,
  type Evidence,
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

function auditText(a: AuditRow): string {
  const d = a.detail;
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
    case "autopilot_skipped":
      return "Autopilot skipped (closed or already submitted)";
    default:
      return a.action.replace(/_/g, " ");
  }
}

function sourceBadge(source: string, model?: string | null): string {
  const ai = source === "ollama" || source === "claude";
  const text = ai ? `AI &middot; ${esc(model || (source === "claude" ? "Claude" : "Ollama"))}` : source === "template" ? "Template" : "Regex fallback";
  return `<span class="badge ${ai ? "badge-ai" : "badge-muted"}">${text}</span>`;
}

function renderEvidence(score: Score): string {
  if (!score.documents.length) return `<p class="muted">No documents uploaded yet.</p>`;
  return score.documents
    .map((doc) => {
      const e = doc.evidence;
      const rows = FIELDS.filter(([k]) => e[k]).map(([k, label]) => `<dt>${label}</dt><dd>${esc(e[k])}</dd>`);
      for (const m of e.customer_messages) rows.push(`<dt>Customer message</dt><dd>${esc(m)}</dd>`);
      return `<div class="card"><div class="card-head"><strong>${esc(doc.name)}</strong>
        <span class="muted">Read by</span> ${sourceBadge(e.source, e.model)}</div>
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
  return `<div class="score">
      <div class="score-num ${tone}" aria-label="Win probability ${score.probability} percent">${score.probability}%</div>
      <div class="score-bar" aria-hidden="true"><span class="${tone}" data-band="${band}" style="width:${score.probability}%"></span></div>
    </div>
    <div class="rec"><span class="rec-label">Recommended</span><span class="badge rec-pill ${recTone}">${recLabel}</span>
      <p class="rec-reason muted">${esc(score.recommendation.reason)}</p></div>
    <ul class="factors"><li class="factor base"><span class="mark" aria-hidden="true">&#8226;</span>
      <span class="factor-text"><span>Starting point</span><span class="muted">Baseline for this kind of dispute</span></span>
      <span class="points">${score.base}</span></li>${factors}</ul>`;
}

function renderDossier(score: Score): string {
  const d = score.dossier;
  const files = d.files.length
    ? `<ul class="files">${d.files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
    : `<p class="muted">No files will be attached.</p>`;
  return `<div class="card"><div class="card-head"><strong>Rebuttal note</strong><span class="muted">Written by</span> ${sourceBadge(d.note_source, d.note_model)}</div>
    <p class="note">${esc(d.note)}</p></div>
    <h4>Attached documents</h4>${files}`;
}

function renderAudit(rows: AuditRow[]): string {
  if (!rows.length) return `<p class="muted">Nothing has happened yet.</p>`;
  return `<ol class="audit">${rows
    .map((a) => `<li><time datetime="${esc(a.at)}">${esc(new Date(a.at).toLocaleTimeString())}</time><span>${esc(auditText(a))}</span></li>`)
    .join("")}</ol>`;
}

export type Act = "submit" | "accept" | "offer" | "sync";

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
    return `Evidence can't be submitted yet: ${text || "the documents were not accepted"}.`;
  }
  if (e.status === 502 && d && typeof d === "object") {
    const o = d as { message?: string; debug_id?: string };
    return `PayPal turned the request down: ${o.message ?? "unknown error"}${o.debug_id ? ` (debug id ${o.debug_id})` : ""}. Nothing was lost, you can try again.`;
  }
  if (e.status === 0) return "Could not reach the server. Check your connection and try again.";
  return text || "Something went wrong. Please try again.";
}

export interface Detail {
  open(d: Dispute): void;
  close(): void;
  isOpen(): boolean;
  /** Called by the grid poll so the header and submit button follow the live row. */
  update(d: Dispute): void;
  /** The audit trail is cheap, so it refreshes with the poll (the score does not, it can cost a model call). */
  refreshAudit(): void;
}

export function createDetail(opts: { onClose: (id: string) => void; onSubmitted: () => void }): Detail {
  const panel = el<HTMLElement>("detail");
  const body = el<HTMLElement>("detail-body");
  const button = el<HTMLButtonElement>("submit-btn");
  const result = el<HTMLElement>("submit-result");
  let current: Dispute | null = null;
  let score: Score | null = null;
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

  function paintHeader(): void {
    if (!current) return;
    el("detail-title").textContent = `Dispute ${current.id}`;
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
    button.textContent = sending
      ? "Submitting..."
      : !needsAction(current)
        ? did === "accepted"
          ? "Claim accepted"
          : did === "offered" && offerWaiting
            ? "Offer waiting for buyer"
            : closed && did !== "submitted"
              ? "Closed"
              : "Evidence submitted"
        : "Submit evidence";

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
    offerForm.hidden = true;
    confirmBox.hidden = true;
    settleActions.hidden = false;
  }

  function openOffer(): void {
    if (!current) return;
    const d = current;
    const max = d.amount_value ?? "";
    closeSteps();
    settleActions.hidden = true;
    offerForm.hidden = false;
    el("offer-currency").textContent = d.currency ?? "USD";
    offerAmount.value = max;
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
    acceptYes.textContent = `Yes, accept and refund ${amt}`;
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
      <section aria-labelledby="h-evidence"><h3 id="h-evidence">Extracted evidence</h3>${renderEvidence(score)}</section>
      <section aria-labelledby="h-dossier"><h3 id="h-dossier">Dossier preview</h3>${renderDossier(score)}</section>
      <section aria-labelledby="h-audit"><h3 id="h-audit">Audit trail</h3><div id="audit-list">${renderAudit(audit)}</div></section>`;
  }

  async function load(d: Dispute): Promise<void> {
    loadError = null;
    score = null;
    paintBody();
    paintHeader();
    try {
      const [s, a] = await Promise.all([api<Score>(`/api/disputes/${encodeURIComponent(d.id)}/score`), api<AuditRow[]>(`/api/disputes/${encodeURIComponent(d.id)}/audit`)]);
      if (current?.id !== d.id) return;
      score = s;
      audit = a;
      auditJson = JSON.stringify(a);
    } catch (e) {
      if (current?.id !== d.id) return;
      loadError = errorText(e);
    }
    paintBody();
    paintHeader();
  }

  async function refreshAudit(): Promise<void> {
    if (!current || !score) return;
    const id = current.id;
    try {
      const a = await api<AuditRow[]>(`/api/disputes/${encodeURIComponent(id)}/audit`);
      if (current?.id !== id || JSON.stringify(a) === auditJson) return;
      audit = a;
      auditJson = JSON.stringify(a);
      const list = document.getElementById("audit-list");
      if (list) list.innerHTML = renderAudit(a);
      paintHeader();
    } catch {
      /* the next poll tries again */
    }
  }

  async function submit(): Promise<void> {
    if (!current || sending) return;
    const d = current;
    sending = true;
    result.innerHTML = "";
    delete result.dataset.shown;
    paintHeader();
    try {
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
      if (current?.id === d.id) {
        paintHeader();
        void refreshAudit();
      }
    }
  }

  button.addEventListener("click", () => void submit());
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
    void act("offer", { amount: offerAmount.value.trim(), note: offerNote.value });
  });
  el("detail-close").addEventListener("click", () => close());
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  });

  function close(): void {
    if (!current) return;
    const id = current.id;
    current = null;
    panel.hidden = true;
    opts.onClose(id);
  }

  return {
    open(d) {
      current = d;
      audit = [];
      auditJson = "";
      sending = false;
      acted = null;
      closeSteps();
      result.innerHTML = "";
      delete result.dataset.shown;
      panel.hidden = false;
      panel.focus();
      void load(d);
    },
    close,
    isOpen: () => current !== null,
    update(d) {
      if (!current || current.id !== d.id) return;
      current = d;
      paintHeader();
    },
    refreshAudit: () => void refreshAudit(),
  };
}
