FROM node:22-bookworm-slim

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TZ=Asia/Shanghai

# slim 镜像不带 ca-certificates，https 源会验证失败；统一走 http 国内源 + 先补证书
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i -e 's|https://deb.debian.org|http://mirrors.aliyun.com|g' \
             -e 's|http://deb.debian.org|http://mirrors.aliyun.com|g' \
             /etc/apt/sources.list.d/debian.sources; \
    fi && \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i -e 's|https://deb.debian.org|http://mirrors.aliyun.com|g' \
             -e 's|deb.debian.org|mirrors.aliyun.com|g' \
             /etc/apt/sources.list; \
    fi

WORKDIR /app

COPY package.json package-lock.json ./

# better-sqlite3 无预编译包时需源码编译；装临时工具链，装完即删
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && npm config set registry https://registry.npmmirror.com \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src

CMD ["node", "src/server.js"]
