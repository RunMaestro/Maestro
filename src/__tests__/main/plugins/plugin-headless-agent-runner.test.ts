import { describe, expect, it, vi } from 'vitest';
import {
	HEADLESS_RUN_TIMEOUT_MS,
	HEADLESS_RUN_COMPLETION_TIMEOUT_MS,
} from '../../../shared/plugins/headless-agent-timeouts';
import * as fs from 'fs';
import * as pathProber from '../../../main/agents/path-prober';
import * as runIdentity from '../../../main/plugins/plugin-tool-run-identity';
import { autoTurnReport } from '../../../shared/autoTurn';
import { isAgentBusy } from '../../../main/utils/agent-busy';
import { captureException } from '../../../main/utils/sentry';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
import type { SpawnAgentOptions } from '../../../cli/services/agent-spawner';
import type { SessionInfo } from '../../../shared/types';
import {
	createPluginHeadlessAgentRunner,
	type PluginHeadlessRunnerDeps,
} from '../../../main/plugins/plugin-headless-agent-runner';

const agent = {
	id: 'agent-a',
	name: 'A',
	toolType: 'codex',
	cwd: '/project',
	projectRoot: '/project',
} as SessionInfo;

describe('plugin headless agent runner', () => {
	it('refuses ordinary sends after preflight consumes the absolute deadline', async () => {
		let now = 1_000;
		const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
		const spawn = vi.fn<PluginHeadlessRunnerDeps['spawn']>(async () => ({
			success: true,
			response: 'done',
		}));
		const issueRunToken = vi.fn(() => 'fixture-token');
		const proof = vi
			.spyOn(runIdentity, 'createPluginRunProofFile')
			.mockReturnValue('/fixture/proof');
		const removeProof = vi
			.spyOn(runIdentity, 'removePluginRunProofFile')
			.mockImplementation(() => {});
		try {
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => agent,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => true,
				spawn,
				prepareSystemPrompt: async () => {
					now += HEADLESS_RUN_TIMEOUT_MS + 1;
					return undefined;
				},
				issueRunToken,
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
			});
			await expect(run(agent.id, 'hello')).resolves.toMatchObject({
				success: false,
				error: 'Agent run stopped: absolute runtime ceiling exceeded',
			});
			expect(spawn).not.toHaveBeenCalled();
			expect(issueRunToken).not.toHaveBeenCalled();
			expect(proof).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
			proof.mockRestore();
			removeProof.mockRestore();
		}
	});
	it.each(['delay', 'expire', 'cancel'] as const)(
		'counts original-audio staging against the absolute deadline on %s',
		async (cause) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const spawn = vi.fn<PluginHeadlessRunnerDeps['spawn']>(async () => ({
				success: true,
				response: 'done',
			}));
			const revokeRunToken = vi.fn();
			const proof = vi
				.spyOn(runIdentity, 'createPluginRunProofFile')
				.mockReturnValue('/fixture/proof');
			const removeProof = vi
				.spyOn(runIdentity, 'removePluginRunProofFile')
				.mockImplementation(() => {});
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => agent,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => true,
				spawn,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: () => 'staging-proof',
				revokeRunToken,
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
			});
			try {
				const result = await run(
					agent.id,
					'read original',
					undefined,
					controller.signal,
					'relay',
					undefined,
					undefined,
					false,
					{
						originalAttachment: {
							signal: controller.signal,
							check: () => {},
							waitFor: async <T>(value: Promise<T>) => value,
							prepare: async () => {
								vi.advanceTimersByTime(cause === 'expire' ? HEADLESS_RUN_TIMEOUT_MS + 1 : 90_000);
								if (cause === 'cancel') controller.abort();
								return {
									path: '/fixture/original.ogg',
									receipt: { filename: 'original.ogg', bytes: 5, sha256: 'a'.repeat(64) },
								};
							},
							handoff: () => {},
						},
					}
				);
				if (cause === 'delay') {
					expect(result.success).toBe(true);
					expect(spawn.mock.calls[0][4]).toMatchObject({
						timeoutMs: HEADLESS_RUN_TIMEOUT_MS - 90_000,
						requireProcessExit: true,
					});
				} else {
					expect(result).toMatchObject({
						success: false,
						error:
							cause === 'cancel'
								? 'Agent run cancelled'
								: 'Agent run stopped: absolute runtime ceiling exceeded',
					});
					expect(spawn).not.toHaveBeenCalled();
				}
				expect(revokeRunToken).toHaveBeenCalledWith('staging-proof');
				expect(removeProof).toHaveBeenCalledWith('/fixture/proof');
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				proof.mockRestore();
				removeProof.mockRestore();
				vi.useRealTimers();
			}
		}
	);
	it.each([true, false])(
		'validates the selected agent binary before dispatch (valid: %s)',
		async (valid) => {
			const probe = vi
				.spyOn(pathProber, 'checkCustomPath')
				.mockResolvedValueOnce({ exists: valid, path: valid ? '/resolved/codex' : undefined });
			try {
				const spawn = vi.fn(async () => ({ success: true, response: 'done' }));
				const detectAgent = vi.fn(async () => ({ available: true, path: '/default/codex' }));
				const issueRunToken = vi.fn();
				const run = createPluginHeadlessAgentRunner({
					getAgent: () => ({ ...agent, customPath: '~/selected/codex' }),
					detectAgent,
					hasPluginTools: () => false,
					spawn,
					prepareSystemPrompt: async () => undefined,
					issueRunToken,
					revokeRunToken: vi.fn(),
					cliScriptPath: () => '/cli.js',
					audit: vi.fn(),
				});
				const result = await run('agent-a', 'hello');
				expect(probe).toHaveBeenCalledWith('~/selected/codex');
				expect(detectAgent).not.toHaveBeenCalled();
				if (valid) {
					expect(result.success).toBe(true);
					expect(spawn).toHaveBeenCalledWith(
						'codex',
						'/project',
						'hello',
						undefined,
						expect.objectContaining({ agentCommand: '/resolved/codex' })
					);
				} else {
					expect(result).toMatchObject({ success: false, error: 'Agent CLI unavailable: codex' });
					expect(spawn).not.toHaveBeenCalled();
					expect(issueRunToken).not.toHaveBeenCalled();
				}
			} finally {
				probe.mockRestore();
			}
		}
	);

	it('forwards live desktop config, binary and global environment independently of session overrides', async () => {
		const spawn = vi.fn(async () => ({ success: true, response: 'done' }));
		const config = { reasoningSummary: 'detailed', customEnvVars: { SHARED: 'agent' } };
		const global = { SHARED: 'global', GLOBAL_ONLY: 'global' };
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => ({ ...agent, customEnvVars: { SHARED: 'session' } }),
			detectAgent: async () => ({ available: true, path: '/desktop/codex' }),
			getAgentConfig: () => config,
			getGlobalEnvVars: () => global,
			hasPluginTools: () => false,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		await run('agent-a', 'hello');
		expect(spawn).toHaveBeenCalledWith(
			'codex',
			'/project',
			'hello',
			undefined,
			expect.objectContaining({
				agentConfigValues: config,
				globalEnvVars: global,
				agentCommand: '/desktop/codex',
				customEnvVars: { SHARED: 'session' },
			})
		);
	});

	it.each([
		{ ...agent, toolType: 'opencode' },
		{ ...agent, sessionSshRemoteConfig: { enabled: true, remoteId: 'remote' } },
		{ ...agent, toolType: 'claude-code', enableMaestroP: true, maestroPMode: 'interactive' },
		{ ...agent, toolType: 'claude-code', enableMaestroP: true, maestroPMode: 'dynamic' },
	])('refuses required plugin tools before spawning an unsupported mode: %j', async (target) => {
		const spawn = vi.fn();
		const issueRunToken = vi.fn();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => target as SessionInfo,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(
			await run('agent-a', 'hello', undefined, undefined, 'user', undefined, undefined, true)
		).toMatchObject({ success: false, error: 'Authenticated plugin tools unavailable' });
		expect(spawn).not.toHaveBeenCalled();
		expect(issueRunToken).not.toHaveBeenCalled();
	});

	it('returns only receipts tied to its issued proof, independent of final prose', async () => {
		const identity = new runIdentity.PluginToolRunIdentity();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn: async (_type, _cwd, prompt, _session, options) => {
				const token = fs.readFileSync(options!.pluginRunProofFile!, 'utf8');
				if (prompt === 'real send') {
					identity.recordReceipt(token, 'sh.maestro.relay/send', { messageIds: ['123'] });
				}
				if (prompt.startsWith('overflow')) {
					for (let index = 0; index < 17; index++) {
						identity.recordReceipt(token, 'sh.maestro.relay/send', {
							messageIds: [String(100 + index)],
						});
					}
				}
				if (prompt === 'overflow failed') {
					return { success: false, error: 'Provider tool loop stopped unexpectedly' };
				}
				return { success: true, response: '{"messageIds":["999"]}' };
			},
			prepareSystemPrompt: async () => undefined,
			issueRunToken: (id, ttl, toolId) => identity.issue(id, ttl, toolId),
			getRunReceipts: (token) => identity.getReceipts(token),
			hasRunReceiptOverflow: (token) => identity.hasReceiptOverflowed(token),
			revokeRunToken: (token) => identity.revoke(token),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		const delivered = await run(
			'agent-a',
			'real send',
			undefined,
			undefined,
			'user',
			undefined,
			'sh.maestro.relay/send'
		);
		expect(delivered.toolReceipts).toEqual([
			{
				runId: expect.stringMatching(/^[0-9a-f]{32}$/),
				agentId: 'agent-a',
				toolId: 'sh.maestro.relay/send',
				messageIds: ['123'],
			},
		]);
		const claimedOnly = await run(
			'agent-a',
			'model only',
			undefined,
			undefined,
			'user',
			undefined,
			'sh.maestro.relay/send'
		);
		expect(claimedOnly.toolReceipts).toEqual([]);
		for (const prompt of ['overflow', 'overflow failed']) {
			const overflow = await run(
				'agent-a',
				prompt,
				undefined,
				undefined,
				'user',
				undefined,
				'sh.maestro.relay/send'
			);
			expect(overflow).toMatchObject({
				success: false,
				response: null,
				error: expect.stringContaining(
					'Plugin tool receipt limit exceeded; inspect recorded receipts before retrying'
				),
			});
			expect(overflow.toolReceipts).toHaveLength(16);
			expect(overflow.toolReceipts?.[0].messageIds).toEqual(['100']);
			expect(overflow.toolReceipts?.[15].messageIds).toEqual(['115']);
			if (prompt === 'overflow failed') {
				expect(overflow.error).toContain('provider error: Provider tool loop stopped unexpectedly');
			}
		}
	});

	it.each(['opencode', 'codex'] as const)(
		'refuses a receipt request for %s without verified injection or an overflow guard',
		async (toolType) => {
			const spawn = vi.fn();
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => ({ ...agent, toolType }),
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => true,
				spawn,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: vi.fn(),
				getRunReceipts: () => [],
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
			});
			expect(
				await run(
					'agent-a',
					'report',
					undefined,
					undefined,
					'user',
					undefined,
					'sh.maestro.relay/send'
				)
			).toMatchObject({ success: false, error: 'Authenticated plugin tool receipt unavailable' });
			expect(spawn).not.toHaveBeenCalled();
		}
	);

	it('keeps Relay as host attribution while marking its provider process unattended', async () => {
		const spawn = vi.fn(async () => ({
			success: true,
			response: 'done',
			agentSessionId: 'relay-1',
		}));
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => false,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		await run('agent-a', 'hello', undefined, undefined, 'relay');
		expect(spawn).toHaveBeenCalledWith(
			'codex',
			'/project',
			'hello',
			undefined,
			expect.objectContaining({ querySource: 'auto' })
		);
	});
	it('retains the configured execution options for a Relay conversation', async () => {
		const configured = {
			...agent,
			customArgs: '--configured-mode',
			customEnvVars: { USER_MODE: 'configured' },
			additionalDirectories: ['/additional'],
			customModel: 'configured-model',
			customEffort: 'high',
		} as SessionInfo;
		const spawn = vi.fn(async () => ({
			success: true,
			response: 'Release discussion',
			agentSessionId: 'provider',
		}));
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => configured,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => false,
			spawn,
			prepareSystemPrompt: async () => 'configured context',
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		await run('agent-a', 'How does a Release work?', 'provider', undefined, 'relay');
		expect(spawn).toHaveBeenCalledWith(
			'codex',
			'/project',
			'How does a Release work?',
			'provider',
			expect.objectContaining({
				customArgs: configured.customArgs,
				customEnvVars: configured.customEnvVars,
				additionalDirectories: configured.additionalDirectories,
				customModel: configured.customModel,
				customEffort: configured.customEffort,
				appendSystemPrompt: 'configured context',
				querySource: 'auto',
			})
		);
		expect(spawn.mock.calls[0][4]).not.toHaveProperty('readOnlyMode');
	});

	it('reports no successful response when a provider exits without final text', async () => {
		const onProgress = vi.fn();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => false,
			spawn: async () => ({ success: true, response: '   ', agentSessionId: 'provider-empty' }),
			prepareSystemPrompt: async () => undefined,
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(await run('agent-a', 'hello', undefined, undefined, 'auto', onProgress)).toMatchObject({
			success: false,
			response: null,
		});
		expect(onProgress).not.toHaveBeenCalled();
	});

	it('keeps two concurrent threads separate, resumes the requested provider session and revokes proofs', async () => {
		const issueRunToken = vi.fn((_id: string) => `proof-${issueRunToken.mock.calls.length}`);
		const revokeRunToken = vi.fn();
		const resolvers: Array<
			(value: { success: true; response: string; agentSessionId: string }) => void
		> = [];
		const spawn = vi.fn(
			() =>
				new Promise<{ success: true; response: string; agentSessionId: string }>((resolve) =>
					resolvers.push(resolve)
				)
		);
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => 'Maestro context',
			issueRunToken,
			revokeRunToken,
			cliScriptPath: () => '/maestro-cli.js',
			audit: vi.fn(),
		});
		const one = run('agent-a', 'thread one');
		const two = run('agent-a', 'thread two');
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
		expect(spawn.mock.calls[0][3]).toBeUndefined();
		expect(spawn.mock.calls[1][3]).toBeUndefined();
		const firstProofFile = spawn.mock.calls[0][4].pluginRunProofFile;
		const secondProofFile = spawn.mock.calls[1][4].pluginRunProofFile;
		expect(firstProofFile).not.toBe(secondProofFile);
		expect(fs.readFileSync(firstProofFile, 'utf8')).toBe('proof-1');
		expect(fs.readFileSync(secondProofFile, 'utf8')).toBe('proof-2');
		resolvers[1]({ success: true, response: 'answer two', agentSessionId: 'provider-two' });
		resolvers[0]({ success: true, response: 'answer one', agentSessionId: 'provider-one' });
		expect(await one).toMatchObject({ response: 'answer one', sessionId: 'provider-one' });
		expect(await two).toMatchObject({ response: 'answer two', sessionId: 'provider-two' });
		const follow = run('agent-a', 'follow', 'provider-one');
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
		expect(spawn.mock.calls[2][3]).toBe('provider-one');
		resolvers[2]({ success: true, response: 'continued', agentSessionId: 'provider-one' });
		expect(await follow).toMatchObject({ response: 'continued', sessionId: 'provider-one' });
		expect(revokeRunToken).toHaveBeenCalledTimes(3);
		expect(fs.existsSync(firstProofFile)).toBe(false);
		expect(fs.existsSync(secondProofFile)).toBe(false);
	});

	it('keeps authenticated tool delivery available through the full six-hour run', async () => {
		vi.useFakeTimers();
		const identity = new runIdentity.PluginToolRunIdentity();
		const issueRunToken = vi.fn((id: string, ttl: number, toolId?: string) =>
			identity.issue(id, ttl, toolId)
		);
		let proofFile: string | undefined;
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn: async (_type, _cwd, _prompt, _session, options) => {
				expect(options!.timeoutMs).toBe(358 * 60_000);
				proofFile = options!.pluginRunProofFile!;
				// Cross the old process/CLI deadlines and approach the new deadline.
				vi.advanceTimersByTime(358 * 60_000 - 1);
				expect(fs.existsSync(proofFile)).toBe(true);
				const token = fs.readFileSync(proofFile, 'utf8');
				expect(identity.resolve(token)).toEqual({ callerAgentId: 'agent-a' });
				identity.recordReceipt(token, 'sh.maestro.relay/send', { messageIds: ['123'] });
				return { success: true, response: 'delivered' };
			},
			prepareSystemPrompt: async () => {
				vi.advanceTimersByTime(120_000);
				return undefined;
			},
			issueRunToken,
			getRunReceipts: (token) => identity.getReceipts(token),
			hasRunReceiptOverflow: (token) => identity.hasReceiptOverflowed(token),
			revokeRunToken: (token) => identity.revoke(token),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		try {
			expect(
				await run(
					'agent-a',
					'report',
					undefined,
					undefined,
					'relay',
					undefined,
					'sh.maestro.relay/send'
				)
			).toMatchObject({
				success: true,
				toolReceipts: [{ agentId: 'agent-a', messageIds: ['123'] }],
			});
			expect(issueRunToken).toHaveBeenCalledWith(
				'agent-a',
				359 * 60_000,
				'sh.maestro.relay/send',
				true
			);
			expect(identity.resolve(issueRunToken.mock.results[0].value)).toEqual({
				callerAgentId: null,
			});
			expect(fs.existsSync(proofFile!)).toBe(false);
		} finally {
			if (proofFile && fs.existsSync(proofFile)) runIdentity.removePluginRunProofFile(proofFile);
			vi.useRealTimers();
		}
	});

	it('preserves the startup recovery error and revokes proof on provider failure', async () => {
		const revokeRunToken = vi.fn();
		const error = 'Codex startup/authentication timed out; check the credential store and retry.';
		const spawn = vi.fn(async () => ({ success: false, error }));
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken: () => 'proof',
			revokeRunToken,
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(await run('agent-a', 'hello')).toEqual({
			success: false,
			response: null,
			sessionId: null,
			usageStats: undefined,
			error,
		});
		expect(spawn.mock.calls[0][4].timeoutMs).toBeLessThanOrEqual(6 * 60 * 60_000);
		expect(spawn.mock.calls[0][4].timeoutMs).toBeGreaterThan(359 * 60_000);
		expect(revokeRunToken).toHaveBeenCalledWith('proof');
	});

	it('revokes the token even when proof-file cleanup fails', async () => {
		const revokeRunToken = vi.fn();
		const createProof = vi.spyOn(runIdentity, 'createPluginRunProofFile').mockReturnValue('/proof');
		const removeProof = vi.spyOn(runIdentity, 'removePluginRunProofFile').mockImplementation(() => {
			expect(revokeRunToken).toHaveBeenCalledWith('proof');
			throw new Error('cleanup denied');
		});
		try {
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => agent,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => true,
				spawn: async () => ({ success: true, response: 'answer' }),
				prepareSystemPrompt: async () => undefined,
				issueRunToken: () => 'proof',
				revokeRunToken,
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
			});
			await expect(run('agent-a', 'hello')).resolves.toMatchObject({
				success: true,
				response: 'answer',
			});
			expect(revokeRunToken).toHaveBeenCalledOnce();
		} finally {
			createProof.mockRestore();
			removeProof.mockRestore();
		}
	});

	it('fails clearly before minting a proof when the configured provider is absent', async () => {
		const issueRunToken = vi.fn();
		const spawn = vi.fn();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: false }),
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		const result = await run('agent-a', 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Agent CLI unavailable/);
		expect(issueRunToken).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it('does not require a local provider binary for an SSH agent', async () => {
		const remoteAgent = {
			...agent,
			sessionSshRemoteConfig: { enabled: true },
		} as SessionInfo;
		const detectAgent = vi.fn(async () => ({ available: false }));
		const issueRunToken = vi.fn();
		const spawn = vi.fn(async () => ({
			success: true,
			response: 'remote answer',
			agentSessionId: 'remote-session',
		}));
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => remoteAgent,
			detectAgent,
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(await run('agent-a', 'hello')).toMatchObject({
			success: true,
			response: 'remote answer',
			sessionId: 'remote-session',
		});
		expect(detectAgent).not.toHaveBeenCalled();
		expect(issueRunToken).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledOnce();
	});

	// `maestro-cli send` through the desktop: the CLI admitted the send against a
	// consult chain, but this process spawns the agent, so the chain reaches the
	// agent's environment only if the runner passes it on.
	describe('a send admitted against a consult chain', () => {
		function harness() {
			const spawn = vi.fn(async () => ({
				success: true,
				response: 'done',
				agentSessionId: 'sess-new',
			}));
			const prepareSystemPrompt = vi.fn(async () => undefined);
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => agent,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => false,
				spawn: spawn as never,
				prepareSystemPrompt,
				issueRunToken: () => 'token',
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
				resolveAutoTurn: vi.fn() as never,
				noteAutoSessionLaunch: vi.fn(),
			});
			return {
				run,
				prepareSystemPrompt,
				spawnOptions: () => spawn.mock.calls[0][4] as Record<string, unknown>,
			};
		}

		it('spawns the agent at the place in the chain the send was admitted at', async () => {
			const { run, spawnOptions } = harness();
			const consultChain = { chainId: 'chain-a', depth: 2 };

			await run(
				'agent-a',
				'what do you think?',
				undefined,
				undefined,
				'user',
				undefined,
				undefined,
				false,
				{
					consultChain,
				}
			);

			expect(spawnOptions()).toMatchObject({ consultChain });
		});

		it('states no chain for a turn that carries none', async () => {
			const { run, spawnOptions } = harness();

			await run('agent-a', 'what do you think?', undefined, undefined, 'user');

			expect('consultChain' in spawnOptions()).toBe(false);
		});

		// So the prompt can state what is left of the chain's budget.
		it('builds the system prompt with the chain the turn was admitted at', async () => {
			const { run, prepareSystemPrompt } = harness();
			const consultChain = { chainId: 'chain-a', depth: 2 };

			await run('agent-a', 'q', undefined, undefined, 'user', undefined, undefined, false, {
				consultChain,
			});
			expect(prepareSystemPrompt).toHaveBeenLastCalledWith(agent, consultChain);

			await run('agent-a', 'q', undefined, undefined, 'user');
			expect(prepareSystemPrompt).toHaveBeenLastCalledWith(agent, undefined);
		});
	});

	// A send to an agent set to the Auto model: the turn is routed here, in the
	// process that owns the router, and the harness is never handed the word.
	describe('an agent on the Auto model', () => {
		const autoAgent = {
			...agent,
			toolType: 'claude-code',
			customModel: 'auto',
			customEffort: 'high',
		};
		const local = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };

		function harness(
			turn: Record<string, unknown>,
			overrides: Partial<Parameters<typeof createPluginHeadlessAgentRunner>[0]> = {}
		) {
			const spawn = vi.fn(async () => ({
				success: true,
				response: 'done',
				agentSessionId: 'sess-new',
			}));
			// A resolved Auto turn always carries its stamp: the reply reports it.
			const resolveAutoTurn = vi.fn(async () => ({
				notes: [],
				warnings: [],
				stamp: { status: 'routed' },
				...turn,
			}));
			const noteAutoSessionLaunch = vi.fn();
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => autoAgent as SessionInfo,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => false,
				spawn: spawn as never,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: () => 'token',
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
				resolveAutoTurn: resolveAutoTurn as never,
				noteAutoSessionLaunch,
				...overrides,
			});
			return { run, spawn, resolveAutoTurn, noteAutoSessionLaunch };
		}
		const spawnOptions = (spawn: ReturnType<typeof vi.fn>) => spawn.mock.calls[0][4];

		it('asks for the turn to be routed and launches on the model and effort it resolves to', async () => {
			const { run, spawn, resolveAutoTurn } = harness({ model: 'haiku', effort: 'low' });

			const reply = await run('agent-a', 'rename the helper');

			expect(reply.success).toBe(true);
			expect(resolveAutoTurn).toHaveBeenCalledWith({
				agent: autoAgent,
				prompt: 'rename the helper',
			});
			expect(spawnOptions(spawn)).toMatchObject({ customModel: 'haiku', customEffort: 'low' });
			expect('runOn' in spawnOptions(spawn)).toBe(false);
		});

		it('never passes the word auto: no decision is no model at all', async () => {
			const { run, spawn } = harness({ model: undefined, effort: 'high' });

			await run('agent-a', 'rename the helper');

			expect(spawnOptions(spawn).customModel).toBeUndefined();
			expect(spawnOptions(spawn).customEffort).toBe('high');
		});

		it('launches on the place the tier names', async () => {
			const { run, spawn } = harness({ model: 'qwen3.5-4b', runOn: local });

			await run('agent-a', 'rename the helper');

			expect(spawnOptions(spawn)).toMatchObject({ customModel: 'qwen3.5-4b', runOn: local });
		});

		it('names the provider session a send resumes, so the session can keep its model', async () => {
			const stop = new AbortController();
			const { run, resolveAutoTurn } = harness({ model: 'haiku' });

			await run('agent-a', 'and the tests', 'sess-1', stop.signal);

			expect(resolveAutoTurn).toHaveBeenCalledWith({
				agent: autoAgent,
				prompt: 'and the tests',
				providerSessionId: 'sess-1',
				signal: stop.signal,
			});
		});

		it('records what the session ran on once the provider has named it', async () => {
			const turn = { model: 'haiku', effort: 'low' };
			const { run, noteAutoSessionLaunch } = harness(turn);

			await run('agent-a', 'rename the helper');

			expect(noteAutoSessionLaunch).toHaveBeenCalledWith(
				'claude-code',
				'sess-new',
				expect.objectContaining(turn)
			);
		});

		it('records Auto routing and relay origin for the same provider session', async () => {
			const recordRelayOrigin = vi.fn();
			const turn = { model: 'haiku', effort: 'low' };
			const { run, noteAutoSessionLaunch } = harness(turn, { recordRelayOrigin });

			const reply = await run('agent-a', 'rename the helper', undefined, undefined, 'relay');

			expect(reply.success).toBe(true);
			expect(noteAutoSessionLaunch).toHaveBeenCalledWith(
				'claude-code',
				'sess-new',
				expect.objectContaining(turn)
			);
			expect(recordRelayOrigin).toHaveBeenCalledWith(autoAgent, 'sess-new');
		});

		it('keeps relay origin if recording the Auto launch throws', async () => {
			const recordRelayOrigin = vi.fn();
			const { run } = harness(
				{ model: 'haiku' },
				{
					recordRelayOrigin,
					noteAutoSessionLaunch: () => {
						throw new Error('Auto launch was not recorded');
					},
				}
			);

			await expect(
				run('agent-a', 'rename the helper', undefined, undefined, 'relay')
			).rejects.toThrow('Auto launch was not recorded');
			expect(recordRelayOrigin).toHaveBeenCalledWith(autoAgent, 'sess-new');
		});

		it('fails the send by name, and spawns nothing, when the tier target cannot be used', async () => {
			const { run, spawn, noteAutoSessionLaunch } = harness({
				refusal: {
					code: 'tier-unsupported-source',
					message: 'This agent\'s "low" tier target cannot run.',
				},
			});

			const reply = await run('agent-a', 'rename the helper');

			expect(reply).toEqual({
				success: false,
				response: null,
				sessionId: null,
				error: 'This agent\'s "low" tier target cannot run.',
			});
			expect(spawn).not.toHaveBeenCalled();
			expect(noteAutoSessionLaunch).not.toHaveBeenCalled();
		});

		it('routes nothing for an agent on a named model', async () => {
			const named = { ...autoAgent, customModel: 'opus' };
			const { run, spawn, resolveAutoTurn, noteAutoSessionLaunch } = harness(
				{ model: 'haiku' },
				{ getAgent: () => named as SessionInfo }
			);

			await run('agent-a', 'rename the helper');

			expect(resolveAutoTurn).not.toHaveBeenCalled();
			expect(noteAutoSessionLaunch).not.toHaveBeenCalled();
			expect(spawnOptions(spawn)).toMatchObject({ customModel: 'opus', customEffort: 'high' });
		});

		it('reports what Auto did with the turn: how its pill reads, and who decided', async () => {
			const stamp = {
				status: 'routed' as const,
				route: {
					tier: 'low' as const,
					effort: 'low' as const,
					engine: 'Embedding router',
					calibrated: false,
				},
			};
			const { run } = harness({ model: 'haiku', effort: 'low', stamp });

			const reply = await run('agent-a', 'rename the helper');

			expect(reply.auto).toEqual(autoTurnReport({ model: 'haiku', stamp }));
			expect(reply.auto).toEqual({
				label: 'Auto → low · haiku',
				detail: expect.stringContaining('Embedding router chose tier low, effort low.'),
			});
		});

		it('reports a turn the router did not decide, which still runs', async () => {
			const stamp = {
				status: 'router-off' as const,
				route: { skipped: 'off' as const, detail: 'The model-routing task is off.' },
			};
			const { run, spawn } = harness({ model: undefined, effort: 'high', stamp });

			const reply = await run('agent-a', 'rename the helper');

			expect(reply.success).toBe(true);
			expect(spawn).toHaveBeenCalledOnce();
			expect(reply.auto).toEqual({
				label: 'Auto (router off)',
				detail: expect.stringContaining('The model-routing task is off.'),
			});
		});

		// `turn.model` is this one turn's model (`maestro-cli send --model`), in
		// place of the agent's own. The ninth argument, after `requirePluginTools`.
		describe('with a model for this one turn', () => {
			const named = { ...autoAgent, customModel: 'opus' };
			const send = (run: ReturnType<typeof harness>['run'], turn?: { model?: string }) =>
				run(
					'agent-a',
					'rename the helper',
					undefined,
					undefined,
					'user',
					undefined,
					undefined,
					false,
					turn
				);

			it("spawns on the named model in place of the agent's own, and asks no router", async () => {
				const { run, spawn, resolveAutoTurn, noteAutoSessionLaunch } = harness(
					{ model: 'haiku' },
					{ getAgent: () => named as SessionInfo }
				);

				const reply = await send(run, { model: 'sonnet' });

				expect(resolveAutoTurn).not.toHaveBeenCalled();
				expect(noteAutoSessionLaunch).not.toHaveBeenCalled();
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'sonnet', customEffort: 'high' });
				expect(reply.success).toBe(true);
				expect(reply).not.toHaveProperty('auto');
			});

			it('keeps the named model for this turn even when the agent is set to Auto', async () => {
				const { run, spawn, resolveAutoTurn } = harness({ model: 'haiku' });

				const reply = await send(run, { model: 'sonnet' });

				expect(resolveAutoTurn).not.toHaveBeenCalled();
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'sonnet' });
				expect(reply).not.toHaveProperty('auto');
			});

			it('routes an auto turn for an agent on a named model, and reports it', async () => {
				const { run, spawn, resolveAutoTurn, noteAutoSessionLaunch } = harness(
					{ model: 'haiku', effort: 'low' },
					{ getAgent: () => named as SessionInfo }
				);

				const reply = await send(run, { model: 'auto' });

				expect(resolveAutoTurn).toHaveBeenCalledWith({
					agent: named,
					prompt: 'rename the helper',
				});
				// The harness is handed the routed model, never the word and never the agent's own.
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'haiku', customEffort: 'low' });
				expect(noteAutoSessionLaunch).toHaveBeenCalledWith(
					'claude-code',
					'sess-new',
					expect.objectContaining({ model: 'haiku' })
				);
				expect(reply.auto).toEqual({
					label: expect.stringMatching(/^Auto/),
					detail: expect.stringMatching(/^Auto/),
				});
				expect(reply.auto?.label).toContain('haiku');
			});

			it.each([[undefined], [{}]])(
				"runs on the agent's own model when no turn model is given (%j)",
				async (turn) => {
					const { run, spawn, resolveAutoTurn } = harness(
						{ model: 'haiku' },
						{ getAgent: () => named as SessionInfo }
					);

					const reply = await send(run, turn);

					expect(resolveAutoTurn).not.toHaveBeenCalled();
					expect(spawnOptions(spawn)).toMatchObject({ customModel: 'opus', customEffort: 'high' });
					expect(reply).not.toHaveProperty('auto');
				}
			);

			it('still routes an agent set to Auto when no turn model is given', async () => {
				const { run, spawn, resolveAutoTurn } = harness({ model: 'haiku' });

				const reply = await send(run, undefined);

				expect(resolveAutoTurn).toHaveBeenCalledOnce();
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'haiku' });
				expect(reply.auto).toBeDefined();
			});
		});
	});
});

