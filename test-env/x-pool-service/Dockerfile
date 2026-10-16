FROM node:22-bookworm

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

CMD ["node", "src/server.js"]
