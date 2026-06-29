import { beforeEach, describe, expect, test } from 'bun:test';
import maestroBridge, {
	pickMessageData,
	pickToolData,
} from '../extension/maestro-bridge.extension';
import { BRIDGE_ENV } from '../protocol';
import { fireEvent, getTool, makeCtx, makeMockPi } from './mock-pi';

function clearBridgeEnv(): void {
	delete process.env[BRIDGE_ENV.url];
	delete process.env[BRIDGE_ENV.token];
	delete process.env[BRIDGE_ENV.runId];
	delete process.env[BRIDGE_ENV.mapPath];
	delete process.env[BRIDGE_ENV.maestroSessionId];
}

beforeEach(clearBridgeEnv);

describe('maestro-bridge registration', () => {
	test('registers all read/observe + inert tools and a session_start handler', () => {
		const mock = makeMockPi();
		maestroBridge(mock.pi);
		for (const name of [
			'maestro_sessions',
			'maestro_playbook_list',
			'maestro_cue',
			'maestro_notify',
			'maestro_dispatch',
			'maestro_playbook_run',
			'maestro_cue_emit',
		]) {
			expect(mock.tools.has(name)).toBe(true);
		}
		expect(mock.handlers.has('session_start')).toBe(true);
		expect(mock.handlers.has('session_shutdown')).toBe(true);
	});
});

describe('maestro-bridge tool behavior', () => {
	test('dispatch-equivalent tools are inert and explain Phase 4', async () => {
		const mock = makeMockPi();
		maestroBridge(mock.pi);
		for (const name of ['maestro_dispatch', 'maestro_playbook_run', 'maestro_cue_emit']) {
			const res = await getTool(mock, name).execute(name, {}, undefined, undefined, makeCtx());
			expect(res.content[0].text).toContain('Phase 4');
		}
	});

	test('notify validates its params', async () => {
		const mock = makeMockPi();
		maestroBridge(mock.pi);
		const res = await getTool(mock, 'maestro_notify').execute(
			'c',
			{ title: 'only-title' },
			undefined,
			undefined,
			makeCtx()
		);
		expect(res.content[0].text).toContain('requires');
	});

	test('read tools report app unavailable when no bridge is connected', async () => {
		const mock = makeMockPi();
		maestroBridge(mock.pi);
		const res = await getTool(mock, 'maestro_sessions').execute(
			'c',
			{},
			undefined,
			undefined,
			makeCtx()
		);
		expect(res.content[0].text.toLowerCase()).toContain('not connected');
	});

	test('session_start without a bridge does not throw', async () => {
		const mock = makeMockPi();
		maestroBridge(mock.pi);
		await fireEvent(mock, 'session_start', {}, makeCtx({ sessionFile: '/s/x.jsonl' }));
		// no assertion beyond "did not throw"; the bridge call returns app_unavailable
		expect(true).toBe(true);
	});
});

describe('bridge emit is metadata-only (W5: never raw transcript/results)', () => {
	test('pickMessageData keeps only role + usage, dropping content/text', () => {
		const data = pickMessageData({
			role: 'assistant',
			usage: { input: 10, output: 20 },
			text: 'SECRET assistant transcript',
			content: [{ type: 'text', text: 'SECRET' }],
			message: { usage: { input: 1 } },
		});
		expect(data).toEqual({ role: 'assistant', usage: { input: 10, output: 20 } });
		expect(data).not.toHaveProperty('text');
		expect(data).not.toHaveProperty('content');
	});

	test('pickMessageData falls back to message.usage and omits absent fields', () => {
		expect(pickMessageData({ message: { usage: { input: 3 } } })).toEqual({ usage: { input: 3 } });
		expect(pickMessageData({})).toEqual({});
	});

	test('pickMessageData whitelists numeric usage fields, dropping nested secrets', () => {
		const data = pickMessageData({
			role: 'assistant',
			usage: {
				input: 10,
				output: 20,
				text: 'SECRET nested in usage',
				detail: { content: 'SECRET' },
			},
		});
		expect(data).toEqual({ role: 'assistant', usage: { input: 10, output: 20 } });
	});

	test('pickToolData keeps only toolName + status, dropping args/result/output', () => {
		const data = pickToolData({
			toolName: 'read',
			status: 'ok',
			args: { path: '/secret' },
			result: 'SECRET file contents',
			output: 'SECRET output',
		});
		expect(data).toEqual({ toolName: 'read', status: 'ok' });
		expect(data).not.toHaveProperty('result');
		expect(data).not.toHaveProperty('args');
		expect(data).not.toHaveProperty('output');
	});
});
