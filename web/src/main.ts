import {
  AllCommunityModule,
  ModuleRegistry,
  createGrid,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
} from "ag-grid-community";
import { api, esc, money, needsAction, reasonLabel, statusLabel, timeLeft, type Dispute } from "./api";
import { createDetail } from "./detail";

ModuleRegistry.registerModules([AllCommunityModule]);

const POLL_MS = 3000;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = byId("status");
const simulateBtn = byId<HTMLButtonElement>("simulate-btn");
const emptyEl = byId("empty");

const badge = (text: string, cls: string) => `<span class="badge ${cls}">${esc(text)}</span>`;

const columns: ColDef<Dispute>[] = [
  { colId: "id", headerName: "Dispute", field: "id", minWidth: 190, flex: 1.4 },
  {
    colId: "amount",
    headerName: "Amount",
    width: 120,
    valueGetter: (p) => (p.data ? Number(p.data.amount_value) : 0),
    valueFormatter: (p) => (p.data ? money(p.data.amount_value, p.data.currency) : ""),
    type: "rightAligned",
  },
  { colId: "reason", headerName: "Reason", minWidth: 170, flex: 1.2, valueGetter: (p) => reasonLabel(p.data?.reason ?? null) },
  {
    colId: "status",
    headerName: "Status",
    width: 160,
    cellRenderer: (p: ICellRendererParams<Dispute>) =>
      p.data ? badge(statusLabel(p.data.status), needsAction(p.data) ? "badge-red" : "badge-calm") : "",
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
    width: 110,
    type: "rightAligned",
    valueGetter: (p) => p.data?.win_probability ?? -1,
    cellRenderer: (p: ICellRendererParams<Dispute>) => {
      const w = p.data?.win_probability;
      if (w === null || w === undefined) return `<span class="muted" title="Upload a document to score this case">&mdash;</span>`;
      return badge(`${w}%`, w >= 80 ? "badge-green" : w >= 50 ? "badge-amber" : "badge-red");
    },
  },
  {
    colId: "due",
    headerName: "Respond within",
    minWidth: 160,
    flex: 1,
    valueGetter: (p) => (p.data?.seller_response_due_date ? Date.parse(p.data.seller_response_due_date) : 0),
    cellRenderer: (p: ICellRendererParams<Dispute>) => {
      if (!p.data) return "";
      if (!needsAction(p.data)) return `<span class="muted">${p.data.outcome ? "Closed" : "Answered"}</span>`;
      const t = timeLeft(p.data.seller_response_due_date);
      return `<span class="${t.urgent ? "urgent" : ""}">${esc(t.text)}</span>`;
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
  theme: themeQuartz.withParams({ accentColor: "#4338ca", headerBackgroundColor: "#f1f5f9", fontSize: 14, rowHeight: 48 }),
  columnDefs: columns,
  rowData: [],
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

function paintEmpty(): void {
  emptyEl.hidden = !(loaded && rows.length === 0);
  byId("empty-hint").hidden = simulateBtn.hidden;
}

async function refresh(): Promise<void> {
  try {
    const next = await api<Dispute[]>("/api/disputes");
    statusEl.textContent = "API online";
    loaded = true;
    const json = JSON.stringify(next);
    if (json !== lastJson) {
      lastJson = json;
      rows = next;
      gridApi.setGridOption("rowData", rows); // getRowId makes this a delta update: selection and scroll stay
      for (const d of rows) detail.update(d);
    }
    gridApi.refreshCells({ columns: ["due"], force: true }); // the countdown moves even when the data does not
    paintEmpty();
    if (detail.isOpen()) detail.refreshAudit();
  } catch {
    statusEl.textContent = "Connection lost, retrying...";
  }
}

simulateBtn.addEventListener("click", async () => {
  simulateBtn.disabled = true;
  try {
    const d = await api<Dispute>("/api/demo/chargeback", "POST");
    await refresh();
    const node = gridApi.getRowNode(d.id);
    node?.setSelected(true);
    if (node?.rowIndex != null) {
      gridApi.ensureIndexVisible(node.rowIndex);
      gridApi.setFocusedCell(node.rowIndex, "id");
    }
  } catch {
    statusEl.textContent = "Could not create the demo chargeback. Is demo mode on?";
  } finally {
    simulateBtn.disabled = false;
  }
});

try {
  const cfg = await api<{ demo_mode: boolean }>("/api/config");
  byId("demo-badge").hidden = !cfg.demo_mode;
  simulateBtn.hidden = !cfg.demo_mode;
} catch {
  /* the poll below reports the outage */
}
await refresh();
setInterval(() => void refresh(), POLL_MS);

export {};
