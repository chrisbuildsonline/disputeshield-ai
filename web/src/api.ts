export interface Dispute {
  id: string;
  reason: string | null;
  status: string | null;
  amount_value: string | null;
  currency: string | null;
  seller_response_due_date: string | null;
  outcome: string | null;
  source: string;
  win_probability: number | null;
  doc_count?: number;
  review_reasons: string[] | null;
}

export interface Summary {
  open_count: number;
  at_risk: { currency: string; value: string }[];
  avg_win: number | null;
  next_deadline: { dispute_id: string; due: string; hours_left: number } | null;
}

export interface Autopilot {
  enabled: boolean;
  threshold: number;
}

export interface Factor {
  label: string;
  weight: number;
  met: boolean;
  points: number;
  reason: string;
}

export interface Evidence {
  carrier: string | null;
  tracking_number: string | null;
  delivered_at: string | null;
  delivered_to: string | null;
  signed_by: string | null;
  order_id: string | null;
  amount: string | null;
  customer_messages: string[];
  /** "recorded": no model was reachable, so this is a real model run's earlier read of these exact PDF bytes. */
  source: "ollama" | "claude" | "recorded" | "fallback";
  model?: string | null;
}

export interface ScoreDoc {
  name: string;
  size: number;
  evidence: Evidence;
}

export type RecAction = "fight" | "offer_refund" | "accept";

export interface Recommendation {
  action: RecAction;
  reason: string;
  fight_at: number;
  accept_below: number;
}

export interface Score {
  recommendation: Recommendation;
  probability: number;
  base: number;
  factors: Factor[];
  documents: ScoreDoc[];
}

/** The rebuttal note and attachments the submit would send; a model may write the note, so it comes apart from the score. */
export interface Dossier {
  note: string;
  note_source: "ollama" | "claude" | "recorded" | "template";
  note_model?: string | null;
  files: string[];
}

export interface AuditRow {
  id: number;
  action: string;
  detail: Record<string, unknown>;
  at: string;
}

export interface SubmitResult {
  mode: string;
  demo: boolean;
  label: string;
  status: string;
  probability: number;
}

export interface ActResult {
  mode: string;
  demo: boolean;
  label: string;
  action: "accept" | "offer";
  status: string;
  paypal_response: unknown;
}

export interface Money {
  currency_code: string;
  value: string;
}

/** POST /api/disputes/{id}/paypal-invoice: a draft invoice in the PayPal sandbox, or a labelled demo fixture. */
export interface InvoiceResult {
  mode: "paypal" | "demo";
  demo: boolean;
  label: string;
  simulated_case: boolean; // the dispute is a seeded simulation, the invoice call was real
  status: string;
  invoice_id: string;
  invoice_number: string;
  debug_id: string | null;
  fields: { total: Money };
  already_recorded: boolean;
}

export interface SyncResult {
  count: number;
  fetched_at: string;
  debug_id: string | null;
  mode: "sandbox" | "live";
  disputes: { dispute_id: string; result: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

const TOKEN_KEY = "disputeshield.token";
let token = localStorage.getItem(TOKEN_KEY) ?? "";
let onUnauthorized: () => void = () => {};

export function setToken(value: string): void {
  token = value.trim();
  localStorage.setItem(TOKEN_KEY, token);
}

export const hasToken = (): boolean => token !== "";

export function handleUnauthorized(callback: () => void): void {
  onUnauthorized = callback;
}

/** The server prints a link ending in #token=...: keep the token and take it out of the address bar. */
export function takeTokenFromHash(): boolean {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromLink = params.get("token");
  if (fromLink === null) return false;
  setToken(fromLink);
  params.delete("token");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
  return true;
}

export function api<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  return send<T>(path, method, json === undefined ? undefined : JSON.stringify(json), "application/json");
}

/** POST raw file bytes (an evidence PDF), same token and errors as api(). */
export function postFile<T>(path: string, file: Blob): Promise<T> {
  return send<T>(path, "POST", file, file.type || "application/pdf");
}

async function send<T>(path: string, method: string, body: BodyInit | undefined, type: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = type;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    throw new ApiError(res.status, detail);
  }
  return data as T;
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The one money formatter: en-US in the dispute's own currency ("€128.00", "NOK 1,299.00"), as parts so
 * the grid and the KPI strip can mute the code and the cents. Null for a value that is not a number.
 */
export function moneyParts(value: string | null, currency: string | null): Intl.NumberFormatPart[] | null {
  const n = Number(value);
  if (value === null || value.trim() === "" || !Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).formatToParts(n);
  } catch {
    return [{ type: "literal", value: `${value} ${currency ?? ""}`.trim() }]; // a code Intl does not know
  }
}

export function money(value: string | null, currency: string | null): string {
  return (moneyParts(value, currency) ?? []).map((p) => p.value).join("");
}

const REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorised",
};

export function reasonLabel(reason: string | null): string {
  if (!reason) return "Other";
  return (
    REASONS[reason] ??
    reason
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/^./, (c) => c.toUpperCase())
  );
}

/** The recommendation bands, the same numbers as FIGHT_AT / ACCEPT_BELOW in app/scoring.py. */
export const FIGHT_AT = 60;
export const ACCEPT_BELOW = 30;

export type Band = "fight" | "offer" | "accept";

/** The win chance a person reads: never above 95%, since no chargeback is a sure thing (the raw score stays in the API). */
export const fmtWin = (probability: number): number => Math.min(probability, 95);

/** Every coloured win probability uses this: green fight, amber offer a refund, red accept. */
export function winBand(probability: number): { band: Band; tone: "green" | "amber" | "red" } {
  if (probability >= FIGHT_AT) return { band: "fight", tone: "green" };
  if (probability >= ACCEPT_BELOW) return { band: "offer", tone: "amber" };
  return { band: "accept", tone: "red" };
}

/** Still waiting on the seller: these are the rows that need attention. */
export function needsAction(d: Dispute): boolean {
  return !d.outcome && (d.status === "OPEN" || d.status === "WAITING_FOR_SELLER_RESPONSE");
}

export function statusLabel(status: string | null): string {
  return (status ?? "Unknown").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export function timeLeft(due: string | null, now = Date.now()): { text: string; urgent: boolean } {
  const ms = due ? Date.parse(due) - now : Number.NaN;
  if (Number.isNaN(ms)) return { text: "No deadline", urgent: false };
  if (ms <= 0) return { text: "Overdue", urgent: true };
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const text = days > 0 ? `${days}d ${hours}h left` : hours > 0 ? `${hours}h ${mins % 60}m left` : `${mins}m left`;
  return { text, urgent: ms < 48 * 3600 * 1000 };
}
