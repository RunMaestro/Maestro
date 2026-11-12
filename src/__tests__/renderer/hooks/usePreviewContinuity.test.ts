/**
 * Tests for useSummarizeAndContinue().previewContinuity - the explicit,
 * read-only continuity preview of one tab.
 *
 * The REAL summarization service and planner run here (the sibling hook tests
 * mock the service), so these cases cover the whole path from the session store
 * and History to the text a person reads. What matters is what the preview
 * refuses and what it leaves alone: another agent's tab, another tab's History,
 * a cleared tab, and every side effect a compaction would have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

import { useSummarizeAndContinue } from '../../../renderer/hooks/agent/useSummarizeAndContinue';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { useOperationStore } from '../../../renderer/stores/operationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { AITab, LogEntry, Session } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';

const getAllPaginated = vi.fn();

function log(id: string, source: LogEntry['source'], text: string, timestamp: number): LogEntry {
	return { id, source, text, timestamp };
}

function tabOf(overrides: Partial<AITab> = {}): AITab {
	return createMockAITab({
		id: 'tab-1',
		agentSessionId: 'sess-1',
		saveToHistory: true,
		logs: [
			log('u1', 'user', 'Ship the exporter. Never touch the CLI.', 1_000),
			log('a1', 'ai', 'Started on the exporter.', 1_100),
		],
		...overrides,
	});
}

function agentOf(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: 'agent-1',
		toolType: 'claude-code',
		cwd: '/projects/app',
		projectRoot: '/projects/app',
		aiTabs: [tabOf()],
		activeTabId: 'tab-1',
		...overrides,
	});
}

function record(overrides: Record<string, unknown> = {}) {
	return {
		id: 'h1',
		type: 'USER',
		timestamp: 1_200,
		summary: 'Renamed the export button.',
		fullResponse: '**Summary:** Renamed the export button.\n\n**Details:** In src/ui.',
		success: true,
		sessionId: 'agent-1',
		tabId: 'tab-1',
		agentSessionId: 'sess-1',
		provider: 'claude-code',
		projectPath: '/projects/app',
		...overrides,
	};
}

function seed(sessions: Session[], activeSessionId = sessions[0]?.id ?? '') {
	useSessionStore.setState({ sessions, activeSessionId } as never);
}

function history(entries: unknown[], hasMore = false) {
	getAllPaginated.mockResolvedValue({ entries, hasMore, total: entries.length });
}

function preview() {
	return renderHook(() => useSummarizeAndContinue()).result.current.previewContinuity;
}

const text = (result: { continuity?: { text: string } }) => result.continuity?.text ?? '';

beforeEach(() => {
	vi.clearAllMocks();
	(window.maestro as unknown as Record<string, unknown>).history = { getAllPaginated };
	useOperationStore.getState().resetAll();
	history([]);
	seed([agentOf()]);
});

describe('previewContinuity', () => {
	it('returns the preview of the tab it is asked about, naming the agent and the tab', async () => {
		const result = await preview()('agent-1', 'tab-1');

		expect(result).toMatchObject({ success: true, sessionId: 'agent-1', tabId: 'tab-1' });
		expect(text(result)).toContain('Continuity preview of tab tab-1 (claude-code)');
		expect(text(result)).toContain('Never touch the CLI.');
		expect(result.continuity).toMatchObject({ entries: 2, synopses: { shown: 0, refused: {} } });
	});

	it('previews a tab too small to compact: it does not use the compaction gate', async () => {
		seed([
			agentOf({
				contextUsage: 0,
				aiTabs: [tabOf({ logs: [log('u1', 'user', 'Fix the footer date today', 1_000)] })],
			}),
		]);
		const result = await preview()('agent-1', 'tab-1');
		expect(result.success).toBe(true);
		expect(text(result)).toContain('Fix the footer date today');
	});

	it('previews the tab it is asked about, not the active one', async () => {
		seed([
			agentOf({
				activeTabId: 'tab-2',
				aiTabs: [
					tabOf(),
					tabOf({
						id: 'tab-2',
						agentSessionId: 'sess-2',
						logs: [log('x1', 'user', 'Only edit the README for the other tab', 2_000)],
					}),
				],
			}),
		]);
		const result = await preview()('agent-1', 'tab-1');

		expect(text(result)).toContain('Never touch the CLI.');
		expect(text(result)).not.toContain('README');
	});

	it("reads the agent's interactive History once, for this agent", async () => {
		await preview()('agent-1', 'tab-1');

		expect(getAllPaginated).toHaveBeenCalledTimes(1);
		expect(getAllPaginated).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'agent-1',
				projectPath: '/projects/app',
				types: ['USER'],
				lookbackHours: null,
			})
		);
	});

	describe('cross-tab rejection', () => {
		it('refuses an agent that does not exist, and reads no History', async () => {
			const result = await preview()('agent-9', 'tab-1');

			expect(result).toEqual({
				success: false,
				error: 'Agent not found: agent-9',
				sessionId: 'agent-9',
				tabId: 'tab-1',
			});
			expect(getAllPaginated).not.toHaveBeenCalled();
		});

		it("refuses a tab of another agent: the agent's own tabs are the only ones it can name", async () => {
			seed([
				agentOf(),
				agentOf({
					id: 'agent-2',
					aiTabs: [tabOf({ id: 'tab-of-agent-2', agentSessionId: 'sess-x' })],
					activeTabId: 'tab-of-agent-2',
				}),
			]);
			const result = await preview()('agent-1', 'tab-of-agent-2');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Tab tab-of-agent-2 is not an AI tab of agent agent-1');
			expect(result.continuity).toBeUndefined();
			expect(getAllPaginated).not.toHaveBeenCalled();
		});

		it('refuses a consult tab', async () => {
			seed([
				agentOf({
					aiTabs: [tabOf({ consultOrigin: { sourceSessionId: 'agent-2', sourceTabId: 'tab-9' } })],
				}),
			]);
			const result = await preview()('agent-1', 'tab-1');

			expect(result.success).toBe(false);
			expect(result.error).toContain('consult');
		});

		it('keeps the History of another tab of the same agent out of the preview', async () => {
			history([
				record({ id: 'mine', fullResponse: '**Summary:** MINE-WORK' }),
				record({
					id: 'theirs',
					tabId: 'tab-2',
					agentSessionId: 'sess-2',
					fullResponse: '**Summary:** THEIRS-WORK',
				}),
			]);
			const result = await preview()('agent-1', 'tab-1');

			expect(text(result)).toContain('MINE-WORK');
			expect(text(result)).not.toContain('THEIRS-WORK');
			expect(result.continuity?.synopses).toEqual({
				shown: 1,
				refused: { 'other-session': 1 },
			});
		});

		it('keeps out a synopsis recorded for the same session id under another tab', async () => {
			history([record({ id: 'moved', tabId: 'tab-2', fullResponse: '**Summary:** ELSEWHERE' })]);
			const result = await preview()('agent-1', 'tab-1');

			expect(text(result)).not.toContain('ELSEWHERE');
			expect(result.continuity?.synopses.refused).toEqual({ 'other-tab': 1 });
		});
	});

	describe('cleared and compacted history', () => {
		it('uses no History to fill in a cleared tab', async () => {
			seed([agentOf({ aiTabs: [tabOf({ logs: [] })] })]);
			history([record()]);
			const result = await preview()('agent-1', 'tab-1');

			expect(result.success).toBe(true);
			expect(result.continuity?.entries).toBe(0);
			expect(text(result)).not.toContain('Renamed the export button');
			expect(text(result)).toContain('cleared or never used');
		});

		it('keeps the synopses written after a clear and drops those from before it', async () => {
			seed([
				agentOf({
					aiTabs: [
						tabOf({
							logs: [
								log('u1', 'user', 'Start over: fix the footer date', 5_000),
								log('a1', 'ai', 'Fixed.', 5_100),
							],
						}),
					],
				}),
			]);
			history([
				record({ id: 'old', timestamp: 1_200, fullResponse: '**Summary:** BEFORE-THE-CLEAR' }),
				record({ id: 'new', timestamp: 5_200, fullResponse: '**Summary:** AFTER-THE-CLEAR' }),
			]);
			const result = await preview()('agent-1', 'tab-1');

			expect(text(result)).toContain('AFTER-THE-CLEAR');
			expect(text(result)).not.toContain('BEFORE-THE-CLEAR');
			expect(result.continuity?.synopses.refused).toEqual({ 'before-transcript': 1 });
		});

		it('marks what stands before a completed compaction', async () => {
			seed([
				agentOf({
					aiTabs: [
						tabOf({
							logs: [
								log('u1', 'user', 'Never touch the CLI while exporting', 1_000),
								{
									...log('c1', 'system', 'Compacted', 2_000),
									contextCompaction: { status: 'done' },
								} as LogEntry,
								log('u2', 'user', 'Now fix the footer date', 2_100),
							],
						}),
					],
				}),
			]);
			history([record({ timestamp: 1_500 })]);
			const result = await preview()('agent-1', 'tab-1');

			expect(text(result)).toContain('before the last compaction');
			expect(text(result)).toContain('[synopsis h1, before the last compaction]');
		});
	});

	describe('History that cannot be read', () => {
		it('still previews the transcript, and says History was not read', async () => {
			getAllPaginated.mockRejectedValue(new Error('remote unreachable'));
			const result = await preview()('agent-1', 'tab-1');

			expect(result.success).toBe(true);
			expect(text(result)).toContain('Never touch the CLI.');
			expect(text(result)).toContain('History could not be read');
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('History could not be read'),
				undefined,
				expect.any(Error)
			);
		});

		it('says only part of History was read', async () => {
			history([record()], true);
			const result = await preview()('agent-1', 'tab-1');
			expect(text(result)).toContain('Only the newest History entries were read');
		});
	});

	describe('while History is being read', () => {
		it('reads the transcript after History, so an entry added meanwhile is included', async () => {
			getAllPaginated.mockImplementation(async () => {
				useSessionStore.setState({
					sessions: [
						agentOf({
							aiTabs: [
								tabOf({
									logs: [
										log('u1', 'user', 'Ship the exporter. Never touch the CLI.', 1_000),
										log('u2', 'user', 'Also never rename the public API', 1_300),
									],
								}),
							],
						}),
					],
				} as never);
				return { entries: [], hasMore: false, total: 0 };
			});
			const result = await preview()('agent-1', 'tab-1');

			expect(text(result)).toContain('Also never rename the public API');
		});

		it('refuses when the tab is closed meanwhile', async () => {
			getAllPaginated.mockImplementation(async () => {
				seed([agentOf({ aiTabs: [tabOf({ id: 'tab-other' })], activeTabId: 'tab-other' })]);
				return { entries: [], hasMore: false, total: 0 };
			});
			const result = await preview()('agent-1', 'tab-1');

			expect(result).toMatchObject({
				success: false,
				error: 'Tab tab-1 is not an AI tab of agent agent-1',
			});
		});
	});

	describe('what it leaves alone', () => {
		it('starts no turn, compacts nothing, writes nothing and raises no toast', async () => {
			history([record()]);
			const before = JSON.stringify(useSessionStore.getState().sessions);

			await preview()('agent-1', 'tab-1');

			expect(JSON.stringify(useSessionStore.getState().sessions)).toBe(before);
			expect(useOperationStore.getState().summarizeStates.size).toBe(0);
			expect(notifyToast).not.toHaveBeenCalled();
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
			expect(window.maestro.process.write).not.toHaveBeenCalled();
			// The only IPC it makes is the one History read.
			expect(getAllPaginated).toHaveBeenCalledTimes(1);
		});

		it('leaves the selected agent and tab where they were', async () => {
			seed([
				agentOf({ aiTabs: [tabOf(), tabOf({ id: 'tab-2', agentSessionId: 'sess-2' })] }),
				agentOf({ id: 'agent-2', aiTabs: [tabOf({ id: 'tab-3' })], activeTabId: 'tab-3' }),
			]);
			useSessionStore.setState({ activeSessionId: 'agent-2' } as never);

			await preview()('agent-1', 'tab-2');

			expect(useSessionStore.getState().activeSessionId).toBe('agent-2');
			expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-1');
		});
	});
});
