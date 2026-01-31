# Polar MCP Proxy

A minimal MCP (Model Context Protocol) proxy server that normalizes invalid tool schemas from Polar MCP.

## Problem

Polar MCP returns tool schemas with `inputSchema` objects that are missing the required `type` field, causing validation errors in MCP clients.

## Solution

This proxy intercepts `tools/list` JSON-RPC responses and normalizes schemas by adding `"type": "object"` to any `inputSchema` missing this field.

## Installation

```bash
bun install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Environment Variables

| Variable        | Description                   | Default                        |
| --------------- | ----------------------------- | ------------------------------ |
| `POLAR_MCP_URL` | Target Polar MCP SSE endpoint | `https://api.polar.sh/mcp/sse` |
| `PROXY_PORT`    | Proxy server port             | `3001`                         |
| `POLAR_API_KEY` | Your Polar API key (required) | -                              |

## Usage

### Development

```bash
bun run dev
```

### Production

```bash
bun run build
bun run start
```

## Connecting

Connect your MCP client to the proxy instead of Polar directly:

```
http://localhost:3001/sse
```

The proxy will:

1. Forward all requests to Polar MCP
2. Normalize tool schemas in `tools/list` responses
3. Stream responses via SSE

## How It Works

### Schema Normalization

When Polar returns a tool like:

```json
{
  "name": "create_checkout",
  "description": "Create a checkout session",
  "inputSchema": {
    "properties": { ... },
    "required": ["product_id"]
  }
}
```

The proxy normalizes it to:

```json
{
  "name": "create_checkout",
  "description": "Create a checkout session",
  "inputSchema": {
    "type": "object",
    "properties": { ... },
    "required": ["product_id"]
  }
}
```

Only `inputSchema` objects missing the `type` field are modified. All other fields are preserved.

## Architecture

- **Transport**: HTTP/SSE via Express
- **MCP Client**: Uses official `@modelcontextprotocol/sdk`
- **JSON-RPC**: Full 2.0 support with request/response matching
- **Streaming**: Server-Sent Events for real-time responses

## License

MIT
