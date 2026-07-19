FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data

ENV PORT=3000
ENV DATA_FILE=/app/data/reelkeeper.json
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["npm", "start"]
