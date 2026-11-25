FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.mjs board_games.mjs chess_rules.mjs janggi_rules.mjs galaga_scores.mjs ./
ENV PORT=8000
EXPOSE 8000
CMD ["npm", "start"]
