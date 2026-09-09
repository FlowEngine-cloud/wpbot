FROM node:24-slim
WORKDIR /app

# Install prod deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# App source only (data.db, auth/, .env stay out - see .dockerignore)
COPY src ./src

# SQLite db + WhatsApp session live here. Mount a volume on /data or the
# pairing is lost on every restart.
RUN mkdir -p /data
ENV DATA_DIR=/data

ENV PORT=3000
EXPOSE 3000

# /api/status is session-gated, so 401 still means the server is answering.
# Only a connection error or a 5xx counts as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/status').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
