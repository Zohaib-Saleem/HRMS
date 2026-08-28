#!/usr/bin/env bash
# Runs every audit suite in sequence, spacing the ones that sign in so the
# login rate limit (10 per five minutes per IP) does not fail a suite for
# reasons that have nothing to do with the code under test.
set -u

cd "$(dirname "$0")/.."
OUT=/tmp/regression
mkdir -p "$OUT"
: > "$OUT/summary.txt"

run() {
  local name="$1"; shift
  echo "=== $name ===" | tee -a "$OUT/summary.txt"
  "$@" > "$OUT/$name.log" 2>&1
  local code=$?
  local line
  line=$(grep -E "PASS=[0-9]+ +FAIL=[0-9]+|passed|failed" "$OUT/$name.log" | tail -1)
  echo "  exit=$code  $line" | tee -a "$OUT/summary.txt"
}

# Phase 3 exercises a two-step approval chain; Phase 4 onwards expects the
# one-step chain. The fixtures are reset either side so neither is testing the
# other phase's configuration.
npx dotenv -e .env -- node scripts/reset-audit-fixtures.mjs --two-step > "$OUT/fixtures-two-step.log" 2>&1
run phase3            bash scripts/audit-phase3.sh
npx dotenv -e .env -- node scripts/reset-audit-fixtures.mjs > "$OUT/fixtures-one-step.log" 2>&1
sleep 150
run phase4            bash scripts/audit-phase4.sh
sleep 150
run phase5            bash scripts/audit-phase5.sh
sleep 150
run phase5-policy     bash scripts/audit-phase5-policy.sh
sleep 150
run phase6            bash scripts/audit-phase6.sh
sleep 150
run zkt               npx dotenv -e .env -- npx tsx scripts/audit-zkt.mjs
run zkt-reliability   npx dotenv -e .env -- npx tsx scripts/audit-zkt-reliability.mjs
run adms              npx dotenv -e .env -- npx tsx scripts/audit-adms.mjs
run timezone          npx dotenv -e .env -- npx tsx scripts/verify-timezone.mjs
run zkt-protocol      npx dotenv -e .env -- npx tsx scripts/verify-zkt-protocol.mjs

echo "=== DONE ===" | tee -a "$OUT/summary.txt"
