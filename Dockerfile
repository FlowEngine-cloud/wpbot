FROM node:24-slim
WORKDIR /app

# Install prod deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# App source only (data.db, auth/, .env stay out — see .dockerignore)
COPY src ./src

ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/index.js"]
