FROM node:22-bookworm-slim

# 设置 UTF-8 locale，防止非 ASCII 字符被截断为 ?
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TZ=Asia/Shanghai

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src ./src

CMD ["node", "src/server.js"]
