/**
 * @file update-agent.test.ts
 * @description Tests for the update-agent CLI command (group + cwd mutation).
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import path from 'path';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	resolveGroupId: vi.fn(),
	getSessionById: vi.fn(),
	// The saved sources `--run-on`, `--tier` and `--background-requests` are
	// checked against.
	readLocalModelEndpoints: vi.fn(() => [
		{
			id: 'ep-ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		},
		{
			id: 'ep-cloud',
			name: 'OpenRouter',
			kind: 'openai-compatible',
			baseUrl: 'https://openrouter.ai/api/v1',
			enabled: true,
		},
	]),
	// The harness tier defaults `--model auto` is judged against.
	readHarnessTierDefaults: vi.fn(() => ({})),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { updateAgent } from '../../../cli/commands/update-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import {
	resolveAgentId,
	resolveGroupId,
	getSessionById,
	readHarnessTierDefaults,
} from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('update-agent command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('errors when no mutable field is provided', async () => {
		await updateAgent('agent-1', {});

		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('Specify at least one field to update')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('sends move_session_to_group when --group is provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'move_session_to_group_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp' });

		expect(resolveAgentId).toHaveBeenCalledWith('agent-1');
		expect(resolveGroupId).toHaveBeenCalledWith('grp');
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'move_session_to_group',
				sessionId: 'full-session-id',
				groupId: 'full-group-id',
			}),
			'move_session_to_group_result'
		);
		expect(formatSuccess).toHaveBeenCalledWith('Updated agent full-session-id');
	});

	it('treats --group none as ungroup (null) without calling resolveGroupId', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'move_session_to_group_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'none' });

		expect(resolveGroupId).not.toHaveBeenCalled();
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'move_session_to_group', groupId: null }),
			'move_session_to_group_result'
		);
	});

	it('sends update_session_cwd with absolute resolved path', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_cwd_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { cwd: '/tmp/some/path' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_cwd',
				sessionId: 'full-session-id',
				newCwd: path.resolve('/tmp/some/path'),
			}),
			'update_session_cwd_result'
		);
	});

	it('sends update_session_ssh enabling a remote with --ssh-remote and --ssh-cwd', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { sshRemote: 'remote-7', sshCwd: '/srv/app' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sessionId: 'full-session-id',
				sshPatch: { enabled: true, remoteId: 'remote-7', workingDirOverride: '/srv/app' },
			}),
			'update_session_ssh_result'
		);
	});

	it('treats --ssh-remote none as reverting to local (enabled:false, remoteId:null)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { sshRemote: 'none' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sshPatch: { enabled: false, remoteId: null },
			}),
			'update_session_ssh_result'
		);
	});

	it('maps --sync-history-to-remote to a syncHistory-only patch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { syncHistoryToRemote: 'true' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sshPatch: { syncHistory: true },
			}),
			'update_session_ssh_result'
		);
	});

	it('sends update_session_config for editable settings (nudge, model, env)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', {
			nudge: 'stay focused',
			model: 'opus',
			env: ['FOO=bar', 'BAZ=qux'],
		});

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				sessionId: 'full-session-id',
				configPatch: {
					nudgeMessage: 'stay focused',
					customModel: 'opus',
					customEnvVars: { FOO: 'bar', BAZ: 'qux' },
				},
			}),
			'update_session_config_result'
		);
	});

	it('maps an empty-string text field to a null clear in the config patch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { nudge: '' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { nudgeMessage: null },
			}),
			'update_session_config_result'
		);
	});

	it('encodes --token-source tui as the enableMaestroP/maestroPMode pair', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { tokenSource: 'tui' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { enableMaestroP: true, maestroPMode: 'interactive' },
			}),
			'update_session_config_result'
		);
	});

	it('sends bookmarked in the config patch for --bookmark', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { bookmark: 'true' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { bookmarked: true },
			}),
			'update_session_config_result'
		);
	});

	it('sends bookmarked:false for --bookmark false rather than dropping the key', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { bookmark: 'no' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ configPatch: { bookmarked: false } }),
			'update_session_config_result'
		);
	});

	it('rejects a non-boolean --bookmark value before contacting the app', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { bookmark: 'maybe' });

		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--bookmark expects'));
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('rejects an invalid --token-source value before contacting the app', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { tokenSource: 'bogus' });

		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--token-source expects'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('rejects --token-source on a non-Claude agent', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'codex',
		} as never);
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { tokenSource: 'tui' });

		// The guard fires before any send (in production process.exit terminates;
		// the test's exit mock is a no-op, so we assert the guard itself fired).
		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('only applies to Claude Code agents')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	describe('--gateway-url', () => {
		function mockAgent(toolType: string) {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			vi.mocked(getSessionById).mockReturnValue({ id: 'full-session-id', toolType } as never);
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		it('sends the normalized URL in the config patch', async () => {
			const sendCommand = mockAgent('claude-code');

			await updateAgent('agent-1', { gatewayUrl: ' http://127.0.0.1:8787/anthropic/ ' });

			expect(sendCommand).toHaveBeenCalledWith(
				{
					type: 'update_session_config',
					sessionId: 'full-session-id',
					configPatch: { gatewayUrl: 'http://127.0.0.1:8787/anthropic' },
				},
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith('  Gateway URL: http://127.0.0.1:8787/anthropic');
		});

		it.each(['none', 'NONE', ''])('clears the gateway for %j', async (value) => {
			const sendCommand = mockAgent('claude-code');

			await updateAgent('agent-1', { gatewayUrl: value });

			expect(sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ configPatch: { gatewayUrl: null } }),
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith('  Gateway URL: (cleared)');
		});

		it('refuses a provider that cannot use a gateway, with the reason', async () => {
			mockAgent('copilot-cli');

			await updateAgent('agent-1', { gatewayUrl: 'http://127.0.0.1:8787' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('ignores base-URL variables')
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('refuses a value that is not a URL', async () => {
			mockAgent('codex');

			await updateAgent('agent-1', { gatewayUrl: 'nope' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--gateway-url:'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('still clears a gateway left on a provider that cannot use one', async () => {
			const sendCommand = mockAgent('copilot-cli');

			await updateAgent('agent-1', { gatewayUrl: 'none' });

			expect(formatError).not.toHaveBeenCalled();
			expect(sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ configPatch: { gatewayUrl: null } }),
				'update_session_config_result'
			);
		});
	});

	describe('--proxy-mode', () => {
		function mockAgent() {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			vi.mocked(getSessionById).mockReturnValue({
				id: 'full-session-id',
				toolType: 'claude-code',
			} as never);
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		it.each([
			['off', 'off'],
			['passthrough', 'passthrough'],
			[' Compress ', 'compress'],
		])('sends %j as the mode for the app to apply', async (value, mode) => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { proxyMode: value });

			// The app chooses the gateway URL the mode implies; the CLI sends
			// only the mode.
			expect(sendCommand).toHaveBeenCalledWith(
				{
					type: 'update_session_config',
					sessionId: 'full-session-id',
					configPatch: { tokenProxyMode: mode },
				},
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith(`  Token proxy mode: ${mode}`);
		});

		it('refuses a mode that is not one of the three, before it reaches the app', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { proxyMode: 'on' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('--proxy-mode expects off, passthrough, compress')
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(sendCommand).not.toHaveBeenCalledWith(
				expect.objectContaining({ configPatch: expect.anything() }),
				'update_session_config_result'
			);
		});

		it('refuses to be combined with --gateway-url: the mode chooses the URL', async () => {
			mockAgent();

			await updateAgent('agent-1', { proxyMode: 'compress', gatewayUrl: 'http://127.0.0.1:1' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('Use --proxy-mode or --gateway-url, not both')
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('--run-on', () => {
		const QWEN = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };

		function mockAgent(agent: Record<string, unknown> = {}) {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			vi.mocked(getSessionById).mockReturnValue({
				id: 'full-session-id',
				toolType: 'claude-code',
				...agent,
			} as never);
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		const sentPatch = (sendCommand: ReturnType<typeof vi.fn>) =>
			sendCommand.mock.calls[0][0].configPatch;

		/**
		 * Run a call that must be refused. The suite's `process.exit` stub returns,
		 * so a refused command would carry on and send its patch; here it stops
		 * the command, as the real exit does.
		 */
		async function refused(flags: Parameters<typeof updateAgent>[1]) {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			await expect(updateAgent('agent-1', flags)).rejects.toThrow('process.exit');
		}

		it('sends the target the picker would store, at its default context', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { runOn: 'ep-ollama:qwen3:latest' });

			expect(sendCommand).toHaveBeenCalledWith(
				{
					type: 'update_session_config',
					sessionId: 'full-session-id',
					configPatch: { runOn: { ...QWEN, contextTokens: 40_960 } },
				},
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith(
				'  Run on: ep-ollama:qwen3:latest (context 40960 tokens)'
			);
		});

		it.each(['provider', 'PROVIDER'])('clears the target for %j', async (value) => {
			const sendCommand = mockAgent({ runOn: QWEN });

			await updateAgent('agent-1', { runOn: value });

			// `null` on the wire: the app stores the absence of a target.
			expect(sentPatch(sendCommand)).toEqual({ runOn: null });
			expect(consoleSpy).toHaveBeenCalledWith('  Run on: provider');
		});

		it('stores the context it is given', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { runOn: 'ep-ollama:qwen3:latest', runOnContext: '131072' });

			expect(sentPatch(sendCommand)).toEqual({ runOn: { ...QWEN, contextTokens: 131_072 } });
		});

		it("changes only the context of the agent's current target, given the context alone", async () => {
			const sendCommand = mockAgent({ runOn: { ...QWEN, contextTokens: 131_072 } });

			await updateAgent('agent-1', { runOnContext: '65536' });

			expect(sentPatch(sendCommand)).toEqual({ runOn: { ...QWEN, contextTokens: 65_536 } });
		});

		it('rides in the same patch as another setting', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { runOn: 'ep-ollama:qwen3:latest', nudge: 'be brief' });

			expect(sendCommand).toHaveBeenCalledTimes(1);
			expect(sentPatch(sendCommand)).toEqual({
				nudgeMessage: 'be brief',
				runOn: { ...QWEN, contextTokens: 40_960 },
			});
		});

		it('reports the target in JSON, the form show agent reads back', async () => {
			mockAgent();

			await updateAgent('agent-1', { runOn: 'ep-ollama:qwen3:latest', json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: true,
				agentId: 'full-session-id',
				config: { runOn: { ...QWEN, contextTokens: 40_960 } },
			});
		});

		it.each([
			['a spelling that is not a target', {}, { runOn: 'qwen3' }, '--run-on:'],
			['a source id that names nothing', {}, { runOn: 'ep-typo:qwen3' }, 'No source has the id'],
			[
				'a context under the agent minimum',
				{},
				{ runOn: 'ep-ollama:qwen3', runOnContext: '8192' },
				'at least 40960 tokens',
			],
			[
				'a context alone for an agent on its provider',
				{},
				{ runOnContext: '65536' },
				'Pass --run-on',
			],
			[
				'a source for a provider with no recipe',
				{ toolType: 'gemini-cli' },
				{ runOn: 'ep-ollama:qwen3' },
				'speaks only the Gemini API',
			],
		])('refuses %s before it reaches the app', async (_name, agent, flags, expected) => {
			const sendCommand = mockAgent(agent);

			await refused(flags);

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining(expected));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('still clears a target left on a provider with no recipe', async () => {
			const sendCommand = mockAgent({ toolType: 'gemini-cli', runOn: QWEN });

			await updateAgent('agent-1', { runOn: 'provider' });

			expect(sentPatch(sendCommand)).toEqual({ runOn: null });
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('counts as a field to update on its own', async () => {
			mockAgent();

			await updateAgent('agent-1', { runOn: 'provider' });

			expect(formatError).not.toHaveBeenCalledWith(
				expect.stringContaining('Specify at least one field to update')
			);
		});

		it('cannot be combined with --provider, like any other settings edit', async () => {
			const sendCommand = mockAgent();

			await refused({ runOn: 'provider', provider: 'codex', force: true });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('Provider migration must be a separate operation')
			);
			expect(sendCommand).not.toHaveBeenCalled();
		});

		describe('and the gateway', () => {
			it.each([
				['--gateway-url', { gatewayUrl: 'http://127.0.0.1:8787' }],
				['--proxy-mode', { proxyMode: 'compress' }],
			])('refuses %s for an agent on a source, with the reason', async (flag, flags) => {
				const sendCommand = mockAgent({ runOn: QWEN });

				await refused(flags);

				expect(formatError).toHaveBeenCalledWith(
					expect.stringContaining(`${flag}: Not applied while Run on is a source`)
				);
				expect(processExitSpy).toHaveBeenCalledWith(1);
				expect(sendCommand).not.toHaveBeenCalled();
			});

			it('refuses a gateway set in the same call as a source target', async () => {
				const sendCommand = mockAgent();

				await refused({ runOn: 'ep-ollama:qwen3:latest', gatewayUrl: 'http://127.0.0.1:8787' });

				expect(formatError).toHaveBeenCalledWith(
					expect.stringContaining('Not applied while Run on is a source')
				);
				expect(sendCommand).not.toHaveBeenCalled();
			});

			it.each([
				['clearing the gateway', { gatewayUrl: 'none' }, { gatewayUrl: null }],
				['switching the proxy off', { proxyMode: 'off' }, { tokenProxyMode: 'off' }],
			])('allows %s for an agent on a source', async (_name, flags, patch) => {
				const sendCommand = mockAgent({ runOn: QWEN });

				await updateAgent('agent-1', flags);

				expect(sentPatch(sendCommand)).toEqual(patch);
				expect(processExitSpy).not.toHaveBeenCalled();
			});

			it('allows a gateway in the call that moves the agent back to its provider', async () => {
				const sendCommand = mockAgent({ runOn: QWEN });

				await updateAgent('agent-1', { runOn: 'provider', gatewayUrl: 'http://127.0.0.1:8787' });

				expect(sentPatch(sendCommand)).toEqual({
					gatewayUrl: 'http://127.0.0.1:8787',
					runOn: null,
				});
			});
		});
	});

	describe('--codex-transport', () => {
		const codexAgent = () =>
			vi.mocked(getSessionById).mockReturnValue({
				id: 'full-session-id',
				toolType: 'codex',
			} as never);

		const connect = (sendCommand: ReturnType<typeof vi.fn>) =>
			vi
				.mocked(withMaestroClient)
				.mockImplementation(async (action) => action({ sendCommand } as never));

		it('stores app-server on a Codex agent', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			codexAgent();
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			connect(sendCommand);

			await updateAgent('agent-1', { codexTransport: 'App-Server' });

			expect(sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'update_session_config',
					configPatch: { codexTransport: 'app-server' },
				}),
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith('  Codex transport: app-server');
		});

		it('clears the field for exec, the default transport', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			codexAgent();
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			connect(sendCommand);

			await updateAgent('agent-1', { codexTransport: 'exec' });

			expect(sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ configPatch: { codexTransport: null } }),
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith('  Codex transport: exec');
		});

		it('rejects an invalid value before contacting the app', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			codexAgent();
			const sendCommand = vi.fn();
			connect(sendCommand);

			await updateAgent('agent-1', { codexTransport: 'websocket' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('--codex-transport expects exec or app-server')
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('rejects the flag on a non-Codex agent', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			vi.mocked(getSessionById).mockReturnValue({
				id: 'full-session-id',
				toolType: 'claude-code',
			} as never);
			const sendCommand = vi.fn();
			connect(sendCommand);

			await updateAgent('agent-1', { codexTransport: 'app-server' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('only applies to Codex agents')
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	it('reports library refusal and sends no blanket destructive switch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'claude-code',
		} as never);
		const sendCommand = vi.fn().mockResolvedValue({
			success: false,
			error: 'Native translation is unverified; explicit limitation acceptance required',
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { provider: 'codex' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				configPatch: {
					toolType: 'codex',
					migrationAction: 'apply',
					acceptTranslationLimitations: false,
				},
			}),
			'provider_translation_result',
			120000
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('uses the dedicated translation verb for --provider with --force', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'claude-code',
		} as never);
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'provider_translation_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { provider: 'codex', force: true });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'provider_translation',
				sessionId: 'full-session-id',
				configPatch: {
					toolType: 'codex',
					migrationAction: 'apply',
					acceptTranslationLimitations: true,
				},
			}),
			'provider_translation_result',
			120000
		);
	});

	it('rejects a non-boolean --sync-history-to-remote value', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand: vi.fn() } as never);
		});

		await updateAgent('agent-1', { syncHistoryToRemote: 'maybe' });

		expect(formatError).toHaveBeenCalledWith(
			'--sync-history-to-remote expects true or false, got "maybe"'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('fans out to both messages when --group and --cwd are both provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi
			.fn()
			.mockResolvedValueOnce({ type: 'move_session_to_group_result', success: true })
			.mockResolvedValueOnce({ type: 'update_session_cwd_result', success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp', cwd: '/tmp/foo' });

		expect(sendCommand).toHaveBeenCalledTimes(2);
		expect(sendCommand.mock.calls[0][0].type).toBe('move_session_to_group');
		expect(sendCommand.mock.calls[1][0].type).toBe('update_session_cwd');
	});

	it('surfaces the renderer error when cwd update is refused (agent running)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_cwd_result',
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { cwd: '/tmp/foo' });

		expect(formatError).toHaveBeenCalledWith(
			'Agent process is running; stop it before changing cwd'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('emits JSON on success when --json is set', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi
			.fn()
			.mockResolvedValueOnce({ type: 'move_session_to_group_result', success: true })
			.mockResolvedValueOnce({ type: 'update_session_cwd_result', success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp', cwd: '/tmp/foo', json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed).toMatchObject({
			success: true,
			agentId: 'full-session-id',
			group: 'full-group-id',
			cwd: path.resolve('/tmp/foo'),
		});
	});

	describe('--tier and --background-requests', () => {
		const LOCAL = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };

		function mockAgent(agent: Record<string, unknown> = {}) {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			vi.mocked(getSessionById).mockReturnValue({
				id: 'full-session-id',
				toolType: 'claude-code',
				...agent,
			} as never);
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		const sentPatch = (sendCommand: ReturnType<typeof vi.fn>) =>
			sendCommand.mock.calls[0][0].configPatch;

		/** Run a call that must be refused before it reaches the app. */
		async function refused(flags: Parameters<typeof updateAgent>[1]) {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			await expect(updateAgent('agent-1', flags)).rejects.toThrow('process.exit');
			expect(withMaestroClient).not.toHaveBeenCalled();
		}

		it('sends one entry per tier named: a patch, not the whole record', async () => {
			// The agent already holds a medium tier; the patch does not restate it.
			const sendCommand = mockAgent({ tierTargets: { medium: LOCAL } });

			await updateAgent('agent-1', {
				tier: ['low=ep-ollama:qwen3:latest', 'high=provider:opus'],
			});

			expect(sentPatch(sendCommand)).toEqual({
				tierTargets: { low: LOCAL, high: { type: 'provider-model', model: 'opus' } },
			});
			expect(consoleSpy).toHaveBeenCalledWith('  Tier low: ep-ollama:qwen3:latest');
			expect(consoleSpy).toHaveBeenCalledWith('  Tier high: provider:opus');
		});

		it('sends null for default: the tier follows its harness default again', async () => {
			const sendCommand = mockAgent({ tierTargets: { low: LOCAL } });

			await updateAgent('agent-1', { tier: ['low=default'] });

			expect(sentPatch(sendCommand)).toEqual({ tierTargets: { low: null } });
			expect(consoleSpy).toHaveBeenCalledWith('  Tier low: default');
		});

		it("reads provider as the provider on the agent's own model", async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { tier: ['medium=provider'] });

			expect(sentPatch(sendCommand)).toEqual({
				tierTargets: { medium: { type: 'provider-model' } },
			});
		});

		it.each([
			['a word that is not tier=target', ['low'], '<low|medium|high>=<target>'],
			['a tier that does not exist', ['turbo=provider:opus'], '<low|medium|high>=<target>'],
			['a target that is not one', ['low=opus'], 'low: A tier target is'],
			['a tier set twice', ['low=provider', 'low=default'], 'set more than once'],
			['a source that does not exist', ['low=ep-gone:m'], 'low: No source has the id "ep-gone"'],
		])('refuses %s before it reaches the app', async (_what, tier, message) => {
			mockAgent();

			await refused({ tier });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining(message));
		});

		it('refuses a source tier on a harness with no Run on recipe', async () => {
			mockAgent({ toolType: 'factory-droid' });

			await refused({ tier: ['high=ep-ollama:qwen3:latest'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringMatching(/^--tier high: /));
		});

		it('sends the background requests target with no context size', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { backgroundRequests: 'ep-ollama:qwen3:4b' });

			expect(sentPatch(sendCommand)).toEqual({
				backgroundRequests: {
					target: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:4b' },
				},
			});
			expect(consoleSpy).toHaveBeenCalledWith('  Background requests: ep-ollama:qwen3:4b');
		});

		it.each(['none', 'NONE'])('turns background requests off for %j', async (value) => {
			// Off is sent for any provider: it is how a stale target is removed.
			const sendCommand = mockAgent({ toolType: 'codex' });

			await updateAgent('agent-1', { backgroundRequests: value });

			expect(sentPatch(sendCommand)).toEqual({ backgroundRequests: null });
			expect(consoleSpy).toHaveBeenCalledWith('  Background requests: none');
		});

		it('refuses a background target on a provider the proxy cannot route for', async () => {
			mockAgent({ toolType: 'codex' });

			await refused({ backgroundRequests: 'ep-ollama:qwen3:4b' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Claude Code agents only'));
		});

		it('refuses a source not known to serve the Anthropic Messages route', async () => {
			mockAgent();

			await refused({ backgroundRequests: 'ep-cloud:some/model' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('/v1/messages'));
		});

		it('refuses a word that is neither none nor a source and a model', async () => {
			mockAgent();

			await refused({ backgroundRequests: 'qwen' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('"none" or <source id>:<model>')
			);
		});

		it.each([
			['--proxy-mode off', { proxyMode: 'off' }],
			['--gateway-url', { gatewayUrl: 'http://127.0.0.1:8787' }],
		])('refuses a background target beside %s: it needs the proxy', async (_what, rest) => {
			mockAgent();

			await refused({ backgroundRequests: 'ep-ollama:qwen3:4b', ...rest });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('routed by the token proxy')
			);
		});

		it('turns the proxy on and names the target in one call', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', {
				proxyMode: 'passthrough',
				backgroundRequests: 'ep-ollama:qwen3:4b',
			});

			expect(sentPatch(sendCommand)).toMatchObject({
				tokenProxyMode: 'passthrough',
				backgroundRequests: {
					target: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:4b' },
				},
			});
		});
	});

	// `--model auto`: the Auto choice of the model picker. Stored as the word,
	// and only for an agent Auto can act on.
	describe('--model auto', () => {
		function mockAgent(agent: Record<string, unknown> = {}) {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			vi.mocked(getSessionById).mockReturnValue({
				id: 'full-session-id',
				toolType: 'claude-code',
				...agent,
			} as never);
			vi.mocked(readHarnessTierDefaults).mockReturnValue({});
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		const sentPatch = (sendCommand: ReturnType<typeof vi.fn>) =>
			sendCommand.mock.calls[0][0].configPatch;

		/** Run a call that must be refused before it reaches the app. */
		async function refused(flags: Parameters<typeof updateAgent>[1]) {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			await expect(updateAgent('agent-1', flags)).rejects.toThrow('process.exit');
			expect(withMaestroClient).not.toHaveBeenCalled();
		}

		it.each(['auto', 'Auto', 'AUTO'])('stores %s as the word auto', async (model) => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { model });

			expect(sentPatch(sendCommand)).toEqual({ customModel: 'auto' });
		});

		it('leaves a named model as it was typed', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { model: 'Opus' });

			expect(sentPatch(sendCommand)).toEqual({ customModel: 'Opus' });
			expect(readHarnessTierDefaults).not.toHaveBeenCalled();
		});

		it('refuses it by name for an agent Auto cannot act on', async () => {
			mockAgent({ toolType: 'opencode' });

			await refused({ model: 'auto' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringMatching(/^--model auto: Auto would change nothing for this agent/)
			);
		});

		it('refuses it as JSON with --json', async () => {
			mockAgent({ toolType: 'opencode' });

			await refused({ model: 'auto', json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: false,
				error: expect.stringMatching(/^--model auto: /),
			});
		});

		it('allows it for that provider when the same call maps a tier', async () => {
			const sendCommand = mockAgent({ toolType: 'opencode' });

			await updateAgent('agent-1', { model: 'Auto', tier: ['medium=provider:some-model'] });

			expect(sentPatch(sendCommand)).toEqual({
				customModel: 'auto',
				tierTargets: { medium: { type: 'provider-model', model: 'some-model' } },
			});
		});

		it('allows it for that provider when the agent already holds a mapped tier', async () => {
			const sendCommand = mockAgent({
				toolType: 'opencode',
				tierTargets: { high: { type: 'provider-model', model: 'some-model' } },
			});

			await updateAgent('agent-1', { model: 'auto' });

			expect(sentPatch(sendCommand)).toEqual({ customModel: 'auto' });
		});

		it('allows it for that provider when a harness default maps a tier', async () => {
			const sendCommand = mockAgent({ toolType: 'opencode' });
			vi.mocked(readHarnessTierDefaults).mockReturnValue({
				opencode: { low: { type: 'provider-model', model: 'some-model' } },
			});

			await updateAgent('agent-1', { model: 'auto' });

			expect(sentPatch(sendCommand)).toEqual({ customModel: 'auto' });
		});

		it('refuses it when the same call takes away the only mapped tier', async () => {
			mockAgent({
				toolType: 'opencode',
				tierTargets: { high: { type: 'provider-model', model: 'some-model' } },
			});

			await refused({ model: 'auto', tier: ['high=default'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringMatching(/^--model auto: /));
		});
	});

	describe('--system-one', () => {
		function mockAgent() {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			vi.mocked(getSessionById).mockReturnValue({
				id: 'full-session-id',
				toolType: 'claude-code',
			} as never);
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		it.each(['off', 'OFF', ' off '])('stores the opt-out for %j', async (value) => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { systemOne: value });

			expect(sendCommand).toHaveBeenCalledWith(
				{
					type: 'update_session_config',
					sessionId: 'full-session-id',
					configPatch: { systemOneOptOut: true },
				},
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringMatching(/^ {2}System One: off\. This agent cannot ask System One/)
			);
		});

		it('clears the opt-out for on, which is the agent following the switch for all agents', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { systemOne: 'on' });

			// On is the absence of the field: null on the wire, never `false`.
			expect(sendCommand.mock.calls[0][0].configPatch).toEqual({ systemOneOptOut: null });
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/^ {2}System One: on\. This agent follows "Let agents use System One"/
				)
			);
			expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('(cleared)'));
		});

		it('rides in one patch with the other settings', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { systemOne: 'off', nudge: 'be brief', json: true });

			expect(sendCommand.mock.calls[0][0].configPatch).toEqual({
				systemOneOptOut: true,
				nudgeMessage: 'be brief',
			});
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: true,
				config: { systemOneOptOut: true },
			});
		});

		it.each(['yes', 'true', ''])('refuses %j before it reaches the app', async (value) => {
			mockAgent();
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});

			await expect(updateAgent('agent-1', { systemOne: value })).rejects.toThrow('process.exit');

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('--system-one expects on or off')
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('peer flags', () => {
		// Names resolve to ids the way the real helper would: `self` is the agent
		// being edited, the rest are other agents.
		const IDS: Record<string, string> = {
			self: 'self-id',
			alpha: 'alpha-id',
			bravo: 'bravo-id',
			'agent-1': 'self-id',
		};

		function mockAgent(peerAgents?: unknown) {
			vi.mocked(resolveAgentId).mockImplementation((ref: string) => {
				const id = IDS[ref];
				if (!id) throw new Error(`Agent not found: ${ref}`);
				return id;
			});
			vi.mocked(getSessionById).mockReturnValue({
				id: 'self-id',
				toolType: 'claude-code',
				peerAgents,
			} as never);
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_config_result',
				success: true,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		async function refused(options: Record<string, unknown>) {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			await expect(updateAgent('agent-1', options)).rejects.toThrow('process.exit');
			expect(withMaestroClient).not.toHaveBeenCalled();
		}

		it('sends one row per --peer, resolved to an id, as a patch', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { peer: ['alpha:r', 'bravo:rw'] });

			expect(sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'update_session_config',
					sessionId: 'self-id',
					configPatch: {
						peerAgentEdits: {
							upsert: [
								{ sessionId: 'alpha-id', read: true, write: false },
								{ sessionId: 'bravo-id', read: true, write: true },
							],
						},
					},
				}),
				'update_session_config_result'
			);
			expect(consoleSpy).toHaveBeenCalledWith('  Peer alpha-id: Consult only');
			expect(consoleSpy).toHaveBeenCalledWith('  Peer bravo-id: Consult + Delegate');
		});

		it('writes none as a row with neither bit, the exclusion', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { peer: ['alpha:none'] });

			expect(sendCommand.mock.calls[0][0].configPatch.peerAgentEdits.upsert).toEqual([
				{ sessionId: 'alpha-id', read: false, write: false },
			]);
			expect(consoleSpy).toHaveBeenCalledWith('  Peer alpha-id: No access');
		});

		it('reads the access word after the last colon, so a name may hold one', async () => {
			IDS['ops: east'] = 'east-id';
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { peer: ['ops: east:w'] });

			expect(sendCommand.mock.calls[0][0].configPatch.peerAgentEdits.upsert).toEqual([
				{ sessionId: 'east-id', read: false, write: true },
			]);
			delete IDS['ops: east'];
		});

		it('sets a note on a row the call adds, keeping colons in the text', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', {
				peer: ['alpha:r'],
				peerNote: ['alpha:infra: ask first'],
			});

			expect(sendCommand.mock.calls[0][0].configPatch.peerAgentEdits).toEqual({
				upsert: [{ sessionId: 'alpha-id', read: true, write: false }],
				notes: [{ sessionId: 'alpha-id', description: 'infra: ask first' }],
			});
		});

		it('sets a note on a row the agent already has', async () => {
			const sendCommand = mockAgent([{ sessionId: 'alpha-id', read: true, write: false }]);

			await updateAgent('agent-1', { peerNote: ['alpha:docs'] });

			expect(sendCommand.mock.calls[0][0].configPatch.peerAgentEdits.notes).toEqual([
				{ sessionId: 'alpha-id', description: 'docs' },
			]);
		});

		it('refuses a note on a peer with no row before it reaches the app', async () => {
			mockAgent();

			await refused({ peerNote: ['alpha:docs'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('no peer row'));
		});

		it('removes a row', async () => {
			const sendCommand = mockAgent([{ sessionId: 'alpha-id', read: true, write: true }]);

			await updateAgent('agent-1', { removePeer: ['alpha'] });

			expect(sendCommand.mock.calls[0][0].configPatch).toEqual({
				peerAgentEdits: { remove: ['alpha-id'] },
			});
			expect(consoleSpy).toHaveBeenCalledWith('  Peer alpha-id: removed');
		});

		it('sets and clears the two derived grants', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { groupPeers: 'rw', worktreePeers: 'off' });

			expect(sendCommand.mock.calls[0][0].configPatch).toEqual({
				groupPeerAccess: { read: true, write: true },
				worktreePeerAccess: null,
			});
			expect(consoleSpy).toHaveBeenCalledWith('  Peers in my group: Consult + Delegate');
			expect(consoleSpy).toHaveBeenCalledWith('  Worktree family peers: off');
		});

		it('rides in one patch with other settings and reports JSON', async () => {
			const sendCommand = mockAgent();

			await updateAgent('agent-1', { peer: ['alpha:r'], nudge: 'be brief', json: true });

			expect(sendCommand).toHaveBeenCalledTimes(1);
			expect(sendCommand.mock.calls[0][0].configPatch).toEqual({
				nudgeMessage: 'be brief',
				peerAgentEdits: { upsert: [{ sessionId: 'alpha-id', read: true, write: false }] },
			});
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: true,
				agentId: 'self-id',
				config: { peerAgentEdits: { upsert: [{ sessionId: 'alpha-id' }] } },
			});
		});

		it.each([
			['a row with no access word', { peer: ['alpha'] }, '--peer expects'],
			['an unknown access word', { peer: ['alpha:read'] }, '--peer expects'],
			['a note with no text', { peerNote: ['alpha'] }, '--peer-note expects'],
			['none as a grant', { groupPeers: 'none' }, '--group-peers expects'],
			['a bad worktree grant', { worktreePeers: 'yes' }, '--worktree-peers expects'],
			['the same peer twice', { peer: ['alpha:r', 'alpha:w'] }, 'named more than once'],
			['the agent as its own peer', { peer: ['self:r'] }, 'its own peer'],
			['an agent that does not resolve', { peer: ['ghost:r'] }, 'Agent not found'],
			[
				'a peer both given access and removed',
				{ peer: ['alpha:r'], removePeer: ['alpha'] },
				'both given access and removed',
			],
		])('refuses %s', async (_label, options, message) => {
			mockAgent();

			await refused(options);

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining(message));
		});

		it('cannot be combined with --provider', async () => {
			mockAgent();

			await refused({ peer: ['alpha:r'], provider: 'codex', force: true });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('Provider migration must be a separate operation')
			);
		});
	});

	it('errors when agent ID cannot be resolved', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: xyz');
		});

		await updateAgent('xyz', { group: 'grp' });

		expect(formatError).toHaveBeenCalledWith('Agent not found: xyz');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('errors when --json is set and command fails', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection lost'));

		await updateAgent('agent-1', { cwd: '/tmp/foo', json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed).toMatchObject({ success: false, error: 'Connection lost' });
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
	it('uses the same provider route for dry-run and status without forcing acceptance', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'claude-code',
		} as never);
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		await updateAgent('agent-1', { provider: 'codex', dryRun: true });
		expect(sendCommand).toHaveBeenLastCalledWith(
			expect.objectContaining({
				configPatch: {
					toolType: 'codex',
					migrationAction: 'plan',
					acceptTranslationLimitations: false,
				},
			}),
			'provider_translation_result',
			120000
		);
		await updateAgent('agent-1', { migration: 'status' });
		expect(sendCommand).toHaveBeenLastCalledWith(
			expect.objectContaining({
				configPatch: { migrationAction: 'status', acceptTranslationLimitations: false },
			}),
			'provider_translation_result',
			120000
		);
	});
	it.each(['recover', 'rollback'] as const)(
		'waits for a %s migration report before closing the CLI connection',
		async (migration) => {
			vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
			const sendCommand = vi.fn().mockResolvedValue({ success: true });
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			await updateAgent('agent-1', { migration });
			expect(sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					configPatch: { migrationAction: migration, acceptTranslationLimitations: false },
				}),
				'provider_translation_result',
				120000
			);
		}
	);
	it('carries a reviewed operation ID through the dedicated translation request', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		await updateAgent('agent-1', {
			provider: 'codex',
			migrationPlan: ' reviewed-plan ',
			acceptTranslationLimitations: true,
		});
		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'provider_translation',
				sessionId: 'full-session-id',
				configPatch: {
					toolType: 'codex',
					migrationAction: 'apply',
					migrationPlanId: 'reviewed-plan',
					acceptTranslationLimitations: true,
				},
			},
			'provider_translation_result',
			120000
		);
	});
	it('refuses an older desktop without falling back to a destructive settings patch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'error',
			message: 'Provider translation is unavailable',
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		await updateAgent('agent-1', { provider: 'codex', dryRun: true, json: true });
		expect(sendCommand).toHaveBeenCalledTimes(1);
		expect(sendCommand.mock.calls[0][0].type).toBe('provider_translation');
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no legacy provider switch'));
	});
});

