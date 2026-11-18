/**
 * @file create-agent.test.ts
 * @description Tests for the create-agent CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { createAgent, CREATE_AGENT_TYPES } from '../../../cli/commands/create-agent';
import { AGENT_IDS } from '../../../shared/agentIds';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('create-agent command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('successful creation', () => {
		it('should create an agent with required options', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: true,
						sessionId: 'new-id-123',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('My Agent', { cwd: '/tmp/project', type: 'claude-code' });

			expect(formatSuccess).toHaveBeenCalledWith('Created agent "My Agent" (claude-code)');
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('new-id-123'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('does not record provenance when --context-window is not passed', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Agent', { cwd: '/tmp', type: 'codex', model: 'gpt-4' });

			// No window, so nothing to describe. A provenance marker with no value
			// would outrank the provider's report on whatever gets set later.
			expect(sentPayload.customContextWindow).toBeUndefined();
			expect(sentPayload.contextWindowSource).toBeUndefined();
		});

		it('should send config fields when provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Agent', {
				cwd: '/tmp',
				type: 'codex',
				model: 'gpt-4',
				effort: 'high',
				nudge: 'Be concise',
				newSessionMessage: 'Init context for every session',
				customPath: '/usr/local/bin/codex',
				customArgs: '--verbose',
				contextWindow: '128000',
				providerPath: '/custom/path',
				env: ['FOO=bar', 'BAZ=qux'],
			});

			expect(sentPayload.customModel).toBe('gpt-4');
			expect(sentPayload.customEffort).toBe('high');
			expect(sentPayload.nudgeMessage).toBe('Be concise');
			expect(sentPayload.newSessionMessage).toBe('Init context for every session');
			expect(sentPayload.customPath).toBe('/usr/local/bin/codex');
			expect(sentPayload.customArgs).toBe('--verbose');
			expect(sentPayload.customContextWindow).toBe(128000);
			// Typing the flag is a deliberate choice, so it must carry provenance or
			// the provider's reported window silently overrides it and the user has
			// to re-apply the same number with `update-agent` (finding AD1, review
			// of PR #1362). `update-agent` already did this; `create-agent` did not.
			expect(sentPayload.contextWindowSource).toBe('user-edited');
			expect(sentPayload.customProviderPath).toBe('/custom/path');
			expect(sentPayload.customEnvVars).toEqual({ FOO: 'bar', BAZ: 'qux' });
		});

		describe('placement', () => {
			function capture() {
				const sent: Record<string, unknown> = {};
				vi.mocked(withMaestroClient).mockImplementation(async (action) => {
					const mockClient = {
						sendCommand: vi.fn().mockImplementation((payload) => {
							Object.assign(sent, payload);
							return Promise.resolve({
								type: 'create_session_result',
								success: true,
								sessionId: 'id-1',
							});
						}),
					};
					return action(mockClient as never);
				});
				return sent;
			}

			it('selects the new agent by default, exactly as it always has', async () => {
				const sent = capture();
				await createAgent('Agent', { cwd: '/tmp', type: 'claude-code' });
				expect(sent.background).toBe(false);
			});

			it('leaves the Left Bar selection alone with --background', async () => {
				const sent = capture();
				await createAgent('Agent', { cwd: '/tmp', type: 'claude-code', background: true });
				expect(sent.background).toBe(true);
				// The agent still exists and is still addressable - "created but
				// invisible" would be a different bug, so the id is still reported.
				expect(formatSuccess).toHaveBeenCalledWith(expect.stringContaining('in the background'));
				expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('id-1'));
			});

			it('reports the placement in JSON output', async () => {
				capture();
				await createAgent('Agent', {
					cwd: '/tmp',
					type: 'claude-code',
					background: true,
					json: true,
				});
				const printed = JSON.parse(vi.mocked(consoleSpy).mock.calls.at(-1)![0] as string);
				expect(printed).toMatchObject({ success: true, agentId: 'id-1', background: true });
			});

			it('lets --focus win over --background', async () => {
				const sent = capture();
				await createAgent('Agent', {
					cwd: '/tmp',
					type: 'claude-code',
					background: true,
					focus: true,
				});
				expect(sent.background).toBe(false);
			});
		});

		it('should send SSH config when ssh-remote is provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Remote Agent', {
				cwd: '/tmp',
				type: 'claude-code',
				sshRemote: 'remote-id-123',
				sshCwd: '/remote/path',
			});

			expect(sentPayload.sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-id-123',
				workingDirOverride: '/remote/path',
			});
		});

		it('should output JSON when --json flag is set', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: true,
						sessionId: 'json-id',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('JSON Agent', { cwd: '/tmp', type: 'claude-code', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.agentId).toBe('json-id');
			expect(parsed.name).toBe('JSON Agent');
		});
	});

	describe('validation errors', () => {
		it('should reject invalid agent type', async () => {
			await createAgent('Bad Agent', { cwd: '/tmp', type: 'invalid-type' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid agent type'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid agent type in JSON mode', async () => {
			await createAgent('Bad Agent', { cwd: '/tmp', type: 'invalid-type', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Invalid agent type');
		});

		it('should reject invalid context window', async () => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', contextWindow: 'abc' });

			expect(formatError).toHaveBeenCalledWith('--context-window must be a positive integer');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid env format', async () => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', env: ['NOEQUALS'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid --env format'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('error handling', () => {
		it('should handle server returning failure', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: false,
						error: 'Duplicate name',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Dupe', { cwd: '/tmp', type: 'claude-code' });

			expect(formatError).toHaveBeenCalledWith('Duplicate name');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

			await createAgent('No App', { cwd: '/tmp', type: 'claude-code' });

			expect(formatError).toHaveBeenCalledWith('App not running');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection refused'));

			await createAgent('No App', { cwd: '/tmp', type: 'claude-code', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('Connection refused');
		});
	});
});

// Grok through `create-agent` (stable ID, same bridge message, no
// provider substitution, background placement, parseable JSON errors).
describe('create-agent Grok', () => {
	let logSpy: MockInstance;
	let exitSpy: MockInstance;
	const sent: Array<{ payload: Record<string, unknown>; expect: string }> = [];
	const desktop = (reply: Record<string, unknown>) =>
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn(async (payload: Record<string, unknown>, expectType: string) => {
					sent.push({ payload, expect: expectType });
					return reply;
				}),
			} as never)
		);
	const lastJson = () => JSON.parse(String(logSpy.mock.calls.at(-1)![0]));

	beforeEach(() => {
		vi.clearAllMocks();
		sent.length = 0;
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		// Throwing exit: a refusal must stop before the bridge is touched.
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit(${code})`);
		});
	});

	it('advertises and accepts exactly the registry IDs except terminal, grok included', () => {
		expect(CREATE_AGENT_TYPES).toContain('grok');
		expect(CREATE_AGENT_TYPES).not.toContain('terminal');
		expect([...CREATE_AGENT_TYPES]).toEqual(AGENT_IDS.filter((id) => id !== 'terminal'));
	});

	it('creates a Grok agent through the one create_session bridge message with its model and env', async () => {
		desktop({ type: 'create_session_result', success: true, sessionId: 'grok-agent-1' });

		await createAgent('Grok Worker', {
			cwd: '/tmp/grok-project',
			type: 'grok',
			model: 'grok-code-fast-1',
			effort: 'high',
			env: ['GROK_TELEMETRY=0'],
			background: true,
			json: true,
		});

		expect(sent).toHaveLength(1);
		expect(sent[0].expect).toBe('create_session_result');
		expect(sent[0].payload).toMatchObject({
			type: 'create_session',
			name: 'Grok Worker',
			toolType: 'grok',
			customModel: 'grok-code-fast-1',
			customEffort: 'high',
			customEnvVars: { GROK_TELEMETRY: '0' },
			background: true,
		});
		expect(exitSpy).not.toHaveBeenCalled();
		expect(lastJson()).toEqual({
			success: true,
			agentId: 'grok-agent-1',
			name: 'Grok Worker',
			type: 'grok',
			background: true,
		});
	});

	it('selects the new Grok agent by default and --focus wins over --background', async () => {
		desktop({ type: 'create_session_result', success: true, sessionId: 'g' });
		await createAgent('G1', { cwd: '/tmp', type: 'grok' });
		await createAgent('G2', { cwd: '/tmp', type: 'grok', background: true, focus: true });
		expect(sent.map((s) => [s.payload.toolType, s.payload.background])).toEqual([
			['grok', false],
			['grok', false],
		]);
	});

	it.each(['grok-cli', 'Grok', 'xai'])(
		'refuses %s with a parseable JSON error naming grok, before any bridge call',
		async (type) => {
			await expect(createAgent('Bad', { cwd: '/tmp', type, json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			const printed = lastJson();
			expect(printed.success).toBe(false);
			expect(printed.error).toContain(`Invalid agent type "${type}"`);
			expect(printed.error).toMatch(/\bgrok\b/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		}
	);

	it('reports a desktop refusal of a Grok create as parseable JSON, never a substituted provider', async () => {
		exitSpy.mockImplementation(() => undefined as never);
		desktop({
			type: 'create_session_result',
			success: false,
			error: 'Managed policy refuses provider grok',
		});

		await createAgent('Grok Worker', { cwd: '/tmp', type: 'grok', json: true });

		expect(sent).toHaveLength(1);
		expect(sent[0].payload.toolType).toBe('grok');
		expect(lastJson()).toEqual({ success: false, error: 'Managed policy refuses provider grok' });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
