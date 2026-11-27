/**
 * @file browser-viewport.test.ts
 * @description Tests for `maestro-cli browser-viewport` (set or read the width a
 * browser tab shows its page at).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveSessionId: vi.fn(() => 'active-session'),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => `resolved-${id}`),
	readActiveAgentId: vi.fn((): string | null => 'active-session'),
}));

import { browserViewport } from '../../../cli/commands/open-browser';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readActiveAgentId, resolveAgentId } from '../../../cli/services/storage';
import { BROWSER_VIEWPORT_PRESETS } from '../../../shared/browserViewport';

type SentMessage = Record<string, unknown>;

/** Stub the desktop: record what the CLI sent and answer with `reply`. */
function stubDesktop(reply: Record<string, unknown>) {
	const sent: Array<{ message: SentMessage; responseType: string }> = [];
	vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
		const client = {
			sendCommand: vi.fn(async (message: SentMessage, responseType: string) => {
				sent.push({ message, responseType });
				return { type: responseType, ...reply };
			}),
		};
		return fn(client as never);
	});
	return sent;
}

/** Everything written to stdout, in order, as one string per call. */
function printed(spy: MockInstance): string[] {
	return spy.mock.calls.map((call) => String(call[0]));
}

describe('browser-viewport command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	describe('set', () => {
		it('sends browser_viewport with the tab and preset, and says what changed', async () => {
			const sent = stubDesktop({
				success: true,
				tabId: 'tab-uuid',
				browserId: 'browser:2',
				preset: 'phone',
				previous: 'fit',
			});

			await browserViewport(' browser:2 ', 'phone', {});

			expect(sent).toEqual([
				{
					message: {
						type: 'browser_viewport',
						sessionId: 'active-session',
						tab: 'browser:2',
						preset: 'phone',
					},
					responseType: 'browser_viewport_result',
				},
			]);
			expect(printed(logSpy)).toEqual([
				'Set the viewport of browser:2 to Phone (390 px wide)',
				"  Was: Fit (the tab's width)",
			]);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('says so when the tab already shows that preset', async () => {
			stubDesktop({ success: true, tabId: 'tab-uuid', preset: 'tablet', previous: 'tablet' });

			await browserViewport('tab-uuid', 'tablet', {});

			expect(printed(logSpy)).toEqual(['The viewport of tab-uuid is already Tablet (768 px wide)']);
		});

		it('reads the preset case-insensitively and sends it normalized', async () => {
			const sent = stubDesktop({ success: true, preset: 'laptop', previous: 'desktop' });

			await browserViewport('tab-uuid', '  LAPTOP ', {});

			expect(sent[0].message.preset).toBe('laptop');
			expect(printed(logSpy)[0]).toBe('Set the viewport of tab-uuid to Laptop (1280 px wide)');
		});

		it.each(BROWSER_VIEWPORT_PRESETS)('accepts the %s preset', async (preset) => {
			const sent = stubDesktop({ success: true, preset, previous: preset });

			await browserViewport('tab-uuid', preset, {});

			expect(sent[0].message.preset).toBe(preset);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('puts a tab back to Fit', async () => {
			stubDesktop({ success: true, preset: 'fit', previous: 'phone' });

			await browserViewport('tab-uuid', 'fit', {});

			expect(printed(logSpy)).toEqual([
				"Set the viewport of tab-uuid to Fit (the tab's width)",
				'  Was: Phone (390 px wide)',
			]);
		});
	});

	describe('read', () => {
		it('sends no preset and reports the one the tab shows', async () => {
			const sent = stubDesktop({ success: true, preset: 'desktop', previous: 'desktop' });

			await browserViewport('tab-uuid', undefined, {});

			expect(sent[0].message).toEqual({
				type: 'browser_viewport',
				sessionId: 'active-session',
				tab: 'tab-uuid',
			});
			expect(printed(logSpy)).toEqual(['The viewport of tab-uuid is Desktop (1440 px wide)']);
		});

		it('reports Fit as the tab width', async () => {
			stubDesktop({ success: true, preset: 'fit', previous: 'fit' });

			await browserViewport('tab-uuid', undefined, {});

			expect(printed(logSpy)).toEqual(["The viewport of tab-uuid is Fit (the tab's width)"]);
		});
	});

	describe('--json', () => {
		it('prints a set with its width, the previous preset, and both ids', async () => {
			stubDesktop({
				success: true,
				tabId: 'tab-uuid',
				browserId: 'browser:2',
				preset: 'phone',
				previous: 'fit',
			});

			await browserViewport('browser:2', 'phone', { json: true });

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: true,
				sessionId: 'active-session',
				tabId: 'tab-uuid',
				browserId: 'browser:2',
				preset: 'phone',
				width: 390,
				previous: 'fit',
				changed: true,
			});
		});

		it('prints a read as unchanged, with a null width for Fit and a null Coworking id', async () => {
			stubDesktop({ success: true, tabId: 'tab-uuid', preset: 'fit', previous: 'fit' });

			await browserViewport('tab-uuid', undefined, { json: true });

			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: true,
				sessionId: 'active-session',
				tabId: 'tab-uuid',
				browserId: null,
				preset: 'fit',
				width: null,
				previous: 'fit',
				changed: false,
			});
		});
	});

	describe('which agent', () => {
		it('names the agent with --agent', async () => {
			const sent = stubDesktop({ success: true, preset: 'fit', previous: 'fit' });

			await browserViewport('tab-uuid', undefined, { agent: 'agent-7' });

			expect(resolveAgentId).toHaveBeenCalledWith('agent-7');
			expect(sent[0].message.sessionId).toBe('resolved-agent-7');
		});

		it('refuses when no agent is named and none is recorded, without calling the desktop', async () => {
			stubDesktop({ success: true, preset: 'fit', previous: 'fit' });
			vi.mocked(readActiveAgentId).mockReturnValueOnce(null);

			await browserViewport('tab-uuid', 'phone', {});

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'No active agent recorded. Pass --agent <id> to say whose tab you mean.'
				)
			);
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('reports an agent --agent cannot resolve', async () => {
			stubDesktop({ success: true, preset: 'fit', previous: 'fit' });
			vi.mocked(resolveAgentId).mockImplementationOnce(() => {
				throw new Error('Agent not found: ghost');
			});

			await browserViewport('tab-uuid', undefined, { agent: 'ghost' });

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Agent not found: ghost'));
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('refusals before the desktop is called', () => {
		it.each([['wide'], ['390'], ['']])(
			'refuses the preset %j and lists the five, rather than reading the tab',
			async (preset) => {
				stubDesktop({ success: true, preset: 'fit', previous: 'fit' });

				await browserViewport('tab-uuid', preset, { json: true });

				expect(withMaestroClient).not.toHaveBeenCalled();
				expect(JSON.parse(printed(logSpy)[0])).toEqual({
					success: false,
					error: `Unknown viewport preset "${preset}". Use one of: fit, desktop, laptop, tablet, phone`,
				});
				expect(exitSpy).toHaveBeenCalledWith(1);
			}
		);

		it('refuses an empty tab', async () => {
			stubDesktop({ success: true, preset: 'fit', previous: 'fit' });

			await browserViewport('   ', 'phone', { json: true });

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: false,
				error: 'Tab cannot be empty',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('prints a refused preset as a plain error without --json', async () => {
			await browserViewport('tab-uuid', 'wide', {});

			expect(logSpy).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Unknown viewport preset "wide"')
			);
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('desktop errors', () => {
		it("reports the desktop's own error and exits 1", async () => {
			stubDesktop({
				success: false,
				error: 'Browser tab not found in your session (it may have been closed).',
			});

			await browserViewport('tab-uuid', 'phone', {});

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Browser tab not found in your session')
			);
			expect(logSpy).not.toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('prints the desktop error as JSON with --json', async () => {
			stubDesktop({ success: false, error: 'No browser tab browser:9 in this agent.' });

			await browserViewport('browser:9', undefined, { json: true });

			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: false,
				error: 'No browser tab browser:9 in this agent.',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('falls back to a generic message when the desktop gives none', async () => {
			stubDesktop({ success: false });

			await browserViewport('tab-uuid', 'phone', { json: true });

			expect(JSON.parse(printed(logSpy)[0]).error).toBe('Failed to set or read the viewport');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('refuses a reply that does not name the preset the tab shows', async () => {
			stubDesktop({ success: true, tabId: 'tab-uuid', preset: 'wide' });

			await browserViewport('tab-uuid', 'phone', { json: true });

			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: false,
				error: "Maestro did not report the tab's viewport",
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('reports the app being unreachable', async () => {
			vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('Maestro is not running'));

			await browserViewport('tab-uuid', undefined, { json: true });

			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: false,
				error: 'Maestro is not running',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});
});
