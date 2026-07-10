import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	registerSpawn,
	lookupBinding,
	createPending,
	resolvePending,
	relayRegistryStats,
} from '../../../main/permission-relay/registry';
import { buildRelayArgs } from '../../../main/permission-relay/spawn-args';
import {
	RELAY_PERMISSION_PROMPT_TOOL,
	RELAY_MCP_SERVER_NAME,
} from '../../../main/permission-relay/types';

describe('permission-relay registry', () => {
	it('registers a spawn and looks up its binding', () => {
		const { token, cleanup } = registerSpawn({ sessionId: 's1', tabId: 't1' });
		expect(lookupBinding(token)).toEqual({ sessionId: 's1', tabId: 't1' });
		cleanup();
		expect(lookupBinding(token)).toBeUndefined();
	});

	it('generates unique tokens per spawn', () => {
		const a = registerSpawn({ sessionId: 's1' });
		const b = registerSpawn({ sessionId: 's1' });
		expect(a.token).not.toBe(b.token);
		a.cleanup();
		b.cleanup();
	});

	it('isolates spawns: cleaning up one leaves the other binding + pending intact', async () => {
		const a = registerSpawn({ sessionId: 'sA', tabId: 'tA' });
		const b = registerSpawn({ sessionId: 'sB', tabId: 'tB' });
		const aPending = createPending('req-a', a.token, 10_000);
		const bPending = createPending('req-b', b.token, 10_000);

		// Tearing down spawn A must not touch spawn B's binding or pending request.
		a.cleanup();
		expect(lookupBinding(a.token)).toBeUndefined();
		expect(lookupBinding(b.token)).toEqual({ sessionId: 'sB', tabId: 'tB' });

		// A's pending was denied by its cleanup; B's is still live and resolvable.
		await expect(aPending).resolves.toEqual({
			behavior: 'deny',
			message: 'Agent process exited.',
		});
		expect(resolvePending('req-b', { behavior: 'allow' })).toBe(true);
		await expect(bPending).resolves.toEqual({ behavior: 'allow' });
		b.cleanup();
	});

	it('rejects lookups for unknown/forged tokens', () => {
		expect(lookupBinding('not-a-real-token')).toBeUndefined();
	});

	it('resolves a pending request via resolvePending', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 's1' });
		const promise = createPending('req-1', token, 10_000);
		expect(resolvePending('req-1', { behavior: 'allow' })).toBe(true);
		await expect(promise).resolves.toEqual({ behavior: 'allow' });
		cleanup();
	});

	it('returns false when resolving an unknown request', () => {
		expect(resolvePending('does-not-exist', { behavior: 'allow' })).toBe(false);
	});

	it('auto-denies a pending request after the timeout', async () => {
		vi.useFakeTimers();
		try {
			const { token, cleanup } = registerSpawn({ sessionId: 's1' });
			const promise = createPending('req-timeout', token, 1_000);
			vi.advanceTimersByTime(1_001);
			await expect(promise).resolves.toEqual({
				behavior: 'deny',
				message: 'Permission request timed out with no response.',
			});
			cleanup();
		} finally {
			vi.useRealTimers();
		}
	});

	it('cleanup denies any still-pending requests for that spawn', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 's1' });
		const promise = createPending('req-live', token, 10_000);
		cleanup();
		await expect(promise).resolves.toEqual({
			behavior: 'deny',
			message: 'Agent process exited.',
		});
	});

	afterEach(() => {
		// Sanity: no bindings should leak across tests that clean up.
		// (Not strict - other tests may register; just ensure it's callable.)
		expect(typeof relayRegistryStats().bindings).toBe('number');
	});
});

describe('permission-relay spawn-args', () => {
	it('writes the mcp config to a file and passes it by path (shell-safe)', () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-args-'));
		try {
			const { args, configPath } = buildRelayArgs(
				'/path/to/node',
				'/path/to/bridge.js',
				'/tmp/relay.sock',
				'toktokreallylong0123456789abcdef',
				configDir
			);
			expect(args[0]).toBe('--permission-prompt-tool');
			expect(args[1]).toBe(RELAY_PERMISSION_PROMPT_TOOL);
			expect(args[2]).toBe('--mcp-config');
			// The 4th arg is a FILE PATH, not inline JSON (no shell metacharacters).
			expect(args[3]).toBe(configPath);
			expect(configPath.startsWith(configDir)).toBe(true);
			expect(args[3]).not.toContain('{');

			const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			const server = config.mcpServers[RELAY_MCP_SERVER_NAME];
			expect(server.command).toBe('/path/to/node');
			expect(server.args).toEqual(['/path/to/bridge.js']);
			expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1');
			expect(server.env.MAESTRO_RELAY_SOCKET).toBe('/tmp/relay.sock');
			expect(server.env.MAESTRO_RELAY_TOKEN).toBe('toktokreallylong0123456789abcdef');
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	it('uses the mcp__server__tool naming for the prompt tool', () => {
		expect(RELAY_PERMISSION_PROMPT_TOOL).toBe(`mcp__${RELAY_MCP_SERVER_NAME}__approve`);
	});
});