describe('headless activity is live process evidence', () => {
	it('counts parallel Relay turns independently without touching desktop tabs', async () => {
		const liveDesktop = new Set<string>();
		const probe = { get: (id: string) => (liveDesktop.has(id) ? {} : undefined) };
		const target = { ...agent, activeTabId: 'desktop', aiTabs: [{ id: 'desktop' }] };
		const runs: Array<{
			options: SpawnAgentOptions & { onProcessStarted?: (pid: number | undefined) => void };
			finish: (value: { success: boolean; response: string }) => void;
		}> = [];
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => target as SessionInfo,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => false,
			spawn: async (_type, _cwd, _prompt, _session, options) =>
				new Promise((finish) => runs.push({ options: options!, finish })),
			prepareSystemPrompt: async () => undefined,
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(isAgentBusy(target, probe)).toBe(false);
		const first = run(agent.id, 'one', undefined, undefined, 'relay');
		const second = run(agent.id, 'two', undefined, undefined, 'relay');
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		// Dispatch/preparation/queue presence alone is not evidence of a process.
		expect(isAgentBusy(target, probe)).toBe(false);
		try {
			runs[0].options.onProcessStarted?.(101);
			runs[0].options.onProcessStarted?.(101); // duplicate start
			runs[1].options.onProcessStarted?.(102);
			expect(isAgentBusy(target, probe)).toBe(true);
			expect(isAgentBusy({ id: 'other-agent' }, probe)).toBe(false);
			runs[0].finish({ success: true, response: 'done' });
			await first;
			expect(isAgentBusy(target, probe)).toBe(true);
			liveDesktop.add(`${agent.id}-ai-desktop`);
			runs[1].finish({ success: true, response: 'done' });
			await second;
			expect(isAgentBusy(target, probe)).toBe(true);
			liveDesktop.clear();
			expect(isAgentBusy(target, probe)).toBe(false);
			runs[0].options.onProcessStarted?.(101); // late start cannot revive it
			expect(isAgentBusy(target, probe)).toBe(false);
		} finally {
			for (const r of runs) r.finish({ success: true, response: 'cleanup' });
			await Promise.all([first, second]);
		}
	});
});

