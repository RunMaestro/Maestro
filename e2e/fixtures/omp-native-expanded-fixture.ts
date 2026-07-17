import { createHash, createPrivateKey, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	buildPluginArtifact,
	type ImmutableTrustRoot,
} from '../../src/main/omp-distribution/plugin-artifact';
import { bundleOmpPlugin } from '../../src/main/omp-distribution/bundle-plugin';
import { buildSigningPayload } from '../../src/shared/plugins/signing';

const PRIVATE = createPrivateKey({
	key: Buffer.from('MC4CAQAwBQYDK2VwBCIEIATZdg3OinGZQrI/FN1Juqj8tMJ6tlO7wTo66mAwm559', 'base64'),
	format: 'der',
	type: 'pkcs8',
});
const PUBLIC = 'MCowBQYDK2VwAyEApeeetOdf9i8GFMKRV+II3au9y25X4c9BqobTCGJDle8=';
export const NATIVE_OMP_TRUST_ROOT: ImmutableTrustRoot = Object.freeze({
	keyId: 'maestro-omp-e2e-root-2026-07',
	algorithm: 'ed25519',
	publicKey: PUBLIC,
});

/**
 * A standalone deterministic JSONL runtime whose frames are restricted to the
 * OMP 16.4.8 surface. Prompt directives deliberately cover every callback,
 * extension-ui and lifecycle category without a terminal or a webview.
 */
