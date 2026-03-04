# syntax=docker/dockerfile:1

FROM node:latest AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY scripts ./scripts
RUN npm run build

FROM node:latest AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV SLOPSCROLL_HOST=0.0.0.0
ENV SLOPSCROLL_PORT=3579
ENV SLOPSCROLL_DATA_DIR=/app/data
ENV SLOPSCROLL_SOUNDS_DIR=/app/data/sounds

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/config ./config

RUN mkdir -p /app/data/images /app/data/videos /app/data/sounds /app/data/session

EXPOSE 3579

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3579/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

CMD ["npm", "run", "start"]
