FROM python:3.12-slim

WORKDIR /app
COPY . .

# 安装Chrome（会拉全部依赖，不需要--no-install-recommends）
RUN apt-get update && \
    apt-get install -y ca-certificates wget gnupg && \
    apt-get install -y /app/chrome.deb && \
    rm -f /app/chrome.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 安装Playwright系统依赖 + 下载内置chromium浏览器（系统Chrome失败时回退用）
RUN pip install --no-cache-dir playwright && \
    python -m playwright install-deps chromium && \
    python -m playwright install chromium

# 安装Python其余依赖
RUN pip install --no-cache-dir flask playwright-stealth requests

# 持久化数据
RUN mkdir -p /data
VOLUME ["/data"]

ENV CONFIG_FILE=/data/config.json
ENV FLASK_HOST=0.0.0.0
ENV FLASK_PORT=3211
ENV TZ=Asia/Shanghai

EXPOSE 3211

CMD ["python", "main.py"]
