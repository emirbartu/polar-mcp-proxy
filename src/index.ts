/**
 * Polar MCP Proxy Server
 *
 * A minimal MCP proxy that normalizes invalid tool schemas from Polar MCP.
 * Intercepts tools/list responses and adds missing `type: "object"` to inputSchemas.
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { normalizeToolsListResponse } from "./schema-normalizer.js";

// Configuration from environment
const POLAR_MCP_URL =
  process.env.POLAR_MCP_URL || "https://api.polar.sh/mcp/sse";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "3001", 10);
const POLAR_API_KEY = process.env.POLAR_API_KEY;

// Validate required configuration
if (!POLAR_API_KEY) {
  console.error("Error: POLAR_API_KEY environment variable is required");
  console.error("Set it in your .env file or environment");
  process.exit(1);
}

// Express app setup
const app = express();
app.use(cors());
app.use(express.json());

// Store active SSE connections
interface ClientConnection {
  response: Response;
  mcpClient: Client;
  messageQueue: unknown[];
  requestMap: Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >;
}

const connections = new Map<string, ClientConnection>();

/**
 * Generate a unique client ID
 */
function generateClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Send a JSON-RPC message to the client via SSE
 */
function sendToClient(connection: ClientConnection, message: unknown): void {
  const data = JSON.stringify(message);
  connection.response.write(`data: ${data}\n\n`);
}

/**
 * Handle SSE connection establishment
 */
app.get("/sse", async (req: Request, res: Response) => {
  const clientId = generateClientId();

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Create MCP client connection to Polar
  // The SDK handles auth through the requestInit option
  const polarUrl = new URL(POLAR_MCP_URL);
  const polarTransport = new SSEClientTransport(polarUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${POLAR_API_KEY}`,
      },
    },
  });

  const mcpClient = new Client(
    {
      name: "polar-mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  const connection: ClientConnection = {
    response: res,
    mcpClient,
    messageQueue: [],
    requestMap: new Map(),
  };

  connections.set(clientId, connection);

  try {
    // Connect to Polar MCP
    await mcpClient.connect(polarTransport);

    console.log(`Client ${clientId} connected to Polar MCP`);

    // Send initial endpoint message
    sendToClient(connection, {
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: {
          name: "polar-mcp-proxy",
          version: "1.0.0",
        },
      },
    });

    // Handle client disconnect
    req.on("close", () => {
      console.log(`Client ${clientId} disconnected`);
      connections.delete(clientId);
      mcpClient.close().catch((err) => {
        console.error(`Error closing MCP client for ${clientId}:`, err);
      });
    });

    req.on("error", (err) => {
      console.error(`Client ${clientId} error:`, err);
      connections.delete(clientId);
      mcpClient.close().catch(() => {});
    });
  } catch (error) {
    console.error(`Failed to connect client ${clientId} to Polar:`, error);
    res.status(500).end();
    connections.delete(clientId);
  }
});

/**
 * Handle JSON-RPC messages from clients
 */
app.post("/message", async (req: Request, res: Response) => {
  const clientId = req.query.clientId as string | undefined;

  if (!clientId) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Missing clientId parameter" },
      id: null,
    });
    return;
  }

  const connection = connections.get(clientId);
  if (!connection) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Client not found" },
      id: null,
    });
    return;
  }

  const message = req.body;

  // Validate JSON-RPC message
  if (!message || typeof message !== "object") {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid JSON-RPC message" },
      id: null,
    });
    return;
  }

  // Only handle requests with methods (not notifications for now)
  if (!message.method) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Missing method field" },
      id: message.id ?? null,
    });
    return;
  }

  try {
    // Handle tools/list specially to normalize schemas
    if (message.method === "tools/list") {
      const result = await connection.mcpClient.listTools();

      // Normalize the response
      const normalizedResponse = normalizeToolsListResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: result.tools },
      });

      // Send response via SSE
      sendToClient(connection, normalizedResponse);

      // Acknowledge receipt
      res.status(202).json({ status: "accepted" });
      return;
    }

    // Handle other tool-related methods
    if (message.method === "tools/call") {
      const result = await connection.mcpClient.callTool(
        message.params as { name: string; arguments?: Record<string, unknown> },
      );

      sendToClient(connection, {
        jsonrpc: "2.0",
        id: message.id,
        result,
      });

      res.status(202).json({ status: "accepted" });
      return;
    }

    // For other methods, forward to Polar and return response
    // This is a simplified implementation - full MCP spec would need more handlers
    console.log(`Unhandled method: ${message.method}`);

    res.status(501).json({
      jsonrpc: "2.0",
      error: {
        code: -32601,
        message: `Method not implemented: ${message.method}`,
      },
      id: message.id ?? null,
    });
  } catch (error) {
    console.error(`Error handling message for client ${clientId}:`, error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    sendToClient(connection, {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32603,
        message: `Internal error: ${errorMessage}`,
      },
    });

    res.status(500).json({ status: "error", message: errorMessage });
  }
});

/**
 * Health check endpoint
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    connections: connections.size,
    polarMcpUrl: POLAR_MCP_URL,
  });
});

/**
 * Start the server
 */
app.listen(PROXY_PORT, () => {
  console.log(`Polar MCP Proxy running on port ${PROXY_PORT}`);
  console.log(`Forwarding to: ${POLAR_MCP_URL}`);
  console.log(`SSE endpoint: http://localhost:${PROXY_PORT}/sse`);
  console.log(`Health check: http://localhost:${PROXY_PORT}/health`);
});
