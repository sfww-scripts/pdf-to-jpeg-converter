FROM node:18

# Install required system dependencies
RUN apt-get update && apt-get install -y \
    poppler-utils \
    imagemagick \
    libpixman-1-dev \
    libcairo2-dev \
    libpango1.0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

CMD ["node", "index.js"]