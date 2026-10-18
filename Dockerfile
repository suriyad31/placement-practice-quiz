# Node 22.5+ is required (the app uses the built-in node:sqlite module)
FROM node:22-alpine

WORKDIR /app
ENV PORT=3000

# Install dependencies first so Docker can cache this layer
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the app code (data/ and node_modules are excluded by .dockerignore)
COPY . .

# Folder for the SQLite database; owned by the non-root "node" user
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
