FROM node:22-bookworm-slim

# Chrome's system libraries. On amd64 we use Puppeteer's Chrome for Testing (downloaded at npm install);
# on arm64 Debian's chromium (Chrome for Testing has no matching arm64 build).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
      libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxkbcommon0 libxrandr2 \
      $([ "$(dpkg --print-architecture)" = arm64 ] && echo chromium) \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/opt/puppeteer \
    DATA_DIR=/data \
    PORT=3100 \
    TZ=Asia/Kolkata

WORKDIR /app
COPY package.json package-lock.json ./
RUN if [ "$(dpkg --print-architecture)" = arm64 ]; then \
      PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev && ln -s /usr/bin/chromium /usr/local/bin/wa-chrome; \
    else \
      npm ci --omit=dev && ln -s "$(node -e "console.log(require('puppeteer').executablePath())")" /usr/local/bin/wa-chrome; \
    fi && npm cache clean --force && /usr/local/bin/wa-chrome --version
ENV CHROME_PATH=/usr/local/bin/wa-chrome

COPY src ./src
COPY test ./test
# Evals: if any engine test fails, the image doesn't build and the running version stays.
RUN npm test && rm -rf test

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
