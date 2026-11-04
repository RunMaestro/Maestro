// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/spawnHelpers.test.ts
// Source: src/__tests__/renderer/utils/terminalKeys.test.ts
// Source: src/__tests__/renderer/utils/textareaSizing.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	loadJourneyFilePath,
	prepareMaestroSystemPrompt,
} from '../../../renderer/utils/spawnHelpers';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { TERMINAL_KEY_SEQUENCES, toControlChar } from '../../../renderer/utils/terminalKeys';
import {
	clampTextareaHeight,
	normalizeTextareaHeight,
	resolveTextareaHeight,
	resizeTextareaToContent,
	sanitizeTextareaHeights,
	scrollTextareaToCaretEnd,
} from '../../../renderer/utils/textareaSizing';
vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((content: string, vars: Record<string, any>) => {
		let result = content;
		for (const [key, value] of Object.entries(vars)) {
			if (typeof value === 'string') {
				result = result.replace(`{{${key}}}`, value);
			}
		}
		return result;
	}),
}));
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
	},
}));
// Source: src/__tests__/renderer/utils/spawnHelpers.test.ts
describe('', () => {
	describe('prepareMaestroSystemPrompt', () => {
		const baseSession = {
			id: 'session-1',
			cwd: '/test/project',
			isGitRepo: false,
			groupId: 'group-1',
		};
		beforeEach(() => {
			vi.clearAllMocks();
			(window as any).maestro = {
				...(window as any).maestro,
				prompts: {
					get: vi.fn().mockResolvedValue({
						success: true,
						content: 'System prompt for {{activeTabId}}',
					}),
				},
				history: {
					getFilePath: vi.fn().mockResolvedValue('/mock/history/path.jsonl'),
				},
				journey: {
					getPath: vi.fn().mockResolvedValue('/mock/journey/session-1.jsonl'),
				},
			};
		});
		it('returns undefined when prompt load fails', async () => {
			(window as any).maestro.prompts.get.mockResolvedValue({
				success: false,
				error: 'not found',
			});
			const result = await prepareMaestroSystemPrompt({ session: baseSession });
			expect(result).toBeUndefined();
		});
		it('returns undefined when prompt content is empty', async () => {
			(window as any).maestro.prompts.get.mockResolvedValue({
				success: true,
				content: '',
			});
			const result = await prepareMaestroSystemPrompt({ session: baseSession });
			expect(result).toBeUndefined();
		});
		it('returns substituted prompt', async () => {
			const result = await prepareMaestroSystemPrompt({
				session: baseSession,
				activeTabId: 'tab-42',
			});
			expect(result).toBeDefined();
			expect(typeof result).toBe('string');
			expect((window as any).maestro.prompts.get).toHaveBeenCalledWith('maestro-system-prompt');
		});
		it('resolves git branch when session is a git repo', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			const result = await prepareMaestroSystemPrompt({
				session: { ...baseSession, isGitRepo: true },
			});
			expect(result).toBeDefined();
			expect(gitService.getStatus).toHaveBeenCalledWith('/test/project');
		});
		it('skips git branch when session is not a git repo', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			await prepareMaestroSystemPrompt({
				session: { ...baseSession, isGitRepo: false },
			});
			expect(gitService.getStatus).not.toHaveBeenCalled();
		});
		it('handles git status errors gracefully', async () => {
			const { gitService } = await import('../../../renderer/services/git');
			vi.mocked(gitService.getStatus).mockRejectedValueOnce(new Error('git failed'));
			const result = await prepareMaestroSystemPrompt({
				session: { ...baseSession, isGitRepo: true },
			});
			expect(result).toBeDefined();
		});
		it('fetches history file path for non-SSH sessions', async () => {
			await prepareMaestroSystemPrompt({ session: baseSession });
			expect((window as any).maestro.history.getFilePath).toHaveBeenCalledWith('session-1');
		});
		it('skips history file path for SSH sessions (sshRemoteId)', async () => {
			await prepareMaestroSystemPrompt({
				session: { ...baseSession, sshRemoteId: 'remote-1' },
			});
			expect((window as any).maestro.history.getFilePath).not.toHaveBeenCalled();
		});
		it('skips history file path for SSH sessions (sessionSshRemoteConfig)', async () => {
			await prepareMaestroSystemPrompt({
				session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
			});
			expect((window as any).maestro.history.getFilePath).not.toHaveBeenCalled();
		});
		it('reads the journey path for non-SSH sessions', async () => {
			await prepareMaestroSystemPrompt({ session: baseSession });
			expect((window as any).maestro.journey.getPath).toHaveBeenCalledWith('session-1');
		});
		it('handles history file path errors gracefully', async () => {
			(window as any).maestro.history.getFilePath.mockRejectedValueOnce(
				new Error('history failed')
			);
			const result = await prepareMaestroSystemPrompt({ session: baseSession });
			expect(result).toBeDefined();
		});
		it('re-injects prompt on every call (no resume-based skip)', async () => {
			// Regression: prior impl returned undefined when a legacy `agentSessionId`
			// was present. Because Claude Code's --append-system-prompt is NOT persisted
			// into the session transcript, resuming with `--resume` dropped the Maestro
			// prompt from turn 2 onward. The prompt MUST be re-injected on every spawn.
			const first = await prepareMaestroSystemPrompt({ session: baseSession });
			const second = await prepareMaestroSystemPrompt({ session: baseSession });
			expect(first).toBeDefined();
			expect(second).toBeDefined();
			// The base prompt each time, plus the Maestro Cue section (Cue ships on).
			const ids = (window as any).maestro.prompts.get.mock.calls.map((call: unknown[]) => call[0]);
			expect(ids.filter((id: string) => id === 'maestro-system-prompt')).toHaveLength(2);
		});
		describe('role and plugin sections (shared assembler)', () => {
			const prompts: Record<string, string> = {
				'maestro-system-prompt': 'BASE',
				'pianola-system': 'PIANOLA',
				'computer-history-system': 'HISTORY {{COMPUTER_HISTORY_DIR}}',
			};
			let savedEncore: unknown;
			beforeEach(() => {
				savedEncore = useSettingsStore.getState().encoreFeatures;
				(window as any).maestro.prompts.get = vi.fn(async (id: string) =>
					id in prompts ? { success: true, content: prompts[id] } : { success: false }
				);
				(window as any).maestro.prompts.getSystemPromptPaths = vi
					.fn()
					.mockResolvedValue({ success: true, computerHistoryDir: '/ud/computer-history' });
			});
			afterEach(() => {
				useSettingsStore.setState({ encoreFeatures: savedEncore as any });
			});
			const enableComputerHistory = () =>
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: true },
				});
			it('returns only the base prompt while no section applies', async () => {
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: false },
				});
				const result = await prepareMaestroSystemPrompt({ session: baseSession });
				expect(result).toBe('BASE');
			});
			it('appends the Pianola role section for the Pianola agent', async () => {
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: false, pianola: true },
				});
				const result = await prepareMaestroSystemPrompt({
					session: { ...baseSession, isPianola: true },
				});
				expect(result).toBe('BASE\n\n---\n\nPIANOLA');
			});
			it('leaves the Pianola role section out while the pianola flag is off', async () => {
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: false, pianola: false },
				});
				const result = await prepareMaestroSystemPrompt({
					session: { ...baseSession, isPianola: true },
				});
				expect(result).toBe('BASE');
			});
			it('appends the Computer History section with the local store path when enabled', async () => {
				enableComputerHistory();
				const result = await prepareMaestroSystemPrompt({ session: baseSession });
				expect(result).toBe('BASE\n\n---\n\nHISTORY /ud/computer-history');
				expect((window as any).maestro.prompts.get).toHaveBeenCalledWith('computer-history-system');
			});
			it('skips the localOnly section and the store path for SSH agents', async () => {
				enableComputerHistory();
				const result = await prepareMaestroSystemPrompt({
					session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
				});
				expect(result).toBe('BASE');
				expect((window as any).maestro.prompts.get).not.toHaveBeenCalledWith(
					'computer-history-system'
				);
			});
			describe('MaestroRun', () => {
				const LAUNCHER = '/Users/me/Applications/MaestroRun.app/Contents/MacOS/maestro-run';
				const readyPath = () =>
					(window as any).maestro.maestroRun.readyPath as ReturnType<typeof vi.fn>;
				beforeEach(() => {
					prompts['maestro-run-system'] = 'RUN {{MAESTRO_RUN_PATH}}';
					readyPath().mockReset();
					readyPath().mockResolvedValue(null);
					useSettingsStore.setState({
						encoreFeatures: { ...(savedEncore as any), computerHistory: false, maestroRun: true },
					});
				});
				afterEach(() => {
					delete prompts['maestro-run-system'];
				});
				it('is left out while the tile is on but the launcher is not ready', async () => {
					const result = await prepareMaestroSystemPrompt({ session: baseSession });
					expect(result).toBe('BASE');
					expect(readyPath()).toHaveBeenCalledTimes(1);
					expect((window as any).maestro.prompts.get).not.toHaveBeenCalledWith(
						'maestro-run-system'
					);
				});
				it('is appended with the launcher path once main says ready', async () => {
					readyPath().mockResolvedValue(LAUNCHER);
					const result = await prepareMaestroSystemPrompt({ session: baseSession });
					expect(result).toBe(`BASE\n\n---\n\nRUN ${LAUNCHER}`);
				});
				it('asks main on every spawn, so a new or revoked grant shows up at once', async () => {
					readyPath().mockResolvedValueOnce(LAUNCHER).mockResolvedValueOnce(null);
					expect(await prepareMaestroSystemPrompt({ session: baseSession })).toContain('RUN');
					expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
				});
				it('does not ask main at all while the feature is off', async () => {
					readyPath().mockResolvedValue(LAUNCHER);
					useSettingsStore.setState({
						encoreFeatures: { ...(savedEncore as any), computerHistory: false, maestroRun: false },
					});
					expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
					expect(readyPath()).not.toHaveBeenCalled();
				});
				it('is never given to an SSH agent', async () => {
					readyPath().mockResolvedValue(LAUNCHER);
					const result = await prepareMaestroSystemPrompt({
						session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
					});
					expect(result).toBe('BASE');
					expect(readyPath()).not.toHaveBeenCalled();
				});
				it('reads a failed check as not ready', async () => {
					readyPath().mockRejectedValue(new Error('main not ready'));
					expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
				});
			});
			it('skips a section whose prompt fails to load', async () => {
				enableComputerHistory();
				delete prompts['computer-history-system'];
				const result = await prepareMaestroSystemPrompt({ session: baseSession });
				expect(result).toBe('BASE');
				prompts['computer-history-system'] = 'HISTORY {{COMPUTER_HISTORY_DIR}}';
			});
		});
	});
	describe('loadJourneyFilePath', () => {
		beforeEach(() => {
			(window as any).maestro = {
				...(window as any).maestro,
				journey: { getPath: vi.fn().mockResolvedValue('/mock/journey/a1.jsonl') },
			};
		});
		it('returns the path for a local agent', async () => {
			await expect(loadJourneyFilePath('a1', false)).resolves.toBe('/mock/journey/a1.jsonl');
		});
		it('skips the local-only path for an SSH agent', async () => {
			await expect(loadJourneyFilePath('a1', true)).resolves.toBeUndefined();
			expect((window as any).maestro.journey.getPath).not.toHaveBeenCalled();
		});
		it('reads a failed lookup or a missing bridge as no path', async () => {
			(window as any).maestro.journey.getPath.mockRejectedValueOnce(new Error('no path'));
			await expect(loadJourneyFilePath('a1', false)).resolves.toBeUndefined();
			(window as any).maestro = { ...(window as any).maestro, journey: undefined };
			await expect(loadJourneyFilePath('a1', false)).resolves.toBeUndefined();
		});
	});
});
// Source: src/__tests__/renderer/utils/terminalKeys.test.ts
describe('', () => {
	describe('TERMINAL_KEY_SEQUENCES', () => {
		it('maps each key bar button to the raw PTY byte sequence a hardware key would send', () => {
			expect(TERMINAL_KEY_SEQUENCES.esc).toBe('\x1b');
			expect(TERMINAL_KEY_SEQUENCES.tab).toBe('\t');
			expect(TERMINAL_KEY_SEQUENCES.enter).toBe('\r');
			expect(TERMINAL_KEY_SEQUENCES.up).toBe('\x1b[A');
			expect(TERMINAL_KEY_SEQUENCES.down).toBe('\x1b[B');
			expect(TERMINAL_KEY_SEQUENCES.left).toBe('\x1b[D');
			expect(TERMINAL_KEY_SEQUENCES.right).toBe('\x1b[C');
		});
	});
	describe('toControlChar', () => {
		it('folds lowercase letters onto their Ctrl code (\\x01-\\x1a)', () => {
			expect(toControlChar('a')).toBe('\x01');
			expect(toControlChar('c')).toBe('\x03'); // Ctrl-C
			expect(toControlChar('d')).toBe('\x04'); // Ctrl-D
			expect(toControlChar('z')).toBe('\x1a');
		});
		it('treats uppercase letters identically to lowercase', () => {
			expect(toControlChar('C')).toBe('\x03');
			expect(toControlChar('Z')).toBe('\x1a');
		});
		it('maps the classic control symbols @ [ \\ ] ^ _', () => {
			expect(toControlChar('@')).toBe('\x00'); // Ctrl-@ = NUL
			expect(toControlChar('[')).toBe('\x1b'); // Ctrl-[ = ESC
			expect(toControlChar('\\')).toBe('\x1c');
			expect(toControlChar(']')).toBe('\x1d');
			expect(toControlChar('^')).toBe('\x1e');
			expect(toControlChar('_')).toBe('\x1f'); // Ctrl-_
		});
		it('maps ? to DEL and space to NUL', () => {
			expect(toControlChar('?')).toBe('\x7f');
			expect(toControlChar(' ')).toBe('\x00');
		});
		it('passes through digits and other single chars with no control code', () => {
			expect(toControlChar('1')).toBe('1');
			expect(toControlChar('!')).toBe('!');
		});
		it('leaves multi-byte input untouched (paste / IME / escape sequences)', () => {
			expect(toControlChar('hello')).toBe('hello');
			expect(toControlChar('\x1b[A')).toBe('\x1b[A');
			expect(toControlChar('')).toBe('');
		});
	});
});
// Source: src/__tests__/renderer/utils/textareaSizing.test.ts
describe('', () => {
	function setViewportHeight(height: number) {
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
	}
	describe('textareaSizing', () => {
		beforeEach(() => {
			setViewportHeight(900);
		});
		describe('normalizeTextareaHeight', () => {
			it('rounds finite positive numbers', () => {
				expect(normalizeTextareaHeight(120.4)).toBe(120);
				expect(normalizeTextareaHeight(120.6)).toBe(121);
			});
			it('rejects junk values', () => {
				for (const value of [0, -10, NaN, Infinity, '200', null, undefined, {}]) {
					expect(normalizeTextareaHeight(value)).toBeNull();
				}
			});
		});
		describe('sanitizeTextareaHeights', () => {
			it('keeps valid entries and drops the rest', () => {
				expect(
					sanitizeTextareaHeights({
						good: 240,
						rounded: 199.7,
						zero: 0,
						negative: -5,
						text: '300',
					})
				).toEqual({ good: 240, rounded: 200 });
			});
			it('returns an empty map for non-objects', () => {
				expect(sanitizeTextareaHeights(null)).toEqual({});
				expect(sanitizeTextareaHeights([240])).toEqual({});
				expect(sanitizeTextareaHeights('240')).toEqual({});
			});
		});
		describe('clampTextareaHeight', () => {
			it('honors the declared minimum', () => {
				expect(clampTextareaHeight(40, { minHeight: 100 })).toBe(100);
			});
			it('caps at the declared maximum', () => {
				expect(clampTextareaHeight(900, { minHeight: 100, maxHeight: 400 })).toBe(400);
			});
			it('caps at the viewport even without a declared maximum', () => {
				setViewportHeight(600);
				// Viewport minus padding on both sides is the tighter of the two caps.
				expect(clampTextareaHeight(5000, { minHeight: 100 })).toBe(536);
			});
			it('never returns a minimum larger than the viewport allows', () => {
				setViewportHeight(300);
				expect(clampTextareaHeight(10, { minHeight: 5000 })).toBe(236);
			});
		});
		describe('resolveTextareaHeight', () => {
			it('prefers the saved height', () => {
				expect(resolveTextareaHeight({ savedHeight: 250, defaultHeight: 100 })).toBe(250);
			});
			it('falls back to the default when nothing is saved', () => {
				expect(resolveTextareaHeight({ savedHeight: undefined, defaultHeight: 100 })).toBe(100);
			});
			it('ignores a corrupt saved height', () => {
				expect(resolveTextareaHeight({ savedHeight: -20, defaultHeight: 100 })).toBe(100);
			});
			it('returns null when nothing is saved and no default is declared', () => {
				expect(resolveTextareaHeight({ savedHeight: undefined })).toBeNull();
			});
			it('clamps a saved height that no longer fits the viewport', () => {
				setViewportHeight(500);
				expect(resolveTextareaHeight({ savedHeight: 2000, minHeight: 100 })).toBe(436);
			});
		});
	});
	describe('resizeTextareaToContent', () => {
		it('resizes to content height capped by max height', () => {
			const textarea = document.createElement('textarea');
			Object.defineProperty(textarea, 'scrollHeight', { value: 220, configurable: true });
			resizeTextareaToContent(textarea, 176);
			expect(textarea.style.height).toBe('176px');
		});
		it('resizes to exact content height below cap', () => {
			const textarea = document.createElement('textarea');
			Object.defineProperty(textarea, 'scrollHeight', { value: 80, configurable: true });
			resizeTextareaToContent(textarea, 176);
			expect(textarea.style.height).toBe('80px');
		});
		it('preserves scroll position across the auto-height toggle', () => {
			const textarea = document.createElement('textarea');
			Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true });
			textarea.scrollTop = 120;
			resizeTextareaToContent(textarea, 176);
			expect(textarea.scrollTop).toBe(120);
		});
	});
	describe('scrollTextareaToCaretEnd', () => {
		it('scrolls the textarea to the bottom when the caret is at the end', () => {
			const textarea = document.createElement('textarea');
			textarea.value = 'hello';
			textarea.scrollTop = 12;
			Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
			Object.defineProperty(textarea, 'selectionEnd', {
				value: textarea.value.length,
				configurable: true,
			});
			scrollTextareaToCaretEnd(textarea);
			expect(textarea.scrollTop).toBe(240);
		});
		it('leaves scroll untouched when the caret is mid-way through the final logical line', () => {
			const textarea = document.createElement('textarea');
			// Regression for the soft-wrap edge case: a long final logical line can wrap
			// across several visual rows past the height cap. A caret before the trailing
			// characters (e.g. an inserted mention) belongs to an earlier visual row, so
			// snapping to scrollHeight would scroll it out of view. The gate keys off the
			// true end of the value, not the final logical line, precisely to avoid that.
			textarea.value = 'first\nsecond\nlast line';
			textarea.scrollTop = 12;
			Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
			Object.defineProperty(textarea, 'selectionEnd', {
				value: textarea.value.indexOf('last line') + 4,
				configurable: true,
			});
			scrollTextareaToCaretEnd(textarea);
			expect(textarea.scrollTop).toBe(12);
		});
		it('leaves scroll untouched for mid-text typing', () => {
			const textarea = document.createElement('textarea');
			textarea.value = 'hello world';
			textarea.scrollTop = 30;
			Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
			Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });
			scrollTextareaToCaretEnd(textarea);
			expect(textarea.scrollTop).toBe(30);
		});
	});
});
