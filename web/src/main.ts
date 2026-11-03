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
  hasToken,
  money,
  moneyParts,
  needsAction,
  reasonLabel,
  setToken,
  statusLabel,
  takeTokenFromHash,
  timeLeft,
  type AuditRow,
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
let demoToken: string | null = null; // /api/config hands it out in demo mode only

/** The sign-in card. In demo mode it leads with one click into the console; the paste form steps back. */
function showGate(refused: boolean): void {
  const demo = demoToken !== null;
  byId("gate-demo").hidden = !demo;
  byId("gate-token-head").hidden = !demo;
  byId("token-title").textContent = demo ? "No operator token needed" : "Operator token needed";
  byId("token-use").classList.toggle("btn-primary", !demo); // one dark pill per screen
  gate.hidden = false;
  document.body.classList.add("locked");
  statusEl.textContent = "Operator token needed";
  byId("token-error").textContent = refused ? "That token was not accepted." : "";
}

// a 401 only comes back for a token we sent (with none, nothing protected is called): a link's or a pasted one
handleUnauthorized(() => showGate(true));

const badge = (text: string, cls: string) => `<span class="badge ${cls}">${esc(text)}</span>`;

/** "NOK 1,299.00" with the code and the cents muted, the way bank tables print money. Text stays the same as money(). */
function moneyHtml(value: string | null, currency: string | null): string {
  return (moneyParts(value, currency) ?? [])
    .map((p) => (p.type === "decimal" || p.type === "fraction" || (p.type === "currency" && p.value.length > 1) ? `<span class="minor">${esc(p.value)}</span>` : esc(p.value)))
    .join("");
}

/** Writes only when the markup changed, so a focused control inside keeps its focus and screen readers stay quiet. */
const written = new WeakMap<HTMLElement, string>();
function put(el: HTMLElement, html: string): void {
  if (written.get(el) === html) return;
  written.set(el, html);
  el.innerHTML = html;
}

function text(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}


// one renderer per value, shared by the grid and the phone's case cards
const amountHtml = (d: Dispute) => `<span class="amount">${moneyHtml(d.amount_value, d.currency)}</span>`;

const statusHtml = (d: Dispute) =>
  `<span class="pills">${badge(statusLabel(d.status), needsAction(d) ? "badge-red" : "badge-calm")}${
    d.review_reasons ? badge("Needs review", "badge-amber") : ""
  }</span>`;

function winHtml(w: number | null | undefined): string {
  if (w === null || w === undefined) return `<span class="muted" title="Upload a document to score this case">&mdash;</span>`;
  const { band, tone } = winBand(w);
  return `<span class="win" data-band="${band}">${badge(`${w}%`, `badge-${tone}`)}<span class="meter meter-${tone}" aria-hidden="true"><span style="width:${w}%"></span></span></span>`;
}

function dueHtml(d: Dispute): string {
  if (!needsAction(d)) return `<span class="muted">${d.outcome ? "Closed" : "Answered"}</span>`;
  const due = d.seller_response_due_date;
  const t = timeLeft(due);
  const when = due ? new Date(due).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const left = t.urgent ? badge(t.text, "badge-red") : `<span class="due-left">${esc(t.text)}</span>`;
  return `<span class="two-line">${left}${when ? `<span class="sub">by ${esc(when)}</span>` : ""}</span>`;
}

const columns: ColDef<Dispute>[] = [
  { colId: "id", headerName: "Dispute", field: "id", minWidth: 190, flex: 1.4, cellClass: "cell-id" },
  {
    colId: "amount",
    headerName: "Amount",
    width: 140,
    valueGetter: (p) => (p.data ? Number(p.data.amount_value) : 0),
    cellRenderer: (p: ICellRendererParams<Dispute>) => (p.data ? amountHtml(p.data) : ""),
    type: "rightAligned",
  },
  { colId: "reason", headerName: "Reason", minWidth: 170, flex: 1.2, valueGetter: (p) => reasonLabel(p.data?.reason ?? null) },
  {
    colId: "status",
    headerName: "Status",
    width: 272, // "Open" + "Needs review" side by side; a long PayPal status puts Needs review on a second line
    // a value that holds everything the pills show: the grid redraws a cell only when its value changes
    valueGetter: (p) => (p.data ? `${statusLabel(p.data.status)}${p.data.outcome ? ` (${p.data.outcome})` : ""}${p.data.review_reasons ? " · Needs review" : ""}` : ""),
    cellRenderer: (p: ICellRendererParams<Dispute>) => (p.data ? statusHtml(p.data) : ""),
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
    cellRenderer: (p: ICellRendererParams<Dispute>) => winHtml(p.data?.win_probability),
  },
  {
    colId: "due",
    headerName: "Respond within",
    minWidth: 170,
    flex: 1,
    valueGetter: (p) => (p.data?.seller_response_due_date ? Date.parse(p.data.seller_response_due_date) : 0),
    cellRenderer: (p: ICellRendererParams<Dispute>) => (p.data ? dueHtml(p.data) : ""),
  },
];