describe('headless lifecycle terminal paths', () => {
	it.each(['success', 'error', 'timeout', 'cancel', 'plugin-stop', 'throw'] as const)(
		'releases only its own process on %s and ignores late starts',
		async (outcome) => {
			const controller = new AbortController();
			const recordRelayOrigin = vi.fn();
			let started!: (pid: number | undefined) => void;
			let end!: () => void;
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => agent,
				recordRelayOrigin,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => false,
				spawn: async (_type, _cwd, _prompt, _session, options) => {
					started = (
						options as SpawnAgentOptions & { onProcessStarted: (pid: number | undefined) => void }
					).onProcessStarted;
					started?.(301);
					await new Promise<void>((resolve) => {
						end = resolve;
					});
					if (outcome === 'throw') throw new Error('spawn failure');
					return outcome === 'success'
						? { success: true, response: 'done', agentSessionId: 'relay-conversation' }
						: { success: false, error: outcome, agentSessionId: 'relay-conversation' };
				},
				prepareSystemPrompt: async () => undefined,
				issueRunToken: vi.fn(),
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
			});
			const pending = run(agent.id, 'hello', undefined, controller.signal, 'relay');
			await vi.waitFor(() => expect(end).toBeTypeOf('function'));
			try {
				expect(isAgentBusy(agent, undefined)).toBe(true);
				if (outcome === 'cancel' || outcome === 'plugin-stop') {
					controller.abort();
					expect(isAgentBusy(agent, undefined)).toBe(true);
				}
				end();
				if (outcome === 'throw') await expect(pending).rejects.toThrow('spawn failure');
				else {
					await pending;
					expect(recordRelayOrigin).toHaveBeenCalledExactlyOnceWith(agent, 'relay-conversation');
				}
				expect(isAgentBusy(agent, undefined)).toBe(false);
				started?.(301);
				expect(isAgentBusy(agent, undefined)).toBe(false);
			} finally {
				end();
				await pending.catch(() => {});
			}
		}
	);
});

