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
    "Amount Paid: USD 49.90",
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

# The demo scenarios in app/demo.py; the comment on each says the score its rules give.
NEW_SAMPLES: dict[str, tuple[str, list[str]]] = {
    # Lisbon: delivered to the billing address, amount matches, no signature: INR 79
    "dhl_lisbon_receipt.pdf": (
        "DHL Delivery Receipt (sample)",
        [
            "Carrier: DHL",
            "Tracking Number: JD014600006281234567",
            "Status: Delivered",
            "Delivered: 2026-10-09 14:20:00",
            "Delivered To: Rua Augusta 88, 1100-048 Lisboa",
            "Amount Paid: EUR 128.00",
        ],
    ),
    # Oslo: not-as-described case, carrier proof plus the shop's order export: SNAD 55
    "postnord_oslo_receipt.pdf": (
        "PostNord Delivery Receipt (sample)",
        [
            "Carrier: PostNord",
            "Tracking Number: 00370729900123456785",
            "Status: Delivered",
            "Delivered: 2026-10-12 11:05:00",
            "Delivered To: Storgata 14, 0155 Oslo",
            "Signed By: O Berg",
        ],
    ),
    "crm_oslo_order.pdf": (
        "CRM Order Export (sample)",
        [
            "Order ID: B-2217",
            "Order Date: 2026-10-05",
            "Item: Waxed field jacket",
            "Total: NOK 1299.00",
            "Payment: PayPal",
            "Customer message: Hello, the jacket looks different from the photos.",
        ],
    ),
    # Bristol: delivered, but not to the billing address: INR 44
    "dpd_bristol_receipt.pdf": (
        "DPD Delivery Receipt (sample)",
        [
            "Carrier: DPD",
            "Tracking Number: 15501234567890",
            "Status: Delivered",
            "Delivered: 2026-10-14 16:40:00",
            "Delivered To: Unit 9 Harbour Quay, Bristol BS1 4RB",
        ],
    ),
    # Madrid: unauthorised claim, signed for at an address that is not the billing one: UNAUTHORISED 25
    "seur_madrid_receipt.pdf": (
        "SEUR Delivery Receipt (sample)",
        [
            "Carrier: SEUR",
            "Tracking Number: 05012345678901",
            "Status: Delivered",
            "Delivered: 2026-10-16 09:15:00",
            "Delivered To: Avenida del Puerto 3, 46021 Valencia",
            "Signed By: R Alvarez",
        ],
    ),
}


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
    for name, (title, lines) in NEW_SAMPLES.items():
        make(OUT / name, title, lines)
    print(f"wrote {OUT}")
