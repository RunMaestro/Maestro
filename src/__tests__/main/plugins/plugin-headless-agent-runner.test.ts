import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as pathProber from '../../../main/agents/path-prober';
import * as runIdentity from '../../../main/plugins/plugin-tool-run-identity';
import type { SessionInfo } from '../../../shared/types';
import { createPluginHeadlessAgentRunner } from '../../../main/plugins/plugin-headless-agent-runner';

const agent = {
	id: 'agent-a',
	name: 'A',
	toolType: 'codex',
	cwd: '/project',
	projectRoot: '/project',
} as SessionInfo;

describe('plugin headless agent runner', () => {
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
				return { success: true, response: '{"messageIds":["999"]}' };
			},
			prepareSystemPrompt: async () => undefined,
			issueRunToken: (id, ttl, toolId) => identity.issue(id, ttl, toolId),
			getRunReceipts: (token) => identity.getReceipts(token),
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
	});

	it('refuses a receipt request for an agent without verified MCP injection', async () => {
		const spawn = vi.fn();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => ({ ...agent, toolType: 'opencode' }),
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
	});

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

	it('keeps authenticated tool delivery available through the full 60-minute run', async () => {
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
				expect(options!.timeoutMs).toBe(60 * 60_000);
				proofFile = options!.pluginRunProofFile!;
				// Cross the old process/CLI deadlines and approach the new deadline.
				vi.advanceTimersByTime(60 * 60_000 - 1);
				expect(fs.existsSync(proofFile)).toBe(true);
				const token = fs.readFileSync(proofFile, 'utf8');
				expect(identity.resolve(token)).toEqual({ callerAgentId: 'agent-a' });
				identity.recordReceipt(token, 'sh.maestro.relay/send', { messageIds: ['123'] });
				return { success: true, response: 'delivered' };
			},
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			getRunReceipts: (token) => identity.getReceipts(token),
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
			expect(issueRunToken).toHaveBeenCalledWith('agent-a', 61 * 60_000, 'sh.maestro.relay/send');
			expect(identity.resolve(issueRunToken.mock.results[0].value)).toEqual({
				callerAgentId: null,
			});
			expect(fs.existsSync(proofFile!)).toBe(false);
		} finally {
			if (proofFile && fs.existsSync(proofFile)) runIdentity.removePluginRunProofFile(proofFile);
			vi.useRealTimers();
		}
	});

	it('sets a finite timeout and revokes proof on provider failure', async () => {
		const revokeRunToken = vi.fn();
		const spawn = vi.fn(async () => ({ success: false, error: 'timed out' }));
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
			error: 'timed out',
		});
		expect(spawn.mock.calls[0][4].timeoutMs).toBe(60 * 60_000);
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
});