const RUNTIME = `import fs from 'node:fs';
import readline from 'node:readline';
let sequence = 0;
let turn = 0;
let sessionId = 'native-expanded-1';
let sessionName = 'Native expanded session';
let model = { provider: 'fixture', id: 'expanded-16.4.8', label: 'Expanded 16.4.8' };
let thinkingLevel = 'high';
let streaming = false;
let pendingApproval = null;
const frameLog = process.env.OMP_NATIVE_FIXTURE_LOG;
const emit = (frame) => {
  const json = JSON.stringify(frame);
  process.stdout.write(json + '\\n');
  if (frameLog) fs.appendFileSync(frameLog, json + '\\n');
};
const event = (type, extra = {}) => emit({ type, sequence: ++sequence, ...extra });
const response = (request, data = {}) => emit({ type: 'response', id: request.id, command: request.type, success: true, data });
const state = () => ({
  model, thinkingLevel, isStreaming: streaming, isCompacting: false,
  steeringMode: 'all', followUpMode: 'all', interruptMode: 'immediate',
  sessionFile: '/fixture/' + sessionId + '.jsonl', sessionId, sessionName,
  autoCompactionEnabled: true, messageCount: turn, queuedMessageCount: 0,
  todoPhases: [{ name: 'Native fixture', status: 'in_progress', items: [{ content: 'Render ordinary session', state: 'in_progress' }] }],
  systemPrompt: 'Native OMP 16.4.8 fixture', dumpTools: false,
  contextUsage: { inputTokens: 21, outputTokens: 34, contextWindow: 200000 }
});
const finish = (cancelled = false) => {
  event('tool_execution_end', { toolCallId: 'tool-' + turn, toolName: 'maestro.session.status', result: cancelled ? 'cancelled' : 'complete', isError: cancelled });
  event('message_end', { role: 'assistant', content: cancelled ? 'native turn cancelled' : 'native expanded complete' });
  event('turn_end', { sessionId, cancelled });
  event('agent_end', { sessionId });
  streaming = false;
  pendingApproval = null;
};
const approval = (method, id, message) => {
  pendingApproval = id;
  emit({ type: 'extension_ui_request', id, method, title: 'Native OMP approval', message,
    options: method === 'select' ? ['safe', 'cancel'] : undefined,
    placeholder: method === 'editor' ? 'Write the native editor response' : 'Write the native response', prefill: 'fixture value' });
};
const prompt = (request) => {
  const text = String(request.message ?? '');
  turn += 1;
  streaming = true;
  if (text.includes('local-only')) {
    response(request, { accepted: true, agentInvoked: false });
    emit({ type: 'prompt_result', text: 'native local-only output', agentInvoked: false });
    streaming = false;
    return;
  }
  response(request, { accepted: true });
  event('agent_start', { sessionId });
  event('turn_start', { sessionId });
  event('message_start', { role: 'assistant' });
  event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'native text: ' + text } });
  event('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'native reasoning: deterministic' } });
  event('tool_execution_start', { toolCallId: 'tool-' + turn, toolName: 'maestro.session.status', args: {} });
  event('tool_execution_update', { toolCallId: 'tool-' + turn, toolName: 'maestro.session.status', partialResult: 'checking' });
  emit({ type: 'host_tool_call', id: 'tool-' + turn, toolCallId: 'tool-' + turn, toolName: 'maestro.session.status', arguments: {} });
  emit({ type: 'host_uri_request', id: 'uri-' + turn, operation: 'read', url: 'maestro://session/status' });
  emit({ type: 'host_tool_cancel', targetId: 'missing-tool-' + turn });
  emit({ type: 'host_uri_cancel', targetId: 'missing-uri-' + turn });
  emit({ type: 'extension_ui_request', id: 'status-' + turn, method: 'setStatus', text: 'Native OMP active' });
  emit({ type: 'extension_ui_request', id: 'title-' + turn, method: 'setTitle', title: 'Native OMP fixture canvas' });
  emit({ type: 'extension_ui_request', id: 'editor-' + turn, method: 'set_editor_text', text: 'native composer text' });
  emit({ type: 'extension_ui_request', id: 'notice-' + turn, method: 'notify', message: 'Native OMP fixture ready', notificationType: 'info' });
  if (text.includes('select-approval')) return approval('select', 'select-' + turn, 'Select native action');
  if (text.includes('input-approval')) return approval('input', 'input-' + turn, 'Input native action');
  if (text.includes('editor-approval')) return approval('editor', 'editor-approval-' + turn, 'Edit native action');
  if (text.includes('crash-reconnect')) {
    emit({ type: 'extension_error', code: 'fixture_crash', message: 'Requested fixture crash' });
    emit({ type: 'ready', version: '16.4.8', reconnected: true });
    return finish(false);
  }
  if (text.includes('no-approval')) return finish(false);
  approval('confirm', 'confirm-' + turn, 'Approve native fixture tool?');
};
emit({ type: 'ready', version: '16.4.8', fixture: true });
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try { request = JSON.parse(line); } catch { emit({ type: 'extension_error', code: 'invalid_json' }); continue; }
  if (frameLog) fs.appendFileSync(frameLog, JSON.stringify({ direction: 'in', ...request }) + '\\n');
  if (!request || typeof request.type !== 'string') continue;
  if (request.type === 'host_tool_update') continue;
  if (request.type === 'host_tool_result' || request.type === 'host_uri_result') continue;
  if (request.type === 'extension_ui_response') {
    if (!pendingApproval || request.id !== pendingApproval || request.cancelled || request.confirmed === false) finish(true);
    else finish(false);
    continue;
  }
  if (typeof request.id !== 'string') continue;
  switch (request.type) {
    case 'prompt': case 'steer': case 'follow_up': case 'abort_and_prompt': prompt(request); break;
    case 'abort': response(request, { aborted: true }); if (streaming) finish(true); break;
    case 'bash': response(request, { started: true }); event('command_output', { text: 'native bash output' }); break;
    case 'abort_bash': response(request, { aborted: true }); break;
    case 'new_session': sessionId = 'native-expanded-' + (turn + 1); sessionName = 'Native expanded session ' + (turn + 1); response(request, state()); emit({ type: 'session_info_update', sessionId, sessionName }); break;
    case 'switch_session': sessionId = String(request.sessionPath).replace(/^.*\\//, '').replace(/\\.jsonl$/, '') || sessionId; response(request, state()); emit({ type: 'session_info_update', sessionId, sessionName }); break;
    case 'set_session_name': sessionName = String(request.name); response(request, state()); emit({ type: 'session_info_update', sessionId, sessionName }); break;
    case 'branch': response(request, { sessionId: sessionId + '-branch' }); event('session_info_update', { sessionId, sessionName }); break;
    case 'compact': response(request, { compacted: true }); event('auto_compaction_start', {}); event('auto_compaction_end', {}); break;
    case 'export_html': response(request, { path: '/fixture/native.html' }); break;
    case 'handoff': response(request, { handedOff: true }); break;
    case 'set_model': model = { provider: String(request.provider), id: String(request.modelId), label: String(request.modelId) }; response(request, state()); emit({ type: 'config_update', model }); break;
    case 'cycle_model': model = { provider: 'fixture', id: 'expanded-fast', label: 'Expanded Fast' }; response(request, state()); emit({ type: 'config_update', model }); break;
    case 'set_thinking_level': thinkingLevel = String(request.level); response(request, state()); event('thinking_level_changed', { level: thinkingLevel }); break;
    case 'cycle_thinking_level': thinkingLevel = 'max'; response(request, state()); event('thinking_level_changed', { level: thinkingLevel }); break;
    case 'set_steering_mode': case 'set_follow_up_mode': case 'set_interrupt_mode': case 'set_auto_compaction': case 'set_auto_retry': case 'abort_retry': response(request, state()); break;
    case 'set_todos': response(request, state()); event('todo_reminder', { text: 'Native fixture todo reminder' }); break;
    case 'set_host_tools': case 'set_host_uri_schemes': case 'set_subagent_subscription': response(request, { accepted: true }); break;
    case 'get_state': response(request, state()); break;
    case 'get_available_commands': response(request, { commands: [{ name: 'fixture', description: 'Native fixture slash command', source: 'builtin', input: true, subcommands: [] }] }); emit({ type: 'available_commands_update', commands: [{ name: 'fixture', description: 'Native fixture slash command' }] }); break;
    case 'get_available_models': response(request, { models: [model, { provider: 'fixture', id: 'expanded-fast', label: 'Expanded Fast' }] }); break;
    case 'get_messages': response(request, { messages: [{ id: 'native-message', role: 'assistant', text: 'native expanded transcript' }] }); break;
    case 'get_subagents': response(request, { subagents: [{ id: 'native-subagent', label: 'Native helper', status: 'running' }] }); emit({ type: 'subagent_lifecycle', subagentId: 'native-subagent', status: 'running' }); emit({ type: 'subagent_progress', subagentId: 'native-subagent', text: 'working' }); break;
    case 'get_subagent_messages': response(request, { messages: [{ id: 'native-subagent-message', text: 'Native helper detail' }] }); break;
    case 'get_session_stats': response(request, { stats: { inputTokens: 21, outputTokens: 34, reasoningTokens: 13, totalTokens: 55, contextWindow: 200000 } }); break;
    case 'get_branch_messages': response(request, { messages: [{ id: 'native-branch-message', text: 'Native branch detail' }] }); break;
    case 'get_last_assistant_text': response(request, { text: 'native expanded complete' }); break;
    case 'get_login_providers': response(request, { providers: [{ id: 'fixture-login', name: 'Fixture Login', available: true, authenticated: false }] }); break;
    case 'login': response(request, { providerId: String(request.providerId ?? 'fixture-login') }); break;
    case 'crash': response(request, { accepted: true }); emit({ type: 'extension_error', code: 'fixture_crash', message: 'Requested fixture crash' }); process.exit(86); break;
    case 'reconnect': response(request, { accepted: true }); emit({ type: 'ready', version: '16.4.8', reconnected: true }); break;
    default: response(request, state());
  }
}
`;

