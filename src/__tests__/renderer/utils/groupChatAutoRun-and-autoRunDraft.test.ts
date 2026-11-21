// Source: src/__tests__/renderer/utils/groupChatAutoRun.test.ts
// Source: src/__tests__/renderer/utils/autoRunDraft.test.ts
// Source: src/__tests__/renderer/utils/autoRunStaging.test.ts
// Source: src/__tests__/renderer/utils/groupChatOrdering.test.ts
// Source: src/__tests__/renderer/utils/groupChatStatus.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { normalizeAutoRunTargetFilename } from '../../../renderer/utils/groupChatAutoRun';
import { resolveGroupChatAutoRunTarget } from '../../../renderer/utils/groupChatAutoRun';
import { isAutoRunDocumentLocked } from '../../../renderer/utils/autoRunDraft';
import { isAutoRunRunDocument } from '../../../renderer/utils/autoRunDraft';
import { reconcileDiskContent } from '../../../renderer/utils/autoRunDraft';
import type { BatchRunState } from '../../../renderer/types';
import { autoRunDocIdForFile } from '../../../renderer/utils/autoRunStaging';
import { collectAutoRunDocsInFolder } from '../../../renderer/utils/autoRunStaging';
import { relativeToAutoRunFolder } from '../../../renderer/utils/autoRunStaging';
import { orderGroupChatsForDisplay } from '../../../renderer/utils/groupChatOrdering';
import { pickNextGroupChatIdAfterDelete } from '../../../renderer/utils/groupChatOrdering';
import { selectVisibleGroupChats } from '../../../renderer/utils/groupChatOrdering';
import { describeGroupChatRunState } from '../../../renderer/utils/groupChatStatus';
import { getBusyGroupChatIds } from '../../../renderer/utils/groupChatStatus';
import { getGroupChatRunState } from '../../../renderer/utils/groupChatStatus';
import { isGroupChatBusy } from '../../../renderer/utils/groupChatStatus';
import type { GroupChatBusySnapshot } from '../../../renderer/utils/groupChatStatus';
describeSourceSuite('groupChatAutoRun', () => {
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
describeSourceSuite('autoRunDraft', () => {
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
describeSourceSuite('autoRunStaging', () => {
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
describeSourceSuite('groupChatOrdering', () => {
	const chats = [
		{ id: 'a', name: 'Charlie', updatedAt: 1 },
		{ id: 'b', name: 'Alpha', updatedAt: 3 },
		{ id: 'c', name: 'Bravo', updatedAt: 2, archived: true },
		{ id: 'd', name: 'Delta', createdAt: 2, updatedAt: undefined as unknown as number },
	];

	describe('orderGroupChatsForDisplay', () => {
		it('drops archived chats and sorts by most-recent activity by default', () => {
			const ordered = orderGroupChatsForDisplay(chats, false);
			expect(ordered.map((c) => c.id)).toEqual(['b', 'd', 'a']);
		});

		it('sorts alphabetically when the toggle is on', () => {
			const ordered = orderGroupChatsForDisplay(chats, true);
			expect(ordered.map((c) => c.name)).toEqual(['Alpha', 'Charlie', 'Delta']);
		});
	});

	describe('selectVisibleGroupChats', () => {
		const base = {
			sortAlphabetical: false,
			showArchived: false,
			showUnreadAgentsOnly: false,
			activeGroupChatId: null,
			isChatBusy: () => false,
			isChatUnread: () => false,
		};

		it('matches the default display order', () => {
			expect(selectVisibleGroupChats(chats, base).map((c) => c.id)).toEqual(['b', 'd', 'a']);
		});

		it('draws archived chats after the active ones when shown', () => {
			const ids = selectVisibleGroupChats(chats, { ...base, showArchived: true }).map((c) => c.id);
			expect(ids).toEqual(['b', 'd', 'a', 'c']);
		});

		it('keeps only busy, unread, or active chats under the unread filter', () => {
			const ids = selectVisibleGroupChats(chats, {
				...base,
				showUnreadAgentsOnly: true,
				activeGroupChatId: 'a',
				isChatBusy: (id) => id === 'd',
				isChatUnread: () => false,
			}).map((c) => c.id);
			expect(ids).toEqual(['d', 'a']);
		});
	});

	describe('pickNextGroupChatIdAfterDelete', () => {
		const list = [
			{ id: 'gc-1', name: 'One', updatedAt: 3 },
			{ id: 'gc-2', name: 'Two', updatedAt: 2 },
			{ id: 'gc-3', name: 'Three', updatedAt: 1 },
		];

		it('returns the chat that shifts up into the deleted slot (next below)', () => {
			expect(pickNextGroupChatIdAfterDelete('gc-1', list, false)).toBe('gc-2');
			expect(pickNextGroupChatIdAfterDelete('gc-2', list, false)).toBe('gc-3');
		});

		it('returns the new last chat when deleting the bottom-most one', () => {
			expect(pickNextGroupChatIdAfterDelete('gc-3', list, false)).toBe('gc-2');
		});

		it('returns null when the deleted chat is the only one', () => {
			expect(pickNextGroupChatIdAfterDelete('gc-1', [list[0]], false)).toBeNull();
		});

		it('returns null when the deleted id is not in the list', () => {
			expect(pickNextGroupChatIdAfterDelete('missing', list, false)).toBeNull();
		});

		it('ignores archived chats when choosing the next focus', () => {
			const withArchived = [
				{ id: 'gc-1', name: 'One', updatedAt: 3 },
				{ id: 'gc-2', name: 'Two', updatedAt: 2, archived: true },
				{ id: 'gc-3', name: 'Three', updatedAt: 1 },
			];
			// Visible order is gc-1, gc-3; deleting gc-1 focuses gc-3.
			expect(pickNextGroupChatIdAfterDelete('gc-1', withArchived, false)).toBe('gc-3');
		});
	});
});
describeSourceSuite('groupChatStatus', () => {
	const CHATS = [{ id: 'gc-1' }, { id: 'gc-2' }, { id: 'gc-3' }];

	describe('groupChatStatus', () => {
		it('treats an idle snapshot as not busy', () => {
			expect(isGroupChatBusy('gc-1', {})).toBe(false);
			expect(getBusyGroupChatIds(CHATS, {})).toEqual([]);
		});

		it('reads the active room from the active-chat fields, not the maps', () => {
			const snapshot: GroupChatBusySnapshot = {
				activeGroupChatId: 'gc-1',
				groupChatState: 'moderator-thinking',
				// Stale map entry for the active room - the live fields must win.
				groupChatStates: new Map([['gc-1', 'idle']]),
			};
			expect(isGroupChatBusy('gc-1', snapshot)).toBe(true);
		});

		it('reads non-active rooms from the all-chats maps', () => {
			const snapshot: GroupChatBusySnapshot = {
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				groupChatStates: new Map([['gc-2', 'agent-working']]),
			};
			expect(isGroupChatBusy('gc-2', snapshot)).toBe(true);
			expect(isGroupChatBusy('gc-3', snapshot)).toBe(false);
		});

		it('counts a working participant even when the moderator is idle', () => {
			const snapshot: GroupChatBusySnapshot = {
				activeGroupChatId: 'gc-1',
				groupChatState: 'idle',
				participantStates: new Map([
					['Atlas', 'idle'],
					['Nova', 'working'],
				]),
				allGroupChatParticipantStates: new Map([
					['gc-2', new Map([['Orion', 'working'] as const])],
				]),
			};
			expect(getGroupChatRunState('gc-1', snapshot).workingParticipants).toEqual(['Nova']);
			expect(getBusyGroupChatIds(CHATS, snapshot)).toEqual(['gc-1', 'gc-2']);
		});

		it('ignores busy map entries for rooms the caller no longer knows about', () => {
			const snapshot: GroupChatBusySnapshot = {
				groupChatStates: new Map([['deleted-chat', 'agent-working']]),
			};
			expect(getBusyGroupChatIds(CHATS, snapshot)).toEqual([]);
		});

		it('describes what is running', () => {
			expect(
				describeGroupChatRunState({
					moderatorState: 'moderator-thinking',
					workingParticipants: [],
					isBusy: true,
				})
			).toBe('Moderator thinking');
			expect(
				describeGroupChatRunState({
					moderatorState: 'agent-working',
					workingParticipants: ['Atlas', 'Nova'],
					isBusy: true,
				})
			).toBe('Atlas, Nova working');
			expect(
				describeGroupChatRunState({
					moderatorState: 'agent-working',
					workingParticipants: ['Atlas', 'Nova', 'Orion'],
					isBusy: true,
				})
			).toBe('3 agents working');
			// Dispatched but the per-agent state has not landed yet.
			expect(
				describeGroupChatRunState({
					moderatorState: 'agent-working',
					workingParticipants: [],
					isBusy: true,
				})
			).toBe('Working');
		});
	});
});
