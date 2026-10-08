/** Pair host source with Backstage source entirely in memory. No live network. */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2])
	throw new Error('Usage: node scripts/verify-relay-reply-path.mjs <Backstage checkout>');
const backstageRoot = path.resolve(process.argv[2]);
const outboundPath = path.join(backstageRoot, 'plugins/relay/src/outbound.ts');
const queuePath = path.join(backstageRoot, 'plugins/relay/src/message-queue.ts');
const bundled = await build({
	stdin: {
		resolveDir: hostRoot,
		contents: `
import assert from 'node:assert/strict';
import { createOutbound } from ${JSON.stringify(outboundPath)};
import { createMessageQueue } from ${JSON.stringify(queuePath)};
import { handlePluginsCallTool, handlePluginsListTools } from './src/main/web-server/handlers/messageHandlers/plugins.ts';
import { setActivePluginManager } from './src/main/plugins/plugin-manager-singleton.ts';
import { pluginToolRunIdentity } from './src/main/plugins/plugin-tool-run-identity.ts';
import { createMcpBridge } from './src/cli/services/mcp-bridge.ts';
import { evaluatePluginDispatch } from './src/shared/plugins/plugin-dispatch-gate.ts';

export async function verify() {
 const owner = 'fixture-agent';
 const binding = { guildId: '10', channelId: '20', agentId: owner };
 const thread = { guildId: '10', parentChannelId: '20', threadId: '30', agentId: owner, sessionId: null, ownerUserId: '40' };
 const posts = [];
 let trusted = true;
 const send = createOutbound({
  channels: { get: async (_guild, id) => id === binding.channelId ? binding : null, listByAgentId: async id => id === owner ? [binding] : [] },
  threads: { getThread: async id => id === thread.threadId ? thread : null },
  policy: { allows: async () => false },
  storage: { get: async () => 'fixture-only-credential' },
  guildId: () => '10', active: () => true,
  net: { fetch: async (url, init) => {
   // This callback is the only network implementation. It never uses fetch.
   assert.equal(new URL(url).origin, 'https://discord.com');
   const id = new URL(url).pathname.split('/')[4];
   if (init.method === 'GET') return { status: 200, body: JSON.stringify(id === '30'
    ? { id, guild_id: '10', parent_id: '20', type: 11 } : { id, guild_id: '10', type: 0 }) };
   assert.equal(init.method, 'POST');
   assert.equal(id, '30');
   posts.push(JSON.parse(init.body));
   return { status: 200, body: JSON.stringify({ id: '100', channel_id: id }) };
  } },
 });
 const tool = { id: 'sh.maestro.relay/send', pluginId: 'sh.maestro.relay', localId: 'send', name: 'Send reply', description: 'Send a message' };
 setActivePluginManager({
  getContributions: () => ({ tools: [tool] }),
  getActiveRecords: () => [{ id: 'sh.maestro.relay', signature: { status: trusted ? 'trusted' : 'untrusted' } }],
  invokeTool: async (id, args, context) => { assert.equal(id, tool.id); return send(args, context); },
 }, () => true);
 const call = async (args, runToken) => {
  const bridge = createMcpBridge({ serverInfo: { name: 'fixture', version: '1' }, runToken, log: () => {},
   request: async message => {
    let response;
    const ctx = { send: (_client, result) => { response = result; } };
    if (message.type === 'plugins_list_tools') handlePluginsListTools(ctx, {}, message);
    else await handlePluginsCallTool(ctx, {}, message);
    return response;
   },
  });
  const [listed] = await bridge.listTools();
  return bridge.callTool(listed.name, args);
 };
 const text = 'Ein Release kann alle Plugins enthalten. Deployment und secrets sind Diskussionsthemen.';
 assert.equal(evaluatePluginDispatch(text).eligible, false);
 const ownerProof = pluginToolRunIdentity.issue(owner);
 const foreignProof = pluginToolRunIdentity.issue('foreign-agent');
 try {
  const result = await call({ text, threadId: '30' }, ownerProof);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { messageIds: ['100'] });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].content, text);
  assert.deepEqual(posts[0].allowed_mentions, { parse: [], replied_user: false });
  for (const [args, proof, expected] of [
   [{ text, threadId: '30', callerAgentId: owner }, undefined, 'Verified caller required'],
   [{ text, threadId: '30', callerAgentId: owner }, foreignProof, 'Thread is not bound to caller'],
   [{ text, threadId: '31' }, ownerProof, 'Thread is not bound to caller'],
   [{ text, channelId: '21' }, ownerProof, 'Channel is not permitted for caller'],
  ]) {
   const denied = await call(args, proof);
   assert.equal(denied.isError, true);
   assert.ok(denied.content[0].text.includes(expected));
  }
  binding.agentId = 'foreign-agent';
  assert.equal((await call({ text, threadId: '30' }, ownerProof)).isError, true);
  binding.agentId = owner;
  thread.guildId = '11';
  assert.equal((await call({ text, threadId: '30' }, ownerProof)).isError, true);
  thread.guildId = '10';
  trusted = false;
  assert.equal((await call({ text, threadId: '30' }, ownerProof)).isError, true);
  trusted = true;
  pluginToolRunIdentity.revoke(ownerProof);
  assert.equal((await call({ text, threadId: '30' }, ownerProof)).isError, true);
  assert.equal(posts.length, 1, 'denied replies must not reach the fake send sink');
  // Pair the retained host error with the actual Relay message queue mapping.
  let failure;
  const queue = createMessageQueue({
   agents: { send: async () => { throw new Error(evaluatePluginDispatch('Release').reason); } },
   threads: { getThread: async () => thread, saveSession: async () => {} },
   sendDiscord: async () => { throw new Error('unexpected reply'); },
   onFailure: async (_thread, code) => { failure = code; },
  });
  await assert.rejects(queue.enqueue('30', 'Release'), /Agent send failed/);
  await queue.stop();
  assert.equal(failure, 'risk-blocked');
  return { releaseReply: 'passed unchanged', deniedTargetsAndProofs: 'passed', legacyRelayErrorContract: 'risk-blocked', fakePosts: posts.length, liveNetworkCalls: 0 };
 } finally {
  pluginToolRunIdentity.revoke(ownerProof);
  pluginToolRunIdentity.revoke(foreignProof);
  setActivePluginManager(null);
 }
}
`,
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	packages: 'external',
	write: false,
	logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
	createRequire(import.meta.url),
	module,
	module.exports
);
console.log(JSON.stringify(await module.exports.verify()));
