FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY dataset/insite-demo.json ./dataset/insite-demo.json
ENV NODE_ENV=production
USER node
CMD ["node", "server.js"]
