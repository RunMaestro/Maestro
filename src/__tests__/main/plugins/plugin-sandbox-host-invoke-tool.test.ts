/**
 * @file plugin-sandbox-host-invoke-tool.test.ts
 * @description The brokered request/response tool-invoke on the sandbox host:
 *   - invokeTool posts an `invokeTool` control message with a correlation id and
 *     resolves with the result once the child posts a matching `toolResult`,
 *   - an `ok:false` toolResult rejects with the child's error,
 *   - invoking a tool on a plugin that is not running rejects,
 *   - an outstanding invocation rejects when the child exits before replying,
 *   - the round-trip rejects when it exceeds the bounded timeout (fake timers).
 * electron's utilityProcess and the file logger are mocked so nothing is forked
 * and no log file is written; the child is the hoisted forkMock stub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { forkMock, listeners, proc } = vi.hoisted(() => {
	const listeners = new Map<string, (...a: unknown[]) => void>();
	const proc = {
		postMessage: vi.fn(),
		on: (event: string, cb: (...a: unknown[]) => void) => {
			listeners.set(event, cb);
		},
		kill: vi.fn(),
	};
	const forkMock = vi.fn(() => proc);
	return { forkMock, listeners, proc };
});

vi.mock('electron', () => ({
	utilityProcess: { fork: forkMock },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';

const allowAll = {
	authorize: () => ({ allowed: true }),
	authorizeInvocation: () => ({ allowed: true }),
} as unknown as PermissionBroker;

function emit(event: string, ...args: unknown[]): void {
	const cb = listeners.get(event);
	if (!cb) throw new Error(`no listener captured for "${event}"`);
	cb(...args);
}

/** Find the most recent invokeTool control message posted to the child. */
function lastInvokeTool(): { id: number; commandId: string; args?: unknown } {
	const calls = proc.postMessage.mock.calls;
	for (let i = calls.length - 1; i >= 0; i--) {
		const m = calls[i][0] as { kind?: string };
		if (m && m.kind === 'invokeTool') {
			return m as unknown as { id: number; commandId: string; args?: unknown };
		}
	}
	throw new Error('no invokeTool control message was posted');
}

describe('PluginSandboxHost.invokeTool request/response', () => {
	let dir: string;
	let host: PluginSandboxHost;

	beforeEach(() => {
		vi.clearAllMocks();
		listeners.clear();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tool-'));
		fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
		host = new PluginSandboxHost({ broker: allowAll, handlers: {} });
		host.start('p', '// entry', {
			ownerPluginId: 'p',
			generation: 1,
			artifactDigest: 'a'.repeat(64),
			authorizationContentHash: 'c'.repeat(64),
			authorizationSignerKey: 'test-authorization-signer',
			signerKeyId: 'test-signer',
		});
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('resolves with the result once the child posts a matching toolResult', async () => {
		const p = host.invokeTool('p', 'lookup', { q: 'x' });
		const sent = lastInvokeTool();
		expect(sent.commandId).toBe('lookup');
		expect(sent.args).toEqual({ q: 'x' });
		expect(typeof sent.id).toBe('number');

		emit('message', { kind: 'toolResult', id: sent.id, ok: true, result: { answer: 42 } });
		await expect(p).resolves.toEqual({ answer: 42 });
	});

	it('rejects with the child error on an ok:false toolResult', async () => {
		const p = host.invokeTool('p', 'lookup', {});
		const sent = lastInvokeTool();
		emit('message', { kind: 'toolResult', id: sent.id, ok: false, error: 'boom' });
		await expect(p).rejects.toThrow('boom');
	});

	it('ignores a toolResult with an unknown correlation id', async () => {
		const p = host.invokeTool('p', 'lookup', {});
		const sent = lastInvokeTool();
		// A stray reply for a different id must not settle our pending call.
		emit('message', { kind: 'toolResult', id: sent.id + 999, ok: true, result: 'stray' });
		emit('message', { kind: 'toolResult', id: sent.id, ok: true, result: 'real' });
		await expect(p).resolves.toBe('real');
	});

	it('rejects when the plugin is not running', async () => {
		await expect(host.invokeTool('missing', 'lookup', {})).rejects.toThrow(/not running/);
	});

	it('rejects outstanding invocations when the child exits first', async () => {
		const p = host.invokeTool('p', 'lookup', {});
		emit('exit', 1);
		await expect(p).rejects.toThrow(/exited before/);
		expect(host.isRunning('p')).toBe(false);
	});

	it('rejects when the round-trip exceeds the timeout', async () => {
		vi.useFakeTimers();
		try {
			const p = host.invokeTool('p', 'slow', {});
			const assertion = expect(p).rejects.toThrow(/timed out/);
			await vi.advanceTimersByTimeAsync(30_001);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});
