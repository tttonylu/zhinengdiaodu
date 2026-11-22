import { sanitizePayload } from './protocol.mjs';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

export const TOOL_DEFINITIONS = [
  {
    name: 'health',
    description:
      '只读健康检查：报告本地桥是否在回环地址监听、已连接的沙盒扩展数量，以及是否处于只读模式。不读取任何页面内容。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY
  },
  {
    name: 'list_sessions',
    description:
      '只读列出已连接的 DM Pulse Sandbox 扩展会话（扩展版本、协议版本、心跳时间、是否过期）。不含令牌、IP、账号或页面数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY
  },
  {
    name: 'run_pulse',
    description:
      '在已连接的测试浏览器中运行一次有界只读会话栏脉冲。只计数会话行与未读行，不点击、不打开会话、不发送消息。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '可选；多个扩展连接时指定会话。' },
        budgetMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 15000 },
        intervalMs: { type: 'integer', minimum: 200, maximum: 5000, default: 500 }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: 'run_deep_pulse',
    description:
      '有界深扫：在只读脉冲基础上按固定步长滚动会话列表，统计虚拟列表中出现过的唯一会话与未读行，结束后恢复原滚动位置。仍不点击、不打开会话、不发送消息。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '可选；多个扩展连接时指定会话。' },
        budgetMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 15000 },
        intervalMs: { type: 'integer', minimum: 200, maximum: 5000, default: 500 },
        maxScrolls: { type: 'integer', minimum: 0, maximum: 12, default: 3 },
        scrollStepPx: { type: 'integer', minimum: 120, maximum: 2400, default: 600 },
        settleMs: { type: 'integer', minimum: 250, maximum: 3000, default: 700 }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: 'read_unread_conversation',
    description:
      '打开会话栏中首条带未读标记的会话并读取气泡统计。该操作会把会话标记为已读，但不发送消息、不填写输入框。必须显式传 allowOpen=true。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '可选；多个扩展连接时指定会话。' },
        allowOpen: {
          type: 'boolean',
          enum: [true],
          description: '必须显式为 true；确认允许打开会话并承担已读副作用。'
        },
        maxWaitMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 10000 }
      },
      required: ['allowOpen'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'get_coexistence_state',
    description:
      '只读取当前页面的共存状态：URL 路径、界面类型、会话列表是否就绪、沙盒是否注入、生产副本的主世界桥与隔离世界桥是否可达。不读取消息正文、账号或配置值。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '可选；多个扩展连接时指定会话。' }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY
  }
];

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function createToolHandlers({ bridge, registry, serverVersion }) {
  return {
    async health() {
      const sessions = registry.list();
      return sanitizePayload({
        status: sessions.length > 0 ? 'ok' : 'degraded',
        serverVersion,
        readOnly: true,
        mcpEnabled: true,
        bridge: {
          host: bridge.host,
          port: bridge.port,
          transport: 'websocket',
          loopbackOnly: true
        },
        sessions: sessions.length,
        sessionsStale: sessions.filter((row) => row.stale).length,
        ts: Date.now()
      });
    },

    async list_sessions() {
      return sanitizePayload({
        readOnly: true,
        sessions: registry.list()
      });
    },

    async run_pulse(params = {}) {
      const budgetMs = clampInteger(params.budgetMs, 15000, 1000, 30000);
      const intervalMs = clampInteger(params.intervalMs, 500, 200, 5000);
      const result = await bridge.request(
        'run_pulse',
        { budgetMs, intervalMs, deep: false },
        { sessionId: params.sessionId, timeoutMs: budgetMs + 5000 }
      );
      return sanitizePayload(result);
    },

    async run_deep_pulse(params = {}) {
      const budgetMs = clampInteger(params.budgetMs, 15000, 1000, 30000);
      const intervalMs = clampInteger(params.intervalMs, 500, 200, 5000);
      const maxScrolls = clampInteger(params.maxScrolls, 3, 0, 12);
      const scrollStepPx = clampInteger(params.scrollStepPx, 600, 120, 2400);
      const settleMs = clampInteger(params.settleMs, 700, 250, 3000);
      const result = await bridge.request(
        'run_pulse',
        { budgetMs, intervalMs, deep: true, maxScrolls, scrollStepPx, settleMs },
        { sessionId: params.sessionId, timeoutMs: budgetMs + 8000 }
      );
      return sanitizePayload(result);
    },

    async read_unread_conversation(params = {}) {
      if (params.allowOpen !== true) {
        const error = new Error('read_unread_conversation requires allowOpen=true');
        error.code = 'OPEN_NOT_ALLOWED';
        throw error;
      }
      const maxWaitMs = clampInteger(params.maxWaitMs, 10000, 1000, 30000);
      const result = await bridge.request(
        'read_unread_conversation',
        { allowOpen: true, maxWaitMs },
        { sessionId: params.sessionId, timeoutMs: maxWaitMs + 8000 }
      );
      return sanitizePayload(result);
    },

    async get_coexistence_state(params = {}) {
      const result = await bridge.request(
        'get_coexistence_state',
        {},
        { sessionId: params.sessionId, timeoutMs: 8000 }
      );
      return sanitizePayload(result);
    }
  };
}
