#!/usr/bin/env node
// stdio bridge for MCP clients that launch a local command (such as Claude Desktop).
// Reads JSON-RPC messages from stdin, forwards them to a running Dispatch
// server's /mcp endpoint, and writes the replies to stdout.
//
//   DISPATCH_URL=http://localhost:8080 DISPATCH_API_KEY=dsp_... node bin/dispatch-mcp.js
import readline from 'node:readline';

const base = (process.env.DISPATCH_URL || 'http://localhost:8080').replace(/\/$/, '');
const key = process.env.DISPATCH_API_KEY;

if (!key) {
  console.error('Set DISPATCH_API_KEY to an API key from Dispatch → Settings → API keys.');
  process.exit(1);
}

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  try {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` },
      body: JSON.stringify(msg),
    });
    if (res.status === 202) return;
    const text = await res.text();
    if (!res.ok) throw new Error(`Dispatch returned ${res.status}: ${text}`);
    write(JSON.parse(text));
  } catch (err) {
    console.error(err.message);
    if (msg.id !== undefined && msg.id !== null) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Could not reach Dispatch at ${base}: ${err.message}` } });
    }
  }
});
