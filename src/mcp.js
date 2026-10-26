// Minimal MCP server (JSON-RPC 2.0). Served over Streamable HTTP at POST /mcp
// and over stdio by bin/dispatch-mcp.js, which forwards to that endpoint.
import { draftPost, rewritePost } from './ai.js';
import { config } from './config.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Dispatch is the user's social media scheduler.
Call list_channels first to get channel ids. create_post makes one post per channel.
Use mode "queue" to take each channel's next free posting slot (the usual choice), "schedule" with an ISO 8601 scheduled_at for an exact time, "draft" to save without scheduling, or "now" to publish immediately.
Only use "now" when the user clearly asks to post immediately. Times are stored in UTC; get_settings returns the user's time zone.`;

function tools(svc, scheduler) {
  const list = [
    {
      name: 'list_channels',
      description: 'List connected social accounts with their ids, network, character limit and posting schedule.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: () => svc.listChannels().map(({ meta, ...c }) => c),
    },
    {
      name: 'get_settings',
      description: "Get the user's time zone and whether AI drafting is available.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: () => svc.getSettings(),
    },
    {
      name: 'create_post',
      description: 'Create a post for one or more channels. Returns the created posts with their scheduled times.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The post text.' },
          channel_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Channel ids from list_channels.' },
          mode: { type: 'string', enum: ['queue', 'schedule', 'draft', 'now'], default: 'queue' },
          scheduled_at: { type: 'string', description: 'ISO 8601 time, required when mode is "schedule".' },
          image_url: { type: 'string', description: 'Optional public image URL (not supported on X or LinkedIn).' },
        },
        required: ['text', 'channel_ids'],
        additionalProperties: false,
      },
      run: async (a) => {
        const posts = svc.createPosts({ ...a, source: 'mcp' });
        if (a.mode === 'now') return Promise.all(posts.map((p) => scheduler.publishOne(p.id)));
        return posts;
      },
    },
    {
      name: 'list_posts',
      description: 'List posts. Filter by status (draft, scheduled, published, failed; comma-separated for several) and/or channel.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          channel_id: { type: 'string' },
          from: { type: 'string', description: 'ISO 8601 start time' },
          to: { type: 'string', description: 'ISO 8601 end time' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: (a) => svc.listPosts({ limit: 50, ...a }),
    },
    {
      name: 'update_post',
      description: 'Edit a post that has not been published: change text or image, reschedule it (scheduled_at), move it to the queue, or turn it into a draft.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          image_url: { type: 'string' },
          scheduled_at: { type: 'string' },
          mode: { type: 'string', enum: ['queue', 'schedule', 'draft'] },
        },
        required: ['id'],
        additionalProperties: false,
      },
      run: ({ id, ...rest }) => svc.updatePost(id, rest),
    },
    {
      name: 'publish_post_now',
      description: 'Publish an existing draft or scheduled post immediately.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: async ({ id }) => {
        svc.updatePost(id, { mode: 'now' });
        return scheduler.publishOne(id);
      },
    },
    {
      name: 'delete_post',
      description: 'Delete a post that has not been published yet (or remove a published one from Dispatch only).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      annotations: { destructiveHint: true },
      run: ({ id }) => svc.deletePost(id),
    },
    {
      name: 'set_posting_schedule',
      description: "Set a channel's queue slots: weekdays (1 = Monday … 7 = Sunday) and times (HH:MM, user's time zone).",
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 } },
          times: { type: 'array', items: { type: 'string', pattern: '^\\d{2}:\\d{2}$' } },
        },
        required: ['channel_id', 'days', 'times'],
        additionalProperties: false,
      },
      run: ({ channel_id, days, times }) => svc.updateChannel(channel_id, { schedule: { days, times } }),
    },
    {
      name: 'add_idea',
      description: 'Save a content idea for later.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['text'],
        additionalProperties: false,
      },
      run: (a) => svc.addIdea(a),
    },
    {
      name: 'list_ideas',
      description: 'List saved content ideas.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: () => svc.listIdeas(),
    },
  ];
  if (config.ai.enabled) {
    list.push({
      name: 'ai_draft_post',
      description: "Draft a post with Dispatch's built-in AI writer, fitted to a channel's character limit. Returns text only; nothing is scheduled.",
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the post should say.' },
          channel_id: { type: 'string', description: 'Optional: fit the draft to this channel.' },
          rewrite_text: { type: 'string', description: 'Optional: existing text to rewrite instead of drafting from scratch.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      run: async ({ prompt, channel_id, rewrite_text }) => {
        const ch = channel_id ? svc.getChannel(channel_id) : null;
        const opts = { network: ch?.label, limit: ch?.limit };
        const text = rewrite_text ? await rewritePost({ text: rewrite_text, instruction: prompt, ...opts }) : await draftPost({ prompt, ...opts });
        return { text };
      },
    });
  }
  return list;
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function createMcpHandler(svc, scheduler) {
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return fail(msg?.id ?? null, -32600, 'Invalid request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null;
    const { id, method, params = {} } = msg;
    try {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          return ok(id, {
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dispatch', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, {
            tools: tools(svc, scheduler).map(({ run, ...t }) => t),
          });
        case 'tools/call': {
          const tool = tools(svc, scheduler).find((t) => t.name === params.name);
          if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
          try {
            const result = await tool.run(params.arguments || {});
            return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result });
          } catch (err) {
            // Tool errors go back to the model as results so it can correct itself.
            return ok(id, { content: [{ type: 'text', text: err.message }], isError: true });
          }
        }
        default:
          return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return fail(id, -32603, err.message);
    }
  };
}
