/**
 * Local development server: wraps the same handleMcpRequest() that Lambda will use
 * in a plain Node HTTP server on http://127.0.0.1:3000/mcp.
 */
import { createServer } from 'node:http';
import { handleMcpRequest } from '../src/mcp/http.js';

const HOST = '127.0.0.1'; // Spec: local servers SHOULD bind to localhost only.
const PORT = Number(process.env.PORT ?? 3000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found. The MCP endpoint is /mcp');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }

    const response = await handleMcpRequest(
      new Request(url, {
        method: req.method ?? 'GET',
        headers,
        body: hasBody ? Buffer.concat(chunks).toString('utf8') : undefined,
      }),
      { allowedOrigins },
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    console.error('Unhandled error in local MCP server', error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`FarmAssist MCP server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`Allowed browser origins: ${allowedOrigins.join(', ') || '(none)'}`);
});
