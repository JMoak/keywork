FROM ghcr.io/astral-sh/uv:0.12.15-python3.12-bookworm-slim

WORKDIR /app
COPY server.py .
RUN uv sync --script server.py

EXPOSE 8080
CMD ["uv", "run", "--script", "server.py"]
