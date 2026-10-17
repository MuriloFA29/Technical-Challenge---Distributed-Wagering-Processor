FROM oven/bun:1.2-alpine AS base
WORKDIR /app

# Dependências
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Código fonte
COPY . .

EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
