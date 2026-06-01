#!/bin/bash
set -e

REPO_DIR="/home/koos_wrf/nyj/koos-forecast-viewer"
MOHID_INPUT="/home/koos_mohid/FORECAST_UST/DOUT/MOHID/OPER/L2/RES"

cd "$REPO_DIR"

echo "[1/4] Pull latest repository"
git pull origin main

echo "[2/4] Prepare MOHID web data"
python tools/prepare_mohid_web.py \
  --input "$MOHID_INPUT" \
  --output data/mohid

echo "[3/4] Commit changes"
git add index.html README.md .gitignore .nojekyll assets src data tools docs || true

if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

CYCLE=$(python - <<'PY'
import json
from pathlib import Path

p = Path("data/mohid/meta.json")
if p.exists():
    meta = json.loads(p.read_text())
    print(meta.get("cycle_utc", "unknown-cycle"))
else:
    print("unknown-cycle")
PY
)

git commit -m "Update KOOS forecast ${CYCLE}"

echo "[4/4] Push to GitHub"
git push origin main

echo "Done."