// with the case panel open the grid sits to its left: drop what the panel already says until the rest fits,
// so the status pills are never cut off under the panel. All columns come back when it closes.
const DROP_FIRST = ["source", "reason", "amount", "due", "win"];
let hiddenCols = "";

function fitColumns(gridApi: GridApi<Dispute>): void {
  const room = byId("grid").clientWidth - 16; // a vertical scrollbar's worth to spare
  const need = (c: ColDef<Dispute>) => c.width ?? c.minWidth ?? 0;
  let total = columns.reduce((n, c) => n + need(c), 0);
  const hide: string[] = [];
  if (detail.isOpen()) {
    for (const id of DROP_FIRST) {
      if (total <= room) break;
      hide.push(id);
      total -= need(columns.find((c) => c.colId === id)!);
    }
  }
  if (hide.join() === hiddenCols) return;
  hiddenCols = hide.join();
  gridApi.setColumnsVisible(columns.map((c) => c.colId!).filter((id) => !hide.includes(id)), true);
  gridApi.setColumnsVisible(hide, false);
}

let rows: Dispute[] = [];
let lastJson = "";
let loaded = false;
let known: Set<string> | null = null; // ids in the last list, null before the first answer
const watching = new Set<string>(); // new cases whose autopilot run the console will report with a toast

const detail = createDetail({
  onClose: (id) => {
    fitColumns(gridApi);
    const card = cardEls.get(id)?.firstElementChild as HTMLElement | null | undefined;
    if (card?.offsetParent) return card.focus(); // a phone: back to the card that opened it
    const node = gridApi.getRowNode(id);
    if (node?.rowIndex != null) gridApi.setFocusedCell(node.rowIndex, "id");
  },
  onSubmitted: () => void refresh(),
});

function open(d: Dispute | undefined): void {
  if (!d) return;
  gridApi.getRowNode(d.id)?.setSelected(true);
  detail.open(d);
  fitColumns(gridApi);
}

// ---- a phone gets case cards instead of the grid (CSS shows one or the other); same rows, same order ----
const cardsEl = byId<HTMLUListElement>("cards");
const cardEls = new Map<string, HTMLLIElement>();

function cardHtml(d: Dispute): string {
  return `<span class="cc-head"><span class="cc-id">${esc(d.id)}</span><span class="cc-status">${statusHtml(d)}</span></span>
    <span class="cc-amount">${amountHtml(d)}</span>
    <span class="cc-reason">${esc(reasonLabel(d.reason))}</span>
    <span class="cc-foot">
      <span class="cc-win"><span class="cc-label">Win chance</span>${winHtml(d.win_probability)}</span>
      <span class="cc-due"><span class="cc-label">Respond within</span>${dueHtml(d)}</span>
    </span>`;
}

function cardName(d: Dispute): string {
  const due = needsAction(d) ? timeLeft(d.seller_response_due_date).text : d.outcome ? "closed" : "answered";
  const win = d.win_probability === null ? "not scored" : `win chance ${d.win_probability}%`;
  return `Dispute ${d.id}, ${money(d.amount_value, d.currency)}, ${statusLabel(d.status)}${d.review_reasons ? ", needs review" : ""}, ${win}, ${due}`;
}

