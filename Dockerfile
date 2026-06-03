FROM apify/actor-node:20

COPY package.json ./
RUN npm install --quiet

COPY main.js ./

CMD ["node", "main.js"]
