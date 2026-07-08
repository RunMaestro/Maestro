/**
 * @file connectivity-commands.test.ts
 * @description Focused coverage for small CLI commands that bridge to Maestro.
 */

import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveSessionId: vi.fn(() => 'default-session'),
	resolveTargetSessionId: vi.fn((agent?: string) => agent ?? 'default-target-session'),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => `resolved-${id}`),
}));

vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn(),
}));

vi.mock('../../../shared/promptDefinitions', () => ({
	CORE_PROMPTS: [
		{
			id: 'alpha',
			filename: 'alpha.md',
			description: 'Alpha prompt',
			category: 'core',
		},
		{
			id: 'gamma',
			filename: 'gamma.md',
			description: 'Gamma prompt',
			category: 'core',
		},
		{
			id: 'beta',
			filename: 'beta.md',
			description: 'Beta prompt',
			category: 'wizard',
		},
	],
}));

import { openBrowser } from '../../../cli/commands/open-browser';
import { openTerminal } from '../../../cli/commands/open-terminal';
import { notifyFlash } from '../../../cli/commands/notify-flash';
import { notifyToast } from '../../../cli/commands/notify-toast';
import { promptsGet, promptsList } from '../../../cli/commands/prompts-get';
import { refreshAutoRun } from '../../../cli/commands/refresh-auto-run';
import { refreshFiles } from '../../../cli/commands/refresh-files';
import { status } from '../../../cli/commands/status';
import {
	withMaestroClient,
	resolveSessionId,
	resolveTargetSessionId,
} from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { readCliServerInfo, isCliServerRunning } from '../../../shared/cli-server-discovery';
import { getCliPrompt } from '../../../cli/services/prompt-loader';

type CommandCall = {
	payload: Record<string, unknown>;
	responseType: string;
};

function mockClient(
	responder:
		| Record<string, unknown>
		| ((payload: Record<string, unknown>, responseType: string) => Record<string, unknown>)
) {
	const calls: CommandCall[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn((payload: Record<string, unknown>, responseType: string) => {
				calls.push({ payload, responseType });
				const response =
					typeof responder === 'function' ? responder(payload, responseType) : responder;
				return Promise.resolve(response);
			}),
		} as never)
	);
	return calls;
}

