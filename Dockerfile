FROM oven/bun:1.3.11
WORKDIR /app
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun public ./public
USER bun
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/taste.sqlite
EXPOSE 3000
CMD ["bun", "src/server.ts"]
