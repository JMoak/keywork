FROM ghcr.io/sparfenyuk/mcp-proxy:v0.12.0
RUN pip install --no-cache-dir mcp-server-fetch==2026.8.18

EXPOSE 8080
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "--"]
CMD ["mcp-server-fetch"]