describe('CLI connectivity commands', () => {
	let consoleLogSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let stdoutSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null) => {
				throw new Error(`__exit_${code}__`);
			});
		vi.mocked(resolveAgentId).mockImplementation((id: string) => `resolved-${id}`);
		vi.mocked(resolveSessionId).mockReturnValue('default-session');
		vi.mocked(resolveTargetSessionId).mockImplementation((agent?: string) =>
			agent ? `target-${agent}` : 'default-target-session'
		);
	});

	describe('openTerminal', () => {
		it('opens a terminal tab for the default session with shell options', async () => {
			const calls = mockClient({ success: true });

			await openTerminal({ cwd: '/repo', shell: '/bin/zsh', name: 'Work' });

			expect(resolveSessionId).toHaveBeenCalledWith({});
			expect(calls[0]).toMatchObject({
				responseType: 'open_terminal_tab_result',
				payload: {
					type: 'open_terminal_tab',
					sessionId: 'default-session',
					cwd: '/repo',
					shell: '/bin/zsh',
					name: 'Work',
				},
			});
			expect(consoleLogSpy).toHaveBeenCalledWith('Terminal tab opened in Maestro');
		});

		it('opens a terminal tab for an explicit agent', async () => {
			const calls = mockClient({ success: true });

			await openTerminal({ agent: 'agent-1' });

			expect(calls[0].payload.sessionId).toBe('resolved-agent-1');
		});

		it('exits when the explicit agent cannot be resolved', async () => {
			vi.mocked(resolveAgentId).mockImplementationOnce(() => {
				throw new Error('Agent not found');
			});

			await expect(openTerminal({ agent: 'missing' })).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Agent not found');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('formats non-Error agent and client failures', async () => {
			vi.mocked(resolveAgentId).mockImplementationOnce(() => {
				throw 'bad agent';
			});

			await expect(openTerminal({ agent: 'missing' })).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: bad agent');

			vi.mocked(withMaestroClient).mockRejectedValueOnce('offline');
			await expect(openTerminal({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: offline');
		});

		it('exits when Maestro rejects the terminal request', async () => {
			mockClient({ success: false, error: 'No session' });

			await expect(openTerminal({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No session');
		});

		it('uses the fallback terminal error when Maestro omits an error message', async () => {
			mockClient({ success: false });

			await expect(openTerminal({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Failed to open terminal tab');
		});
	});

	describe('refresh commands', () => {
		it('refreshes the file tree for a target agent', async () => {
			const calls = mockClient({ success: true });

			await refreshFiles({ agent: 'agent-2' });

			expect(resolveTargetSessionId).toHaveBeenCalledWith('agent-2');
			expect(calls[0]).toMatchObject({
				responseType: 'refresh_file_tree_result',
				payload: { type: 'refresh_file_tree', sessionId: 'target-agent-2' },
			});
			expect(consoleLogSpy).toHaveBeenCalledWith('File tree refreshed');
		});

		it('refreshes Auto Run documents for the default target session', async () => {
			const calls = mockClient({ success: true });

			await refreshAutoRun({});

			expect(calls[0]).toMatchObject({
				responseType: 'refresh_auto_run_docs_result',
				payload: { type: 'refresh_auto_run_docs', sessionId: 'default-target-session' },
			});
			expect(consoleLogSpy).toHaveBeenCalledWith('Auto Run documents refreshed');
		});

		it('exits on refresh file tree failure', async () => {
			mockClient({ success: false, error: 'refresh failed' });

			await expect(refreshFiles({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: refresh failed');
		});

		it('uses the refresh file fallback error and stringifies thrown failures', async () => {
			mockClient({ success: false });

			await expect(refreshFiles({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Failed to refresh file tree');

			vi.mocked(withMaestroClient).mockRejectedValueOnce('refresh offline');
			await expect(refreshFiles({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: refresh offline');
		});

		it('exits on refresh Auto Run connection failure', async () => {
			vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('offline'));

			await expect(refreshAutoRun({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: offline');
		});

		it('uses the refresh Auto Run fallback error and stringifies thrown failures', async () => {
			mockClient({ success: false });

			await expect(refreshAutoRun({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Failed to refresh Auto Run documents');

			vi.mocked(withMaestroClient).mockRejectedValueOnce('auto run offline');
			await expect(refreshAutoRun({})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: auto run offline');
		});
	});

	describe('status', () => {
		it('exits when the Maestro discovery file is missing', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);

			await expect(status()).rejects.toThrow('__exit_3__');

			expect(consoleLogSpy).toHaveBeenCalledWith('Maestro desktop app is not running');
		});

		it('exits when the discovery file is stale', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 4321,
				token: 'token',
				pid: 123,
				startedAt: 1,
			});
			vi.mocked(isCliServerRunning).mockReturnValue(false);

			await expect(status()).rejects.toThrow('__exit_3__');

			expect(consoleLogSpy).toHaveBeenCalledWith(
				'Maestro discovery file is stale (app may have crashed)'
			);
		});

		it('pings Maestro and reports singular session count', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 4321,
				token: 'token',
				pid: 123,
				startedAt: 1,
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);
			mockClient((_payload, responseType) =>
				responseType === 'sessions_list' ? { sessions: [{}] } : { type: 'pong' }
			);

			await status();

			expect(consoleLogSpy).toHaveBeenCalledWith('Maestro is running on port 4321 with 1 agent');
		});

		it('reports plural session count and tolerates missing session arrays', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 4321,
				token: 'token',
				pid: 123,
				startedAt: 1,
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);
			mockClient((_payload, responseType) =>
				responseType === 'sessions_list' ? {} : { type: 'pong' }
			);

			await status();

			expect(consoleLogSpy).toHaveBeenCalledWith('Maestro is running on port 4321 with 0 agents');
		});

		it('exits when the status ping fails', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 4321,
				token: 'token',
				pid: 123,
				startedAt: 1,
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);
			vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('socket closed'));

			await expect(status()).rejects.toThrow('__exit_3__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: socket closed');
		});

		it('stringifies non-Error status failures', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 4321,
				token: 'token',
				pid: 123,
				startedAt: 1,
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);
			vi.mocked(withMaestroClient).mockRejectedValueOnce('socket string failure');

			await expect(status()).rejects.toThrow('__exit_3__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: socket string failure');
		});
	});

	describe('openBrowser', () => {
		it('normalizes scheme-less URLs before opening a browser tab', async () => {
			const calls = mockClient({ success: true });

			await openBrowser('example.com/path', {});

			expect(calls[0]).toMatchObject({
				responseType: 'open_browser_tab_result',
				payload: {
					type: 'open_browser_tab',
					sessionId: 'default-session',
					url: 'https://example.com/path',
				},
			});
			expect(consoleLogSpy).toHaveBeenCalledWith('Opened https://example.com/path in Maestro');
		});

		it('uses an explicit agent and preserves http URLs', async () => {
			const calls = mockClient({ success: true });

			await openBrowser('http://localhost:3000/', { agent: 'agent-3' });

			expect(calls[0].payload).toMatchObject({
				sessionId: 'resolved-agent-3',
				url: 'http://localhost:3000/',
			});
		});

		it('exits when browser agent resolution fails', async () => {
			vi.mocked(resolveAgentId).mockImplementationOnce(() => {
				throw 'bad browser agent';
			});

			await expect(openBrowser('https://example.com', { agent: 'missing' })).rejects.toThrow(
				'__exit_1__'
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: bad browser agent');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('formats Error instances from browser agent resolution', async () => {
			vi.mocked(resolveAgentId).mockImplementationOnce(() => {
				throw new Error('browser agent missing');
			});

			await expect(openBrowser('https://example.com', { agent: 'missing' })).rejects.toThrow(
				'__exit_1__'
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: browser agent missing');
		});

		it('rejects empty, malformed, and unsupported URLs before connecting', async () => {
			await expect(openBrowser('  ', {})).rejects.toThrow('__exit_1__');
			await expect(openBrowser('http://[', {})).rejects.toThrow('__exit_1__');
			await expect(openBrowser('foo:bar@baz', {})).rejects.toThrow('__exit_1__');
			await expect(openBrowser('file:///tmp/a.txt', {})).rejects.toThrow('__exit_1__');

			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('exits when browser tab creation fails', async () => {
			mockClient({ success: false, error: 'browser rejected' });

			await expect(openBrowser('https://example.com', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: browser rejected');
		});

		it('uses browser fallback errors and formats connection failures', async () => {
			mockClient({ success: false });

			await expect(openBrowser('https://example.com', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Failed to open browser tab');

			vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('browser offline'));
			await expect(openBrowser('https://example.com', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: browser offline');

			vi.mocked(withMaestroClient).mockRejectedValueOnce('browser string failure');
			await expect(openBrowser('https://example.com', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: browser string failure');
		});
	});

	describe('notifyFlash', () => {
		it('sends a center flash with converted timeout', async () => {
			const calls = mockClient({ success: true });

			await notifyFlash('Build passed', { color: 'green', detail: '42 tests', timeout: '2.5' });

			expect(calls[0]).toMatchObject({
				responseType: 'notify_center_flash_result',
				payload: {
					type: 'notify_center_flash',
					message: 'Build passed',
					detail: '42 tests',
					color: 'green',
					duration: 2500,
				},
			});
			expect(consoleLogSpy).toHaveBeenCalledWith('Flash sent');
		});

		it('prints JSON success for flash notifications', async () => {
			mockClient({ success: true });

			await notifyFlash('Done', { json: true });

			expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ success: true, color: 'theme' }));
		});

		it('validates flash message, color, and timeout', async () => {
			await expect(notifyFlash(' ', {})).rejects.toThrow('__exit_1__');
			await expect(notifyFlash('Done', { color: 'blue' })).rejects.toThrow('__exit_1__');
			await expect(notifyFlash('Done', { timeout: '0' })).rejects.toThrow('__exit_1__');
			await expect(notifyFlash('Done', { timeout: '6' })).rejects.toThrow('__exit_1__');
		});

		it('prints JSON failure when flash delivery fails', async () => {
			mockClient({ success: false, error: 'flash failed' });

			await expect(notifyFlash('Done', { json: true })).rejects.toThrow('__exit_1__');

			expect(consoleLogSpy).toHaveBeenCalledWith(
				JSON.stringify({ success: false, error: 'flash failed' })
			);
		});

		it('prints non-JSON flash failures and stringifies thrown values', async () => {
			mockClient({ success: false });

			await expect(notifyFlash('Done', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Failed to send flash');

			vi.mocked(withMaestroClient).mockRejectedValueOnce('flash offline');
			await expect(notifyFlash('Done', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: flash offline');
		});
	});

	describe('notifyToast', () => {
		it('sends a toast with jump, action, and file click metadata', async () => {
			const calls = mockClient({ success: true });

			await notifyToast('Title', 'Message', {
				agent: 'agent-4',
				tab: 'tab-1',
				sourceAgent: ' Codex ',
				color: 'orange',
				timeout: '3',
				actionUrl: 'https://example.com',
				actionLabel: 'Open',
				openFile: '/repo/file.ts',
			});

			expect(calls[0]).toMatchObject({
				responseType: 'notify_toast_result',
				payload: {
					type: 'notify_toast',
					title: 'Title',
					message: 'Message',
					color: 'orange',
					duration: 3000,
					dismissible: false,
					sessionId: 'resolved-agent-4',
					sourceAgent: 'Codex',
					tabId: 'tab-1',
					actionUrl: 'https://example.com',
					actionLabel: 'Open',
					clickAction: {
						kind: 'open-file',
						sessionId: 'resolved-agent-4',
						path: '/repo/file.ts',
					},
				},
			});
		});

		it('sends sticky and URL-opening toasts', async () => {
			const calls = mockClient({ success: true });

			await notifyToast('Title', 'Message', {
				dismissible: true,
				openUrl: 'https://example.com',
				json: true,
			});

			expect(calls[0].payload).toMatchObject({
				dismissible: true,
				clickAction: { kind: 'open-url', url: 'https://example.com' },
			});
			expect(consoleLogSpy).toHaveBeenCalledWith(
				JSON.stringify({ success: true, color: 'theme', dismissible: true })
			);
		});

		it('prints the sticky toast message for non-JSON dismissible toasts', async () => {
			mockClient({ success: true });

			await notifyToast('Title', 'Message', { dismissible: true });

			expect(consoleLogSpy).toHaveBeenCalledWith('Toast sent (sticky — click to dismiss)');
		});

		it('sends a basic agent toast with jump-session click metadata', async () => {
			const calls = mockClient({ success: true });

			await notifyToast('Title', 'Message', { agent: 'agent-5' });

			expect(calls[0].payload).toMatchObject({
				sessionId: 'resolved-agent-5',
				clickAction: undefined,
			});
			expect(consoleLogSpy).toHaveBeenCalledWith('Toast sent');
		});

		it('validates toast options before connecting', async () => {
			await expect(notifyToast(' ', 'Message', {})).rejects.toThrow('__exit_1__');
			await expect(notifyToast('Title', 'Message', { color: 'blue' })).rejects.toThrow(
				'__exit_1__'
			);
			await expect(
				notifyToast('Title', 'Message', { dismissible: true, timeout: '1' })
			).rejects.toThrow('__exit_1__');
			await expect(notifyToast('Title', 'Message', { timeout: '0' })).rejects.toThrow('__exit_1__');
			await expect(notifyToast('Title', 'Message', { timeout: '61' })).rejects.toThrow(
				'__exit_1__'
			);
			await expect(notifyToast('Title', 'Message', { tab: 'tab-1' })).rejects.toThrow('__exit_1__');
			await expect(notifyToast('Title', 'Message', { actionLabel: 'Open' })).rejects.toThrow(
				'__exit_1__'
			);
			await expect(notifyToast('Title', 'Message', { openFile: '/repo/file.ts' })).rejects.toThrow(
				'__exit_1__'
			);
			await expect(
				notifyToast('Title', 'Message', {
					agent: 'agent-1',
					openFile: '/repo/file.ts',
					openUrl: 'https://example.com',
				})
			).rejects.toThrow('__exit_1__');
		});

		it('exits when toast agent resolution fails', async () => {
			vi.mocked(resolveAgentId).mockImplementationOnce(() => {
				throw 'toast agent missing';
			});

			await expect(notifyToast('Title', 'Message', { agent: 'missing' })).rejects.toThrow(
				'__exit_1__'
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: toast agent missing');
		});

		it('formats Error instances from toast agent resolution failures', async () => {
			vi.mocked(resolveAgentId).mockImplementationOnce(() => {
				throw new Error('toast agent error');
			});

			await expect(notifyToast('Title', 'Message', { agent: 'missing' })).rejects.toThrow(
				'__exit_1__'
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: toast agent error');
		});

		it('prints non-JSON toast failures', async () => {
			mockClient({ success: false });

			await expect(notifyToast('Title', 'Message', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Failed to send toast');
		});

		it('prints JSON toast result failures', async () => {
			mockClient({ success: false, error: 'toast rejected' });

			await expect(notifyToast('Title', 'Message', { json: true })).rejects.toThrow('__exit_1__');
			expect(consoleLogSpy).toHaveBeenCalledWith(
				JSON.stringify({ success: false, error: 'toast rejected' })
			);
		});

		it('prints JSON failure when toast delivery throws', async () => {
			vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('toast failed'));

			await expect(notifyToast('Title', 'Message', { json: true })).rejects.toThrow('__exit_1__');

			expect(consoleLogSpy).toHaveBeenCalledWith(
				JSON.stringify({ success: false, error: 'toast failed' })
			);
		});

		it('prints non-JSON toast delivery errors from string throws', async () => {
			vi.mocked(withMaestroClient).mockRejectedValueOnce('toast offline');

			await expect(notifyToast('Title', 'Message', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('Error: toast offline');
		});
	});

	describe('prompts commands', () => {
		it('prints prompt content as plain text', async () => {
			vi.mocked(getCliPrompt).mockResolvedValueOnce('Prompt body');

			await promptsGet('alpha', {});

			expect(stdoutSpy).toHaveBeenCalledWith('Prompt body');
		});

		it('prints prompt metadata as JSON', async () => {
			vi.mocked(getCliPrompt).mockResolvedValueOnce('Prompt body');

			await promptsGet('alpha', { json: true });

			expect(consoleLogSpy).toHaveBeenCalledWith(
				JSON.stringify({
					id: 'alpha',
					filename: 'alpha.md',
					description: 'Alpha prompt',
					category: 'core',
					content: 'Prompt body',
				})
			);
		});

		it('exits for unknown prompt IDs and prompt load failures', async () => {
			await expect(promptsGet('missing', { json: true })).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				JSON.stringify({ error: 'Unknown prompt id: missing. Available: alpha, gamma, beta' })
			);

			await expect(promptsGet('missing', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Unknown prompt id: missing. Available: alpha, gamma, beta'
			);

			vi.mocked(getCliPrompt).mockRejectedValueOnce(new Error('load failed'));
			await expect(promptsGet('alpha', {})).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith('load failed');

			vi.mocked(getCliPrompt).mockRejectedValueOnce('unknown prompt failure');
			await expect(promptsGet('alpha', { json: true })).rejects.toThrow('__exit_1__');
			expect(consoleErrorSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Unknown error' }));
		});

		it('lists prompts in text and JSON formats', () => {
			promptsList({});
			expect(consoleLogSpy).toHaveBeenCalledWith('\n[core]');
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('alpha'));

			promptsList({ json: true });
			expect(consoleLogSpy).toHaveBeenLastCalledWith(
				JSON.stringify(
					[
						{ id: 'alpha', category: 'core', description: 'Alpha prompt' },
						{ id: 'gamma', category: 'core', description: 'Gamma prompt' },
						{ id: 'beta', category: 'wizard', description: 'Beta prompt' },
					],
					null,
					2
				)
			);
		});
	});
});