/** Keyed: a card is made once and only rewritten when its markup changes, so a focused card keeps its focus. */
function paintCards(): void {
  const keep = new Set(rows.map((d) => d.id));
  for (const [id, li] of cardEls)
    if (!keep.has(id)) {
      li.remove();
      cardEls.delete(id);
    }
  let at = cardsEl.firstElementChild;
  for (const d of rows) {
    let li = cardEls.get(d.id);
    if (!li) {
      li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.id = d.id;
      li.append(btn);
      cardEls.set(d.id, li);
    }
    const btn = li.firstElementChild as HTMLButtonElement;
    put(btn, cardHtml(d));
    btn.className = `case-card ${needsAction(d) ? "is-open" : "is-closed"}`;
    if (btn.getAttribute("aria-label") !== cardName(d)) btn.setAttribute("aria-label", cardName(d));
    if (li === at) at = at.nextElementSibling;
    else cardsEl.insertBefore(li, at);
  }
}

cardsEl.addEventListener("click", (e) => {
  const card = (e.target as Element).closest<HTMLElement>(".case-card");
  if (card) open(rows.find((r) => r.id === card.dataset.id));
});

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
  // AG Grid slides rows to their new place over 0.4 s while a new row shows at once in its slot: for that time two
  // rows are drawn on top of each other (an insert at the top or a case moving down after it is answered)
  animateRows: false,
  // the same for columns: when the panel opens and columns are dropped, the rest slid left over several frames,
  // drawn past the grid's right edge (Respond within cut to "RESPON") until they arrived
  suppressColumnMoveAnimation: true,
  onGridSizeChanged: (e) => fitColumns(e.api),
  onGridReady: (e) => window.addEventListener("resize", () => fitColumns(e.api)), // AG Grid's own size event lags a frame or more
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

// ---- KPI strip: totals over the open cases, from /api/summary. The tiles are in the page; a poll only changes what moved ----
const DASH = "—";

function dueText(hours: number): string {
  if (hours <= 0) return "Overdue";
  return hours < 48 ? `Due in ${Math.floor(hours)} h` : `Due in ${Math.floor(hours / 24)} d`;
}

const kpiLink = byId<HTMLButtonElement>("kpi-link");

function paintKpis(s: Summary): void {
  text(byId("kpi-open"), String(s.open_count));
  text(byId("kpi-open-foot"), s.open_count ? "waiting on your reply" : "nothing waiting on you");
  const soon = rows.filter((d) => needsAction(d) && timeLeft(d.seller_response_due_date).urgent).length;
  put(byId("kpi-soon"), soon ? badge(`${soon} due in 48 h`, "badge-red") : "");

  const risk = byId("kpi-risk");
  risk.hidden = s.at_risk.length === 0;
  byId("kpi-risk-none").hidden = s.at_risk.length > 0;
  risk.classList.toggle("kpi-money-many", s.at_risk.length > 2);
  put(risk, s.at_risk.map((m) => `<li>${moneyHtml(m.value, m.currency)}</li>`).join(""));
  text(
    byId("kpi-risk-foot"),
    s.at_risk.length ? `in ${s.at_risk.length} ${s.at_risk.length === 1 ? "currency" : "currencies"}, open cases only` : "nothing at stake",
  );

  const bar = byId("kpi-win-bar");
  const win = s.avg_win === null ? null : winBand(s.avg_win);
  text(byId("kpi-win"), s.avg_win === null ? DASH : `${s.avg_win}%`);
  bar.style.width = `${s.avg_win ?? 0}%`;
  bar.className = win ? `tone-${win.tone}` : "";
  if (win) bar.dataset.band = win.band;
  else delete bar.dataset.band;

  const next = s.next_deadline;
  byId("kpi-deadline-none").hidden = !!next;
  kpiLink.hidden = !next;
  if (!next) {
    put(byId("kpi-due-pill"), "");
    return;
  }
  // from the due date itself, so the pill and the row's countdown agree to the hour
  const hours = Number.isNaN(Date.parse(next.due)) ? next.hours_left : (Date.parse(next.due) - Date.now()) / 3600000;
  const tone = hours < 48 ? "badge-red" : hours < 96 ? "badge-amber" : "badge-muted";
  put(byId("kpi-due-pill"), badge(dueText(hours), tone));
  const d = rows.find((r) => r.id === next.dispute_id);
  if (kpiLink.dataset.id !== next.dispute_id) kpiLink.dataset.id = next.dispute_id;
  put(byId("kpi-link-amount"), d ? moneyHtml(d.amount_value, d.currency) : esc(next.dispute_id));
  text(byId("kpi-link-reason"), d ? `${reasonLabel(d.reason)} · ` : "");
  text(byId("kpi-link-id"), next.dispute_id);
}

