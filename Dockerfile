FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production || npm install --production
COPY src ./src
ENV NODE_ENV=production
CMD ["node","src/index.js"]