describe('cancelled preparation', () => {
	it('ignores its first delayed start after cancellation', async () => {
		const controller = new AbortController();
		const runs: Array<{
			options: SpawnAgentOptions;
			finish: (value: { success: boolean; response: string }) => void;
		}> = [];
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => false,
			spawn: async (_type, _cwd, _prompt, _session, options) =>
				new Promise((finish) => runs.push({ options: options!, finish })),
			prepareSystemPrompt: async () => undefined,
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		const pending = run(agent.id, 'cancelled', undefined, controller.signal, 'relay');
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		controller.abort();
		try {
			runs[0].options.onProcessStarted?.(401);
			expect(isAgentBusy(agent, undefined)).toBe(false);
		} finally {
			runs[0].finish({ success: true, response: 'late' });
			await pending;
		}
	});
});

it('retains known Relay provenance when cancelled before provider spawn', async () => {
	const controller = new AbortController();
	const recordRelayOrigin = vi.fn();
	const spawn = vi.fn();
	const run = createPluginHeadlessAgentRunner({
		getAgent: () => agent,
		detectAgent: async () => {
			controller.abort();
			return { available: true };
		},
		hasPluginTools: () => false,
		spawn,
		recordRelayOrigin,
		prepareSystemPrompt: async () => undefined,
		issueRunToken: vi.fn(),
		revokeRunToken: vi.fn(),
		cliScriptPath: () => '/cli.js',
		audit: vi.fn(),
	});
	expect(
		await run(agent.id, 'resume', 'known-conversation', controller.signal, 'relay')
	).toMatchObject({ success: false });
	expect(spawn).not.toHaveBeenCalled();
	expect(isAgentBusy(agent, undefined)).toBe(false);
	expect(recordRelayOrigin).toHaveBeenCalledExactlyOnceWith(agent, 'known-conversation');
});