// The Edit Agent settings `update-agent` did not reach: Agent Resilience, the
// Codex auto reset, Additional Directories, parking an environment variable,
// and mirroring History into the project directory.
describe('update-agent command: the rest of the Edit Agent dialog', () => {
	let processExitSpy: MockInstance;

	function mockSend() {
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		return sendCommand;
	}

	const configPatch = (sendCommand: ReturnType<typeof vi.fn>) =>
		sendCommand.mock.calls.find(([payload]) => payload.type === 'update_session_config')?.[0]
			.configPatch;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('sends the resilience switches as booleans, and "default" as a clear', async () => {
		const sendCommand = mockSend();

		await updateAgent('agent-1', {
			retryOnAvailability: 'false',
			retryOnTokenExhaustion: 'default',
			codexAutoReset: 'on',
		});

		// The two retries are on by default, so dropping the choice (null) is not
		// the same as switching it off (false).
		expect(configPatch(sendCommand)).toEqual({
			retryOnAvailabilityErrors: false,
			retryOnTokenExhaustion: null,
			codexAutoResetOnExhaustion: true,
		});
	});

	it('replaces the additional directories with the ones given', async () => {
		const sendCommand = mockSend();

		await updateAgent('agent-1', { additionalDir: ['/srv/docs', '/srv/out:rw'] });

		expect(configPatch(sendCommand)).toEqual({
			additionalDirectories: [
				{ path: '/srv/docs', read: true, write: false },
				{ path: '/srv/out', read: true, write: true },
			],
		});
	});

	it('clears the additional directories', async () => {
		const sendCommand = mockSend();
		await updateAgent('agent-1', { clearAdditionalDirs: true });
		expect(configPatch(sendCommand)).toEqual({ additionalDirectories: null });
	});

	it('sends the variables to park and to switch back on by name', async () => {
		const sendCommand = mockSend();

		await updateAgent('agent-1', { envPark: ['DEBUG'], envUnpark: ['OLD_FLAG'] });

		expect(configPatch(sendCommand)).toEqual({
			envParkEdits: { park: ['DEBUG'], unpark: ['OLD_FLAG'] },
		});
	});

	it('refuses to park beside a flag that replaces the variables being parked', async () => {
		const sendCommand = mockSend();

		await updateAgent('agent-1', { envPark: ['DEBUG'], env: ['FOO=bar'] });

		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('cannot be combined with --env or --clear-env')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(configPatch(sendCommand)).toBeUndefined();
	});

	it('refuses a malformed switch, directory, or both directory flags at once', async () => {
		mockSend();

		await updateAgent('agent-1', { retryOnAvailability: 'sometimes' });
		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('--retry-on-availability expects true or false')
		);

		await updateAgent('agent-1', { additionalDir: ['/srv/docs:none'] });
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('needs r, w or rw'));

		await updateAgent('agent-1', { additionalDir: ['/srv/docs'], clearAdditionalDirs: true });
		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('--additional-dir or --clear-additional-dirs, not both')
		);
	});

	it('sends the history mirror switch in the SSH block, where the record keeps it', async () => {
		const sendCommand = mockSend();

		await updateAgent('agent-1', { shareHistoryToProjectDir: 'true' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sessionId: 'full-session-id',
				sshPatch: { shareHistoryToProjectDir: true },
			}),
			'update_session_ssh_result'
		);
	});
});
