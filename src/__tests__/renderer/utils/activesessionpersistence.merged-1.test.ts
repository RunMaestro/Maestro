// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/activeSessionPersistence.test.ts
// Source: src/__tests__/renderer/utils/agentArgs.test.ts
// Source: src/__tests__/renderer/utils/agentTaskList.test.ts
// Source: src/__tests__/renderer/utils/applyTypographyVars.test.ts
// Source: src/__tests__/renderer/utils/autoRunDraft.test.ts
// Source: src/__tests__/renderer/utils/browserTabPersistence.test.ts
// Source: src/__tests__/renderer/utils/documentStats.test.ts
// Source: src/__tests__/renderer/utils/fileTree.test.ts
// Source: src/__tests__/renderer/utils/groupChatAutoRun.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	persistActiveSessionId,
	readPersistedActiveSessionId,
	WEB_ACTIVE_SESSION_STORAGE_KEY,
	persistClientSessionView,
	restoreClientSessionView,
} from '../../../renderer/utils/activeSessionPersistence';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';
import { installLocalStorageMock, installSessionStorageMock } from '../../helpers/mockLocalStorage';
import { createMockSession, createMockAITab } from '../../helpers';
import { filterYoloArgs } from '../../../renderer/utils/agentArgs';
import {
	extractAgentTaskList,
	findLatestAgentTaskList,
	summarizeAgentTaskList,
} from '../../../renderer/utils/agentTaskList';
import type { LogEntry } from '../../../renderer/types';
import {
	computeTypographyVars,
	type TypographyVarInput,
} from '../../../renderer/utils/applyTypographyVars';
import { MONO_ACCENT_VAR, TYPOGRAPHY_SURFACE_SPECS } from '../../../shared/typography';
import {
	isAutoRunDocumentLocked,
	isAutoRunRunDocument,
	reconcileDiskContent,
} from '../../../renderer/utils/autoRunDraft';
import type { BatchRunState } from '../../../renderer/types';
import {
	DEFAULT_BROWSER_TAB_URL,
	DEFAULT_BROWSER_TAB_TITLE,
	getBrowserTabLabel,
	getBrowserTabPartition,
	getBrowserTabTitle,
	getEphemeralBrowserTabPartition,
	getSafeBrowserTabPartition,
	isEphemeralBrowserTab,
	isHttpBrowserTabUrl,
	normalizeBrowserTabUrl,
	sanitizeBrowserTabForPersistence,
	resolveBrowserTabNavigationTarget,
	toWebviewSrc,
} from '../../../renderer/utils/browserTabPersistence';
import type { BrowserTab } from '../../../shared/browserPage';
/**
 * Tests for document stats utility
 */
