# Used by Glama's evaluator and anyone who prefers a container. The server
# speaks MCP over stdio, so run it with -i.
#
#   docker build -t telegram-slack-mcp .
#   docker run -i --rm -e TELEGRAM_API_ID=... -e TELEGRAM_API_HASH=... telegram-slack-mcp telegram
#   docker run -i --rm -e SLACK_USER_TOKENS=... telegram-slack-mcp slack
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Session data lives here; mount it to keep logins across container restarts.
ENV CHAT_MCP_DATA_DIR=/data
VOLUME /data
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["telegram"]
