# ARKAIN — production image. Multi-stage: build with devDependencies +
# TypeScript, ship a slim runtime with only production deps + compiled JS.
# See ARCHITECTURE.md §2 ("Docker image; host on a single small container
# platform — no Kubernetes for the MVP") and docs/deployment.md.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npm run db:generate && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npm run db:generate
COPY --from=build /app/dist ./dist

# Run as a non-root user (node:20-alpine ships a "node" user/group).
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
