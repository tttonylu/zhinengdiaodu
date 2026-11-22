import { randomUUID } from 'node:crypto';

export class SessionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SessionError';
    this.code = code;
  }
}

export class SessionRegistry {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.staleAfterMs = options.staleAfterMs == null ? 45000 : options.staleAfterMs;
    this.sessions = new Map();
  }

  get size() {
    return this.sessions.size;
  }

  add(socket, meta = {}) {
    const at = this.now();
    const session = {
      sessionId: randomUUID(),
      socket,
      extensionVersion: String(meta.extensionVersion || 'unknown'),
      schema: String(meta.schema || 'unknown'),
      connectedAt: at,
      lastSeenAt: at,
      pending: new Map()
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  touch(sessionId, at) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.lastSeenAt = at == null ? this.now() : at;
    return true;
  }

  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    for (const reject of session.pending.values()) {
      try {
        reject(new SessionError('SESSION_CLOSED', 'extension session closed'));
      } catch {
        // a rejecting promise must never break cleanup
      }
    }
    session.pending.clear();
    return true;
  }

  list(options = {}) {
    const at = options.now == null ? this.now() : options.now;
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      extensionVersion: session.extensionVersion,
      schema: session.schema,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      pendingRequests: session.pending.size,
      stale: at - session.lastSeenAt > this.staleAfterMs
    }));
  }

  pick(sessionId) {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) throw new SessionError('SESSION_NOT_FOUND', 'unknown session');
      return session;
    }
    if (this.sessions.size === 0) {
      throw new SessionError('NO_SESSION', 'no extension connected');
    }
    if (this.sessions.size > 1) {
      throw new SessionError('MULTIPLE_SESSIONS', 'pass sessionId when several extensions are connected');
    }
    return this.sessions.values().next().value;
  }

  addPending(sessionId, requestId, reject) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionError('SESSION_NOT_FOUND', 'unknown session');
    session.pending.set(requestId, reject);
  }

  takePending(sessionId, requestId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const reject = session.pending.get(requestId) || null;
    session.pending.delete(requestId);
    return reject;
  }
}
