"""Exit 2 unless PAYPAL_API_BASE is the PayPal sandbox. bun run paypal:invoice calls this before it starts anything."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import paypal

if not paypal.is_sandbox():
    sys.stderr.write("refused: PAYPAL_API_BASE is not the PayPal sandbox (https://api-m.sandbox.paypal.com)\n")
    sys.exit(2)
