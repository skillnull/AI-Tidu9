FROM node:22.14.0-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json .nvmrc ./
COPY packages/tidu/package.json packages/tidu/package.json
RUN npm install --no-package-lock --ignore-scripts
COPY . .
RUN npm run check \
  && mkdir -p /release \
  && npm pack --workspace @skillnull/tidu --pack-destination /release

FROM node:22.14.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV TIDU_HOST=0.0.0.0
ENV TIDU_PORT=9639
ENV TIDU_DATABASE_PATH=/var/lib/ai-tidu9/tidu.db
ENV TIDU_LOG_PATH=/var/lib/ai-tidu9/logs/runtime.log
ENV TIDU_RUNTIME_CONFIG_PATH=/var/lib/ai-tidu9/tidu.db

RUN groupadd --system tidu \
  && useradd --system --create-home --gid tidu --home-dir /home/tidu tidu \
  && mkdir -p /var/lib/ai-tidu9 \
  && chown tidu:tidu /var/lib/ai-tidu9
COPY --from=builder /release/*.tgz /tmp/tidu.tgz
RUN npm install --global /tmp/tidu.tgz --omit=dev \
  && rm /tmp/tidu.tgz

USER tidu
EXPOSE 9639
VOLUME ["/var/lib/ai-tidu9"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:9639/health').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["tidu", "start"]