import {
	computeDocumentStats,
	formatFileSize,
	countWords,
	countLines,
	extractTitle,
	extractDescription,
	type DocumentStats,
} from '../../../renderer/utils/documentStats';
import { buildFileTreeFromPaths } from '../../../renderer/utils/fileTree';
import type { FileNode } from '../../../renderer/types/fileTree';
import {
	normalizeAutoRunTargetFilename,
	resolveGroupChatAutoRunTarget,
} from '../../../renderer/utils/groupChatAutoRun';
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));
// Source: src/__tests__/renderer/utils/activeSessionPersistence.test.ts
describe('', () => {
	const asWebDesktop = (value: boolean) => vi.mocked(isWebDesktop).mockReturnValue(value);
	describe('activeSessionPersistence', () => {
		let setActiveSessionId: ReturnType<typeof vi.fn>;
		let getActiveSessionId: ReturnType<typeof vi.fn>;
		beforeEach(() => {
			// Both tiers are mocked rather than cleared: this environment ships no
			// working Storage, so a bare `localStorage.clear()` throws and takes the
			// whole suite with it. Installing fresh mocks doubles as the per-test reset.
			installLocalStorageMock();
			installSessionStorageMock();
			asWebDesktop(false);
			setActiveSessionId = vi.fn().mockResolvedValue(undefined);
			getActiveSessionId = vi.fn().mockResolvedValue('desktop-agent');
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = {
				sessions: { setActiveSessionId, getActiveSessionId },
			};
		});
		describe('on the desktop', () => {
			it('writes the shared pointer', () => {
				persistActiveSessionId('agent-1');
				expect(setActiveSessionId).toHaveBeenCalledWith('agent-1');
				expect(localStorage.getItem(WEB_ACTIVE_SESSION_STORAGE_KEY)).toBeNull();
			});
			it('reads the shared pointer, ignoring any web-desktop leftover', async () => {
				localStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'browser-agent');
				sessionStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'browser-tab-agent');
				await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
			});
		});
		describe('in web-desktop', () => {
			beforeEach(() => asWebDesktop(true));
			it('records independent focus without replacing the host pointer', async () => {
				let hostFocus = 'host-agent';
				setActiveSessionId.mockImplementation(async (id) => {
					hostFocus = id;
				});
				getActiveSessionId.mockImplementation(async () => hostFocus);
				persistActiveSessionId('agent-2');
				expect(await readPersistedActiveSessionId()).toBe('agent-2');
				expect(hostFocus).toBe('host-agent');
			});
			it('restores what THIS tab was on, not what another tab moved to', async () => {
				// Two tabs share an origin and therefore share localStorage, so a
				// tab-scoped answer has to win or the bleed just moves one level down.
				sessionStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'this-tab-agent');
				localStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'other-tab-agent');
				await expect(readPersistedActiveSessionId()).resolves.toBe('this-tab-agent');
				expect(getActiveSessionId).not.toHaveBeenCalled();
			});
			it('opens a fresh tab on the last agent used in this browser', async () => {
				localStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'browser-agent');
				await expect(readPersistedActiveSessionId()).resolves.toBe('browser-agent');
				expect(getActiveSessionId).not.toHaveBeenCalled();
			});
			it('falls back to the desktop pointer on a first visit', async () => {
				await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
			});
			it('falls back when browser Storage refuses reads', async () => {
				const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
					throw new DOMException('SecurityError');
				});
				try {
					await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
				} finally {
					blocked.mockRestore();
				}
			});
			it('never falls back to shared host writes when Storage refuses client focus', async () => {
				let hostFocus = 'host-agent';
				setActiveSessionId.mockImplementation(async (id) => {
					hostFocus = id;
				});
				getActiveSessionId.mockImplementation(async () => hostFocus);
				const blockedSession = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
					throw new DOMException('QuotaExceededError');
				});
				const blockedLocal = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
					throw new DOMException('QuotaExceededError');
				});
				try {
					persistActiveSessionId('agent-3');
					expect(await readPersistedActiveSessionId()).toBe('host-agent');
					expect(hostFocus).toBe('host-agent');
				} finally {
					blockedSession.mockRestore();
					blockedLocal.mockRestore();
				}
			});
			it('restores this client draft and tab after rebootstrap without copying host drafts', () => {
				const host = createMockSession({
					id: 'shared',
					activeTabId: 'host-tab',
					aiTabs: [createMockAITab({ id: 'one' })],
				});
				const own = {
					...host,
					activeTabId: 'my-tab',
					terminalDraftInput: 'my terminal draft',
					aiTabs: [{ ...host.aiTabs[0], inputValue: 'my unsent prompt' }],
				};
				persistClientSessionView(own);
				const restored = restoreClientSessionView({
					...host,
					aiTabs: [{ ...host.aiTabs[0], inputValue: 'host unsent prompt' }],
				});
				expect(restored.activeTabId).toBe('my-tab');
				expect(restored.aiTabs[0].inputValue).toBe('my unsent prompt');
				expect(restored.terminalDraftInput).toBe('my terminal draft');
				sessionStorage.clear();
				expect(restoreClientSessionView(own).aiTabs[0].inputValue).toBe('');
			});
			it('preserves a native client draft across view recreation without borrowing another window draft', async () => {
				const originalUrl = window.location.href;
				const host = createMockSession({
					id: 'shared',
					aiTabs: [createMockAITab({ id: 'one', inputValue: 'host draft' })],
				});
				try {
					window.history.replaceState(null, '', '?liteClientId=first-window');
					persistClientSessionView({
						...host,
						activeGroupId: 'first-group',
						aiTabs: [{ ...host.aiTabs[0], inputValue: 'first draft' }],
					});
					persistActiveSessionId('first-agent');
					sessionStorage.clear();
					window.history.replaceState(null, '', '?liteClientId=second-window');
					expect(restoreClientSessionView(host).aiTabs[0].inputValue).toBe('');
					persistClientSessionView({
						...host,
						aiTabs: [{ ...host.aiTabs[0], inputValue: 'second draft' }],
					});
					persistActiveSessionId('second-agent');
					sessionStorage.clear();
					window.history.replaceState(null, '', '?liteClientId=first-window');
					expect(restoreClientSessionView(host).aiTabs[0].inputValue).toBe('first draft');
					expect(restoreClientSessionView(host).activeGroupId).toBe('first-group');
					expect(await readPersistedActiveSessionId()).toBe('first-agent');
				} finally {
					window.history.replaceState(null, '', originalUrl);
				}
			});
		});
		it('returns an empty id when there is no bridge at all', async () => {
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = {};
			await expect(readPersistedActiveSessionId()).resolves.toBe('');
		});
	});
});
// Source: src/__tests__/renderer/utils/agentArgs.test.ts
describe('', () => {
	describe('filterYoloArgs', () => {
		it('filters --dangerously-skip-permissions from args', () => {
			const result = filterYoloArgs(['--print', '--dangerously-skip-permissions', '--verbose'], {});
			expect(result).toEqual(['--print', '--verbose']);
		});
		it('filters --dangerously-bypass-approvals-and-sandbox from args', () => {
			const result = filterYoloArgs(['--json', '--dangerously-bypass-approvals-and-sandbox'], {});
			expect(result).toEqual(['--json']);
		});
		it('filters --skip-permissions-unsafe from args', () => {
			const result = filterYoloArgs(['--skip-permissions-unsafe', '--format', 'json'], {});
			expect(result).toEqual(['--format', 'json']);
		});
		it('filters -y from args', () => {
			const result = filterYoloArgs(['--output-format', 'stream-json', '-y'], {});
			expect(result).toEqual(['--output-format', 'stream-json']);
		});
		it('includes agent-specific yoloModeArgs in the filter', () => {
			const result = filterYoloArgs(['--custom-yolo', '--safe-flag'], {
				yoloModeArgs: ['--custom-yolo'],
			});
			expect(result).toEqual(['--safe-flag']);
		});
		it('returns all args when none are YOLO flags', () => {
			const args = ['--print', '--verbose', '--format', 'json'];
			const result = filterYoloArgs(args, {});
			expect(result).toEqual(args);
		});
		it('returns empty array when all args are YOLO flags', () => {
			const result = filterYoloArgs(['--dangerously-skip-permissions', '-y'], {});
			expect(result).toEqual([]);
		});
		it('handles empty args array', () => {
			const result = filterYoloArgs([], {});
			expect(result).toEqual([]);
		});
		it('handles empty yoloModeArgs array', () => {
			const result = filterYoloArgs(['--print', '-y'], { yoloModeArgs: [] });
			expect(result).toEqual(['--print']);
		});
	});
});
// Source: src/__tests__/renderer/utils/agentTaskList.test.ts
describe('', () => {
	describe('extractAgentTaskList', () => {
		it('extracts a Claude Code / OpenCode TodoWrite todos array', () => {
			const list = extractAgentTaskList({
				todos: [
					{ content: 'Fix lint issues', status: 'completed', activeForm: 'Fixing lint issues' },
					{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
					{ content: 'Build project', status: 'pending', activeForm: 'Building project' },
				],
			});
			expect(list).not.toBeNull();
			expect(list?.tasks).toHaveLength(3);
			expect(list?.completed).toBe(1);
			expect(list?.inProgress?.content).toBe('Run tests');
			expect(list?.tasks[1].activeForm).toBe('Running tests');
		});
		it('extracts a Codex update_plan plan array', () => {
			const list = extractAgentTaskList({
				plan: [
					{ step: 'Read the failing spec', status: 'completed' },
					{ step: 'Patch the parser', status: 'in_progress' },
				],
			});
			expect(list?.tasks.map((t) => t.content)).toEqual([
				'Read the failing spec',
				'Patch the parser',
			]);
			expect(list?.completed).toBe(1);
			expect(list?.inProgress?.content).toBe('Patch the parser');
		});
		it('extracts a generic tasks array with title labels', () => {
			const list = extractAgentTaskList({
				tasks: [
					{ title: 'Draft the RFC', status: 'done' },
					{ title: 'Circulate for review', status: 'pending' },
				],
			});
			expect(list?.tasks[0].status).toBe('completed');
			expect(list?.tasks[1].status).toBe('pending');
		});
		it('normalizes status spellings and unknown values', () => {
			const list = extractAgentTaskList({
				todos: [
					{ content: 'a', status: 'in-progress' },
					{ content: 'b', status: 'COMPLETE' },
					{ content: 'c', status: 'blocked' },
					{ content: 'd' },
				],
			});
			expect(list?.tasks.map((t) => t.status)).toEqual([
				'in_progress',
				'completed',
				'pending',
				'pending',
			]);
		});
		it('returns the first in-progress task when several are marked active', () => {
			const list = extractAgentTaskList({
				todos: [
					{ content: 'first', status: 'in_progress' },
					{ content: 'second', status: 'in_progress' },
				],
			});
			expect(list?.inProgress?.content).toBe('first');
		});
		it('returns null for payloads that are not checklists', () => {
			expect(extractAgentTaskList({ command: 'npm test' })).toBeNull();
			expect(extractAgentTaskList({ todos: [] })).toBeNull();
			expect(extractAgentTaskList({ todos: 'not an array' })).toBeNull();
			expect(extractAgentTaskList(null)).toBeNull();
			expect(extractAgentTaskList(undefined)).toBeNull();
			expect(extractAgentTaskList('raw string input')).toBeNull();
			expect(extractAgentTaskList([{ content: 'top level array' }])).toBeNull();
		});
		it('rejects arrays whose entries have no usable label', () => {
			// A partially-labeled list would misreport progress, so fall back to
			// generic tool rendering instead.
			expect(
				extractAgentTaskList({ todos: [{ content: 'ok' }, { status: 'pending' }] })
			).toBeNull();
			expect(extractAgentTaskList({ todos: [1, 2, 3] })).toBeNull();
		});
	});
	describe('summarizeAgentTaskList', () => {
		it('prefers the active task activeForm with a progress count', () => {
			const list = extractAgentTaskList({
				todos: [
					{ content: 'Fix lint issues', status: 'completed', activeForm: 'Fixing lint issues' },
					{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
					{ content: 'Build project', status: 'pending', activeForm: 'Building project' },
				],
			})!;
			expect(summarizeAgentTaskList(list)).toBe('Running tests (1/3)');
		});
		it('falls back to the first task when nothing is in progress', () => {
			const list = extractAgentTaskList({
				todos: [
					{ content: 'Fix lint issues', status: 'completed' },
					{ content: 'Run tests', status: 'completed' },
				],
			})!;
			expect(summarizeAgentTaskList(list)).toBe('Fix lint issues (2/2)');
		});
		it('uses the in-progress content when no activeForm is supplied', () => {
			const list = extractAgentTaskList({
				plan: [{ step: 'Patch the parser', status: 'in_progress' }],
			})!;
			expect(summarizeAgentTaskList(list)).toBe('Patch the parser (0/1)');
		});
	});
	describe('findLatestAgentTaskList', () => {
		const toolEntry = (id: string, input: unknown) =>
			({
				id,
				timestamp: 0,
				source: 'tool',
				text: 'TodoWrite',
				metadata: { toolState: { status: 'completed', input } },
			}) as unknown as LogEntry;
		const todos = (...statuses: string[]) => ({
			todos: statuses.map((status, i) => ({ content: `task ${i}`, status })),
		});
		it('returns the newest checklist in the log', () => {
			const latest = findLatestAgentTaskList([
				toolEntry('a', todos('in_progress', 'pending')),
				toolEntry('b', { file_path: '/tmp/x.ts' }),
				toolEntry('c', todos('completed', 'in_progress')),
			]);
			expect(latest?.entryId).toBe('c');
			expect(latest?.list.completed).toBe(1);
		});
		it('returns null when no tool call carried a checklist', () => {
			expect(findLatestAgentTaskList([toolEntry('a', { command: 'ls' })])).toBeNull();
			expect(findLatestAgentTaskList([])).toBeNull();
			expect(findLatestAgentTaskList(undefined)).toBeNull();
		});
		it('ignores non-tool entries', () => {
			const chat = {
				id: 'msg',
				timestamp: 0,
				source: 'ai',
				text: 'todos: 1. do it',
			} as LogEntry;
			expect(findLatestAgentTaskList([chat])).toBeNull();
		});
		it("skips a subagent's private checklist", () => {
			const nested = toolEntry('b', todos('pending', 'pending'));
			nested.metadata = { ...nested.metadata, parentToolUseId: 'task_1' };
			const latest = findLatestAgentTaskList([
				toolEntry('a', todos('in_progress', 'pending')),
				nested,
			]);
			expect(latest?.entryId).toBe('a');
		});
		it('returns null when the only checklist came from a subagent', () => {
			const nested = toolEntry('a', todos('pending'));
			nested.metadata = { ...nested.metadata, parentToolUseId: 'task_1' };
			expect(findLatestAgentTaskList([nested])).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/utils/applyTypographyVars.test.ts
describe('', () => {
	function input(overrides: Partial<TypographyVarInput> = {}): TypographyVarInput {
		return {
			fonts: {
				interface: 'Inter',
				chat: '',
				terminal: '',
				filePreview: '',
				fileEditor: '',
			},
			sizes: { interface: 14, chat: 0, terminal: 0, filePreview: 0, fileEditor: 0 },
			baseSize: 14,
			zoom: 1,
			...overrides,
		};
	}
	describe('computeTypographyVars', () => {
		it('publishes a font and a size variable for every surface', () => {
			// These are what reach the 47 components that portal to document.body
			// and the ~200 font-mono sites - none of which can take a prop.
			const vars = computeTypographyVars(input());
			for (const spec of Object.values(TYPOGRAPHY_SURFACE_SPECS)) {
				expect(vars[spec.fontVar]).toBeTruthy();
				expect(vars[spec.sizeVar]).toMatch(/^[\d.]+px$/);
			}
		});
		it('resolves an unset surface to the interface font', () => {
			const vars = computeTypographyVars(input());
			expect(vars['--maestro-font-chat']).toContain('Inter');
			expect(vars['--maestro-font-file-preview']).toContain('Inter');
		});
		it('prefers a surface font over the interface font', () => {
			const vars = computeTypographyVars(
				input({
					fonts: {
						interface: 'Inter',
						chat: '',
						terminal: 'JetBrains Mono',
						filePreview: '',
						fileEditor: '',
					},
				})
			);
			expect(vars['--maestro-font-terminal']).toContain('JetBrains Mono');
			expect(vars['--maestro-font-terminal']).not.toContain('Inter');
		});
		it('always appends a generic family so nothing can fall through to serif', () => {
			const vars = computeTypographyVars(
				input({ fonts: { ...input().fonts, interface: 'Nonesuch' } })
			);
			for (const spec of Object.values(TYPOGRAPHY_SURFACE_SPECS)) {
				expect(vars[spec.fontVar]).toMatch(/\b(monospace|sans-serif|serif)\b/);
			}
		});
		describe('the code face', () => {
			it('follows the terminal font, the user\'s answer to "what is code"', () => {
				const vars = computeTypographyVars(
					input({
						fonts: { ...input().fonts, terminal: 'Fira Code' },
					})
				);
				expect(vars[MONO_ACCENT_VAR]).toContain('Fira Code');
			});
			it('falls back to the interface font when the terminal inherits', () => {
				const vars = computeTypographyVars(input());
				expect(vars[MONO_ACCENT_VAR]).toContain('Inter');
			});
		});
		describe('zoom', () => {
			it('scales every surface size by the same ratio', () => {
				const vars = computeTypographyVars(
					input({
						sizes: { interface: 16, chat: 0, terminal: 12, filePreview: 0, fileEditor: 0 },
						baseSize: 16,
						zoom: 1.5,
					})
				);
				expect(vars['--maestro-size-interface']).toBe('24px');
				expect(vars['--maestro-size-terminal']).toBe('18px');
			});
			it('drives --font-scale so fixed-width modals grow with the text', () => {
				// 14px is the baseline the .modal-w-* widths were drawn against.
				const vars = computeTypographyVars(input({ baseSize: 14, zoom: 2 }));
				expect(vars['--font-scale']).toBe('2');
			});
			it('leaves the surface sizes themselves untouched at 100%', () => {
				const vars = computeTypographyVars(
					input({ sizes: { ...input().sizes, terminal: 13 }, zoom: 1 })
				);
				expect(vars['--maestro-size-terminal']).toBe('13px');
			});
		});
		it('never lets the interface surface inherit, since it is the base', () => {
			// Its own size is used directly rather than resolved through itself,
			// which would be a cycle.
			const vars = computeTypographyVars(
				input({ baseSize: 18, sizes: { ...input().sizes, interface: 0 } })
			);
			expect(vars['--maestro-size-interface']).toBe('18px');
		});
	});
});
// Source: src/__tests__/renderer/utils/autoRunDraft.test.ts
describe('', () => {
	const runState = (overrides: Partial<BatchRunState> = {}) =>
		({
			isRunning: true,
			worktreeActive: false,
			lockedDocuments: ['plan'],
			...overrides,
		}) as BatchRunState;
	describe('reconcileDiskContent', () => {
		it('keeps the draft when the disk matches the saved text (own save echo)', () => {
			expect(
				reconcileDiskContent({ draft: 'Saved. More', saved: 'Saved.', incoming: 'Saved.' })
			).toEqual({ draft: 'Saved. More', saved: 'Saved.', conflict: false });
		});
		it('adopts the disk when there are no unsaved edits', () => {
			expect(reconcileDiskContent({ draft: 'A', saved: 'A', incoming: 'B' })).toEqual({
				draft: 'B',
				saved: 'B',
				conflict: false,
			});
		});
		it('treats a draft that already equals the disk as clean', () => {
			expect(reconcileDiskContent({ draft: 'B', saved: 'A', incoming: 'B' })).toEqual({
				draft: 'B',
				saved: 'B',
				conflict: false,
			});
		});
		it('keeps an unsaved draft over a different disk and moves the baseline', () => {
			expect(reconcileDiskContent({ draft: 'Mine', saved: 'A', incoming: 'Theirs' })).toEqual({
				draft: 'Mine',
				saved: 'Theirs',
				conflict: true,
			});
		});
		it('lets the disk win when a run owns the document', () => {
			expect(
				reconcileDiskContent({ draft: 'Mine', saved: 'A', incoming: 'Theirs', diskWins: true })
			).toEqual({ draft: 'Theirs', saved: 'Theirs', conflict: false });
		});
	});
	describe('isAutoRunRunDocument / isAutoRunDocumentLocked', () => {
		it('claims a locked document of a run on the main checkout', () => {
			expect(isAutoRunRunDocument(runState(), 'plan')).toBe(true);
			expect(isAutoRunDocumentLocked(runState(), 'plan', false)).toBe(true);
		});
		it('hands the document back while the run is paused', () => {
			expect(isAutoRunDocumentLocked(runState(), 'plan', true)).toBe(false);
		});
		it('never claims documents outside the run, in a worktree, or with no run', () => {
			expect(isAutoRunRunDocument(runState(), 'other')).toBe(false);
			expect(isAutoRunRunDocument(runState({ worktreeActive: true }), 'plan')).toBe(false);
			expect(isAutoRunRunDocument(runState({ isRunning: false }), 'plan')).toBe(false);
			expect(isAutoRunRunDocument(undefined, 'plan')).toBe(false);
			expect(isAutoRunRunDocument(runState(), null)).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/utils/browserTabPersistence.test.ts
describe('', () => {
	describe('browserTabPersistence', () => {
		describe('resolveBrowserTabNavigationTarget', () => {
			it('normalizes localhost addresses to http URLs', () => {
				expect(resolveBrowserTabNavigationTarget('localhost:5173/docs')).toEqual({
					kind: 'url',
					url: 'http://localhost:5173/docs',
				});
			});
			it('normalizes bare hosts to https URLs', () => {
				expect(resolveBrowserTabNavigationTarget('example.com/docs')).toEqual({
					kind: 'url',
					url: 'https://example.com/docs',
				});
			});
			it('converts free text into a search URL', () => {
				expect(resolveBrowserTabNavigationTarget('maestro browser tabs')).toEqual({
					kind: 'url',
					url: 'https://www.google.com/search?q=maestro%20browser%20tabs',
				});
			});
			it('rejects blocked protocols', () => {
				expect(resolveBrowserTabNavigationTarget('javascript:alert(1)')).toEqual({
					kind: 'error',
					message: 'Protocol not allowed in browser tabs: javascript:',
				});
			});
			it('treats blank input as a safe default URL', () => {
				expect(resolveBrowserTabNavigationTarget('   ')).toEqual({
					kind: 'url',
					url: DEFAULT_BROWSER_TAB_URL,
				});
			});
			// `looksLikeLocalAddress` matches the SHAPE of a loopback host, so it also
			// accepts values the URL parser rejects. These used to escape as a thrown
			// TypeError instead of the documented `{ kind: 'error' }` result.
			it.each([
				['localhost:99999', 'an out-of-range port'],
				['127.999.999.999', 'an out-of-range IPv4 octet'],
				['0.0.0.0:70000', 'an out-of-range port on a bare IPv4 host'],
			])('reports %s (%s) as an error instead of throwing', (input) => {
				expect(resolveBrowserTabNavigationTarget(input)).toEqual({
					kind: 'error',
					message: 'Enter a valid URL or search term',
				});
			});
		});
		describe('toWebviewSrc', () => {
			it('passes through a parseable URL unchanged', () => {
				expect(toWebviewSrc('https://example.com/docs')).toBe('https://example.com/docs');
			});
			it('keeps about:blank', () => {
				expect(toWebviewSrc(DEFAULT_BROWSER_TAB_URL)).toBe(DEFAULT_BROWSER_TAB_URL);
			});
			// Electron parses the `src` attribute with `new URL()` while attaching the
			// element, so any of these would throw mid-render (MAESTRO-QX/QY/QZ).
			it.each(['http://', 'https://[bad', 'https://x y', 'http://localhost:99999'])(
				'falls back to about:blank for the unparseable URL %s',
				(input) => {
					expect(toWebviewSrc(input)).toBe(DEFAULT_BROWSER_TAB_URL);
				}
			);
			it('falls back to about:blank for a missing URL', () => {
				expect(toWebviewSrc('')).toBe(DEFAULT_BROWSER_TAB_URL);
				expect(toWebviewSrc('   ')).toBe(DEFAULT_BROWSER_TAB_URL);
				expect(toWebviewSrc(null)).toBe(DEFAULT_BROWSER_TAB_URL);
				expect(toWebviewSrc(undefined)).toBe(DEFAULT_BROWSER_TAB_URL);
			});
		});
		describe('helpers', () => {
			it('falls back to about:blank when normalization hits a blocked protocol', () => {
				expect(normalizeBrowserTabUrl('javascript:alert(1)')).toBe(DEFAULT_BROWSER_TAB_URL);
			});
			it('derives a human-friendly title from a URL when page title is empty', () => {
				expect(getBrowserTabTitle('https://example.com/docs', '')).toBe('example.com');
			});
			it('uses the default new-tab title for about:blank without a page title', () => {
				expect(getBrowserTabTitle(DEFAULT_BROWSER_TAB_URL, '')).toBe(DEFAULT_BROWSER_TAB_TITLE);
			});
			describe('isHttpBrowserTabUrl', () => {
				it('accepts http and https URLs', () => {
					expect(isHttpBrowserTabUrl('http://example.com')).toBe(true);
					expect(isHttpBrowserTabUrl('https://example.com/docs?q=1')).toBe(true);
				});
				it('rejects dangerous and non-http schemes', () => {
					// eslint-disable-next-line no-script-url
					expect(isHttpBrowserTabUrl('javascript:alert(1)')).toBe(false);
					expect(isHttpBrowserTabUrl('data:text/html,<script>1</script>')).toBe(false);
					expect(isHttpBrowserTabUrl('file:///etc/passwd')).toBe(false);
					expect(isHttpBrowserTabUrl(DEFAULT_BROWSER_TAB_URL)).toBe(false);
				});
				it('rejects empty and unparseable values', () => {
					expect(isHttpBrowserTabUrl('')).toBe(false);
					expect(isHttpBrowserTabUrl(null)).toBe(false);
					expect(isHttpBrowserTabUrl(undefined)).toBe(false);
					expect(isHttpBrowserTabUrl('not a url')).toBe(false);
				});
			});
			describe('getBrowserTabLabel', () => {
				// Build a BrowserTab with sensible defaults so each case only sets the
				// fields under test (customTitle / title / url).
				const makeTab = (overrides: Partial<BrowserTab>): BrowserTab => ({
					id: 'browser-1',
					url: 'https://example.com/docs',
					title: '',
					createdAt: 1,
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
					...overrides,
				});
				it('prefers a user-assigned customTitle over the page title and URL', () => {
					expect(getBrowserTabLabel(makeTab({ customTitle: 'My Tab', title: 'Page Title' }))).toBe(
						'My Tab'
					);
				});
				it('ignores a blank/whitespace customTitle and falls back to the page title', () => {
					expect(getBrowserTabLabel(makeTab({ customTitle: '   ', title: 'Page Title' }))).toBe(
						'Page Title'
					);
				});
				it('uses the page title when no customTitle is set', () => {
					expect(getBrowserTabLabel(makeTab({ title: 'Page Title' }))).toBe('Page Title');
				});
				it('falls back to the URL host when neither customTitle nor title is set', () => {
					expect(getBrowserTabLabel(makeTab({ title: '', url: 'https://fallback.com/path' }))).toBe(
						'fallback.com'
					);
				});
				it('uses the default new-tab title for the blank URL with no titles', () => {
					expect(getBrowserTabLabel(makeTab({ title: '', url: DEFAULT_BROWSER_TAB_URL }))).toBe(
						DEFAULT_BROWSER_TAB_TITLE
					);
				});
				it('returns the raw string when the URL cannot be parsed', () => {
					expect(getBrowserTabLabel(makeTab({ title: '', url: 'not a url' }))).toBe('not a url');
				});
			});
			it('sanitizes session ids when deriving persisted browser partitions', () => {
				expect(getBrowserTabPartition(' session / branch:1 ')).toBe(
					'persist:maestro-browser-session-session-branch-1'
				);
			});
			it('keeps safe persisted partitions and repairs unsafe ones', () => {
				expect(
					getSafeBrowserTabPartition('persist:maestro-browser-session-session-1', 'session-1')
				).toBe('persist:maestro-browser-session-session-1');
				expect(getSafeBrowserTabPartition('persist:evil', 'session-1')).toBe(
					'persist:maestro-browser-session-session-1'
				);
			});
			it('sanitizes persisted browser tabs to stable restart-safe state', () => {
				expect(
					sanitizeBrowserTabForPersistence(
						{
							id: 'browser-1',
							url: 'localhost:3000/docs',
							title: '',
							createdAt: 1,
							partition: 'persist:evil',
							canGoBack: true,
							canGoForward: true,
							isLoading: true,
							favicon: undefined,
							webContentsId: 99,
						},
						'session-1'
					)
				).toMatchObject({
					id: 'browser-1',
					url: 'http://localhost:3000/docs',
					title: 'localhost:3000',
					partition: 'persist:maestro-browser-session-session-1',
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
					favicon: null,
				});
			});
			it('repairs missing browser tab fields to safe defaults during persistence', () => {
				expect(
					sanitizeBrowserTabForPersistence(
						{
							id: 'browser-2',
							url: '',
							title: '',
							createdAt: 1,
							canGoBack: false,
							canGoForward: false,
							isLoading: false,
						},
						'session / 2'
					)
				).toMatchObject({
					id: 'browser-2',
					url: DEFAULT_BROWSER_TAB_URL,
					title: DEFAULT_BROWSER_TAB_TITLE,
					partition: 'persist:maestro-browser-session-session-2',
					favicon: null,
				});
			});
			describe('ephemeral (incognito) partitions', () => {
				const baseTab: BrowserTab = {
					id: 'browser-eph',
					url: 'https://example.com',
					title: 'Example',
					createdAt: 1,
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
				};
				it('mints partitions that satisfy the main-process clear/attach gates', () => {
					// Must match EPHEMERAL_BROWSER_TAB_PARTITION_PATTERN in
					// src/main/ipc/handlers/browser-session.ts (and the will-attach-webview
					// allowlist): a minted incognito partition that fails those gates would
					// make ephemeral tabs unattachable/unclearable.
					const partition = getEphemeralBrowserTabPartition(' My Session/1! ');
					expect(partition).toMatch(/^maestro-ephemeral-[A-Za-z0-9_-]+-[a-z0-9]{8}$/);
					// No persist: scheme - Electron must keep the data in memory only.
					expect(partition.startsWith('persist:')).toBe(false);
				});
				it('mints a distinct partition per call so incognito tabs never share state', () => {
					expect(getEphemeralBrowserTabPartition('s')).not.toBe(
						getEphemeralBrowserTabPartition('s')
					);
				});
				it('isEphemeralBrowserTab recognizes the flag OR the partition prefix', () => {
					expect(isEphemeralBrowserTab({ ...baseTab, ephemeral: true })).toBe(true);
					expect(
						isEphemeralBrowserTab({ ...baseTab, partition: 'maestro-ephemeral-s-a1b2c3d4' })
					).toBe(true);
					expect(
						isEphemeralBrowserTab({ ...baseTab, partition: 'persist:maestro-browser-session-s' })
					).toBe(false);
					expect(isEphemeralBrowserTab(baseTab)).toBe(false);
				});
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/documentStats.test.ts
describe('', () => {
	describe('formatFileSize', () => {
		it('should format bytes', () => {
			expect(formatFileSize(0)).toBe('0 B');
			expect(formatFileSize(100)).toBe('100 B');
			expect(formatFileSize(1023)).toBe('1023 B');
		});
		it('should format kilobytes', () => {
			expect(formatFileSize(1024)).toBe('1.0 KB');
			expect(formatFileSize(1536)).toBe('1.5 KB');
			expect(formatFileSize(10240)).toBe('10.0 KB');
		});
		it('should format megabytes', () => {
			expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
			expect(formatFileSize(1024 * 1024 * 2.5)).toBe('2.5 MB');
		});
		it('should format gigabytes', () => {
			expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
			expect(formatFileSize(1024 * 1024 * 1024 * 3.7)).toBe('3.7 GB');
		});
		it('should handle negative values', () => {
			expect(formatFileSize(-100)).toBe('0 B');
		});
	});
	describe('countWords', () => {
		it('should count words in simple text', () => {
			expect(countWords('hello world')).toBe(2);
			expect(countWords('one two three four')).toBe(4);
		});
		it('should handle multiple spaces', () => {
			expect(countWords('hello    world')).toBe(2);
		});
		it('should handle tabs and newlines', () => {
			expect(countWords('hello\tworld\nfoo')).toBe(3);
		});
		it('should handle empty content', () => {
			expect(countWords('')).toBe(0);
			expect(countWords('   ')).toBe(0);
			expect(countWords('\n\t\n')).toBe(0);
		});
		it('should count markdown content correctly', () => {
			// Words: #, Heading, This, is, a, paragraph, with, **bold**, text.
			const content = '# Heading\n\nThis is a paragraph with **bold** text.';
			expect(countWords(content)).toBe(9);
		});
	});
	describe('countLines', () => {
		it('should count lines in simple text', () => {
			expect(countLines('one line')).toBe(1);
			expect(countLines('line one\nline two')).toBe(2);
			expect(countLines('line one\nline two\nline three')).toBe(3);
		});
		it('should handle trailing newline', () => {
			expect(countLines('line one\nline two\n')).toBe(2);
		});
		it('should handle empty content', () => {
			expect(countLines('')).toBe(0);
			expect(countLines('   ')).toBe(0);
		});
		it('should count empty lines', () => {
			expect(countLines('line one\n\nline three')).toBe(3);
		});
	});
	describe('extractTitle', () => {
		it('should prefer front matter title', () => {
			const content = '# Heading Title\n\nContent here';
			const frontMatter = { title: 'Front Matter Title' };
			expect(extractTitle(content, 'document.md', frontMatter)).toBe('Front Matter Title');
		});
		it('should fall back to H1 heading', () => {
			const content = '# Heading Title\n\nContent here';
			const frontMatter = {};
			expect(extractTitle(content, 'document.md', frontMatter)).toBe('Heading Title');
		});
		it('should handle H1 with extra spaces', () => {
			const content = '#   Heading with Spaces   \n\nContent';
			const frontMatter = {};
			expect(extractTitle(content, 'document.md', frontMatter)).toBe('Heading with Spaces');
		});
		it('should fall back to filename', () => {
			const content = 'Just content, no heading.';
			const frontMatter = {};
			expect(extractTitle(content, 'my-document.md', frontMatter)).toBe('my-document');
		});
		it('should handle paths with directories', () => {
			const content = 'Just content.';
			const frontMatter = {};
			expect(extractTitle(content, 'docs/guide/setup.md', frontMatter)).toBe('setup');
		});
		it('should not match H2 or other headings', () => {
			const content = '## H2 Heading\n\n### H3 Heading';
			const frontMatter = {};
			expect(extractTitle(content, 'document.md', frontMatter)).toBe('document');
		});
		it('should find first H1 even if not at start', () => {
			const content = 'Some intro text.\n\n# The Real Title\n\nMore content.';
			const frontMatter = {};
			expect(extractTitle(content, 'document.md', frontMatter)).toBe('The Real Title');
		});
		it('should skip non-string front matter title', () => {
			const content = '# Heading Title';
			const frontMatter = { title: 123 };
			expect(extractTitle(content, 'document.md', frontMatter)).toBe('Heading Title');
		});
	});
	describe('extractDescription', () => {
		it('should extract description key', () => {
			const frontMatter = { description: 'This is a description' };
			expect(extractDescription(frontMatter)).toBe('This is a description');
		});
		it('should extract overview key', () => {
			const frontMatter = { overview: 'This is an overview' };
			expect(extractDescription(frontMatter)).toBe('This is an overview');
		});
		it('should extract abstract key', () => {
			const frontMatter = { abstract: 'This is an abstract' };
			expect(extractDescription(frontMatter)).toBe('This is an abstract');
		});
		it('should extract summary key', () => {
			const frontMatter = { summary: 'This is a summary' };
			expect(extractDescription(frontMatter)).toBe('This is a summary');
		});
		it('should extract synopsis key', () => {
			const frontMatter = { synopsis: 'This is a synopsis' };
			expect(extractDescription(frontMatter)).toBe('This is a synopsis');
		});
		it('should extract intro key', () => {
			const frontMatter = { intro: 'This is an intro' };
			expect(extractDescription(frontMatter)).toBe('This is an intro');
		});
		it('should extract introduction key', () => {
			const frontMatter = { introduction: 'This is an introduction' };
			expect(extractDescription(frontMatter)).toBe('This is an introduction');
		});
		it('should extract about key', () => {
			const frontMatter = { about: 'This is about' };
			expect(extractDescription(frontMatter)).toBe('This is about');
		});
		it('should extract tldr key', () => {
			const frontMatter = { tldr: 'This is a tldr' };
			expect(extractDescription(frontMatter)).toBe('This is a tldr');
		});
		it('should extract excerpt key', () => {
			const frontMatter = { excerpt: 'This is an excerpt' };
			expect(extractDescription(frontMatter)).toBe('This is an excerpt');
		});
		it('should extract blurb key', () => {
			const frontMatter = { blurb: 'This is a blurb' };
			expect(extractDescription(frontMatter)).toBe('This is a blurb');
		});
		it('should extract brief key', () => {
			const frontMatter = { brief: 'This is a brief' };
			expect(extractDescription(frontMatter)).toBe('This is a brief');
		});
		it('should extract preamble key', () => {
			const frontMatter = { preamble: 'This is a preamble' };
			expect(extractDescription(frontMatter)).toBe('This is a preamble');
		});
		it('should prefer description over other keys', () => {
			const frontMatter = {
				summary: 'Summary text',
				description: 'Description text',
				overview: 'Overview text',
			};
			expect(extractDescription(frontMatter)).toBe('Description text');
		});
		it('should return undefined when no description key found', () => {
			const frontMatter = { title: 'Some Title', author: 'John' };
			expect(extractDescription(frontMatter)).toBeUndefined();
		});
		it('should skip non-string values', () => {
			const frontMatter = { description: 123, summary: 'Valid summary' };
			expect(extractDescription(frontMatter)).toBe('Valid summary');
		});
		it('should return undefined for empty front matter', () => {
			expect(extractDescription({})).toBeUndefined();
		});
	});
	describe('computeDocumentStats', () => {
		it('should compute all stats for a complete document', () => {
			const content = `---
title: My Document
description: A test document for stats
---

# Introduction

This is a test document with multiple lines.
It has several words.

## Section One

More content here.
`;
			const result = computeDocumentStats(content, 'docs/my-doc.md', 1536);
			expect(result.title).toBe('My Document');
			expect(result.description).toBe('A test document for stats');
			expect(result.lineCount).toBe(13);
			// Word count includes front matter (---, title:, etc.) and markdown symbols (#, ##)
			expect(result.wordCount).toBe(31);
			expect(result.size).toBe('1.5 KB');
			expect(result.filePath).toBe('docs/my-doc.md');
		});
		it('should compute stats without front matter', () => {
			const content = `# Document Title

Some content here.
`;
			const result = computeDocumentStats(content, 'readme.md', 512);
			expect(result.title).toBe('Document Title');
			expect(result.description).toBeUndefined();
			expect(result.lineCount).toBe(3);
			// Words: #, Document, Title, Some, content, here.
			expect(result.wordCount).toBe(6);
			expect(result.size).toBe('512 B');
			expect(result.filePath).toBe('readme.md');
		});
		it('should use filename when no title available', () => {
			const content = 'Just some content without a heading.';
			const result = computeDocumentStats(content, 'notes/my-notes.md', 256);
			expect(result.title).toBe('my-notes');
		});
		it('should handle empty content', () => {
			const content = '';
			const result = computeDocumentStats(content, 'empty.md', 0);
			expect(result.title).toBe('empty');
			expect(result.lineCount).toBe(0);
			expect(result.wordCount).toBe(0);
			expect(result.size).toBe('0 B');
			expect(result.description).toBeUndefined();
		});
		it('should handle different description keys', () => {
			const content = `---
title: Doc
overview: This is the overview
---

Content
`;
			const result = computeDocumentStats(content, 'doc.md', 100);
			expect(result.description).toBe('This is the overview');
		});
		it('should preserve the full file path', () => {
			const content = '# Test';
			const result = computeDocumentStats(content, 'deeply/nested/path/to/file.md', 100);
			expect(result.filePath).toBe('deeply/nested/path/to/file.md');
		});
		describe('malformed content handling (graceful degradation)', () => {
			describe('null/undefined/invalid input handling', () => {
				it('should handle null content without crashing', () => {
					// @ts-expect-error Testing runtime behavior with null input
					const result = computeDocumentStats(null, 'doc.md', 100);
					expect(result.title).toBe('doc');
					expect(result.lineCount).toBe(0);
					expect(result.wordCount).toBe(0);
					expect(result.size).toBe('100 B');
					expect(result.filePath).toBe('doc.md');
				});
				it('should handle undefined content without crashing', () => {
					// @ts-expect-error Testing runtime behavior with undefined input
					const result = computeDocumentStats(undefined, 'doc.md', 100);
					expect(result.title).toBe('doc');
					expect(result.lineCount).toBe(0);
					expect(result.wordCount).toBe(0);
				});
				it('should handle null filePath without crashing', () => {
					// @ts-expect-error Testing runtime behavior with null input
					const result = computeDocumentStats('# Test', null, 100);
					// Should use fallback path
					expect(result.filePath).toBe('unknown.md');
					expect(result.title).toBe('Test');
				});
				it('should handle undefined filePath without crashing', () => {
					// @ts-expect-error Testing runtime behavior with undefined input
					const result = computeDocumentStats('# Test', undefined, 100);
					expect(result.filePath).toBe('unknown.md');
				});
				it('should handle NaN fileSize without crashing', () => {
					const result = computeDocumentStats('# Test', 'doc.md', NaN);
					expect(result.size).toBe('0 B');
				});
				it('should handle undefined fileSize without crashing', () => {
					// @ts-expect-error Testing runtime behavior with undefined input
					const result = computeDocumentStats('# Test', 'doc.md', undefined);
					expect(result.size).toBe('0 B');
				});
				it('should handle negative fileSize without crashing', () => {
					const result = computeDocumentStats('# Test', 'doc.md', -500);
					expect(result.size).toBe('0 B');
				});
				it('should handle all null parameters without crashing', () => {
					// @ts-expect-error Testing runtime behavior with null inputs
					const result = computeDocumentStats(null, null, null);
					expect(result.filePath).toBe('unknown.md');
					expect(result.title).toBe('unknown');
					expect(result.lineCount).toBe(0);
					expect(result.wordCount).toBe(0);
					expect(result.size).toBe('0 B');
				});
			});
			describe('binary and special content', () => {
				it('should handle content with null bytes', () => {
					const content = '# Title\x00with\x00null\x00bytes';
					const result = computeDocumentStats(content, 'doc.md', 100);
					// Should not crash
					expect(result).toBeDefined();
					expect(result.title).toBeDefined();
				});
				it('should handle content with control characters', () => {
					const content = '# Title\x01\x02\x03\x04\x05 with control chars';
					const result = computeDocumentStats(content, 'doc.md', 100);
					expect(result.title).toBe('Title\x01\x02\x03\x04\x05 with control chars');
				});
				it('should handle content with only binary data', () => {
					const content = '\x00\x01\x02\x03\x04\x05\x06\x07';
					const result = computeDocumentStats(content, 'binary.md', 8);
					// Should not crash, should use filename as title
					expect(result.title).toBe('binary');
				});
				it('should handle very long content', () => {
					const content = 'x'.repeat(1024 * 1024); // 1MB
					const result = computeDocumentStats(content, 'large.md', 1024 * 1024);
					expect(result.title).toBe('large');
					expect(result.wordCount).toBe(1); // All one "word"
					expect(result.lineCount).toBe(1);
				});
			});
			describe('malformed front matter', () => {
				it('should handle corrupted front matter without crashing', () => {
					const content = `---
this: is: invalid: yaml
nested:
  without: proper
    indentation
---

# Title`;
					const result = computeDocumentStats(content, 'doc.md', 100);
					// Should not crash, title should fall back to heading or filename
					expect(result).toBeDefined();
					expect(result.title).toBeDefined();
				});
				it('should handle front matter with only opening delimiter', () => {
					const content = `---
title: Incomplete`;
					const result = computeDocumentStats(content, 'doc.md', 100);
					// Should not crash
					expect(result.title).toBe('doc');
				});
			});
			describe('edge cases in stats computation', () => {
				it('should handle content with only newlines', () => {
					const content = '\n\n\n\n\n';
					const result = computeDocumentStats(content, 'empty.md', 5);
					expect(result.lineCount).toBe(0);
					expect(result.wordCount).toBe(0);
				});
				it('should handle content with only whitespace', () => {
					const content = '     \t\t\t   \n   \t   ';
					const result = computeDocumentStats(content, 'whitespace.md', 20);
					expect(result.lineCount).toBe(0);
					expect(result.wordCount).toBe(0);
				});
				it('should handle mixed line endings', () => {
					const content = 'Line1\rLine2\r\nLine3\nLine4';
					const result = computeDocumentStats(content, 'doc.md', 100);
					// Just checking it doesn't crash - line count may vary based on implementation
					expect(result).toBeDefined();
				});
				it('should handle extremely long single line', () => {
					const content = 'word '.repeat(100000);
					const result = computeDocumentStats(content, 'doc.md', 500000);
					expect(result.lineCount).toBe(1);
					expect(result.wordCount).toBe(100000);
				});
				it('should handle content with Unicode characters', () => {
					const content = '# 日本語タイトル\n\n中文内容 和 한국어';
					const result = computeDocumentStats(content, 'unicode.md', 100);
					expect(result.title).toBe('日本語タイトル');
					expect(result.wordCount).toBeGreaterThan(0);
				});
				it('should handle content with emojis', () => {
					const content = '# 🎉 Celebration 🎊\n\n🚀 Rocket 🌟 Star';
					const result = computeDocumentStats(content, 'emoji.md', 100);
					expect(result.title).toBe('🎉 Celebration 🎊');
				});
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/fileTree.test.ts
describe('', () => {
	const names = (nodes: FileNode[]) => nodes.map((n) => n.name);
	const folder = (nodes: FileNode[], name: string) =>
		nodes.find((n) => n.name === name && n.type === 'folder');
	describe('buildFileTreeFromPaths', () => {
		it('returns an empty tree for no paths', () => {
			expect(buildFileTreeFromPaths([])).toEqual([]);
		});
		it('places a root-level file at the top level', () => {
			const tree = buildFileTreeFromPaths(['README.md']);
			expect(tree).toEqual([{ name: 'README.md', type: 'file', fullPath: 'README.md' }]);
		});
		it('infers folders from the path segments', () => {
			const tree = buildFileTreeFromPaths(['docs/guides/setup.md']);
			const docs = folder(tree, 'docs');
			expect(docs?.isFolder).toBe(true);
			const guides = folder(docs!.children!, 'guides');
			expect(names(guides!.children!)).toEqual(['setup.md']);
		});
		it('keeps fullPath as the original path, not just the basename', () => {
			const tree = buildFileTreeFromPaths(['docs/guides/setup.md']);
			const leaf = folder(folder(tree, 'docs')!.children!, 'guides')!.children![0];
			// Wiki-link resolution matches on fullPath, so a basename here would make
			// two same-named files in different folders indistinguishable.
			expect(leaf.fullPath).toBe('docs/guides/setup.md');
		});
		it('reuses a shared folder rather than duplicating it', () => {
			const tree = buildFileTreeFromPaths(['docs/a.md', 'docs/b.md']);
			expect(tree.filter((n) => n.name === 'docs')).toHaveLength(1);
			expect(names(folder(tree, 'docs')!.children!)).toEqual(['a.md', 'b.md']);
		});
		it('reuses shared ancestors across diverging branches', () => {
			const tree = buildFileTreeFromPaths(['docs/guides/a.md', 'docs/specs/b.md']);
			const docs = folder(tree, 'docs')!;
			expect(names(docs.children!).sort()).toEqual(['guides', 'specs']);
		});
		it('skips empty path entries instead of creating blank nodes', () => {
			const tree = buildFileTreeFromPaths(['', 'docs/a.md', '']);
			expect(tree).toHaveLength(1);
			expect(names(tree)).toEqual(['docs']);
		});
		it('keeps two same-named files in different folders separate', () => {
			const tree = buildFileTreeFromPaths(['docs/index.md', 'specs/index.md']);
			expect(folder(tree, 'docs')!.children![0].fullPath).toBe('docs/index.md');
			expect(folder(tree, 'specs')!.children![0].fullPath).toBe('specs/index.md');
		});
	});
});
// Source: src/__tests__/renderer/utils/groupChatAutoRun.test.ts
describe('', () => {
	describe('groupChatAutoRun', () => {
		describe('normalizeAutoRunTargetFilename', () => {
			it('removes md extension and normalizes slashes', () => {
				expect(normalizeAutoRunTargetFilename('./plans\\phase-01.md')).toBe('plans/phase-01');
			});
		});
		describe('resolveGroupChatAutoRunTarget', () => {
			it('matches an exact relative path after normalization', () => {
				expect(
					resolveGroupChatAutoRunTarget(['plans/phase-01', 'plans/phase-02'], 'plans/phase-01.md')
				).toEqual({
					files: ['plans/phase-01'],
				});
			});
			it('matches a unique basename when the moderator omits the subfolder', () => {
				expect(
					resolveGroupChatAutoRunTarget(['plans/phase-01', 'plans/phase-02'], 'phase-02.md')
				).toEqual({
					files: ['plans/phase-02'],
				});
			});
			it('returns an ambiguity error for duplicate basenames', () => {
				expect(resolveGroupChatAutoRunTarget(['frontend/plan', 'backend/plan'], 'plan.md')).toEqual(
					{
						error:
							'Specified file "plan.md" is ambiguous. Matching files: frontend/plan, backend/plan',
					}
				);
			});
			it('returns a not found error for unknown files', () => {
				expect(resolveGroupChatAutoRunTarget(['plans/phase-01'], 'missing.md')).toEqual({
					error: 'Specified file "missing.md" not found. Available files: plans/phase-01',
				});
			});
		});
	});
});
