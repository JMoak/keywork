# /// script
# requires-python = ">=3.12"
# dependencies = ["fastmcp==4.0.4", "httpx==0.28.1"]
# ///
"""Wraps an internal HTTP API as MCP tools. Each docstring is what the model reads when it
decides whether to call the tool, so describe the record and the moment to use it."""

import os

import httpx
from fastmcp import FastMCP

mcp = FastMCP("SYSTEM")

api = httpx.Client(
    base_url=os.environ["SYSTEM_BASE_URL"],
    headers={"Authorization": f"Bearer {os.environ['SYSTEM_API_TOKEN']}"},
    timeout=30,
)


@mcp.tool
def get_record(record_id: str) -> dict:
    """Fetch one record by its id."""
    response = api.get(f"/records/{record_id}")
    response.raise_for_status()
    return response.json()


if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8080)
