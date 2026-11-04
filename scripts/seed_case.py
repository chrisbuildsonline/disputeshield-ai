"""Put one simulated case (with its sample receipt) into the database named by DISPUTESHIELD_DB; prints its id.

Demo mode can be off when the server runs, so this seeds the database directly instead of calling /api/demo/seed.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import BackgroundTasks

from app import demo, submit

case = asyncio.run(submit._create_demo(demo.SCENARIOS[1], BackgroundTasks(), use_llm=False))
print(case["id"])
