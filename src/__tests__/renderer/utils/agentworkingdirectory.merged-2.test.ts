// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/agentWorkingDirectory.test.ts
// Source: src/__tests__/renderer/utils/appTitleStrip.test.ts
// Source: src/__tests__/renderer/utils/autoRunStaging.test.ts
// Source: src/__tests__/renderer/utils/buildMaestroUrl.test.ts
// Source: src/__tests__/renderer/utils/contextUsage.test.ts
// Source: src/__tests__/renderer/utils/contextWindowPrecedence.test.ts
// Source: src/__tests__/renderer/utils/documentSelectionOrder.test.ts
import { describe, it, expect } from 'vitest';
import {
	isSameDirectory,
	rebasePathOntoRoot,
	withWorkingDirectory,
	workingDirectoryChangeBlocker,
} from '../../../renderer/utils/agentWorkingDirectory';
import { createMockSession } from '../../helpers/mockSession';
import {
	APP_TITLE_STRIP_HEIGHT,
	shouldShowAppTitleStrip,
} from '../../../renderer/utils/appTitleStrip';
import {
	autoRunDocIdForFile,
	collectAutoRunDocsInFolder,
	relativeToAutoRunFolder,
} from '../../../renderer/utils/autoRunStaging';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { buildMaestroUrl } from '../../../renderer/utils/buildMaestroUrl';
import {
	estimateContextUsage,
	calculateContextTokens,
	calculateContextDisplay,
	computeOverLimitDisplay,
	calculateDisplayInputTokens,
	estimateAccumulatedGrowth,
	resolveGaugeTokenStats,
	DEFAULT_CONTEXT_WINDOWS,
} from '../../../renderer/utils/contextUsage';
import type { UsageStats } from '../../../shared/types';
import {
	resolveContextWindow,
	isStoredContextWindowOverridden,
} from '../../../renderer/utils/contextWindowPrecedence';
import {
	applySelectionOrder,
	deselectFolderFiles,
	selectAllDocuments,
	selectFolderFiles,
} from '../../../renderer/utils/documentSelectionOrder';
import type { BatchDocumentEntry } from '../../../shared/types';
// Source: src/__tests__/renderer/utils/agentWorkingDirectory.test.ts
describe('', () => {
	describe('withWorkingDirectory', () => {
		const base = () =>
			createMockSession({
				cwd: '/projects/old',
				fullPath: '/projects/old',
				shellCwd: '/projects/old',
				projectRoot: '/projects/old',
				autoRunFolderPath: '/projects/old/.maestro/playbooks',
			});
		it('moves every path field to the new directory', () => {
			const moved = withWorkingDirectory(base(), '/projects/new');
			expect(moved.cwd).toBe('/projects/new');
			expect(moved.fullPath).toBe('/projects/new');
			expect(moved.shellCwd).toBe('/projects/new');
			expect(moved.projectRoot).toBe('/projects/new');
			expect(moved.autoRunFolderPath).toBe('/projects/new/.maestro/playbooks');
		});
		it('leaves an Auto Run folder that lives outside the project where the user put it', () => {
			const session = { ...base(), autoRunFolderPath: '/shared/playbooks' };
			expect(withWorkingDirectory(session, '/projects/new').autoRunFolderPath).toBe(
				'/shared/playbooks'
			);
		});
		it('clears state that describes the old directory so it reloads from the new one', () => {
			const session = {
				...base(),
				fileTree: [{ name: 'stale.ts', type: 'file' }],
				fileExplorerExpanded: ['src'],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 1 } as any,
				isGitRepo: true,
				gitBranches: ['main'],
			};
			const moved = withWorkingDirectory(session, '/projects/new');
			expect(moved.fileTree).toEqual([]);
			expect(moved.fileExplorerExpanded).toEqual([]);
			expect(moved.fileTreeStats).toBeUndefined();
			// Git polling re-detects a repo for sessions marked false.
			expect(moved.isGitRepo).toBe(false);
			expect(moved.gitBranches).toBeUndefined();
		});
		it('puts down a file tree load that was in flight for the old directory', () => {
			const session = {
				...base(),
				fileTreeLoading: true,
				fileTreeLoadingProgress: { directoriesScanned: 3, filesFound: 40, currentDirectory: 'src' },
			};
			const moved = withWorkingDirectory(session, '/projects/new');
			// With the flag down the auto-loader starts a fresh, newer-sequenced load,
			// and the old request discards its result as stale instead of writing
			// the previous project's tree into the moved agent.
			expect(moved.fileTreeLoading).toBe(false);
			expect(moved.fileTreeLoadingProgress).toBeUndefined();
		});
		it('forgets the remote cwd the agent reported in the old directory', () => {
			const session = {
				...base(),
				sshRemoteId: 'remote-1',
				remoteCwd: '/projects/old/src',
			};
			expect(withWorkingDirectory(session, '/projects/new').remoteCwd).toBeUndefined();
		});
		it('moves the SSH working directory override for a remote agent', () => {
			const session = {
				...base(),
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/projects/old',
				},
			};
			expect(withWorkingDirectory(session, '/projects/new').sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/projects/new',
			});
		});
		it('does not invent an override for an agent that runs locally', () => {
			const ssh = { enabled: false, remoteId: null, shareHistoryToProjectDir: true };
			const session = { ...base(), sessionSshRemoteConfig: ssh };
			expect(withWorkingDirectory(session, '/projects/new').sessionSshRemoteConfig).toBe(ssh);
		});
		it('returns the same session for a blank or unchanged directory', () => {
			const session = base();
			expect(withWorkingDirectory(session, '   ')).toBe(session);
			expect(withWorkingDirectory(session, '/projects/old/')).toBe(session);
		});
		it('treats a terminal `cd` as unchanged, since shellCwd moves on its own', () => {
			const session = { ...base(), shellCwd: '/projects/old/src' };
			expect(withWorkingDirectory(session, '/projects/old')).toBe(session);
		});
		it('repairs an agent whose cwd moved while projectRoot stayed behind', () => {
			const split = {
				...base(),
				cwd: '/projects/new',
				fullPath: '/projects/new',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/projects/new',
				},
			};
			const repaired = withWorkingDirectory(split, '/projects/old');
			expect(repaired).not.toBe(split);
			expect(repaired.cwd).toBe('/projects/old');
			expect(repaired.fullPath).toBe('/projects/old');
			expect(repaired.sessionSshRemoteConfig?.workingDirOverride).toBe('/projects/old');
		});
	});
	describe('rebasePathOntoRoot', () => {
		it('keeps Windows separators', () => {
			expect(
				rebasePathOntoRoot('C:\\work\\old\\.maestro\\playbooks', 'C:\\work\\old', 'C:\\work\\new')
			).toBe('C:\\work\\new\\.maestro\\playbooks');
		});
		it('matches a Windows root regardless of case', () => {
			expect(
				rebasePathOntoRoot('c:\\Work\\Old\\.maestro\\playbooks', 'C:\\work\\old', 'C:\\work\\new')
			).toBe('C:\\work\\new\\.maestro\\playbooks');
		});
		it('keeps POSIX paths case-sensitive', () => {
			expect(rebasePathOntoRoot('/Projects/Old/docs', '/projects/old', '/projects/new')).toBe(
				'/Projects/Old/docs'
			);
		});
		it('does not treat a sibling that shares a name prefix as inside the root', () => {
			expect(
				rebasePathOntoRoot('/projects/old-archive/docs', '/projects/old', '/projects/new')
			).toBe('/projects/old-archive/docs');
		});
		it('moves a bare root onto a bare root without losing the separator', () => {
			expect(rebasePathOntoRoot('C:\\', 'C:\\', 'D:\\')).toBe('D:\\');
			expect(rebasePathOntoRoot('C:\\work', 'C:\\', 'D:\\')).toBe('D:\\work');
			expect(rebasePathOntoRoot('/', '/', '/projects/new')).toBe('/projects/new');
		});
		it('moves a folder out from under a bare root', () => {
			expect(rebasePathOntoRoot('/.maestro/playbooks', '/', '/projects/new')).toBe(
				'/projects/new/.maestro/playbooks'
			);
			expect(rebasePathOntoRoot('C:\\.maestro\\playbooks', 'C:\\', 'D:\\work')).toBe(
				'D:\\work\\.maestro\\playbooks'
			);
		});
	});
	describe('isSameDirectory', () => {
		it('ignores a trailing separator', () => {
			expect(isSameDirectory('/projects/old/', '/projects/old')).toBe(true);
		});
		it('ignores case on Windows paths only', () => {
			expect(isSameDirectory('C:\\Work\\Old', 'c:/work/old')).toBe(true);
			expect(isSameDirectory('/Projects/Old', '/projects/old')).toBe(false);
		});
		it('keeps a backslash as an ordinary character in a POSIX path', () => {
			expect(isSameDirectory('/projects/a\\b', '/projects/a/b')).toBe(false);
		});
		it('treats a missing path as different from a real one', () => {
			expect(isSameDirectory(undefined, '/projects/old')).toBe(false);
		});
	});
	describe('workingDirectoryChangeBlocker', () => {
		it('allows an idle agent', () => {
			expect(workingDirectoryChangeBlocker({ state: 'idle', aiPid: 0 })).toBeNull();
		});
		it('refuses while the agent is busy or its process is alive', () => {
			expect(workingDirectoryChangeBlocker({ state: 'busy', aiPid: 0 })).toMatch(/Stop the agent/);
			// A connecting agent is already starting in its current directory.
			expect(workingDirectoryChangeBlocker({ state: 'connecting', aiPid: 0 })).toMatch(
				/Stop the agent/
			);
			expect(workingDirectoryChangeBlocker({ state: 'idle', aiPid: 4242 })).toMatch(
				/Stop the agent/
			);
		});
	});
});
// Source: src/__tests__/renderer/utils/appTitleStrip.test.ts
describe('', () => {
	describe('shouldShowAppTitleStrip', () => {
		const flags = [
			'isMobileLandscape',
			'useNativeTitleBar',
			'isMdDownViewport',
			'isWebDesktop',
		] as const;
		// Every combination of the four conditions: the strip is drawn only when all
		// of them are false.
		for (let mask = 0; mask < 1 << flags.length; mask++) {
			const conditions = {
				isMobileLandscape: !!(mask & 1),
				useNativeTitleBar: !!(mask & 2),
				isMdDownViewport: !!(mask & 4),
				isWebDesktop: !!(mask & 8),
			};
			const on = flags.filter((f) => conditions[f]);
			it(`is ${mask === 0} with ${on.length ? on.join(' + ') : 'nothing set'}`, () => {
				expect(shouldShowAppTitleStrip(conditions)).toBe(mask === 0);
			});
		}
		it('asks the live runtime when web-desktop is not passed (Electron in tests)', () => {
			expect(
				shouldShowAppTitleStrip({
					isMobileLandscape: false,
					useNativeTitleBar: false,
					isMdDownViewport: false,
				})
			).toBe(true);
		});
		it('matches the 40px strip AppShell pads for', () => {
			expect(APP_TITLE_STRIP_HEIGHT).toBe(40);
		});
	});
});
// Source: src/__tests__/renderer/utils/autoRunStaging.test.ts
describe('', () => {
	describe('relativeToAutoRunFolder', () => {
		const root = '/project/.maestro/playbooks';
		it('returns the empty string for the Auto Run folder itself', () => {
			expect(relativeToAutoRunFolder(root, root)).toBe('');
		});
		it('returns the path relative to the Auto Run folder for a descendant', () => {
			expect(relativeToAutoRunFolder(`${root}/RET/nested`, root)).toBe('RET/nested');
		});
		it('returns null for a folder outside the Auto Run folder', () => {
			expect(relativeToAutoRunFolder('/project/docs', root)).toBeNull();
		});
		it('does not treat a sibling with a shared prefix as inside', () => {
			expect(relativeToAutoRunFolder(`${root}-archive/RET`, root)).toBeNull();
		});
		it('ignores trailing slashes on either side', () => {
			expect(relativeToAutoRunFolder(`${root}/RET/`, `${root}/`)).toBe('RET');
		});
		it('matches across Windows separators', () => {
			expect(
				relativeToAutoRunFolder(
					'C:\\project\\.maestro\\playbooks\\RET',
					'C:/project/.maestro/playbooks'
				)
			).toBe('RET');
		});
		it('returns null when either path is missing', () => {
			expect(relativeToAutoRunFolder(undefined, root)).toBeNull();
			expect(relativeToAutoRunFolder(root, undefined)).toBeNull();
			expect(relativeToAutoRunFolder(root, '')).toBeNull();
		});
	});
	describe('collectAutoRunDocsInFolder', () => {
		const docs = ['RET/RET-01', 'RET/nested/RET-02', 'RETRO/R-01', 'SPEC'];
		it('returns every document when the folder is the Auto Run folder itself', () => {
			expect(collectAutoRunDocsInFolder('', docs)).toEqual(docs);
		});
		it('includes documents in nested subfolders', () => {
			expect(collectAutoRunDocsInFolder('RET', docs)).toEqual(['RET/RET-01', 'RET/nested/RET-02']);
		});
		it('does not match a sibling folder that shares a name prefix', () => {
			expect(collectAutoRunDocsInFolder('RET', docs)).not.toContain('RETRO/R-01');
		});
		it('returns an empty list when the folder holds no documents', () => {
			expect(collectAutoRunDocsInFolder('Working', docs)).toEqual([]);
		});
	});
	describe('autoRunDocIdForFile', () => {
		const root = '/project/.maestro/playbooks';
		it('drops the .md extension to form the document id', () => {
			expect(autoRunDocIdForFile(`${root}/RET/RET-01.md`, root)).toBe('RET/RET-01');
		});
		it('handles an uppercase extension', () => {
			expect(autoRunDocIdForFile(`${root}/SPEC.MD`, root)).toBe('SPEC');
		});
		it('returns null for a non-markdown file inside the Auto Run folder', () => {
			expect(autoRunDocIdForFile(`${root}/notes.txt`, root)).toBeNull();
		});
		it('returns null for a markdown file outside the Auto Run folder', () => {
			expect(autoRunDocIdForFile('/project/docs/README.md', root)).toBeNull();
		});
		it('returns null for the Auto Run folder itself', () => {
			expect(autoRunDocIdForFile(root, root)).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/utils/buildMaestroUrl.test.ts
describe('', () => {
	describe('buildMaestroUrl', () => {
		it('appends theme ID as query parameter for built-in themes', () => {
			useSettingsStore.setState({ activeThemeId: 'dracula' });
			const url = buildMaestroUrl('https://runmaestro.ai');
			expect(url).toBe('https://runmaestro.ai/?theme=dracula');
		});
		it('preserves existing path segments', () => {
			useSettingsStore.setState({ activeThemeId: 'nord' });
			const url = buildMaestroUrl('https://runmaestro.ai/discord');
			expect(url).toBe('https://runmaestro.ai/discord?theme=nord');
		});
		it('preserves existing query parameters', () => {
			useSettingsStore.setState({ activeThemeId: 'tokyo-night' });
			const url = buildMaestroUrl('https://docs.runmaestro.ai/?foo=bar');
			expect(url).toBe('https://docs.runmaestro.ai/?foo=bar&theme=tokyo-night');
		});
		it('falls back to dark for custom theme with dark mode', () => {
			useSettingsStore.setState({ activeThemeId: 'custom' });
			// custom theme defaults to dracula which is dark mode
			const url = buildMaestroUrl('https://runmaestro.ai');
			expect(url).toBe('https://runmaestro.ai/?theme=dark');
		});
		it('works with all 16 built-in theme IDs', () => {
			const themeIds = [
				'dracula',
				'monokai',
				'github-light',
				'solarized-light',
				'nord',
				'tokyo-night',
				'one-light',
				'gruvbox-light',
				'catppuccin-mocha',
				'gruvbox-dark',
				'catppuccin-latte',
				'ayu-light',
				'pedurple',
				'maestros-choice',
				'dre-synth',
				'winamp',
			];
			for (const id of themeIds) {
				useSettingsStore.setState({ activeThemeId: id });
				const url = buildMaestroUrl('https://runmaestro.ai');
				expect(url).toContain('theme=' + id);
			}
		});
		it('works with docs subdomain', () => {
			useSettingsStore.setState({ activeThemeId: 'catppuccin-latte' });
			const url = buildMaestroUrl('https://docs.runmaestro.ai/symphony');
			expect(url).toBe('https://docs.runmaestro.ai/symphony?theme=catppuccin-latte');
		});
	});
});
// Source: src/__tests__/renderer/utils/contextUsage.test.ts
describe('', () => {
	describe('estimateContextUsage', () => {
		const createStats = (overrides: Partial<UsageStats> = {}): UsageStats => ({
			inputTokens: 10000,
			outputTokens: 5000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 0,
			...overrides,
		});
		describe('when contextWindow is provided', () => {
			it('should calculate percentage from provided context window', () => {
				const stats = createStats({ contextWindow: 100000 });
				const result = estimateContextUsage(stats, 'claude-code');
				// (10000 + 0 + 0) / 100000 = 10%
				expect(result).toBe(10);
			});
			it('should include cacheReadInputTokens in calculation (part of total input context)', () => {
				const stats = createStats({
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadInputTokens: 50000,
					cacheCreationInputTokens: 5000,
					contextWindow: 100000,
				});
				const result = estimateContextUsage(stats, 'claude-code');
				// (1000 + 50000 + 5000) / 100000 = 56%
				expect(result).toBe(56);
			});
			it('should return null when accumulated tokens exceed context window', () => {
				const stats = createStats({
					inputTokens: 50000,
					outputTokens: 50000,
					cacheReadInputTokens: 150000,
					cacheCreationInputTokens: 200000,
					contextWindow: 200000,
				});
				const result = estimateContextUsage(stats, 'claude-code');
				// (50000 + 150000 + 200000) = 400000 > 200000 -> null (accumulated values)
				expect(result).toBeNull();
			});
			it('should round to nearest integer', () => {
				const stats = createStats({
					inputTokens: 33333,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					contextWindow: 100000,
				});
				const result = estimateContextUsage(stats, 'claude-code');
				// 33333 / 100000 = 33.333% -> 33%
				expect(result).toBe(33);
			});
		});
		describe('when contextWindow is not provided (fallback)', () => {
			it('should use claude-code default context window (200k)', () => {
				const stats = createStats({ contextWindow: 0 });
				const result = estimateContextUsage(stats, 'claude-code');
				// (10000 + 0 + 0) / 200000 = 5%
				expect(result).toBe(5);
			});
			it('should use codex default context window (200k) and include output tokens', () => {
				const stats = createStats({ contextWindow: 0 });
				const result = estimateContextUsage(stats, 'codex');
				// Codex includes output tokens: (10000 + 5000 + 0) / 200000 = 7.5% -> 8%
				expect(result).toBe(8);
			});
			it('should use opencode default context window (128k)', () => {
				const stats = createStats({ contextWindow: 0 });
				const result = estimateContextUsage(stats, 'opencode');
				// (10000 + 0 + 0) / 128000 = 7.8% -> 8%
				expect(result).toBe(8);
			});
			it('should return null for terminal agent', () => {
				const stats = createStats({ contextWindow: 0 });
				const result = estimateContextUsage(stats, 'terminal');
				expect(result).toBeNull();
			});
			it('should return null when no agent specified', () => {
				const stats = createStats({ contextWindow: 0 });
				const result = estimateContextUsage(stats);
				expect(result).toBeNull();
			});
			it('should return 0 when no tokens used', () => {
				const stats = createStats({
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					contextWindow: 0,
				});
				const result = estimateContextUsage(stats, 'claude-code');
				expect(result).toBe(0);
			});
		});
		describe('cacheReadInputTokens handling', () => {
			it('should handle undefined cacheReadInputTokens', () => {
				const stats = createStats({
					inputTokens: 10000,
					outputTokens: 5000,
					contextWindow: 100000,
				});
				// @ts-expect-error - testing undefined case
				stats.cacheReadInputTokens = undefined;
				const result = estimateContextUsage(stats, 'claude-code');
				// (10000 + 0) / 100000 = 10%
				expect(result).toBe(10);
			});
			it('should return null when accumulated cacheRead tokens cause total to exceed context window', () => {
				// During multi-tool turns, Claude Code accumulates token values across
				// internal API calls. When accumulated total exceeds context window,
				// return null to signal callers should preserve previous valid percentage.
				const stats = createStats({
					inputTokens: 500,
					outputTokens: 1000,
					cacheReadInputTokens: 758000, // accumulated across multi-tool turn
					cacheCreationInputTokens: 50000,
					contextWindow: 200000,
				});
				const result = estimateContextUsage(stats, 'claude-code');
				// (500 + 758000 + 50000) = 808500 > 200000 -> null (accumulated values)
				expect(result).toBeNull();
			});
		});
		describe('edge cases', () => {
			it('should handle negative context window as missing', () => {
				const stats = createStats({ contextWindow: -100 });
				const result = estimateContextUsage(stats, 'claude-code');
				// Should use fallback since contextWindow is invalid
				expect(result).toBe(5);
			});
			it('should handle undefined context window', () => {
				const stats = createStats();
				// @ts-expect-error - testing undefined case
				stats.contextWindow = undefined;
				const result = estimateContextUsage(stats, 'claude-code');
				// Should use fallback
				expect(result).toBe(5);
			});
			it('should return null for very large accumulated token counts', () => {
				const stats = createStats({
					inputTokens: 250000,
					outputTokens: 500000,
					cacheReadInputTokens: 500000,
					cacheCreationInputTokens: 250000,
					contextWindow: 0,
				});
				const result = estimateContextUsage(stats, 'claude-code');
				// (250000 + 500000 + 250000) = 1000000 > 200000 -> null (accumulated values)
				expect(result).toBeNull();
			});
			it('should handle very small percentages', () => {
				const stats = createStats({
					inputTokens: 100,
					outputTokens: 50,
					cacheReadInputTokens: 0,
					contextWindow: 0,
				});
				const result = estimateContextUsage(stats, 'claude-code');
				// (100 + 0) / 200000 = 0.05% -> 0% (output excluded for Claude)
				expect(result).toBe(0);
			});
		});
	});
	describe('calculateContextTokens', () => {
		const createStats = (
			overrides: Partial<UsageStats> = {}
		): Pick<
			UsageStats,
			'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
		> => ({
			inputTokens: 10000,
			outputTokens: 5000,
			cacheReadInputTokens: 2000,
			cacheCreationInputTokens: 1000,
			...overrides,
		});
		describe('Claude agents (input + cacheRead + cacheCreation)', () => {
			it('should include input, cacheRead, and cacheCreation tokens for claude-code', () => {
				const stats = createStats();
				const result = calculateContextTokens(stats, 'claude-code');
				// 10000 + 2000 + 1000 = 13000 (excludes output only)
				expect(result).toBe(13000);
			});
			it('should include input, cacheRead, and cacheCreation tokens for claude', () => {
				const stats = createStats();
				const result = calculateContextTokens(stats, 'claude');
				expect(result).toBe(13000);
			});
			it('should include input, cacheRead, and cacheCreation tokens when agent is undefined', () => {
				const stats = createStats();
				const result = calculateContextTokens(stats);
				// Defaults to Claude behavior
				expect(result).toBe(13000);
			});
		});
		describe('OpenAI agents (includes output tokens)', () => {
			it('should include input, output, and cacheCreation tokens for codex', () => {
				const stats = createStats();
				const result = calculateContextTokens(stats, 'codex');
				// 10000 + 5000 + 1000 = 16000 (input + output + cacheCreation, excludes cacheRead)
				expect(result).toBe(16000);
			});
		});
		describe('edge cases', () => {
			it('should handle zero values', () => {
				const stats = createStats({
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
				});
				const result = calculateContextTokens(stats, 'claude-code');
				expect(result).toBe(0);
			});
			it('should handle undefined cache tokens', () => {
				const stats = {
					inputTokens: 10000,
					outputTokens: 5000,
					cacheReadInputTokens: undefined as unknown as number,
					cacheCreationInputTokens: undefined as unknown as number,
				};
				const result = calculateContextTokens(stats, 'claude-code');
				expect(result).toBe(10000);
			});
			it('should include cacheRead in raw calculation (callers detect accumulated values)', () => {
				// calculateContextTokens returns the raw total including cacheRead.
				// Callers (estimateContextUsage) detect when total > contextWindow
				// and return null to signal accumulated values from multi-tool turns.
				const stats = createStats({
					inputTokens: 50000,
					outputTokens: 9000,
					cacheReadInputTokens: 758000,
					cacheCreationInputTokens: 75000,
				});
				const result = calculateContextTokens(stats, 'claude-code');
				// 50000 + 758000 + 75000 = 883000 (raw total, callers check against window)
				expect(result).toBe(883000);
			});
		});
	});
	describe('estimateAccumulatedGrowth', () => {
		it('should grow by 1% for typical multi-tool turn with many internal calls', () => {
			// 31% usage, 40 internal API calls
			// outputTokens: 10026 (accumulated), cacheRead: 2.5M, window: 200K
			const result = estimateAccumulatedGrowth(31, 10026, 2500000, 200000);
			// prevTokens = 62000, estCalls = 2500000/62000 ≈ 40
			// singleTurnGrowth = 10026/40 ≈ 251, growthPercent = 251/200000*100 ≈ 0 → min 1%
			expect(result).toBe(32);
		});
		it('should cap per-turn growth at 3%', () => {
			// Fewer calls, more output per call
			const result = estimateAccumulatedGrowth(40, 100000, 400000, 200000);
			// prevTokens = 80000, estCalls = 400000/80000 = 5
			// singleTurnGrowth = 100000/5 = 20000, growthPercent = 20000/200000*100 = 10 → cap 3%
			expect(result).toBe(43);
		});
		it('should guarantee minimum 1% growth', () => {
			const result = estimateAccumulatedGrowth(50, 100, 5000000, 200000);
			// Very small output → growthPercent ≈ 0 → min 1%
			expect(result).toBe(51);
		});
		it('should return currentUsage unchanged when currentUsage is 0', () => {
			const result = estimateAccumulatedGrowth(0, 10000, 500000, 200000);
			expect(result).toBe(0);
		});
		it('should return currentUsage unchanged when contextWindow is 0', () => {
			const result = estimateAccumulatedGrowth(30, 10000, 500000, 0);
			expect(result).toBe(30);
		});
		it('should handle zero cacheRead tokens', () => {
			const result = estimateAccumulatedGrowth(30, 5000, 0, 200000);
			// estCalls = max(1, 0/60000) = 1, singleTurnGrowth = 5000
			// growthPercent = 5000/200000*100 = 3% (at cap)
			expect(result).toBe(33);
		});
		it('should grow monotonically across consecutive accumulated turns', () => {
			let usage = 31;
			for (let i = 0; i < 5; i++) {
				const prev = usage;
				usage = estimateAccumulatedGrowth(usage, 10000, 2500000, 200000);
				expect(usage).toBeGreaterThan(prev);
			}
			expect(usage).toBeGreaterThanOrEqual(36);
		});
		it('should not be capped internally (caller handles threshold cap)', () => {
			// At 98% with substantial output, growth of 3% still applies (bounded max).
			// The function intentionally does not cap at 100% - the caller in App.tsx
			// applies Math.min(estimated, yellowThreshold - 5) to prevent exceeding thresholds.
			const result = estimateAccumulatedGrowth(98, 50000, 500000, 200000);
			// prevTokens=196000, estCalls=3, singleTurnGrowth=16667, growthPercent=8 → cap 3%
			expect(result).toBeGreaterThan(98);
			expect(result).toBe(101); // 98 + 3% (max bounded growth)
		});
		it('should use minimum context floor for low usage to avoid inflated call estimates', () => {
			// At 1% usage, prevTokens would be 2000 without the floor.
			// With MIN_PREV_CONTEXT_FRACTION (5%), floor is 10000.
			// This prevents dividing cacheRead by a tiny number and inflating estCalls.
			const result = estimateAccumulatedGrowth(1, 50000, 100000, 200000);
			// minTokens = 10000, prevTokens = max(10000, 2000) = 10000
			// estCalls = max(1, round(100000/10000)) = 10
			// singleTurnGrowth = 50000/10 = 5000, growthPercent = round(5000/200000*100) = 3 → cap 3%
			expect(result).toBe(4); // 1 + 3%
		});
	});
	describe('calculateContextDisplay', () => {
		it('should calculate tokens and percentage for normal usage', () => {
			const result = calculateContextDisplay(
				{ inputTokens: 50000, cacheReadInputTokens: 30000, cacheCreationInputTokens: 20000 },
				200000,
				'claude-code'
			);
			// (50000 + 30000 + 20000) / 200000 = 50%
			expect(result.tokens).toBe(100000);
			expect(result.percentage).toBe(50);
			expect(result.contextWindow).toBe(200000);
			expect(result.trustworthy).toBe(true);
		});
		it('should fall back to fallbackPercentage when tokens exceed context window', () => {
			const result = calculateContextDisplay(
				{
					inputTokens: 50000,
					cacheReadInputTokens: 758000,
					cacheCreationInputTokens: 200000,
				},
				200000,
				'claude-code',
				75 // preserved contextUsage from session
			);
			// Raw = 1008000 > 200000, so falls back: tokens = round(75/100 * 200000) = 150000
			expect(result.tokens).toBe(150000);
			expect(result.percentage).toBe(75);
			expect(result.trustworthy).toBe(true);
		});
		it('should cap percentage at 100 when fallback tokens fill the entire window', () => {
			// Raw overflow with a fallback percentage at the window cap derives tokens
			// equal to the full window - percentage must clamp to 100 (not 100.x).
			const result = calculateContextDisplay(
				{ inputTokens: 190000, cacheReadInputTokens: 15000, cacheCreationInputTokens: 0 },
				200000,
				'claude-code',
				100
			);
			expect(result.tokens).toBe(200000);
			expect(result.percentage).toBe(100);
			expect(result.trustworthy).toBe(true);
		});
		it('should return zeros when context window is 0', () => {
			const result = calculateContextDisplay({ inputTokens: 50000 }, 0, 'claude-code');
			expect(result.tokens).toBe(0);
			expect(result.percentage).toBe(0);
			expect(result.contextWindow).toBe(0);
			expect(result.trustworthy).toBe(false);
		});
		it('should return untrustworthy zeros when accumulated values overflow without a fallback', () => {
			// Issue #762: previously this branch returned tokens=contextWindow, surfacing
			// the capacity (e.g. 700,000) as if it were the used token count. Now it
			// returns zeros + trustworthy:false so the caller can preserve last-known-good.
			const result = calculateContextDisplay(
				{
					inputTokens: 50000,
					cacheReadInputTokens: 758000,
					cacheCreationInputTokens: 200000,
				},
				200000,
				'claude-code'
				// no fallback
			);
			expect(result.tokens).toBe(0);
			expect(result.percentage).toBe(0);
			expect(result.contextWindow).toBe(200000);
			expect(result.trustworthy).toBe(false);
		});
		it('should return untrustworthy zeros when accumulated values overflow with a zero fallback', () => {
			// Finding Q1: a zero fallback is the ABSENCE of a prior measurement, not a
			// measurement of zero. Accepting it derived tokens = 0 and flagged the frame
			// trustworthy, which latched the gauge at 0% for the life of any session
			// whose first turn already overflowed the window.
			const result = calculateContextDisplay(
				{
					inputTokens: 50000,
					cacheReadInputTokens: 758000,
					cacheCreationInputTokens: 200000,
				},
				200000,
				'claude-code',
				0 // no baseline established yet
			);
			expect(result.tokens).toBe(0);
			expect(result.percentage).toBe(0);
			expect(result.contextWindow).toBe(200000);
			expect(result.trustworthy).toBe(false);
		});
		it('should clamp fallback percentages above 100 before deriving tokens', () => {
			const result = calculateContextDisplay(
				{
					inputTokens: 50000,
					cacheReadInputTokens: 758000,
					cacheCreationInputTokens: 200000,
				},
				200000,
				'claude-code',
				150
			);
			expect(result.tokens).toBe(200000);
			expect(result.percentage).toBe(100);
			expect(result.trustworthy).toBe(true);
		});
		it('should use Codex semantics (includes output tokens)', () => {
			const result = calculateContextDisplay(
				{ inputTokens: 50000, outputTokens: 30000, cacheCreationInputTokens: 20000 },
				200000,
				'codex'
			);
			// Codex: (50000 + 20000 + 30000) / 200000 = 50%
			expect(result.tokens).toBe(100000);
			expect(result.percentage).toBe(50);
		});
		it('should handle history entries with accumulated tokens and preserved contextUsage', () => {
			// Simulates what HistoryDetailModal sees: accumulated stats + entry.contextUsage
			const result = calculateContextDisplay(
				{
					inputTokens: 5676,
					outputTokens: 8522,
					cacheReadInputTokens: 1128700,
					cacheCreationInputTokens: 0,
				},
				200000,
				undefined, // history entries don't have agent type
				100 // the screenshot showed 100% context
			);
			// Raw = 5676 + 1128700 + 0 = 1134376 > 200000
			// Falls back to: round(100/100 * 200000) = 200000
			expect(result.tokens).toBe(200000);
			expect(result.percentage).toBe(100);
		});
		describe('over-limit percentages (finding R1, Decision 2)', () => {
			it('reads exactly 100 at the window boundary with the clamp removed', () => {
				const result = calculateContextDisplay(
					{ inputTokens: 150000, cacheReadInputTokens: 50000 },
					200000,
					'claude-code'
				);
				expect(result.tokens).toBe(200000);
				expect(result.percentage).toBe(100);
				expect(result.trustworthy).toBe(true);
			});
			it('still bounds a fallback-derived reading at 100', () => {
				// The bound that stays (Task 5): a stored `contextUsage` fallback is
				// 0-100 by construction, so a percentage recovered from it is NOT an
				// over-limit measurement and must not be presented as one.
				const result = calculateContextDisplay(
					{ inputTokens: 400000, cacheReadInputTokens: 100000 },
					200000,
					'claude-code',
					150
				);
				expect(result.percentage).toBe(100);
				expect(result.trustworthy).toBe(true);
			});
			it('documents that a raw over-limit frame is still untrustworthy, not a >100 reading', () => {
				// KNOWN GAP, deliberate: removing the clamp does not by itself make the
				// header pill read `147%`. A raw frame above the window with no
				// fallback hits the #762 branch first and returns untrustworthy zeros,
				// so the header holds its last good value instead. Changing that branch
				// is explicitly out of scope for this playbook; this test pins the
				// current contract so the asymmetry with the timeline stays deliberate.
				const result = calculateContextDisplay(
					{ inputTokens: 250000, cacheReadInputTokens: 44000 },
					200000,
					'claude-code'
				);
				expect(result.percentage).toBe(0);
				expect(result.trustworthy).toBe(false);
			});
		});
	});
	describe('computeOverLimitDisplay', () => {
		// Review of PR #1364 (CodeRabbit). The guard checked `scaleMax > 0`, so a
		// positive-but-too-small scale slipped through and pushed an in-window point
		// past the track - the exact case the code comment warned about.
		it('ignores a scaleMax smaller than the window', () => {
			const result = computeOverLimitDisplay(100000, 200000, 100000);
			expect(result.fillFraction).toBe(0.5);
			expect(result.truePercentage).toBe(50);
			expect(result.overLimit).toBe(false);
		});
		it('uses a scaleMax equal to the window unchanged', () => {
			expect(computeOverLimitDisplay(100000, 200000, 200000).fillFraction).toBe(0.5);
		});
		const WINDOW = 200000;
		it('reports an under-limit point with its true percentage and proportional fill', () => {
			const result = computeOverLimitDisplay(100000, WINDOW);
			expect(result.truePercentage).toBe(50);
			expect(result.overLimit).toBe(false);
			expect(result.fillFraction).toBe(0.5);
		});
		it('treats a point exactly at the window as 100% but NOT over limit', () => {
			const result = computeOverLimitDisplay(WINDOW, WINDOW);
			expect(result.truePercentage).toBe(100);
			expect(result.overLimit).toBe(false);
			expect(result.fillFraction).toBe(1);
		});
		it('reports the true unclamped percentage for an over-limit point', () => {
			// 294000 / 200000 = 147%
			const result = computeOverLimitDisplay(294000, WINDOW);
			expect(result.truePercentage).toBe(147);
			expect(result.overLimit).toBe(true);
			// Without a headroom scale the bar saturates at the track end.
			expect(result.fillFraction).toBe(1);
		});
		it('fills proportionally against a shared headroom scale', () => {
			const result = computeOverLimitDisplay(294000, WINDOW, WINDOW * 2);
			expect(result.truePercentage).toBe(147);
			expect(result.overLimit).toBe(true);
			// 294000 / 400000 = 0.735, so the bar sits past the 100% tick at 0.5.
			expect(result.fillFraction).toBeCloseTo(0.735, 5);
		});
		it('keeps an under-limit point below the tick when a headroom scale applies', () => {
			const result = computeOverLimitDisplay(100000, WINDOW, WINDOW * 2);
			expect(result.truePercentage).toBe(50);
			expect(result.overLimit).toBe(false);
			expect(result.fillFraction).toBeCloseTo(0.25, 5);
		});
		it('uses each point OWN window for the percentage, not the shared scale', () => {
			// A mid-session window change must not retroactively distort old rows.
			const older = computeOverLimitDisplay(90000, 100000, 400000);
			expect(older.truePercentage).toBe(90);
			expect(older.overLimit).toBe(false);
			expect(older.fillFraction).toBeCloseTo(0.225, 5);
		});
		it('returns zeros (not NaN) for a degenerate zero window', () => {
			const result = computeOverLimitDisplay(50000, 0);
			expect(result.truePercentage).toBe(0);
			expect(result.fillFraction).toBe(0);
			expect(result.overLimit).toBe(false);
			expect(Number.isNaN(result.truePercentage)).toBe(false);
			expect(Number.isNaN(result.fillFraction)).toBe(false);
		});
		it('returns zeros for a negative or non-finite window', () => {
			expect(computeOverLimitDisplay(50000, -1)).toEqual({
				truePercentage: 0,
				fillFraction: 0,
				overLimit: false,
			});
			expect(computeOverLimitDisplay(50000, Number.NaN)).toEqual({
				truePercentage: 0,
				fillFraction: 0,
				overLimit: false,
			});
		});
		it('floors negative or non-finite token counts at zero', () => {
			expect(computeOverLimitDisplay(-500, WINDOW)).toEqual({
				truePercentage: 0,
				fillFraction: 0,
				overLimit: false,
			});
			expect(computeOverLimitDisplay(Number.NaN, WINDOW)).toEqual({
				truePercentage: 0,
				fillFraction: 0,
				overLimit: false,
			});
		});
		it('ignores an unusable scaleMax and falls back to the window', () => {
			expect(computeOverLimitDisplay(100000, WINDOW, 0).fillFraction).toBe(0.5);
			expect(computeOverLimitDisplay(100000, WINDOW, Number.NaN).fillFraction).toBe(0.5);
		});
	});
	describe('DEFAULT_CONTEXT_WINDOWS', () => {
		it('should have context windows defined for all ToolType agent types', () => {
			// Only ToolType values have context windows defined
			// 'claude' was consolidated to 'claude-code', and 'aider' is not a ToolType
			expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
			expect(DEFAULT_CONTEXT_WINDOWS['factory-droid']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
		});
	});
	describe('calculateDisplayInputTokens', () => {
		// Reproduces the issue #844 scenario: a Claude Code entry whose usage comes
		// from a resumed session. The new `input_tokens` delta is tiny, but the
		// conversation actually lives in `cache_read_input_tokens`.
		it('adds cache tokens back for Claude so resumed conversations do not look empty', () => {
			const stats: Partial<UsageStats> = {
				inputTokens: 5,
				cacheReadInputTokens: 47382,
				cacheCreationInputTokens: 1204,
			};
			// Before the fix this displayed as 5 - see issue #844.
			expect(calculateDisplayInputTokens(stats, 'claude-code')).toBe(48591);
		});
		it('treats missing cache fields as zero (older history entries)', () => {
			expect(calculateDisplayInputTokens({ inputTokens: 1000 }, 'claude-code')).toBe(1000);
		});
		it('defaults to the Claude formula when agentId is omitted', () => {
			// Safe default: Claude Code is the most common provider, and the fallback
			// over-counts rather than under-counts if we guess wrong.
			const stats: Partial<UsageStats> = {
				inputTokens: 10,
				cacheReadInputTokens: 500,
				cacheCreationInputTokens: 100,
			};
			expect(calculateDisplayInputTokens(stats)).toBe(610);
		});
		it('returns inputTokens as-is for Codex (cached tokens already included)', () => {
			// Per codex-output-parser.ts: cached_input_tokens is a SUBSET of input_tokens.
			// Adding cacheReadInputTokens would double-count.
			const stats: Partial<UsageStats> = {
				inputTokens: 12000,
				cacheReadInputTokens: 8000, // reported for display only; already in inputTokens
				cacheCreationInputTokens: 0,
			};
			expect(calculateDisplayInputTokens(stats, 'codex')).toBe(12000);
		});
		it('handles all-zero / empty stats without throwing', () => {
			expect(calculateDisplayInputTokens({}, 'claude-code')).toBe(0);
			expect(calculateDisplayInputTokens({}, 'codex')).toBe(0);
		});
		it('treats unknown agent types as Claude-family', () => {
			// If a new agent is added and this helper isn't updated, the Claude formula
			// is the safer default - the worst case is an over-count on a single entry,
			// not an "abnormally low" under-count that regresses issue #844.
			const stats: Partial<UsageStats> = {
				inputTokens: 3,
				cacheReadInputTokens: 2000,
				cacheCreationInputTokens: 50,
			};
			expect(calculateDisplayInputTokens(stats, 'brand-new-agent')).toBe(2053);
		});
	});
	describe('header and timeline cross-surface agreement (finding R1)', () => {
		const WINDOW = 200000;
		/**
		 * Feed one tokens/window pair through BOTH display paths: the header's
		 * `calculateContextDisplay` and the Context Timeline's
		 * `computeOverLimitDisplay`. The two surfaces sitting side by side must not
		 * report different numbers for the same turn - that disagreement is the class
		 * of bug PR #1221 fixed, and R1 re-opened it by rendering the over-limit case
		 * differently on each surface.
		 */
		const bothSurfaces = (contextTokens: number) => ({
			header: calculateContextDisplay(
				{ inputTokens: contextTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
				WINDOW,
				'claude-code'
			),
			timeline: computeOverLimitDisplay(contextTokens, WINDOW),
		});
		it('agrees on an under-limit turn', () => {
			const { header, timeline } = bothSurfaces(90000);
			expect(header.trustworthy).toBe(true);
			expect(header.percentage).toBe(45);
			expect(timeline.truePercentage).toBe(45);
			expect(header.percentage).toBe(timeline.truePercentage);
			expect(timeline.overLimit).toBe(false);
		});
		it('agrees on a turn exactly at the limit', () => {
			const { header, timeline } = bothSurfaces(WINDOW);
			expect(header.trustworthy).toBe(true);
			expect(header.percentage).toBe(100);
			expect(timeline.truePercentage).toBe(100);
			expect(header.percentage).toBe(timeline.truePercentage);
			// Exactly at the window is not over it.
			expect(timeline.overLimit).toBe(false);
		});
		it('documents the over-limit asymmetry so future drift is deliberate', () => {
			// The timeline reports the true magnitude of an over-limit turn, which is
			// the whole point of R1. The header does NOT match it on this input, and
			// that is by construction rather than by a clamp: a raw frame above the
			// window with no preserved fallback is the #762 untrustworthy branch, so
			// the header holds its previous good value instead of rendering anything.
			// `calculateContextDisplay`'s own clamp is gone (Decision 2), so the day a
			// trustworthy over-limit numerator reaches it, it will agree with the
			// timeline automatically. Pinned here so any change to that contract has
			// to update this expectation on purpose.
			const { header, timeline } = bothSurfaces(294000);
			expect(timeline.truePercentage).toBe(147);
			expect(timeline.overLimit).toBe(true);
			expect(header.trustworthy).toBe(false);
			expect(header.percentage).toBe(0);
		});
		it('agrees when the over-limit turn arrives with a preserved fallback', () => {
			// The reachable over-limit path today: the accumulated-turn fallback. It is
			// bounded at 100 on purpose (a stored contextUsage is 0-100 by
			// construction), so the header reads 100 while the timeline, which plots
			// the real measured tokens, reads the true figure. Same documented
			// asymmetry, different entry point.
			const header = calculateContextDisplay(
				{ inputTokens: 294000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
				WINDOW,
				'claude-code',
				100
			);
			const timeline = computeOverLimitDisplay(294000, WINDOW);
			expect(header.trustworthy).toBe(true);
			expect(header.percentage).toBe(100);
			expect(timeline.truePercentage).toBe(147);
		});
	});
	describe('resolveGaugeTokenStats (issue #1782)', () => {
		// The reporter's numbers: one turn of ~7 internal API calls on a 1M window.
		// The result message's totals are the SUM of those calls; the last call alone
		// is what was actually in the window.
		const turnSpend = {
			inputTokens: 22,
			outputTokens: 4100,
			cacheReadInputTokens: 437222,
			cacheCreationInputTokens: 89297,
		};
		const lastCall = {
			inputTokens: 3,
			outputTokens: 600,
			cacheReadInputTokens: 78900,
			cacheCreationInputTokens: 4500,
			reasoningTokens: 0,
		};
		const ONE_M = 1000000;
		it('measures the occupancy snapshot instead of the summed turn spend for Claude', () => {
			const stats = resolveGaugeTokenStats(
				{ ...turnSpend, absoluteUsage: lastCall },
				'claude-code'
			);
			const display = calculateContextDisplay(stats, ONE_M, 'claude-code');
			expect(display.tokens).toBe(83403);
			expect(display.percentage).toBe(8);
			expect(display.trustworthy).toBe(true);
		});
		it('pins the bug: the summed spend stays under a 1M window, so no overflow guard fires', () => {
			// Without the snapshot this is what the gauge rendered - 53% for a context
			// that was 8% full. The guard only catches a sum that EXCEEDS the window.
			const display = calculateContextDisplay(turnSpend, ONE_M, 'claude-code');
			expect(display.tokens).toBe(526541);
			expect(display.percentage).toBe(53);
			expect(display.trustworthy).toBe(true);
		});
		it('falls back to the top-level fields when no snapshot was attached', () => {
			expect(resolveGaugeTokenStats(turnSpend, 'claude-code')).toBe(turnSpend);
		});
		it('uses the snapshot when the agent is unknown (Claude semantics are the default)', () => {
			expect(resolveGaugeTokenStats({ ...turnSpend, absoluteUsage: lastCall })).toBe(lastCall);
		});
		it('keeps the top-level fields for combined-context providers', () => {
			// Codex's snapshot is its CLI's running session total, not one call's
			// input, and its gauge has always read the per-turn fields.
			const stats = { ...turnSpend, absoluteUsage: lastCall };
			expect(resolveGaugeTokenStats(stats, 'codex')).toBe(stats);
			expect(resolveGaugeTokenStats(stats, 'copilot-cli')).toBe(stats);
		});
	});
});
// Source: src/__tests__/renderer/utils/contextWindowPrecedence.test.ts
describe('', () => {
	describe('resolveContextWindow', () => {
		it('ranks a [1m] model marker above everything', () => {
			const resolved = resolveContextWindow({
				customModel: 'opus[1m]',
				customContextWindow: 120000,
				contextWindowSource: 'user-edited',
				reportedWindow: 200000,
				reportedResolved: true,
				configuredWindow: 200000,
			});
			expect(resolved).toEqual({ window: 1000000, source: 'model-marker' });
		});
		it('ranks a user-edited window above a provider report', () => {
			const resolved = resolveContextWindow({
				customContextWindow: 120000,
				contextWindowSource: 'user-edited',
				reportedWindow: 1000000,
				reportedResolved: true,
			});
			expect(resolved).toEqual({ window: 120000, source: 'user-edited' });
		});
		it('ranks a provider report above a stored value with no provenance', () => {
			const resolved = resolveContextWindow({
				customContextWindow: 200000,
				reportedWindow: 1000000,
				reportedResolved: true,
			});
			expect(resolved).toEqual({ window: 1000000, source: 'provider' });
		});
		it('keeps the stored value when the reported window is not flagged resolved', () => {
			const resolved = resolveContextWindow({
				customContextWindow: 200000,
				reportedWindow: 1000000,
			});
			expect(resolved).toEqual({ window: 200000, source: 'stored' });
		});
		it('falls back to the configured window, then the raw report', () => {
			expect(resolveContextWindow({ configuredWindow: 200000, reportedWindow: 99 })).toEqual({
				window: 200000,
				source: 'configured',
			});
			expect(resolveContextWindow({ reportedWindow: 150000 })).toEqual({
				window: 150000,
				source: 'reported',
			});
		});
		it('reports nothing known as zero', () => {
			expect(resolveContextWindow({})).toEqual({ window: 0, source: 'none' });
		});
		it('ignores a non-positive stored value', () => {
			const resolved = resolveContextWindow({
				customContextWindow: 0,
				contextWindowSource: 'user-edited',
				configuredWindow: 200000,
			});
			expect(resolved).toEqual({ window: 200000, source: 'configured' });
		});
	});
	describe('isStoredContextWindowOverridden', () => {
		it('is true only when a higher rank than the stored value won', () => {
			expect(isStoredContextWindowOverridden({ window: 1, source: 'model-marker' })).toBe(true);
			expect(isStoredContextWindowOverridden({ window: 1, source: 'provider' })).toBe(true);
		});
		it('is false when the stored value itself won, in either provenance', () => {
			expect(isStoredContextWindowOverridden({ window: 1, source: 'user-edited' })).toBe(false);
			expect(isStoredContextWindowOverridden({ window: 1, source: 'stored' })).toBe(false);
		});
		it('is false for the ranks below the stored value', () => {
			// Reaching these means there was no stored value to override.
			expect(isStoredContextWindowOverridden({ window: 1, source: 'configured' })).toBe(false);
			expect(isStoredContextWindowOverridden({ window: 1, source: 'reported' })).toBe(false);
			expect(isStoredContextWindowOverridden({ window: 0, source: 'none' })).toBe(false);
		});
		it('agrees with resolveContextWindow on the same figure from different sources', () => {
			// The reason this takes a source rather than comparing numbers: both of
			// these resolve to 200000, but only one is an override.
			const overridden = resolveContextWindow({
				customContextWindow: 200000,
				reportedWindow: 200000,
				reportedResolved: true,
			});
			const notOverridden = resolveContextWindow({ customContextWindow: 200000 });
			expect(overridden.window).toBe(notOverridden.window);
			expect(isStoredContextWindowOverridden(overridden)).toBe(true);
			expect(isStoredContextWindowOverridden(notOverridden)).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/utils/documentSelectionOrder.test.ts
describe('', () => {
	function entry(
		filename: string,
		overrides: Partial<BatchDocumentEntry> = {}
	): BatchDocumentEntry {
		return {
			id: `id-${filename}`,
			filename,
			resetOnCompletion: false,
			isDuplicate: false,
			...overrides,
		};
	}
	let created = 0;
	const createEntry = (filename: string): BatchDocumentEntry => {
		created += 1;
		return {
			id: `new-${created}`,
			filename,
			resetOnCompletion: false,
			isDuplicate: false,
		};
	};
	describe('selectFolderFiles', () => {
		it('appends a folder block in tree order', () => {
			const next = selectFolderFiles(new Set(['a/1']), ['b/1', 'b/2']);
			expect([...next]).toEqual(['a/1', 'b/1', 'b/2']);
		});
		it('keeps folder click order when folders are clicked out of tree order', () => {
			let selection = new Set<string>();
			selection = selectFolderFiles(selection, ['verify/1', 'verify/2']);
			selection = selectFolderFiles(selection, ['deploy/1']);
			expect([...selection]).toEqual(['verify/1', 'verify/2', 'deploy/1']);
		});
		it('moves already-selected files so the folder stays one contiguous block', () => {
			const next = selectFolderFiles(new Set(['b/2', 'a/1']), ['b/1', 'b/2']);
			expect([...next]).toEqual(['a/1', 'b/1', 'b/2']);
		});
	});
	describe('deselectFolderFiles', () => {
		it('removes only that folder and leaves the rest in order', () => {
			const next = deselectFolderFiles(new Set(['a/1', 'b/1', 'b/2', 'c/1']), ['b/1', 'b/2']);
			expect([...next]).toEqual(['a/1', 'c/1']);
		});
	});
	describe('selectAllDocuments', () => {
		it('extends the existing selection instead of resetting it', () => {
			const next = selectAllDocuments(new Set(['z', 'y']), ['x', 'y', 'z']);
			expect([...next]).toEqual(['z', 'y', 'x']);
		});
	});
	describe('applySelectionOrder', () => {
		it('emits documents in selection order, not list order', () => {
			const documents = [entry('a'), entry('b')];
			const result = applySelectionOrder(documents, new Set(['c', 'b', 'a']), createEntry);
			expect(result.map((d) => d.filename)).toEqual(['c', 'b', 'a']);
		});
		it('reuses existing entries so ids and reset flags survive', () => {
			const documents = [entry('a', { resetOnCompletion: true })];
			const result = applySelectionOrder(documents, new Set(['b', 'a']), createEntry);
			expect(result[1]).toBe(documents[0]);
			expect(result[1].resetOnCompletion).toBe(true);
		});
		it('keeps duplicates grouped with their original', () => {
			const documents = [entry('a'), entry('a', { id: 'id-a-dup', isDuplicate: true }), entry('b')];
			const result = applySelectionOrder(documents, new Set(['b', 'a']), createEntry);
			expect(result.map((d) => d.id)).toEqual(['id-b', 'id-a', 'id-a-dup']);
		});
		it('drops documents that were deselected', () => {
			const documents = [entry('a'), entry('b')];
			const result = applySelectionOrder(documents, new Set(['a']), createEntry);
			expect(result.map((d) => d.filename)).toEqual(['a']);
		});
		it('returns an empty list when nothing is selected', () => {
			expect(applySelectionOrder([entry('a')], new Set<string>(), createEntry)).toEqual([]);
		});
	});
});
