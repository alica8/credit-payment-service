FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
RUN npm run db:generate
COPY tsconfig.json ./
COPY .prettierrc.json .prettierignore compose.yaml ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY public ./public
RUN npm run build && chown -R node:node dist
USER node
EXPOSE 3000
CMD ["npm", "start"]
