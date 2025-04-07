FROM node:18

# Install dependencies for pdf2pic (GraphicsMagick, Ghostscript, Poppler) and ImageMagick as fallback
RUN apt-get update && apt-get install -y \
    poppler-utils \
    ghostscript \
    graphicsmagick \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Configure ImageMagick policy to allow PDF conversion
RUN if [ -f /etc/ImageMagick-6/policy.xml ]; then \
    sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml; \
    fi

# Set environment variable for pdf2pic to find GraphicsMagick
ENV GM_PATH=/usr/bin/gm

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

CMD ["node", "index.js"]