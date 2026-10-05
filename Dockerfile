# Boekhouding Medialan – wordt automatisch gebouwd door GitHub Actions (amd64 + arm64)
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-slim
ENV NODE_ENV=production \
    TZ=Europe/Amsterdam \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    BACKUP_EXTERN_DIR=/backup-extern \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data /backup-extern
# Start als root alleen om de rechten van de gekoppelde mappen goed te zetten;
# src/start.ts laat daarna direct alle root-rechten los en draait als 'node' (1000:1000).
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/start.ts"]
