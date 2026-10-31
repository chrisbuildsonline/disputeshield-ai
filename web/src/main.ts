import {
  AllCommunityModule,
  ModuleRegistry,
  createGrid,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
} from "ag-grid-community";
import {
  api,
  ApiError,
  esc,
  handleUnauthorized,
  money,
  needsAction,
  reasonLabel,
  setToken,
  statusLabel,
  takeTokenFromHash,
  timeLeft,
  type Autopilot,
  type Dispute,
  type Summary,
  type SyncResult,
  winBand,
} from "./api";
import { createDetail, errorText } from "./detail";

ModuleRegistry.registerModules([AllCommunityModule]);
takeTokenFromHash();

const POLL_MS = 3000;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = byId("status");
const simulateBtn = byId<HTMLButtonElement>("simulate-btn");
const emptyEl = byId("empty");

const gate = byId("token-gate");
const gateOpen = () => !gate.hidden;
let tokenTried = false;

handleUnauthorized(() => {
  gate.hidden = false;
  document.body.classList.add("locked");
  statusEl.textContent = "Operator token needed";
  byId("token-error").textContent = tokenTried ? "That token was not accepted." : "";
});

const badge = (text: string, cls: string) => `<span class="badge ${cls}">${esc(text)}</span>`;

/** "NOK 1,299.00" with the code and the cents muted, the way bank tables print money. Text stays the same. */
function moneyHtml(value: string | null, currency: string | null): string {
  const n = Number(value);
  if (value === null || Number.isNaN(n)) return "";
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).formatToParts(n);
    return parts
      .map((p) => (p.type === "decimal" || p.type === "fraction" || (p.type === "currency" && p.value.length > 1) ? `<span class="minor">${esc(p.value)}</span>` : esc(p.value)))
      .join("");
  } catch {
    return esc(money(value, currency));
  }
}


const columns: ColDef<Dispute>[] = [
  { colId: "id", headerName: "Dispute", field: "id", minWidth: 190, flex: 1.4, cellClass: "cell-id" },
  {
    colId: "amount",
    headerName: "Amount",
    width: 140,
    valueGetter: (p) => (p.data ? Number(p.data.amount_value) : 0),
    cellRenderer: (p: ICellRendererParams<Dispute>) => (p.data ? `<span class="amount">${moneyHtml(p.data.amount_value, p.data.currency)}</span>` : ""),
    type: "rightAligned",
  },
  { colId: "reason", headerName: "Reason", minWidth: 170, flex: 1.2, valueGetter: (p) => reasonLabel(p.data?.reason ?? null) },
  {
    colId: "status",
    headerName: "Status",
    width: 160,
    cellRenderer: (p: ICellRendererParams<Dispute>) =>
      p.data
        ? badge(statusLabel(p.data.status), needsAction(p.data) ? "badge-red" : "badge-calm") +
          (p.data.review_reasons ? ` ${badge("Needs review", "badge-amber")}` : "")
        : "",
  },
  {
    colId: "source",
    headerName: "Source",
    width: 130,
    cellRenderer: (p: ICellRendererParams<Dispute>) =>
      p.data ? badge(p.data.source === "paypal" ? "PayPal" : "Simulated", p.data.source === "paypal" ? "badge-blue" : "badge-muted") : "",
  },
  {
    colId: "win",
    headerName: "Win %",
    width: 150,
    valueGetter: (p) => p.data?.win_probability ?? -1,
    cellRenderer: (p: ICellRendererParams<Dispute>) => {
      const w = p.data?.win_probability;
      if (w === null || w === undefined) return `<span class="muted" title="Upload a document to score this case">&mdash;</span>`;
      const { band, tone } = winBand(w);
      return `<span class="win" data-band="${band}">${badge(`${w}%`, `badge-${tone}`)}<span class="meter meter-${tone}" aria-hidden="true"><span style="width:${w}%"></span></span></span>`;
    },
  },
  {
    colId: "due",
    headerName: "Respond within",
    minWidth: 170,
    flex: 1,
    valueGetter: (p) => (p.data?.seller_response_due_date ? Date.parse(p.data.seller_response_due_date) : 0),
    cellRenderer: (p: ICellRendererParams<Dispute>) => {
      if (!p.data) return "";
      if (!needsAction(p.data)) return `<span class="muted">${p.data.outcome ? "Closed" : "Answered"}</span>`;
      const due = p.data.seller_response_due_date;
      const t = timeLeft(due);
      const when = due ? new Date(due).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      const left = t.urgent ? badge(t.text, "badge-red") : `<span class="due-left">${esc(t.text)}</span>`;
      return `<span class="two-line">${left}${when ? `<span class="sub">by ${esc(when)}</span>` : ""}</span>`;
    },
  },
];

