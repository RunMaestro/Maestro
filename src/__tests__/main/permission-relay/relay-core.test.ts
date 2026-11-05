import {
	isRemoteMethodAllowed,
	isRemoteEventAllowed,
} from '../../../main/web-server/handlers/bridgeDenyList';
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import {
	registerSpawn,
	lookupBinding,
	createPending,
	resolvePending,
	relayRegistryStats,
	getPendingPermissionSnapshot,
	subscribePendingPermissions,
} from '../../../main/permission-relay/registry';
import { buildRelayArgs } from '../../../main/permission-relay/spawn-args';
import { parseQuestionRequest } from '../../../main/permission-relay/question-request';
import { PermissionRelayServer } from '../../../main/permission-relay/PermissionRelayServer';
import {
	RELAY_PERMISSION_PROMPT_TOOL,
	RELAY_MCP_SERVER_NAME,
} from '../../../main/permission-relay/types';
import type { PermissionRequest } from '../../../main/permission-relay/types';
import { resolvePermissionResponse } from '../../../main/permission-relay/integration';
import { grokConsentAuthority } from '../../../main/process-manager/spawners/GrokAcpSpawner';
import type { GrokEffect, GrokEffectAuthority } from '../../../shared/maestro-lib/grok/host-seams';

describe('permission-relay registry', () => {
	it('keeps the registry snapshot and status push native-only', () => {
		expect(isRemoteMethodAllowed('process:getPendingPermissions')).toBe(false);
		expect(isRemoteEventAllowed('process:pending-permissions')).toBe(false);
	});

	it('publishes only versioned process IDs and clears them on timeout and exit', async () => {
		vi.useFakeTimers();
		const spawn = registerSpawn({ sessionId: 'agent-ai-tab', tabId: 'tab' });
		const changes = vi.fn();
		const off = subscribePendingPermissions(changes);
		try {
			const timed = createPending('timed-status', spawn.token, 10);
			expect(getPendingPermissionSnapshot()).toEqual({
				version: expect.any(Number),
				processIds: ['agent-ai-tab'],
			});
			const version = getPendingPermissionSnapshot().version;
			await vi.advanceTimersByTimeAsync(10);
			await timed;
			expect(getPendingPermissionSnapshot().processIds).toEqual([]);
			expect(getPendingPermissionSnapshot().version).toBeGreaterThan(version);
			const exited = createPending('exited-status', spawn.token);
			spawn.cleanup();
			await exited;
			expect(changes).toHaveBeenLastCalledWith({ version: expect.any(Number), processIds: [] });
		} finally {
			off();
			spawn.cleanup();
			vi.useRealTimers();
		}
	});

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

describe('permission-relay parseQuestionRequest', () => {
	it('returns null for ordinary (non-AskUserQuestion) tools', () => {
		expect(parseQuestionRequest('Bash', { command: 'ls' })).toBeNull();
		expect(parseQuestionRequest('Edit', { file_path: '/tmp/x' })).toBeNull();
	});

	it('parses a single-select question into the typed shape', () => {
		const parsed = parseQuestionRequest('AskUserQuestion', {
			questions: [
				{
					question: 'Which color do you prefer?',
					header: 'Color',
					options: [{ label: 'Red', description: 'The red one' }, { label: 'Blue' }],
					multiSelect: false,
				},
			],
		});
		expect(parsed).toEqual({
			kind: 'question',
			questions: [
				{
					question: 'Which color do you prefer?',
					header: 'Color',
					options: [{ label: 'Red', description: 'The red one' }, { label: 'Blue' }],
					multiSelect: false,
				},
			],
		});
	});

	it('preserves multiSelect and parses multiple questions', () => {
		const parsed = parseQuestionRequest('AskUserQuestion', {
			questions: [
				{ question: 'Pick colors', options: [{ label: 'Red' }], multiSelect: true },
				{ question: 'Pick a size', options: [{ label: 'S' }], multiSelect: false },
			],
		});
		expect(parsed?.questions).toHaveLength(2);
		expect(parsed?.questions[0].multiSelect).toBe(true);
		expect(parsed?.questions[1].multiSelect).toBe(false);
		// Absent header stays undefined, not the empty string.
		expect(parsed?.questions[0].header).toBeUndefined();
	});

	it('tolerates bare-string options', () => {
		const parsed = parseQuestionRequest('AskUserQuestion', {
			questions: [{ question: 'Q?', options: ['A', 'B'], multiSelect: false }],
		});
		expect(parsed?.questions[0].options).toEqual([{ label: 'A' }, { label: 'B' }]);
	});

	it('drops malformed questions and returns null when none survive', () => {
		expect(
			parseQuestionRequest('AskUserQuestion', { questions: [{}, { header: 'x' }] })
		).toBeNull();
		expect(parseQuestionRequest('AskUserQuestion', {})).toBeNull();
		expect(parseQuestionRequest('AskUserQuestion', { questions: 'nope' })).toBeNull();
	});
});

describe('permission-relay server AskUserQuestion round-trip', () => {
	/** Collect newline-delimited JSON messages arriving on a client socket. */
	function collectMessages(
		client: net.Socket,
		onMessage: (msg: Record<string, unknown>) => void
	): void {
		let buffer = '';
		client.setEncoding('utf8');
		client.on('data', (chunk: string) => {
			buffer += chunk;
			let idx: number;
			while ((idx = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.length > 0) {
					onMessage(JSON.parse(line));
				}
			}
		});
	}

	// Production runs exactly one relay server per process; its socket path (a
	// pid-derived named pipe on Windows) is process-global. Each `it` spinning up
	// its own server and calling stop() collided on Windows: server.close() is
	// async and does not release the named pipe synchronously, so the next
	// listen() on the same pipe threw EADDRINUSE. Share one server across the
	// block and set the per-test onRequest handler instead.
	let server: PermissionRelayServer;
	let socketPath: string;
	let serverDir: string;

	beforeAll(async () => {
		server = new PermissionRelayServer();
		serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-srv-'));
		socketPath = await server.ensureStarted(serverDir);
	});

	afterAll(() => {
		server.stop();
		fs.rmSync(serverDir, { recursive: true, force: true });
	});

	it('surfaces a kind=question request and round-trips a deny+message answer', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sQ', tabId: 'tQ' });
		let captured: PermissionRequest | undefined;

		// Stand in for the renderer: answer via deny+message (the proven shape).
		server.setOnRequest((req) => {
			captured = req;
			expect(getPendingPermissionSnapshot().processIds).toContain('sQ');
			resolvePending(req.requestId, { behavior: 'deny', message: 'Color: Blue' });
		});

		const client = net.createConnection(socketPath);

		try {
			const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
				collectMessages(client, (msg) => {
					if (msg.type === 'permission-response') {
						resolve(msg);
					}
				});
				client.on('error', reject);
				client.on('connect', () => {
					client.write(JSON.stringify({ type: 'hello', token }) + '\n');
					client.write(
						JSON.stringify({
							type: 'permission-request',
							token,
							requestId: 'b1',
							toolName: 'AskUserQuestion',
							input: {
								questions: [
									{
										question: 'Which color do you prefer?',
										header: 'Color',
										options: [{ label: 'Red' }, { label: 'Blue' }],
										multiSelect: false,
									},
								],
							},
						}) + '\n'
					);
				});
			});

			expect(captured?.kind).toBe('question');
			expect(captured?.questions?.[0].question).toBe('Which color do you prefer?');
			expect(captured?.questions?.[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
			expect(response.requestId).toBe('b1');
			expect(response.decision).toEqual({ behavior: 'deny', message: 'Color: Blue' });
		} finally {
			client.destroy();
			cleanup();
		}
	});

	it('leaves an ordinary tool request unchanged (no kind/questions)', async () => {
		const { token, cleanup } = registerSpawn({ sessionId: 'sB', tabId: 'tB' });
		let captured: PermissionRequest | undefined;

		server.setOnRequest((req) => {
			captured = req;
			resolvePending(req.requestId, { behavior: 'allow' });
		});

		const client = net.createConnection(socketPath);

		try {
			await new Promise<void>((resolve, reject) => {
				collectMessages(client, (msg) => {
					if (msg.type === 'permission-response') {
						resolve();
					}
				});
				client.on('error', reject);
				client.on('connect', () => {
					client.write(JSON.stringify({ type: 'hello', token }) + '\n');
					client.write(
						JSON.stringify({
							type: 'permission-request',
							token,
							requestId: 'b2',
							toolName: 'Bash',
							input: { command: 'ls' },
						}) + '\n'
					);
				});
			});

			expect(captured?.toolName).toBe('Bash');
			expect(captured?.kind).toBeUndefined();
			expect(captured?.questions).toBeUndefined();
		} finally {
			client.destroy();
			cleanup();
		}
	});
});

// A standalone Grok tab's consent through the one relay path the desktop, the
// web-desktop and Lite share. GrokAcpSpawner opens one consent session per tab and asks it
// through grokConsentAuthority; every client answers by the server-minted request id over
// `permission:respond` (resolvePermissionResponse). A Grok question never reaches this path
// (the driver settles it as unavailable), so the only answer a client can give is a
// person's decision on one exact tool request of its owning tab.
describe('Grok consent answers through the relay', () => {
	const binding = {
		actor: { kind: 'human', id: 'desktop-user' },
		leaseId: 'desktop-consent:grok-agent:1',
	} as unknown as Parameters<GrokEffectAuthority['decide']>[1];
	const effect = (title: string, file: string): GrokEffect => ({
		kind: 'permissions',
		permissions: { request: { toolCall: { toolCallId: title, title, rawInput: { path: file } } } },
	});
	const opened: Array<{ close(): void }> = [];
	function relay() {
		const server = new PermissionRelayServer();
		const asked: PermissionRequest[] = [];
		server.setOnRequest((req) => asked.push(req));
		const tab = (tabId: string) => {
			const session = server.openConsentSession({ sessionId: 'grok-agent', tabId });
			if (!session) throw new Error('No consent surface');
			opened.push(session);
			const authority = grokConsentAuthority(session);
			// The driver always passes its turn signal; a fresh one is a live turn.
			const decide = (e: GrokEffect, signal = new AbortController().signal) =>
				Promise.resolve(authority.decide(e, binding, signal));
			return { session, decide };
		};
		return { asked, tab };
	}
	const isSettled = async (promise: Promise<unknown>) => {
		let settled = false;
		void promise.then(() => (settled = true));
		await new Promise((resolve) => setImmediate(resolve));
		return settled;
	};
	afterEach(() => {
		for (const session of opened.splice(0)) session.close();
	});

	it('routes each answer to the owning tab request only; a duplicate or reconnecting answer is stale', async () => {
		const { asked, tab } = relay();
		const one = tab('tab-1');
		const two = tab('tab-2');
		const decided1 = one.decide(effect('Read', 'a.md'));
		const decided2 = two.decide(effect('Write', 'b.md'));
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		const [r1, r2] = asked;
		expect(r1).toMatchObject({
			sessionId: 'grok-agent',
			tabId: 'tab-1',
			toolName: 'Read',
			input: { path: 'a.md' },
		});
		expect(r2).toMatchObject({ sessionId: 'grok-agent', tabId: 'tab-2', toolName: 'Write' });
		// A tool request, never a question picker.
		expect(r1).not.toHaveProperty('kind');
		expect(r1.requestId).not.toBe(r2.requestId);
		expect(r1.token).not.toBe(r2.token);

		expect(resolvePermissionResponse(r2.requestId, { behavior: 'allow' })).toBe(true);
		await expect(decided2).resolves.toEqual({ decision: 'allow' });
		// A second client (or the same one after a reconnect) answering again changes nothing.
		expect(resolvePermissionResponse(r2.requestId, { behavior: 'deny', message: 'late' })).toBe(
			false
		);
		expect(await isSettled(decided1)).toBe(false);
		expect(resolvePermissionResponse(r1.requestId, { behavior: 'deny', message: 'No' })).toBe(true);
		await expect(decided1).resolves.toEqual({ decision: 'deny', reason: 'No' });

		// An allow is one request's, not the tab's: the next request asks again.
		const again = two.decide(effect('Write', 'b.md'));
		await vi.waitFor(() => expect(asked).toHaveLength(3));
		expect(asked[2].requestId).not.toBe(r2.requestId);
		two.session.close();
		await expect(again).resolves.toEqual({ decision: 'deny', reason: 'Agent process exited.' });
	});

	it('refuses unauthorized responders and never widens what the person was shown', async () => {
		const { asked, tab } = relay();
		const one = tab('tab-1');
		const decided = one.decide(effect('Read', 'a.md'));
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		const [request] = asked;
		expect(resolvePermissionResponse('guessed-request', { behavior: 'allow' })).toBe(false);
		expect(resolvePermissionResponse(request.token, { behavior: 'allow' })).toBe(false);
		expect(resolvePermissionResponse(`${request.requestId} `, { behavior: 'allow' })).toBe(false);
		expect(await isSettled(decided)).toBe(false);
		// An Allow that edits the input is not the request shown and denies.
		expect(
			resolvePermissionResponse(request.requestId, {
				behavior: 'allow',
				updatedInput: { path: '/outside/secret' },
			})
		).toBe(true);
		await expect(decided).resolves.toEqual({
			decision: 'deny',
			reason: 'An edited tool input cannot be approved for Grok.',
		});
		// Any other effect is never put to the person.
		await expect(
			one.decide({
				kind: 'tool-call',
				tool: 'Bash',
				input: { command: 'ls' },
			} as unknown as GrokEffect)
		).resolves.toMatchObject({ decision: 'deny' });
		expect(asked).toHaveLength(1);
	});

	it('denies on a cancelled turn or process exit and keeps late answers stale', async () => {
		const { asked, tab } = relay();
		const one = tab('tab-1');
		const controller = new AbortController();
		const cancelled = one.decide(effect('Read', 'a.md'), controller.signal);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		controller.abort();
		await expect(cancelled).resolves.toEqual({
			decision: 'deny',
			reason: 'The request was cancelled before a decision.',
		});
		expect(resolvePermissionResponse(asked[0].requestId, { behavior: 'allow' })).toBe(false);
		// Already cancelled: never surfaced to any client.
		await expect(one.decide(effect('Read', 'b.md'), controller.signal)).resolves.toMatchObject({
			decision: 'deny',
		});
		expect(asked).toHaveLength(1);

		const pending = one.decide(effect('Read', 'c.md'));
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		one.session.close();
		await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'Agent process exited.' });
		expect(resolvePermissionResponse(asked[1].requestId, { behavior: 'allow' })).toBe(false);
		await expect(one.decide(effect('Read', 'd.md'))).resolves.toEqual({
			decision: 'deny',
			reason: 'Agent process exited.',
		});
		expect(asked).toHaveLength(2);
	});

	it('gives browser and Lite clients the same reply channel and no question answer channel', () => {
		expect(isRemoteEventAllowed('process:permission-request')).toBe(true);
		expect(isRemoteMethodAllowed('permission:respond')).toBe(true);
		// Plans and the question gap are display events every client mirrors.
		expect(isRemoteEventAllowed('process:tool-execution')).toBe(true);
		expect(isRemoteEventAllowed('agent:error')).toBe(true);
		for (const channel of [
			'permission:answerQuestion',
			'permission:question',
			'process:answerQuestion',
			'process:question',
			'grok:answerQuestion',
			'agent:answerQuestion',
			'agent:question',
		]) {
			expect(isRemoteMethodAllowed(channel), channel).toBe(false);
		}
	});
});