it.each(['success', 'error', 'throw', 'cancel-before-spawn'] as const)(
	'reports the original provenance exception without replacing %s or delaying security cleanup',
	async (outcome) => {
		const provenanceError = new Error('Origin store write failed');
		const providerError = new Error('Provider failed');
		const controller = new AbortController();
		const identity = new runIdentity.PluginToolRunIdentity();
		const issueRunToken = vi.fn((id: string, ttl: number) => identity.issue(id, ttl));
		let proofFile: string | undefined;
		let finishReporting!: () => void;
		const reporter = vi.mocked(captureException);
		reporter.mockReset().mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishReporting = resolve;
			})
		);
		const recordRelayOrigin = vi.fn(() => {
			expect(isAgentBusy(agent, undefined)).toBe(false);
			throw provenanceError;
		});
		const spawn = vi.fn<PluginHeadlessRunnerDeps['spawn']>(
			async (_type, _cwd, _prompt, _session, options) => {
				proofFile = options!.pluginRunProofFile;
				options!.onProcessStarted?.(501);
				expect(isAgentBusy(agent, undefined)).toBe(true);
				const token = fs.readFileSync(proofFile!, 'utf8');
				expect(identity.resolve(token)).toEqual({ callerAgentId: agent.id });
				if (outcome === 'throw') throw providerError;
				return outcome === 'success'
					? { success: true, response: 'answer', agentSessionId: 'conversation' }
					: { success: false, error: 'provider timeout', agentSessionId: 'conversation' };
			}
		);
		const removeProof = vi.spyOn(runIdentity, 'removePluginRunProofFile');
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => {
				if (outcome === 'cancel-before-spawn') controller.abort();
				return { available: true };
			},
			hasPluginTools: () => true,
			spawn,
			recordRelayOrigin,
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			revokeRunToken: (token) => identity.revoke(token),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		try {
			const pending = run(agent.id, 'hello', 'conversation', controller.signal, 'relay');
			if (outcome === 'throw') await expect(pending).rejects.toBe(providerError);
			else if (outcome === 'cancel-before-spawn') {
				await expect(pending).resolves.toEqual({
					success: false,
					response: null,
					sessionId: null,
					error: 'Agent run cancelled',
				});
				expect(spawn).not.toHaveBeenCalled();
			} else {
				await expect(pending).resolves.toEqual({
					success: outcome === 'success',
					response: outcome === 'success' ? 'answer' : null,
					sessionId: 'conversation',
					usageStats: undefined,
					...(outcome === 'error' ? { error: 'provider timeout' } : {}),
				});
			}
			// Reporting is still pending: it must not hold the turn or its authority open.
			expect(isAgentBusy(agent, undefined)).toBe(false);
			if (outcome === 'cancel-before-spawn') {
				expect(issueRunToken).not.toHaveBeenCalled();
				expect(removeProof).not.toHaveBeenCalled();
			} else {
				expect(identity.resolve(issueRunToken.mock.results[0].value)).toEqual({
					callerAgentId: null,
				});
				expect(removeProof).toHaveBeenCalledOnce();
				proofFile = removeProof.mock.calls[0][0];
				expect(fs.existsSync(proofFile)).toBe(false);
			}
			expect(recordRelayOrigin).toHaveBeenCalledExactlyOnceWith(agent, 'conversation');
			expect(reporter).toHaveBeenCalledExactlyOnceWith(provenanceError, {
				operation: 'plugin-headless.recordRelayOrigin',
			});
			expect(reporter.mock.calls[0][0]).toBe(provenanceError);
		} finally {
			finishReporting();
			reporter.mockReset();
			removeProof.mockRestore();
			if (proofFile && fs.existsSync(proofFile)) runIdentity.removePluginRunProofFile(proofFile);
		}
	}
);

