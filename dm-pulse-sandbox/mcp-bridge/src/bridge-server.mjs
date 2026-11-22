import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { SessionRegistry, SessionError } from './session-registry.mjs';
import { MAX_FRAME_BYTES, parseFrame, timingSafeEqualToken } from './protocol.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export class BridgeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export class BridgeServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.path = options.path || '/bridge';
    this.port = options.port == null ? 47321 : options.port;
    this.token = options.token;
    this.helloTimeoutMs = options.helloTimeoutMs == null ? 5000 : options.helloTimeoutMs;
    this.requestTimeoutMs = options.requestTimeoutMs == null ? 20000 : options.requestTimeoutMs;
    this.registry = options.registry || new SessionRegistry({
      staleAfterMs: options.heartbeatTimeoutMs
    });
    this.logger = options.logger || (() => {});
    this.wss = null;
    this.socketSessions = new Map();

    if (!this.token) throw new Error('bridge token is required');
  }

  get url() {
    const address = this.wss && this.wss.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    return 'ws://' + this.host + ':' + port + this.path;
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        host: this.host,
        port: this.port,
        path: this.path,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false
      });
      const onError = (error) => reject(error);
      this.wss.once('error', onError);
      this.wss.once('listening', () => {
        this.wss.off('error', onError);
        resolve();
      });
      this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
    });
    this.port = this.wss.address().port;
    return this;
  }

  handleConnection(socket, request) {
    const remote = String((request.socket && request.socket.remoteAddress) || '');
    if (!LOOPBACK.has(remote)) {
      socket.close(4003, 'loopback only');
      return;
    }

    let sessionId = null;
    const helloTimer = setTimeout(() => socket.close(4002, 'hello timeout'), this.helloTimeoutMs);

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = parseFrame(raw);
      } catch (error) {
        socket.close(4004, error.message);
        return;
      }

      if (!sessionId) {
        if (frame.type !== 'hello') {
          clearTimeout(helloTimer);
          socket.close(4002, 'hello required');
          return;
        }
        if (!timingSafeEqualToken(frame.token, this.token)) {
          clearTimeout(helloTimer);
          socket.close(4001, 'unauthorized');
          return;
        }
        clearTimeout(helloTimer);
        const client = frame.client && typeof frame.client === 'object' ? frame.client : {};
        const session = this.registry.add(socket, {
          extensionVersion: client.extensionVersion,
          schema: client.schema
        });
        sessionId = session.sessionId;
        this.socketSessions.set(socket, sessionId);
        this.send(socket, { type: 'hello_ok', sessionId, serverTime: Date.now() });
        this.logger('session-open', { sessionId });
        this.emit('session-open', { sessionId });
        return;
      }

      if (frame.type === 'heartbeat') {
        this.registry.touch(sessionId);
        return;
      }

      if (frame.type === 'response') {
        const reject = this.registry.takePending(sessionId, frame.id);
        if (!reject) return;
        if (frame.ok === true) {
          reject(null, frame.result);
        } else {
          const error = frame.error && typeof frame.error === 'object' ? frame.error : {};
          reject(new BridgeError(String(error.code || 'EXTENSION_ERROR'), String(error.message || 'extension error')));
        }
        return;
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (!sessionId) return;
      this.registry.remove(sessionId);
      this.socketSessions.delete(socket);
      this.logger('session-closed', { sessionId });
      this.emit('session-closed', { sessionId });
    });

    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
    });
  }

  send(socket, frame) {
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.logger('send-failed', { message: String(error && error.message) });
    }
  }

  async request(method, params, options = {}) {
    const session = this.registry.pick(options.sessionId);
    const timeoutMs = options.timeoutMs == null ? this.requestTimeoutMs : options.timeoutMs;
    const id = randomUUID();

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.registry.takePending(session.sessionId, id);
        reject(new BridgeError('BRIDGE_TIMEOUT', 'extension did not answer within ' + timeoutMs + 'ms'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.registry.addPending(session.sessionId, id, (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      });

      this.send(session.socket, {
        type: 'request',
        id,
        method,
        params: params || {}
      });
    });
  }

  async close() {
    if (!this.wss) return;
    for (const sessionId of Array.from(this.registry.sessions.keys())) {
      this.registry.remove(sessionId);
    }
    for (const client of this.wss.clients) {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => this.wss.close(() => resolve()));
    this.wss = null;
  }
}

export { SessionError };
