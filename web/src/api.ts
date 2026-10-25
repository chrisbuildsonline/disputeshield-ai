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
  source: "claude" | "fallback";
}

export interface ScoreDoc {
  name: string;
  size: number;
  evidence: Evidence;
}

export interface Score {
  probability: number;
  base: number;
  factors: Factor[];
  documents: ScoreDoc[];
  dossier: { note: string; note_source: "claude" | "template"; files: string[] };
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export async function api<T>(path: string, method = "GET"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body;
    throw new ApiError(res.status, detail);
  }
  return body as T;
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function money(value: string | null, currency: string | null): string {
  const n = Number(value);
  if (value === null || Number.isNaN(n)) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(n);
  } catch {
    return `${value} ${currency ?? ""}`.trim();
  }
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
