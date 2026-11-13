FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Install dependencies in a clean layer with proper ownership
COPY --chown=bun:bun package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy application source
COPY --chown=bun:bun tsconfig.json ./
COPY --chown=bun:bun src ./src

# Drop root privileges
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3000/health/live").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["bun", "run", "src/main.ts"]
