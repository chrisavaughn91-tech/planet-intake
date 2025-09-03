# Use a Playwright image that already has all headless Chromium deps
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Install only production deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy app code
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Start the server
CMD ["node", "src/server.js"]
