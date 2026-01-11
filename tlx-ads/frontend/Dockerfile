FROM node:20-alpine

WORKDIR /web

COPY package.json tsconfig.json index.html app.ts docker-entrypoint.sh /web/

RUN npm install
RUN npx tsc

RUN chmod +x /web/docker-entrypoint.sh

EXPOSE 5173

ENTRYPOINT ["/web/docker-entrypoint.sh"]
CMD ["npx", "serve", "-s", ".", "-l", "5173"]
