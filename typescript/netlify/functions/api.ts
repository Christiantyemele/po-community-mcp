import type { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import * as tools from "../../tools";
import { IMcpTool } from "../../IMcpTool";

const handler: Handler = async (event: HandlerEvent, _context: HandlerContext) => {
  const path = event.path.replace("/.netlify/functions/api", "");
  const method = event.httpMethod;
  const headers = event.headers as Record<string, string>;
  const body = event.body ? JSON.parse(event.body) : {};

  // Health check endpoint
  if (method === "GET" && path === "/hello-world") {
    return {
      statusCode: 200,
      body: "Hello World",
      headers: { "Content-Type": "text/plain" },
    };
  }

  // MCP endpoint
  if (method === "POST" && path === "/mcp") {
    try {
      const server = new McpServer(
        {
          name: "Clinical Trial Matcher MCP Server",
          version: "1.0.0",
        },
        {
          capabilities: {
            experimental: {
              fhir_context_required: {
                value: true,
              },
            },
          },
        },
      );

      // Create mock request object with headers
      const mockReq = {
        headers: headers,
        body: body,
      } as any;

      for (const tool of Object.values<IMcpTool>(tools)) {
        tool.registerTool(server, mockReq);
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      // Create mock response object
      let responseBody: any = null;
      let responseStatus = 200;
      let responseHeaders: Record<string, string> = {};

      const mockRes = {
        headersSent: false,
        status: (code: number) => {
          responseStatus = code;
          return mockRes;
        },
        json: (data: any) => {
          responseBody = data;
          return mockRes;
        },
        send: (data: any) => {
          responseBody = data;
          return mockRes;
        },
        on: () => {},
        setHeader: (name: string, value: string) => {
          responseHeaders[name] = value;
        },
      } as any;

      await transport.handleRequest(mockReq, mockRes, body);

      return {
        statusCode: responseStatus,
        body: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
        headers: {
          "Content-Type": "application/json",
          ...responseHeaders,
        },
      };
    } catch (error: any) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error?.message ?? "Internal server error",
          },
          id: null,
        }),
        headers: { "Content-Type": "application/json" },
      };
    }
  }

  // 404 for unknown routes
  return {
    statusCode: 404,
    body: JSON.stringify({ error: "Not found" }),
    headers: { "Content-Type": "application/json" },
  };
};

export { handler };
