FROM node:18

# Install dependencies for pdf2pic (GraphicsMagick, Ghostscript, Poppler) and ImageMagick
RUN apt-get update && apt-get install -y \
    poppler-utils \
    ghostscript \
    graphicsmagick \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies for canvas (required for pdf.js rendering)
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Java for PDFBox
RUN apt-get update && apt-get install -y \
    openjdk-11-jre \
    && rm -rf /var/lib/apt/lists/*

# Download PDFBox JAR
RUN mkdir -p /usr/local/lib && \
    curl -L https://repo1.maven.org/maven2/org/apache/pdfbox/pdfbox-app/2.0.27/pdfbox-app-2.0.27.jar -o /usr/local/lib/pdfbox-app-2.0.27.jar

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

# Expose the port
EXPOSE 8080

CMD ["node", "index.js"]
