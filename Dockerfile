FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY cameras.example.yaml ./

RUN mkdir -p /app/data

EXPOSE 8787/tcp
EXPOSE 8555/tcp
EXPOSE 8555/udp

CMD ["node", "server/index.js"]