let rows: Dispute[] = [];
let lastJson = "";
let loaded = false;

const detail = createDetail({
  onClose: (id) => {
    const node = gridApi.getRowNode(id);
    if (node?.rowIndex != null) gridApi.setFocusedCell(node.rowIndex, "id");
  },
  onSubmitted: () => void refresh(),
});

function open(d: Dispute | undefined): void {
  if (!d) return;
  gridApi.getRowNode(d.id)?.setSelected(true);
  detail.open(d);
}

const gridApi: GridApi<Dispute> = createGrid<Dispute>(byId("grid"), {
  theme: themeQuartz.withParams({
    accentColor: "#4338ca",
    foregroundColor: "#0f172a",
    borderColor: "#eef0f4",
    wrapperBorder: false,
    columnBorder: false,
    headerBackgroundColor: "#ffffff",
    headerTextColor: "#5b6476",
    headerFontSize: 11,
    headerFontWeight: 600,
    headerHeight: 44,
    headerColumnResizeHandleColor: "transparent", // no bars between header cells; resizing still works on hover
    rowHoverColor: "#f7f8fb",
    fontSize: 14,
    rowHeight: 56,
  }),
  columnDefs: columns,
  rowData: [],
  loading: false,
  suppressOverlays: ["noRows", "loading"], // the page draws its own empty state and loading overlay
  getRowId: (p) => p.data.id,
  rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
  rowClassRules: {
    "row-contested": (p) => !!p.data && needsAction(p.data),
    "row-submitted": (p) => !!p.data && !needsAction(p.data),
  },
  suppressCellFocus: false,
  onRowClicked: (e) => open(e.data),
  onCellKeyDown: (e) => {
    if ((e.event as KeyboardEvent | null)?.key === "Enter") open(e.data);
  },
});

// ---- empty state and loading overlay: the grid's own overlays are off ----
const loadingEl = byId("grid-loading");
const emptySimulate = byId<HTMLButtonElement>("empty-simulate");
const emptySeed = byId<HTMLButtonElement>("empty-seed");
let busy = 0; // requests that will change the list, in flight

function paintEmpty(): void {
  const waiting = rows.length === 0 && (!loaded || busy > 0);
  loadingEl.hidden = !waiting;
  emptyEl.hidden = waiting || !(loaded && rows.length === 0);
  byId("empty-actions").hidden = simulateBtn.hidden;
  byId("empty-live").hidden = !simulateBtn.hidden;
  // one dark pill per screen: while the empty state offers the first chargeback, the header's steps back
  simulateBtn.classList.toggle("btn-primary", emptyEl.hidden);
}

async function whileBusy<T>(work: () => Promise<T>): Promise<T> {
  busy += 1;
  paintEmpty();
  try {
    return await work();
  } finally {
    busy -= 1;
    paintEmpty();
  }
}

// ---- KPI strip: totals over the open cases, from /api/summary ----
const DASH = "&mdash;";

function dueText(hours: number): string {
  if (hours <= 0) return "Overdue";
  return hours < 48 ? `Due in ${Math.floor(hours)} h` : `Due in ${Math.floor(hours / 24)} d`;
}

