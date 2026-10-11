import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** The existing Space ingress remains the only network caller of this private bridge. */
export function privateIngress({ upstreamPort, allowedClients, upstreamHost = '127.0.0.1' }) {
  const allowed = new Set(allowedClients);
  return http.createServer((request, response) => {
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (!allowed.has(peer)) { response.writeHead(403); response.end(); return; }
    if (!request.url?.startsWith('/api/') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) {
      response.writeHead(404); response.end(); return;
    }
    const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}`, connection: 'close' };
    delete headers.upgrade;
    const upstream = http.request({ hostname: upstreamHost, port: upstreamPort, path: request.url, method: request.method, headers }, reply => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
      reply.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    upstream.setTimeout(86_400_000, () => upstream.destroy());
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  privateIngress({ upstreamPort: 13004, allowedClients: ['192.168.1.14'] }).listen(13005, '192.168.1.41');
}