export interface ExpandedFixture {
	artifactPath: string;
	runtimePath: string;
	sha256: string;
	trustRoot: ImmutableTrustRoot;
}

export async function createExpandedNativeFixture(root: string): Promise<ExpandedFixture> {
	const dir = path.join(root, 'native-expanded');
	fs.mkdirSync(dir, { recursive: true });
	const runtimePath = path.join(dir, 'runtime.mjs');
	fs.writeFileSync(runtimePath, RUNTIME);
	const bundle = await bundleOmpPlugin(path.resolve(__dirname, '../../plugins/com.maestro.omp'));
	const files = bundle.files;
	const digests = Object.fromEntries(
		files.map((file) => [file.path, createHash('sha256').update(file.content).digest('hex')])
	);
	const signature = JSON.stringify({
		algorithm: 'ed25519',
		publicKey: PUBLIC,
		signature: sign(null, Buffer.from(buildSigningPayload(digests)), PRIVATE).toString('base64'),
		files: digests,
	});
	const artifact = buildPluginArtifact({
		pluginId: 'com.maestro.omp',
		version: '1.0.0',
		contractSha256: bundle.contractSha256,
		trustRoot: NATIVE_OMP_TRUST_ROOT,
		files: [...files, { path: 'signature.json', content: Buffer.from(signature) }],
		sign: (payload) => sign(null, payload, PRIVATE).toString('base64url'),
	});
	const artifactPath = path.join(dir, 'com.maestro.omp.omp');
	fs.writeFileSync(artifactPath, artifact);
	return {
		artifactPath,
		runtimePath,
		sha256: createHash('sha256').update(artifact).digest('hex'),
		trustRoot: NATIVE_OMP_TRUST_ROOT,
	};
}
