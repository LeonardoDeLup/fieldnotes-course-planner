FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
ENV FIELDNOTES_AI_ENABLED=0 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/app/ ./backend/app/
COPY database/ ./database/
COPY --from=frontend /build/dist/ ./frontend/dist/
USER 10001
CMD ["sh", "-c", "exec python -m uvicorn app.hosted:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000}"]
