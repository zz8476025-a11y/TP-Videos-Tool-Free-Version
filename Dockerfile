FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages edge-tts \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

RUN mkdir -p /app/generated_videos

EXPOSE 3000

CMD ["node", "server.js"]