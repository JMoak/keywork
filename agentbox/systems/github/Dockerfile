FROM ghcr.io/github/github-mcp-server:v1.12.2 AS github

FROM ghcr.io/sparfenyuk/mcp-proxy:v0.12.0
COPY --from=github /server/github-mcp-server /usr/local/bin/github-mcp-server

EXPOSE 8080
ENTRYPOINT ["mcp-proxy", "--host", "0.0.0.0", "--port", "8080", "--pass-environment", "--"]
CMD ["github-mcp-server", "stdio"]
