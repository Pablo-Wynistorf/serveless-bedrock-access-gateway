/**
 * Lightweight MCP client for remote Streamable HTTP servers.
 * Supports connecting to multiple servers concurrently.
 * Handles: initialize → tools/list → tools/call
 */

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MCP_REQUEST_TIMEOUT = 15_000;
const MAX_TOOL_RESULT_CHARS = 10_000;
let jsonRpcId = 0;

function nextId() {
  return ++jsonRpcId;
}

/**
 * Send a JSON-RPC request/notification to an MCP server via HTTP POST.
 * Handles both application/json and text/event-stream responses.
 * @returns {object|null} Parsed result (null for notifications)
 */
async function mcpPost(url, headers, body) {
  const isNotification = !body.id;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });

    // Notifications return 202 with no body
    if (isNotification) {
      if (res.ok || res.status === 202) return null;
      throw new Error(`MCP notification failed: HTTP ${res.status}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP request failed: HTTP ${res.status} ${text}`);
    }

    const contentType = res.headers.get('content-type') || '';
    const sessionId = res.headers.get('mcp-session-id') || null;

    let result;
    if (contentType.includes('text/event-stream')) {
      result = await parseSSEResponse(res);
    } else {
      result = await res.json();
    }

    // Unwrap JSON-RPC response
    if (result.error) {
      throw new Error(`MCP error: ${result.error.message || JSON.stringify(result.error)}`);
    }

    const parsed = result.result || result;
    if (sessionId) parsed._sessionId = sessionId;
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`MCP request timed out (${MCP_REQUEST_TIMEOUT}ms): ${url}`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse a Server-Sent Events response to extract the JSON-RPC result.
 * Some MCP servers return SSE instead of plain JSON.
 */
async function parseSSEResponse(res) {
  const text = await res.text();
  const lines = text.split('\n');
  let lastData = null;

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      lastData = line.slice(6);
    }
  }

  if (!lastData) throw new Error('No data in SSE response');

  try {
    return JSON.parse(lastData);
  } catch {
    throw new Error(`Failed to parse SSE data: ${lastData.slice(0, 200)}`);
  }
}

/**
 * Connect to a single MCP server: initialize, send initialized notification, list tools.
 * @param {{ url: string, name?: string, headers?: object }} server
 * @returns {{ tools: Array, sessionId: string|null, serverUrl: string, serverName: string }}
 */
async function connectServer(server) {
  const { url, name, headers = {} } = server;
  const serverName = name || new URL(url).hostname;

  // Step 1: Initialize
  const initResult = await mcpPost(url, headers, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'BedrockGateway', version: '1.0.0' },
    },
  });

  const sessionId = initResult._sessionId || null;
  const sessionHeaders = { ...headers };
  if (sessionId) sessionHeaders['Mcp-Session-Id'] = sessionId;

  // Step 2: Send initialized notification
  await mcpPost(url, sessionHeaders, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  // Step 3: List tools (handle pagination)
  let allTools = [];
  let cursor = undefined;

  do {
    const params = cursor ? { cursor } : {};
    const listResult = await mcpPost(url, sessionHeaders, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
      params,
    });

    allTools = allTools.concat(listResult.tools || []);
    cursor = listResult.nextCursor || null;
  } while (cursor);

  console.log(`MCP server "${serverName}" (${url}): ${allTools.length} tools discovered`);

  return {
    tools: allTools,
    sessionId,
    serverUrl: url,
    serverName,
    headers: sessionHeaders,
  };
}

/**
 * Call a tool on a specific MCP server.
 * @param {{ url: string, headers: object }} connection
 * @param {string} toolName
 * @param {object} args
 * @returns {string} Text result
 */
async function callTool(connection, toolName, args) {
  const result = await mcpPost(connection.url, connection.headers, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  if (result.isError) {
    const errorText = extractTextContent(result.content);
    throw new Error(errorText || 'MCP tool returned an error');
  }

  return extractTextContent(result.content);
}

/**
 * Extract text from MCP content blocks.
 */
function extractTextContent(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

/**
 * Connect to multiple MCP servers concurrently and build a unified tool registry.
 * 
 * @param {Array<{ url: string, name?: string, headers?: object }>} servers
 * @param {Function|null} onProgress - Optional callback: (serverName, status, message) => void
 * @returns {{ 
 *   tools: Array<{ toolSpec: object }>,  // Bedrock-compatible tool specs
 *   executor: (toolName: string, input: object) => Promise<{ text: string }>
 * }}
 */
export async function initMcpServers(servers, onProgress = null) {
  if (!servers || servers.length === 0) {
    return { tools: [], executor: null };
  }

  // Notify per-server connection start
  if (onProgress) {
    for (const s of servers) {
      onProgress(s.name || new URL(s.url).hostname, 'running', `Connecting to ${s.name || new URL(s.url).hostname}...`);
    }
  }

  // Connect to all servers concurrently
  const results = await Promise.allSettled(
    servers.map(s => connectServer(s))
  );

  // toolName → { connection, mcpToolName }
  const toolRegistry = new Map();
  const bedrockTools = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const serverName = servers[i].name || new URL(servers[i].url).hostname;
    if (result.status === 'rejected') {
      console.error(`MCP server "${serverName}" failed to connect: ${result.reason.message}`);
      if (onProgress) onProgress(serverName, 'error', `Failed to connect to ${serverName}`);
      continue;
    }
    if (onProgress) onProgress(serverName, 'complete', `Connected to ${serverName} — ${result.value.tools.length} tools`);

    const conn = result.value;
    for (const tool of conn.tools) {
      // Prefix tool names with server name to avoid collisions across servers
      const qualifiedName = `mcp_${conn.serverName.replace(/[^a-zA-Z0-9_]/g, '_')}__${tool.name}`;

      // Build Bedrock-compatible toolSpec
      const desc = tool.description || tool.name;
      bedrockTools.push({
        toolSpec: {
          name: qualifiedName,
          description: `[${conn.serverName}] ${desc.length > 200 ? desc.slice(0, 200) + '...' : desc}`,
          inputSchema: {
            json: tool.inputSchema || { type: 'object', properties: {}, required: [] },
          },
        },
      });

      toolRegistry.set(qualifiedName, {
        connection: { url: conn.serverUrl, headers: conn.headers },
        mcpToolName: tool.name,
      });
    }
  }

  console.log(`MCP total: ${bedrockTools.length} tools from ${results.filter(r => r.status === 'fulfilled').length}/${servers.length} servers`);

  // Build executor function
  const executor = async (toolName, input) => {
    const entry = toolRegistry.get(toolName);
    if (!entry) {
      return { text: `Unknown MCP tool: ${toolName}` };
    }

    try {
      let text = await callTool(entry.connection, entry.mcpToolName, input);
      // Truncate large results to avoid blowing up the context window
      if (text && text.length > MAX_TOOL_RESULT_CHARS) {
        text = text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[Result truncated — showing first 10,000 characters]';
      }
      return { text: text || 'Tool returned no content.' };
    } catch (err) {
      console.error(`MCP tool "${toolName}" error: ${err.message}`);
      return { text: `MCP tool error: ${err.message}` };
    }
  };

  return { tools: bedrockTools, executor };
}
