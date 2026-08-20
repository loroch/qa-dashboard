FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node.js + Playwright + Chromium — the Test Generator's automation-run feature
# (Phase 2) drafts a Playwright script per Jira Test issue and executes it as a
# subprocess from this image. Baked in at build time so a run never needs a
# runtime download of the browser binary.
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g playwright@1.61.1 \
    && npx playwright install --with-deps chromium
ENV NODE_PATH=/usr/lib/node_modules

# Copy source
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
