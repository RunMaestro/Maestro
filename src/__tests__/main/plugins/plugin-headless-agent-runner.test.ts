import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
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
		expect(spawn.mock.calls[0][4].timeoutMs).toBe(20 * 60_000);
		expect(revokeRunToken).toHaveBeenCalledWith('proof');
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
