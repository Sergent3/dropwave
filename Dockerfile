FROM node:20-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-dev && rm -rf /var/lib/apt/lists/*

COPY server.js agent.js client.js install.sh ./
COPY public/ ./public/

RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node
CMD ["node", "server.js"]
