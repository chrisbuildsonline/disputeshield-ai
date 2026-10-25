import {
  api,
  ApiError,
  esc,
  money,
  needsAction,
  reasonLabel,
  statusLabel,
  type AuditRow,
  type Dispute,
  type Evidence,
  type Score,
  type SubmitResult,
} from "./api";

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
    default:
      return a.action.replace(/_/g, " ");
  }
}

function sourceBadge(source: string): string {
  const [text, cls] = source === "claude" ? ["Claude", "badge-ai"] : source === "template" ? ["Template", "badge-muted"] : ["Regex fallback", "badge-muted"];
  return `<span class="badge ${cls}">${text}</span>`;
}

function renderEvidence(score: Score): string {
  if (!score.documents.length) return `<p class="muted">No documents uploaded yet.</p>`;
  return score.documents
    .map((doc) => {
      const e = doc.evidence;
      const rows = FIELDS.filter(([k]) => e[k]).map(([k, label]) => `<dt>${label}</dt><dd>${esc(e[k])}</dd>`);
      for (const m of e.customer_messages) rows.push(`<dt>Customer message</dt><dd>${esc(m)}</dd>`);
      return `<div class="card"><div class="card-head"><strong>${esc(doc.name)}</strong>
        <span class="muted">Read by</span> ${sourceBadge(e.source)}</div>
        <dl class="facts">${rows.join("") || `<dt>Nothing found</dt><dd>No facts could be read from this file.</dd>`}</dl></div>`;
    })
    .join("");
}

function renderScore(score: Score): string {
  const tone = score.probability >= 80 ? "good" : score.probability >= 50 ? "warn" : "bad";
  const factors = score.factors
    .map(
      (f) => `<li class="factor ${f.met ? "met" : "unmet"}">
        <span class="mark" aria-hidden="true">${f.met ? "&#10003;" : "&#10005;"}</span>
        <span class="factor-text"><span>${esc(f.label)}</span><span class="muted">${esc(f.reason)}</span></span>
        <span class="points">${f.met ? "+" : ""}${f.points}<span class="sr-only"> points</span></span></li>`,
    )
    .join("");
  return `<div class="score">
      <div class="score-num ${tone}" aria-label="Win probability ${score.probability} percent">${score.probability}%</div>
      <div class="score-bar" aria-hidden="true"><span class="${tone}" style="width:${score.probability}%"></span></div>
    </div>
    <ul class="factors"><li class="factor base"><span class="mark" aria-hidden="true">&#8226;</span>
      <span class="factor-text"><span>Starting point</span><span class="muted">Baseline for this kind of dispute</span></span>
      <span class="points">${score.base}</span></li>${factors}</ul>`;
}

function renderDossier(score: Score): string {
  const d = score.dossier;
  const files = d.files.length
    ? `<ul class="files">${d.files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
    : `<p class="muted">No files will be attached.</p>`;
  return `<div class="card"><div class="card-head"><strong>Rebuttal note</strong><span class="muted">Written by</span> ${sourceBadge(d.note_source)}</div>
    <p class="note">${esc(d.note)}</p></div>
    <h4>Attached documents</h4>${files}`;
}

function renderAudit(rows: AuditRow[]): string {
  if (!rows.length) return `<p class="muted">Nothing has happened yet.</p>`;
  return `<ol class="audit">${rows
    .map((a) => `<li><time datetime="${esc(a.at)}">${esc(new Date(a.at).toLocaleTimeString())}</time><span>${esc(auditText(a))}</span></li>`)
    .join("")}</ol>`;
}

function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  const d = e.detail;
  const text = typeof d === "string" ? d : "";
  if (e.status === 409) return "This dispute was already submitted or is closed, so nothing more can be sent.";
  if (e.status === 422) return `Evidence can't be submitted yet: ${text || "the documents were not accepted"}.`;
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
  /** The audit trail is cheap, so it refreshes with the poll (the score does not, it can cost a Claude call). */
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

  function paintHeader(): void {
    if (!current) return;
    el("detail-title").textContent = `Dispute ${current.id}`;
    const amt = money(current.amount_value, current.currency);
    el("detail-sub").textContent = `${reasonLabel(current.reason)}${amt ? ` · ${amt}` : ""} · ${statusLabel(current.status)}`;
    const submittedEntry = audit.find((a) => a.action === "submitted");
    const done = !needsAction(current) || sending || !!submittedEntry;
    button.disabled = done || !score;
    button.classList.toggle("btn-done", !needsAction(current));
    button.textContent = sending ? "Submitting..." : done && !needsAction(current) ? "Evidence submitted" : "Submit evidence";
    if (submittedEntry && !result.dataset.shown) {
      const demo = submittedEntry.detail.mode !== "paypal";
      showBanner(demo ? "Demo mode: nothing was sent to PayPal" : "Sent to PayPal sandbox", `Status: ${statusLabel(current.status)}`, demo ? "info" : "good");
    }
  }

  function showBanner(title: string, sub: string, tone: "info" | "good" | "bad"): void {
    result.dataset.shown = "1";
    result.innerHTML = `<div class="banner banner-${tone}"><strong>${esc(title)}</strong><span>${esc(sub)}</span></div>`;
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
