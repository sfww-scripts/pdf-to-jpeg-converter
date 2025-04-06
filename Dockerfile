FROM node:18

# Install GraphicsMagick
RUN apt-get update && apt-get install -y graphicsmagick

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "index.js"]