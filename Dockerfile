# 精简镜像，加快 Railway 构建
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
# 省内存：限制 V8 堆；省钱默认低并发、跳过预拉图片
ENV NODE_OPTIONS=--max-old-space-size=192
ENV CONCURRENCY=1
ENV ECONOMY_MODE=1
ENV SKIP_IMAGE_PREFETCH=1

EXPOSE 8787

CMD ["npm", "start"]
