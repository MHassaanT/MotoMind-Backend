FROM ghcr.io/puppeteer/puppeteer:21.6.1

ENV NODE_ENV=production
USER root

# Set working directory to a safe writable path
WORKDIR /app

# Create a writable directory for WhatsApp sessions
RUN mkdir -p /app/data/.wwebjs_auth && \
    chown -R pptruser:pptruser /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all source code
COPY . .

# Expose the app port
EXPOSE 4000

# Puppeteer skip chromium download (already included in base image)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Set writable data path for WhatsApp sessions
ENV WWEBJS_AUTH_DIR=/app/data/.wwebjs_auth

# Start the application
CMD ["node", "server.js"]
