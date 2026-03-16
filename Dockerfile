FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# settings.json lives on a persistent volume — create empty default
RUN echo '{}' > /app/settings.json

ENV DATABASE_URL=postgres://postgres:8j9Kil5kiLVulIaCwSPV0WYrzfn7lTk6e1cCaUxASK1LMm8QgCaRuKsY7spHlH0d@cwg0skg4s8osk0c40kkc8kkk:5432/postgres

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "index.js"]