function paintKpis(s: Summary): void {
  byId("kpi-open").textContent = String(s.open_count);
  byId("kpi-open-foot").textContent = s.open_count ? "waiting on your reply" : "nothing waiting on you";
  const soon = rows.filter((d) => needsAction(d) && timeLeft(d.seller_response_due_date).urgent).length;
  byId("kpi-soon").innerHTML = soon ? badge(`${soon} due in 48 h`, "badge-red") : "";

  const risk = byId("kpi-risk");
  risk.hidden = s.at_risk.length === 0;
  byId("kpi-risk-none").hidden = s.at_risk.length > 0;
  risk.classList.toggle("kpi-money-many", s.at_risk.length > 2);
  risk.innerHTML = s.at_risk.map((m) => `<li>${moneyHtml(m.value, m.currency)}</li>`).join("");
  byId("kpi-risk-foot").textContent = s.at_risk.length
    ? `in ${s.at_risk.length} ${s.at_risk.length === 1 ? "currency" : "currencies"}, open cases only`
    : "nothing at stake";

  const win = byId("kpi-win");
  const bar = byId("kpi-win-bar");
  if (s.avg_win === null) {
    win.innerHTML = DASH;
    bar.style.width = "0";
  } else {
    win.textContent = `${s.avg_win}%`;
    const { band, tone } = winBand(s.avg_win);
    bar.style.width = `${s.avg_win}%`;
    bar.className = `tone-${tone}`;
    bar.dataset.band = band;
  }

  const pill = byId("kpi-due-pill");
  const body = byId("kpi-deadline");
  const next = s.next_deadline;
  if (!next) {
    pill.innerHTML = "";
    body.innerHTML = `<p class="kpi-value">${DASH}</p><p class="kpi-foot">no replies due</p>`;
    return;
  }
  // from the due date itself, so the pill and the row's countdown agree to the hour
  const hours = Number.isNaN(Date.parse(next.due)) ? next.hours_left : (Date.parse(next.due) - Date.now()) / 3600000;
  const tone = hours < 48 ? "badge-red" : hours < 96 ? "badge-amber" : "badge-muted";
  pill.innerHTML = badge(dueText(hours), tone);
  const d = rows.find((r) => r.id === next.dispute_id);
  body.innerHTML = `<button class="kpi-link" type="button" data-id="${esc(next.dispute_id)}">
      <span class="kpi-amount">${d ? moneyHtml(d.amount_value, d.currency) : esc(next.dispute_id)}</span>
      <span class="kpi-foot">${d ? `${esc(reasonLabel(d.reason))} &middot; ` : ""}<span class="kpi-id">${esc(next.dispute_id)}</span></span>
    </button>`;
}

byId("kpi-deadline").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".kpi-link")?.dataset.id;
  if (id) open(rows.find((r) => r.id === id));
});

async function refresh(): Promise<void> {
  if (gateOpen()) return; // wait for a token instead of polling a closed door
  try {
    const [next, summary] = await Promise.all([api<Dispute[]>("/api/disputes"), api<Summary>("/api/summary").catch(() => null)]);
    statusEl.textContent = "API online";
    loaded = true;
    const json = JSON.stringify(next);
    if (json !== lastJson) {
      lastJson = json;
      rows = next;
      gridApi.setGridOption("rowData", rows); // getRowId makes this a delta update: selection and scroll stay
      for (const d of rows) detail.update(d);
    }
    if (summary) paintKpis(summary);
    gridApi.refreshCells({ columns: ["due"], force: true }); // the countdown moves even when the data does not
    paintEmpty();
    if (detail.isOpen()) detail.refreshAudit();
  } catch {
    statusEl.textContent = "Connection lost, retrying...";
  }
}

function focusRow(id: string): void {
  const node = gridApi.getRowNode(id);
  node?.setSelected(true);
  if (node?.rowIndex != null) {
    gridApi.ensureIndexVisible(node.rowIndex);
    gridApi.setFocusedCell(node.rowIndex, "id");
  }
}

async function simulate(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const d = await whileBusy(async () => {
      const made = await api<Dispute>("/api/demo/chargeback", "POST");
      await refresh();
      return made;
    });
    focusRow(d.id);
  } catch {
    if (!gateOpen()) statusEl.textContent = "Could not create the demo chargeback. Is demo mode on?";
  } finally {
    btn.disabled = false;
  }
}