kpiLink.addEventListener("click", () => open(rows.find((r) => r.id === kpiLink.dataset.id)));

async function refresh(): Promise<void> {
  if (gateOpen()) return; // wait for a token instead of polling a closed door
  try {
    const [next, summary] = await Promise.all([api<Dispute[]>("/api/disputes"), api<Summary>("/api/summary").catch(() => null)]);
    statusEl.textContent = "API online";
    loaded = true;
    const json = JSON.stringify(next);
    if (json !== lastJson) {
      lastJson = json;
      // a case that turns up on its own (a PayPal webhook) gets its autopilot result reported; samples loading in bulk don't
      if (known && busy === 0) for (const d of next) if (!known.has(d.id)) watching.add(d.id);
      known = new Set(next.map((d) => d.id));
      rows = next;
      gridApi.setGridOption("rowData", rows); // getRowId makes this a delta update: selection and scroll stay
      for (const d of rows) detail.update(d);
    }
    paintCards(); // every poll, like the grid's due column: the countdown moves even when the data does not
    if (summary) paintKpis(summary);
    gridApi.refreshCells({ columns: ["due"], force: true }); // the countdown moves even when the data does not
    paintEmpty();
    if (detail.isOpen()) detail.refreshAudit();
    for (const d of rows) if (watching.has(d.id)) void reportAutopilot(d);
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

/** The autopilot runs after the chargeback is answered: once its row moves (flagged or sent), say what it did. */
// awaiting (autopilot off, nothing wrong) is done too, with no toast: a person sends it
const AUTOPILOT_DONE = new Set(["autopilot_submitted", "autopilot_flagged", "autopilot_skipped", "autopilot_awaiting"]);

async function reportAutopilot(d: Dispute): Promise<void> {
  if (!d.review_reasons && needsAction(d)) return; // still running, or not started: the next poll looks again
  watching.delete(d.id); // before the await, so two polls never report it twice
  let audit: AuditRow[];
  try {
    audit = await api<AuditRow[]>(`/api/disputes/${encodeURIComponent(d.id)}/audit`);
  } catch {
    watching.add(d.id);
    return;
  }
  const last = [...audit].reverse().find((a) => AUTOPILOT_DONE.has(a.action));
  if (!last) {
    if (audit.some((a) => a.action === "autopilot_started")) watching.add(d.id); // sent, but its own audit row is not in yet
    return; // otherwise a person acted and the autopilot never ran
  }
  const x = last.detail;
  if (last.action === "autopilot_submitted") {
    toast("good", `Autopilot submitted evidence for ${d.id}`, [`Win probability ${String(x.probability)}% · status ${statusLabel(String(x.status))}`], simulateBtn);
  } else if (last.action === "autopilot_flagged") {
    toast("warn", `Autopilot flagged ${d.id} for review`, Array.isArray(x.reasons) ? x.reasons.map(String) : [], simulateBtn);
  }
}

async function simulate(btn: HTMLButtonElement): Promise<void> {
  const label = btn.textContent ?? "";
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  // the local model reads the receipt PDF: that can take half a minute in Docker
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Reading the receipt…`;
  try {
    const d = await whileBusy(async () => {
      const made = await api<Dispute>("/api/demo/chargeback", "POST");
      watching.add(made.id);
      await refresh();
      return made;
    });
    focusRow(d.id);
  } catch (e) {
    const why = e instanceof ApiError && e.status === 404 ? "Demo mode is off on this server." : errorText(e);
    if (!gateOpen()) toast("bad", "Could not create the demo chargeback", [why], btn);
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.textContent = label;
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
// desktop: the toast sits on the canvas under the grid, and the grid gives up exactly that much height (styles.css)
new ResizeObserver(() => {
  document.querySelector<HTMLElement>(".stage")?.style.setProperty("--toast-room", toastEl.firstElementChild ? `${toastEl.offsetHeight + 16}px` : "0px");
}).observe(toastEl);

function toast(tone: "good" | "warn" | "bad", title: string, lines: string[], returnFocus: HTMLElement): void {
  window.clearTimeout(toastTimer);
  const head = esc(title).replace(/\bPP-D-[A-Z0-9]+/g, (id) => `<span class="nowrap">${id}</span>`); // never split an id at its hyphens
  toastEl.innerHTML = `<div class="toast-card toast-${tone}"><span class="toast-dot" aria-hidden="true"></span>
    <div class="toast-text"><strong>${head}</strong>${lines.map((l) => `<span>${esc(l)}</span>`).join("")}</div>
    <button class="toast-close" type="button" aria-label="Dismiss">&times;</button></div>`;
  const hide = () => {
    const hadFocus = toastEl.contains(document.activeElement);
    toastEl.innerHTML = "";
    if (hadFocus) returnFocus.focus();
  };
  toastEl.querySelector("button")?.addEventListener("click", hide);
  if (tone !== "bad") toastTimer = window.setTimeout(hide, 10000); // errors stay until dismissed
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

const THRESHOLD_HINT = "Use a whole number from 0 to 100.";
let savedThreshold = 85; // what the server has, sent along when the switch flips while the box holds a bad value

function apHint(text: string): void {
  apError.textContent = text;
  apError.hidden = !text;
}

/** Marks the box invalid (aria-invalid plus a short hint) while it holds anything but a whole number 0-100. */
function checkThreshold(): boolean {
  const v = apThreshold.value;
  const ok = /^\d{1,3}$/.test(v) && Number(v) <= 100;
  if (ok) apThreshold.removeAttribute("aria-invalid");
  else apThreshold.setAttribute("aria-invalid", "true");
  apHint(ok ? "" : THRESHOLD_HINT);
  return ok;
}

function showAutopilot(s: Autopilot): void {
  apOn.checked = s.enabled;
  savedThreshold = s.threshold;
  apThreshold.value = String(s.threshold);
  checkThreshold();
}

async function saveAutopilot(): Promise<void> {
  const threshold = checkThreshold() ? Number(apThreshold.value) : savedThreshold;
  try {
    showAutopilot(await api<Autopilot>("/api/autopilot", "PUT", { enabled: apOn.checked, threshold }));
  } catch (e) {
    if (gateOpen()) return;
    apHint(e instanceof ApiError && e.status === 422 ? THRESHOLD_HINT : "Could not save the autopilot setting.");
  }
}
apOn.addEventListener("change", () => void saveAutopilot());
apThreshold.addEventListener("input", checkThreshold);
apThreshold.addEventListener("change", () => {
  if (checkThreshold()) void saveAutopilot(); // a bad value stays in the box, marked, and is not sent
});

async function loadAutopilot(): Promise<void> {
  try {
    showAutopilot(await api<Autopilot>("/api/autopilot"));
  } catch {
    if (!gateOpen()) apHint("Could not load the autopilot setting.");
  }
}

async function useToken(): Promise<void> {
  gate.hidden = true;
  document.body.classList.remove("locked");
  statusEl.textContent = "Checking API...";
  await loadAutopilot();
  await refresh();
}

byId("demo-open").addEventListener("click", () => {
  if (demoToken === null) return;
  setToken(demoToken);
  void useToken();
});

byId("token-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = byId<HTMLInputElement>("token-input");
  setToken(input.value);
  input.value = "";
  void useToken();
});

// a fresh link with #token=... pasted into this tab: take it without a reload
window.addEventListener("hashchange", () => {
  if (takeTokenFromHash()) void useToken();
});

if (!hasToken()) document.body.classList.add("locked"); // no console flashing up behind the card while /api/config answers
try {
  const cfg = await api<{ demo_mode: boolean; demo_token?: string | null }>("/api/config");
  byId("demo-badge").hidden = !cfg.demo_mode;
  simulateBtn.hidden = !cfg.demo_mode;
  demoToken = cfg.demo_token ?? null;
} catch {
  /* the poll below reports the outage */
}
if (hasToken()) {
  await loadAutopilot();
  await refresh();
} else {
  showGate(false); // a first visit: ask before calling anything that needs a token
}
setInterval(() => void refresh(), POLL_MS);

export {};
