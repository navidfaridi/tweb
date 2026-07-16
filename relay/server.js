'use strict';

const http = require('http');
const {WebSocket, WebSocketServer} = require('ws');
const {constructUpstreamUrl, parseRelayPath} = require('./routes');

const PORT = parsePositiveInteger(process.env.PORT, 3001);
const MAX_CONNECTIONS_PER_IP = parsePositiveInteger(process.env.MAX_CONNECTIONS_PER_IP, 24);
const MAX_PAYLOAD_BYTES = parsePositiveInteger(process.env.MAX_PAYLOAD_BYTES, 16 * 1024 * 1024);
const MAX_BUFFERED_BYTES = parsePositiveInteger(process.env.MAX_BUFFERED_BYTES, 16 * 1024 * 1024);
const HEARTBEAT_INTERVAL_MS = parsePositiveInteger(process.env.HEARTBEAT_INTERVAL_MS, 25_000);
const UPSTREAM_CONNECT_TIMEOUT_MS = parsePositiveInteger(process.env.UPSTREAM_CONNECT_TIMEOUT_MS, 7_000);
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://tweb.itext.ir')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
);

const connectionsByIp = new Map();
const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
  handleProtocols(protocols) {
    return protocols.has('binary') ? 'binary' : false;
  }
});

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(request) {
  return request.headers['cf-connecting-ip'] ||
    request.headers['x-forwarded-for']?.split(',')[0].trim() ||
    request.socket.remoteAddress ||
    'unknown';
}

function releaseConnection(ip) {
  const count = connectionsByIp.get(ip) || 1;
  if(count <= 1) {
    connectionsByIp.delete(ip);
  } else {
    connectionsByIp.set(ip, count - 1);
  }
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(statusText)}\r\n` +
    '\r\n' +
    statusText
  );
}

function closeSocket(socket, code = 1011, reason = 'Relay connection closed') {
  if(socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  } else if(socket.readyState === WebSocket.OPEN) {
    socket.close(code, reason);
  }
}

function bridge(client, upstream, ip) {
  let closed = false;
  client.isAlive = true;
  upstream.isAlive = true;

  const cleanup = () => {
    if(closed) {
      return;
    }

    closed = true;
    releaseConnection(ip);
  };

  client.on('pong', () => {
    client.isAlive = true;
  });
  upstream.on('pong', () => {
    upstream.isAlive = true;
  });

  client.on('message', (data, isBinary) => {
    if(upstream.readyState === WebSocket.OPEN) {
      if(upstream.bufferedAmount + data.length > MAX_BUFFERED_BYTES) {
        client.terminate();
        upstream.terminate();
        cleanup();
        return;
      }

      upstream.send(data, {binary: isBinary});
    }
  });
  upstream.on('message', (data, isBinary) => {
    if(client.readyState === WebSocket.OPEN) {
      if(client.bufferedAmount + data.length > MAX_BUFFERED_BYTES) {
        client.terminate();
        upstream.terminate();
        cleanup();
        return;
      }

      client.send(data, {binary: isBinary});
    }
  });

  client.on('close', (code, reason) => {
    cleanup();
    closeSocket(upstream, code === 1000 ? 1000 : 1011, reason.toString().slice(0, 120));
  });
  upstream.on('close', (code, reason) => {
    cleanup();
    closeSocket(client, code === 1000 ? 1000 : 1011, reason.toString().slice(0, 120));
  });

  client.on('error', () => {
    cleanup();
    closeSocket(upstream);
  });
  upstream.on('error', () => {
    cleanup();
    closeSocket(client);
  });

  const heartbeat = setInterval(() => {
    if(closed) {
      clearInterval(heartbeat);
      return;
    }

    if(!client.isAlive || !upstream.isAlive) {
      client.terminate();
      upstream.terminate();
      cleanup();
      clearInterval(heartbeat);
      return;
    }

    client.isAlive = false;
    upstream.isAlive = false;
    client.ping();
    upstream.ping();
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref();
}

const server = http.createServer((request, response) => {
  if(request.url === '/healthz') {
    response.writeHead(200, {'content-type': 'text/plain'});
    response.end('ok');
    return;
  }

  response.writeHead(404, {'content-type': 'text/plain'});
  response.end('not found');
});

server.on('upgrade', (request, socket, head) => {
  const route = parseRelayPath(request.url);
  if(!route) {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  const origin = request.headers.origin;
  if(!origin || !ALLOWED_ORIGINS.has(origin)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }

  const protocols = request.headers['sec-websocket-protocol'] || '';
  if(!protocols.split(',').map((protocol) => protocol.trim()).includes('binary')) {
    rejectUpgrade(socket, 400, 'WebSocket subprotocol binary is required');
    return;
  }

  const ip = getClientIp(request);
  const connectionCount = connectionsByIp.get(ip) || 0;
  if(connectionCount >= MAX_CONNECTIONS_PER_IP) {
    rejectUpgrade(socket, 429, 'Too Many Connections');
    return;
  }

  connectionsByIp.set(ip, connectionCount + 1);

  const upstream = new WebSocket(constructUpstreamUrl(route), 'binary', {
    handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    origin: 'https://web.telegram.org'
  });

  let upgraded = false;
  let reservationReleased = false;
  const releaseReservation = () => {
    if(!reservationReleased) {
      reservationReleased = true;
      releaseConnection(ip);
    }
  };
  const abortUpstream = () => {
    if(!upgraded) {
      releaseReservation();
      rejectUpgrade(socket, 502, 'Bad Gateway');
      upstream.terminate();
    }
  };

  upstream.once('error', abortUpstream);
  upstream.once('open', () => {
    upstream.removeListener('error', abortUpstream);
    if(socket.destroyed) {
      releaseReservation();
      upstream.terminate();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      upgraded = true;
      reservationReleased = true;
      webSocketServer.emit('connection', client, request);
      bridge(client, upstream, ip);
    });
  });
});

function shutdown() {
  server.close(() => process.exit(0));
  for(const client of webSocketServer.clients) {
    closeSocket(client, 1001, 'Server shutting down');
  }
  setTimeout(() => process.exit(1), 10_000).unref();
}

if(require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MTProto relay listening on port ${PORT}`);
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
