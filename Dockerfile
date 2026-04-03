FROM ghcr.io/puppeteer/puppeteer:21.6.1

ENV NODE_ENV=production
USER root

# Set working directory to a safe writable path
WORKDIR /app

# Create a writable directory for WhatsApp sessions
RUN mkdir -p /app/data/.wwebjs_auth && \
    chown -R pptruser:pptruser /app

# Copy package files and install dependencies
COPY --chown=pptruser:pptruser package*.json ./
USER pptruser
RUN npm install --production

# Copy all source code
COPY --chown=pptruser:pptruser . .

# Expose the app port
EXPOSE 4000

# Puppeteer skip chromium download (already included in base image)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/opt/google/chrome/chrome

# Set writable data path for WhatsApp sessions
ENV WWEBJS_AUTH_DIR=/app/data/.wwebjs_auth

# Start the application
CMD ["node", "server.js"]
