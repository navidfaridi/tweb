FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY relay/package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY relay/server.js relay/routes.js ./

USER node
EXPOSE 3001

CMD ["node", "server.js"]
