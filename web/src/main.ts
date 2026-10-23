const statusEl = document.getElementById("status") as HTMLElement;

try {
  const res = await fetch("/api/health");
  const body = (await res.json()) as { ok: boolean };
  statusEl.textContent = body.ok ? "API online" : "API offline";
} catch {
  statusEl.textContent = "API offline";
}

export {};
