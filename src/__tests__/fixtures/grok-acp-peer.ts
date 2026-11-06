/**
 * A synthetic Grok ACP peer (wire 1, schema 0.11.4 shapes) for transport consumer tests
 * It is not native qualification: it proves what the consumers do with the
 * traffic, never what a real Grok build sends.
 *
 * `writeSyntheticGrokAcpPeer(dir)` writes the peer and a `#!/bin/sh` wrapper that starts it
 * with this Node, and returns the wrapper's path, which a test uses as the Grok executable.
 * POSIX only (the wrapper is a shell script). The peer reads its environment:
 *
 * - `FAKE_MODE`: `ok` (default) answers each prompt; `permission` asks one
 *   `session/request_permission` (`perm-1`) and answers by the selected option; `hold` keeps
 *   the prompt open until `session/cancel`; `vanish` sends one chunk and exits 0
 *   with the prompt unanswered; `rpcerror` answers the prompt with the JSON-RPC
 *   error `FAKE_RPCERROR` (JSON `{ code, message }`); `noversion` reports no agent version; `question`
 *   sends a `plan` update (`FAKE_PLAN` entries, default one in-progress step)
 *   and then one reverse request `q-1` of method `FAKE_QMETHOD` (default
 *   `_x.ai/ask_user_question`) for session `FAKE_QSESSION` (default its own), with params
 *   `FAKE_QPARAMS` (JSON) or a two-choice question; `FAKE_QREPLAY` sends the same request
 *   twice. The answer is logged as `qanswer <result>` or `qerror <code>`, and then
 *   `FAKE_QTHEN` decides: absent, the turn ends `end_turn`; `permission` asks `perm-1` as the
 *   `permission` mode does; `hold` keeps the prompt open until `session/cancel`.
 * - `FAKE_SESSION`: the native session id `session/new` allocates (default `native-1`).
 * - `FAKE_TICKS`: the terminal usage's `costUsdTicks`; absent, the turn reports no cost.
 * - `FAKE_COMMANDS`: a JSON array advertised as `available_commands_update` once the
 *   session is allocated or loaded; absent, nothing is advertised.
 * - `FAKE_LOG`: a file each received method (and `prompt <blocks>`) is appended to.
 *
 * A cancel answers `cancelled` with partial usage (`costUsdTicks: '777'`, `costIsPartial`).
 */

import * as fs from 'fs';
import * as path from 'path';

const PEER_SOURCE = `const fs = require('node:fs');
const env = process.env;
const log = (line) => env.FAKE_LOG && fs.appendFileSync(env.FAKE_LOG, line + '\\n');
let buf = '', pending, sid = env.FAKE_SESSION || 'native-1';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const chunk = (text) => send({ method: 'session/update', params: { sessionId: sid,
	update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const finish = (id, stopReason, cost) => send({ id, result: { stopReason, _meta: { usage: {
	inputTokens: 130, outputTokens: 10, cachedReadTokens: 20, cacheCreationTokens: 10,
	reasoningTokens: 3, ...cost } } } });
const advertise = () => env.FAKE_COMMANDS && send({ method: 'session/update', params: { sessionId: sid,
	update: { sessionUpdate: 'available_commands_update', availableCommands: JSON.parse(env.FAKE_COMMANDS) } } });
const ask = () => {
	send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'plan',
		entries: env.FAKE_PLAN ? JSON.parse(env.FAKE_PLAN) : [{ content: 'step one', status: 'in_progress', priority: 'high' }] } } });
	const q = { id: 'q-1', method: env.FAKE_QMETHOD || '_x.ai/ask_user_question', params: {
		sessionId: env.FAKE_QSESSION || sid, ...(env.FAKE_QPARAMS ? JSON.parse(env.FAKE_QPARAMS)
			: { questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] }) } };
	send(q);
	if (env.FAKE_QREPLAY) send(q);
};
process.stdin.on('data', (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf('\\n')) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		log((m.method || 'answer:' + m.id) + (m.params && m.params.sessionId ? ' ' + m.params.sessionId : ''));
		if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1,
			agentCapabilities: { loadSession: true },
			...(env.FAKE_MODE === 'noversion' ? {} : { _meta: { grokShell: true, agentVersion: '9.9.9-fixture' } }) } });
		else if (m.method === 'session/new') { advertise(); send({ id: m.id, result: { sessionId: sid } }); }
		else if (m.method === 'session/load') { sid = m.params.sessionId; advertise(); send({ id: m.id, result: {} }); }
		else if (m.method === 'session/prompt') {
			pending = m.id;
			log('prompt ' + JSON.stringify(m.params.prompt));
			if (env.FAKE_MODE === 'permission') send({ id: 'perm-1', method: 'session/request_permission', params: {
				sessionId: sid, toolCall: { toolCallId: 'perm-1', title: 'Read', rawInput: { path: 'README.md' } },
				options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
					{ optionId: 'no', name: 'Deny', kind: 'reject_once' }] } });
			else if (env.FAKE_MODE === 'hold') chunk('working');
			else if (env.FAKE_MODE === 'vanish') { chunk('working'); process.stdout.write('', () => process.exit(0)); }
			else if (env.FAKE_MODE === 'rpcerror') send({ id: m.id, error: JSON.parse(env.FAKE_RPCERROR) });
			else if (env.FAKE_MODE === 'question') ask();
			else { chunk('Hello from ACP'); finish(m.id, 'end_turn', env.FAKE_TICKS ? { costUsdTicks: env.FAKE_TICKS } : {}); }
		} else if (m.id === 'q-1' && !m.method) {
			log(m.error ? 'qerror ' + m.error.code : 'qanswer ' + JSON.stringify(m.result));
			if (env.FAKE_QTHEN === 'permission') send({ id: 'perm-1', method: 'session/request_permission', params: {
				sessionId: sid, toolCall: { toolCallId: 'perm-1', title: 'Read', rawInput: { path: 'README.md' } },
				options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
					{ optionId: 'no', name: 'Deny', kind: 'reject_once' }] } });
			else if (env.FAKE_QTHEN === 'hold') chunk('waiting');
			else { chunk('after question'); finish(pending, 'end_turn', {}); }
		} else if (m.id === 'perm-1') {
			const allowed = m.result && m.result.outcome && m.result.outcome.optionId === 'yes';
			chunk(allowed ? 'Allowed answer' : 'Denied');
			finish(pending, allowed ? 'end_turn' : 'cancelled', {});
		} else if (m.method === 'session/cancel') finish(pending, 'cancelled', { costUsdTicks: '777', costIsPartial: true });
		else if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
	}
});
process.stdin.on('end', () => process.exit(0));
`;

/** Write the peer and its wrapper into `dir`; returns the wrapper (the "grok" executable). */
export function writeSyntheticGrokAcpPeer(dir: string): string {
	const peer = path.join(dir, 'grok-acp-peer.cjs');
	fs.writeFileSync(peer, PEER_SOURCE);
	const wrapper = path.join(dir, 'grok');
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${peer}' "$@"\n`);
	fs.chmodSync(wrapper, 0o755);
	return wrapper;
}

/** The peer's received-method log (see `FAKE_LOG`), one entry per line; empty when absent. */
export function readSyntheticGrokAcpLog(file: string): string[] {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
}
