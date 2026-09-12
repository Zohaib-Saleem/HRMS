#!/usr/bin/env bash
# Update HRMS from GitHub and redeploy.
#
# Touches nothing outside the hrms compose project. The BI stack, its database
# and its containers are never referenced here.
set -euo pipefail

cd /opt/hrms

echo "==> pulling"
git pull --ff-only origin master

echo "==> rebuilding images"
docker compose -p hrms build hrms-api hrms-web

echo "==> applying migrations (deploy: additive only, never resets)"
docker compose -p hrms run --rm --no-deps --entrypoint sh hrms-api \
  -c 'cd /app/apps/api && node /app/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma'

echo "==> restarting HRMS services"
docker compose -p hrms up -d hrms-api hrms-web

echo "==> health"
sleep 5
curl -fsS https://hrms.gamempires.com/health && echo
