/**
 * Schema Normalizer - Normalizes invalid tool schemas from Polar MCP
 *
 * Polar MCP returns tool schemas with inputSchema objects missing the required
 * `type` field. This module detects and normalizes those schemas.
 */

/**
 * JSON Schema property types
 */
interface JSONSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

/**
 * MCP Tool definition
 */
interface MCPTool {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
  [key: string]: unknown;
}

/**
 * Checks if a schema object is missing the required `type` field
 *
 * @param schema - The schema object to check
 * @returns True if the schema needs normalization
 */
function schemaNeedsNormalization(schema: unknown): schema is JSONSchema {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }

  const schemaObj = schema as JSONSchema;

  // Only normalize if type is missing but properties exist (indicates it's meant to be an object schema)
  return !schemaObj.type && schemaObj.properties !== undefined;
}

/**
 * Normalizes a single inputSchema by adding type: "object" if missing
 *
 * @param schema - The inputSchema to normalize
 * @returns Normalized schema with type: "object" added if needed
 */
function normalizeInputSchema(schema: JSONSchema): JSONSchema {
  if (!schemaNeedsNormalization(schema)) {
    return schema;
  }

  return {
    type: "object",
    ...schema,
  };
}

/**
 * Normalizes an array of MCP tools by fixing their inputSchemas
 *
 * @param tools - Array of MCP tools to normalize
 * @returns Array of tools with normalized schemas
 */
export function normalizeTools(tools: unknown[]): MCPTool[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.map((tool) => normalizeTool(tool));
}

/**
 * Normalizes a single MCP tool by fixing its inputSchema
 *
 * @param tool - The tool to normalize
 * @returns Normalized tool with proper inputSchema
 */
function normalizeTool(tool: unknown): MCPTool {
  if (typeof tool !== "object" || tool === null) {
    throw new Error(`Invalid tool: expected object, got ${typeof tool}`);
  }

  const toolObj = tool as Record<string, unknown>;

  if (typeof toolObj.name !== "string") {
    throw new Error(`Invalid tool: missing or invalid 'name' field`);
  }

  const normalizedTool: MCPTool = {
    name: toolObj.name,
    description:
      typeof toolObj.description === "string" ? toolObj.description : undefined,
    inputSchema: {},
  };

  // Normalize inputSchema if present
  if (toolObj.inputSchema !== undefined) {
    if (
      typeof toolObj.inputSchema !== "object" ||
      toolObj.inputSchema === null
    ) {
      throw new Error(
        `Invalid tool '${toolObj.name}': inputSchema must be an object`,
      );
    }

    normalizedTool.inputSchema = normalizeInputSchema(
      toolObj.inputSchema as JSONSchema,
    );
  } else {
    // If no inputSchema, provide a default empty object schema
    normalizedTool.inputSchema = { type: "object", properties: {} };
  }

  // Preserve any additional fields on the tool
  for (const [key, value] of Object.entries(toolObj)) {
    if (!["name", "description", "inputSchema"].includes(key)) {
      (normalizedTool as Record<string, unknown>)[key] = value;
    }
  }

  return normalizedTool;
}

/**
 * Normalizes a tools/list JSON-RPC response by fixing tool schemas
 *
 * @param response - The JSON-RPC response to normalize
 * @returns Normalized response with fixed tool schemas
 */
export function normalizeToolsListResponse(response: unknown): unknown {
  if (typeof response !== "object" || response === null) {
    return response;
  }

  const responseObj = response as Record<string, unknown>;

  // Only process successful responses with a result
  if (responseObj.error !== undefined) {
    return response;
  }

  const result = responseObj.result;
  if (typeof result !== "object" || result === null) {
    return response;
  }

  const resultObj = result as Record<string, unknown>;

  // Check if this is a tools/list response
  if (!Array.isArray(resultObj.tools)) {
    return response;
  }

  // Normalize the tools array
  const normalizedTools = normalizeTools(resultObj.tools);

  return {
    ...responseObj,
    result: {
      ...resultObj,
      tools: normalizedTools,
    },
  };
}
