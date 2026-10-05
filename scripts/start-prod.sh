#!/bin/sh
# Starts the StreamVerse API and the video worker in one container.
set -e

mkdir -p "${UPLOAD_DIR:-/app/uploads}" "${HLS_OUTPUT_DIR:-/app/hls-output}"

# Apply database migrations (safe to run on every start).
npm run prisma:deploy -w @tesor_gp/database

# Optional one-time demo data. Set SEED_ON_START=true for the first deploy, then remove it.
if [ "$SEED_ON_START" = "true" ]; then
  npm run seed -w @tesor_gp/database
fi

node workers/video-processor/dist/index.js &
exec node apps/api/dist/index.js
