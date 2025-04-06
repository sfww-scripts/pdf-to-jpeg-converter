FROM node:18

# Install Poppler utilities (required by pdf-to-img)
RUN apt-get update && apt-get install -y poppler-utils

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "index.js"]