# Production image for the StreamVerse API + video worker (demo bank or blockchain mode, chosen by PAYMENTS_MODE).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci

RUN npm run build -w @tesor_gp/shared \
  && npm run build -w @tesor_gp/storage \
  && npm run build -w @tesor_gp/blockchain \
  && npm run build -w @tesor_gp/database \
  && npm run build -w @tesor_gp/api \
  && npm run build -w @tesor_gp/worker-video-processor

ENV NODE_ENV=production
# Small host (Render free: 512 MB): one rendition, two encoder threads. Override in the service settings.
ENV TRANSCODE_LADDER=480p TRANSCODE_THREADS=2
EXPOSE 4000
CMD ["sh", "scripts/start-prod.sh"]
