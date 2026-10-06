#!/bin/sh
# Starts the StreamVerse API and the video worker in one container.
set -e

mkdir -p "${UPLOAD_DIR:-/app/uploads}" "${HLS_OUTPUT_DIR:-/app/hls-output}"

# Apply database migrations (safe to run on every start).
npm run prisma:deploy -w @tesor_gp/database

# Optional demo data. Runs in the background so the API can answer right away.
# Set SEED_ON_START=true when the media folders are wiped on restart (free hosting).
if [ "$SEED_ON_START" = "true" ]; then
  (npm run seed -w @tesor_gp/database || echo "seed failed (the API keeps running)") &
fi

node workers/video-processor/dist/index.js &
exec node apps/api/dist/index.js
