FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:18-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY --from=builder /app/dist ./dist
# 如果需要静态文件，取消注释以下行
# COPY ./public ./public
# COPY ./html ./html

ENV PORT=80 TOKEN=

EXPOSE 80

CMD ["npm", "run", "prod"]
