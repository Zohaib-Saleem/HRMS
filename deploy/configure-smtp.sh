#!/usr/bin/env bash
# Configure Gmail / Google Workspace SMTP for HRMS.
#
# Prompts for the address and the App Password. The password is read with
# `read -rs`, so it is never echoed to the terminal, never appears in your shell
# history, and never leaves this host. It is written straight into
# /opt/hrms/.env, which is mode 600 and git-ignored.
#
# Gmail requires an APP PASSWORD (16 characters, 2FA must be on).
# A normal account password will be rejected.
#   https://myaccount.google.com/apppasswords
set -euo pipefail

ENV_FILE=/opt/hrms/.env
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

read -rp  "Gmail / Workspace address (e.g. hr@gamempires.com): " SMTP_ADDR
read -rsp "App Password (input hidden): " SMTP_PW; echo
[ -n "$SMTP_ADDR" ] && [ -n "$SMTP_PW" ] || { echo "both values are required" >&2; exit 1; }

# Google shows app passwords in groups of four; the spaces are display only.
SMTP_PW="${SMTP_PW// /}"

cp -a "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

# Rewrite the key by filtering it out and re-appending. No sed/perl escaping is
# involved, so a password containing / & \ or newlines cannot corrupt the file.
set_key() {
  local key="$1" val="$2" tmp
  tmp=$(mktemp)
  chmod 600 "$tmp"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

set_key MAIL_PROVIDER smtp
set_key SMTP_HOST     smtp.gmail.com
set_key SMTP_PORT     587
set_key SMTP_SECURE   false
set_key SMTP_USER     "$SMTP_ADDR"
set_key SMTP_PASSWORD "$SMTP_PW"
# Gmail rewrites a From that is not the authenticated user or a verified alias,
# so the envelope sender is set to the account actually signing in.
set_key MAIL_FROM     "HRMS <${SMTP_ADDR}>"

unset SMTP_PW
chmod 600 "$ENV_FILE"

echo
echo "==> restarting hrms-api"
cd /opt/hrms
docker compose -p hrms up -d --force-recreate hrms-api >/dev/null 2>&1

echo "==> waiting for SMTP verification at boot"
for i in $(seq 1 20); do
  if docker logs hrms-api 2>&1 | grep -q 'SMTP transport ready'; then
    echo "OK: SMTP transport ready"; break
  fi
  if docker logs hrms-api 2>&1 | grep -qi 'email provider verification failed\|EAUTH\|Invalid login'; then
    echo "FAILED - Gmail rejected the credentials. Check the App Password." >&2
    docker logs hrms-api 2>&1 | grep -i 'verification failed\|EAUTH\|Invalid login' | tail -3 >&2
    exit 1
  fi
  sleep 2
done

echo "==> health"
curl -fsS https://hrms.gamempires.com/health && echo