it.each([
	['custom binary', 'cancel'],
	['custom binary', 'deadline'],
	['detection', 'cancel'],
	['detection', 'deadline'],
	['prompt', 'cancel'],
	['prompt', 'deadline'],
] as const)('bounds stalled %s preparation by %s without late authority', async (stage, stop) => {
	vi.useFakeTimers();
	const controller = new AbortController();
	let finish!: () => void;
	const stalled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const customProbe =
		stage === 'custom binary'
			? vi.spyOn(pathProber, 'checkCustomPath').mockImplementationOnce(async () => {
					await stalled;
					return { exists: true, path: '/resolved/codex' };
				})
			: undefined;
	const spawn = vi.fn();
	const issueRunToken = vi.fn();
	const prepareSystemPrompt = vi.fn(async () => {
		if (stage === 'prompt') await stalled;
		return undefined;
	});
	const run = createPluginHeadlessAgentRunner({
		getAgent: () => (stage === 'custom binary' ? { ...agent, customPath: '~/codex' } : agent),
		detectAgent: async () => {
			if (stage === 'detection') await stalled;
			return { available: true };
		},
		hasPluginTools: () => true,
		spawn,
		prepareSystemPrompt,
		issueRunToken,
		revokeRunToken: vi.fn(),
		cliScriptPath: () => '/cli.js',
		audit: vi.fn(),
	});
	try {
		const pending = run(agent.id, 'hello', undefined, controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		if (stop === 'cancel') controller.abort();
		else await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		const result = await Promise.race([
			pending,
			Promise.resolve().then(() => Promise.resolve('still waiting')),
		]);
		expect(result).toMatchObject({
			success: false,
			error:
				stop === 'cancel'
					? 'Agent run cancelled'
					: 'Agent run stopped: absolute runtime ceiling exceeded',
		});
		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(spawn).not.toHaveBeenCalled();
		expect(issueRunToken).not.toHaveBeenCalled();
		if (stage !== 'prompt') expect(prepareSystemPrompt).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		finish();
		customProbe?.mockRestore();
		vi.useRealTimers();
	}
});

it.each(['user', 'auto', 'relay'] as const)(
	'stamps %s provenance before exposing a headless proof',
	async (origin) => {
		const identity = new runIdentity.PluginToolRunIdentity();
		const modes: boolean[] = [];
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn: async () => ({ success: true, response: 'synthetic' }),
			prepareSystemPrompt: async () => undefined,
			issueRunToken: (id, ttl, receiptToolId, unattended) => {
				const token = identity.issue(id, ttl, receiptToolId, unattended);
				modes.push(identity.resolveVerified(token).unattended === true);
				return token;
			},
			revokeRunToken: (token) => identity.revoke(token),
			cliScriptPath: () => '/synthetic/cli.js',
			audit: () => {},
		});
		try {
			expect(
				(await run('agent-a', 'synthetic request', undefined, undefined, origin)).success
			).toBe(true);
			expect(modes).toEqual([origin !== 'user']);
		} finally {
			identity.stop();
		}
	}
);
