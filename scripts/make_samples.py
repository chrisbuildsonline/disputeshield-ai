"""Generate the synthetic sample PDFs in samples/. Run: bun run samples (CC0, all data fictional)."""

from __future__ import annotations

from pathlib import Path

from fpdf import FPDF

OUT = Path(__file__).resolve().parent.parent / "samples"

UPS_LINES = [
    "Carrier: UPS",
    "Tracking Number: 1Z999AA10123456784",
    "Service: UPS Ground",
    "Status: Delivered",
    "Delivered: 2026-10-01 10:00:00",
    "Delivered To: 12 High Street, Leeds LS1 4AB",
    "Signed By: J Smith",
    "Left At: Front door",
]

CRM_LINES = [
    "Order ID: A-1042",
    "Order Date: 2026-09-28",
    "Item: Wireless keyboard",
    "Total: USD 49.90",
    "Payment: PayPal",
    "Customer message: Hi, where is my parcel? It has not arrived.",
    "Customer message: Please confirm the delivery address is correct.",
]


def make(path: Path, title: str, lines: list[str]) -> None:
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 12, title, new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", size=12)
    for line in lines:
        pdf.multi_cell(0, 8, line, new_x="LMARGIN", new_y="NEXT")
    pdf.output(str(path))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make(OUT / "ups_receipt.pdf", "UPS Delivery Receipt (sample)", UPS_LINES)
    make(OUT / "crm_order.pdf", "CRM Order Export (sample)", CRM_LINES)
    print(f"wrote {OUT}")