simulateBtn.addEventListener("click", () => void simulate(simulateBtn));
emptySimulate.addEventListener("click", () => void simulate(emptySimulate));

emptySeed.addEventListener("click", async () => {
  emptySeed.disabled = true;
  try {
    await whileBusy(async () => {
      await api<{ count: number }>("/api/demo/seed", "POST");
      await refresh();
    });
  } catch {
    if (!gateOpen()) statusEl.textContent = "Could not load the sample disputes. Is demo mode on?";
  } finally {
    emptySeed.disabled = false;
  }
});

// ---- toast: one message at a time, in a live region that is always in the page ----
const toastEl = byId("toast");
let toastTimer = 0;

function toast(tone: "good" | "bad", title: string, lines: string[], returnFocus: HTMLElement): void {
  window.clearTimeout(toastTimer);
  toastEl.innerHTML = `<div class="toast-card toast-${tone}"><span class="toast-dot" aria-hidden="true"></span>
    <div class="toast-text"><strong>${esc(title)}</strong>${lines.map((l) => `<span>${esc(l)}</span>`).join("")}</div>
    <button class="toast-close" type="button" aria-label="Dismiss">&times;</button></div>`;
  const hide = () => {
    const hadFocus = toastEl.contains(document.activeElement);
    toastEl.innerHTML = "";
    if (hadFocus) returnFocus.focus();
  };
  toastEl.querySelector("button")?.addEventListener("click", hide);
  if (tone === "good") toastTimer = window.setTimeout(hide, 10000); // errors stay until dismissed
}

const syncBtn = byId<HTMLButtonElement>("sync-btn");

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing...";
  try {
    const r = await api<SyncResult>("/api/paypal/sync", "POST");
    toast(
      "good",
      `Synced ${r.count} dispute${r.count === 1 ? "" : "s"} from PayPal ${r.mode}`,
      [`Fetched at ${new Date(r.fetched_at).toLocaleTimeString()}`, r.debug_id ? `PayPal debug id ${r.debug_id}` : "PayPal sent no debug id"],
      syncBtn,
    );
    await refresh();
  } catch (e) {
    if (!gateOpen()) toast("bad", "Not synced", [errorText(e, "sync")], syncBtn);
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = "Sync from PayPal";
  }
});

const apOn = byId<HTMLInputElement>("autopilot-on");
const apThreshold = byId<HTMLInputElement>("autopilot-threshold");
const apError = byId("autopilot-error");

async function saveAutopilot(): Promise<void> {
  apError.textContent = "";
  try {
    const s = await api<Autopilot>("/api/autopilot", "PUT", { enabled: apOn.checked, threshold: Number(apThreshold.value) });
    apOn.checked = s.enabled;
    apThreshold.value = String(s.threshold);
  } catch (e) {
    if (gateOpen()) return;
    apError.textContent = e instanceof ApiError && e.status === 422 ? "Threshold must be a whole number from 0 to 100." : "Could not save the autopilot setting.";
  }
}
apOn.addEventListener("change", () => void saveAutopilot());
apThreshold.addEventListener("change", () => void saveAutopilot());

async function loadAutopilot(): Promise<void> {
  try {
    const s = await api<Autopilot>("/api/autopilot");
    apOn.checked = s.enabled;
    apThreshold.value = String(s.threshold);
  } catch {
    if (!gateOpen()) apError.textContent = "Could not load the autopilot setting.";
  }
}

byId("token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = byId<HTMLInputElement>("token-input");
  setToken(input.value);
  input.value = "";
  tokenTried = true;
  gate.hidden = true;
  document.body.classList.remove("locked");
  statusEl.textContent = "Checking API...";
  await loadAutopilot();
  await refresh();
  if (!gateOpen()) tokenTried = false;
});

try {
  const cfg = await api<{ demo_mode: boolean }>("/api/config");
  byId("demo-badge").hidden = !cfg.demo_mode;
  simulateBtn.hidden = !cfg.demo_mode;
} catch {
  /* the poll below reports the outage */
}
await loadAutopilot();
await refresh();
setInterval(() => void refresh(), POLL_MS);

export {};
