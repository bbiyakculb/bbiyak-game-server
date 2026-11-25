
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.mjs ./
COPY board_games.mjs ./
COPY chess_rules.mjs ./
COPY janggi_rules.mjs ./

ENV PORT=8000
EXPOSE 8000

CMD ["npm", "start"]
