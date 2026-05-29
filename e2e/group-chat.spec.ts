/**
 * E2E Tests: seeded group chat coverage.
 *
 * These tests exercise persisted Group Chat UI without launching live AI agents.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createGroupChatWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-group-chat-'));
	const projectDir = path.join(homeDir, 'project');
	const now = Date.now();
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const moderatorSessionId = `group-chat-coverage-${idSuffix}`;
	const reviewerSessionId = `session-group-reviewer-${idSuffix}`;
	const implementerSessionId = `session-group-implementer-${idSuffix}`;
	const chatId = `coverage-room-${idSuffix}`;
	const archivedChatId = `archived-room-${idSuffix}`;

	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'README.md'), '# Group Chat Coverage\n', 'utf-8');

	return {
		homeDir,
		sessions: [
			{
				id: reviewerSessionId,
				name: 'Reviewer',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs: [],
				shellLogs: [],
				workLog: [],
				contextUsage: 0,
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 0,
				isLive: false,
				changedFiles: [],
				isGitRepo: false,
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				executionQueue: [],
				activeTimeMs: 0,
				fileTreeAutoRefreshInterval: 180,
				aiTabs: [
					{
						id: `reviewer-tab-${idSuffix}`,
						agentSessionId: null,
						name: 'Main',
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: 'idle',
					},
				],
				activeTabId: `reviewer-tab-${idSuffix}`,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: `reviewer-tab-${idSuffix}` }],
				unifiedClosedTabHistory: [],
			},
			{
				id: implementerSessionId,
				name: 'Implementer',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now + 1,
				aiLogs: [],
				shellLogs: [],
				workLog: [],
				contextUsage: 0,
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 0,
				isLive: false,
				changedFiles: [],
				isGitRepo: false,
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				executionQueue: [],
				activeTimeMs: 0,
				fileTreeAutoRefreshInterval: 180,
				aiTabs: [
					{
						id: `implementer-tab-${idSuffix}`,
						agentSessionId: null,
						name: 'Main',
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: 'idle',
					},
				],
				activeTabId: `implementer-tab-${idSuffix}`,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: `implementer-tab-${idSuffix}` }],
				unifiedClosedTabHistory: [],
			},
		],
		groupChats: [
			{
				id: chatId,
				name: 'Coverage Room',
				createdAt: now,
				updatedAt: now,
				moderatorAgentId: 'codex',
				moderatorSessionId,
				participants: [
					{
						name: 'Reviewer',
						agentId: 'codex',
						sessionId: reviewerSessionId,
						addedAt: now,
						lastSummary: 'Reviewed seeded plan',
						contextUsage: 12,
						tokenCount: 1200,
						messageCount: 1,
						totalCost: 0.01,
					},
					{
						name: 'Implementer',
						agentId: 'codex',
						sessionId: implementerSessionId,
						addedAt: now,
						lastSummary: 'Prepared implementation notes',
						contextUsage: 8,
						tokenCount: 900,
						messageCount: 0,
						totalCost: 0.02,
					},
				],
				messages: [
					{
						timestamp: new Date(now - 120_000).toISOString(),
						from: 'user',
						content: 'Please review the seeded plan with @Reviewer.',
					},
					{
						timestamp: new Date(now - 60_000).toISOString(),
						from: 'moderator',
						content: 'Moderator routed the work to @Reviewer.',
					},
					{
						timestamp: new Date(now).toISOString(),
						from: 'Reviewer',
						content: 'Reviewed README.md and found no blocker.',
					},
				],
				historyEntries: [
					{
						id: `history-${idSuffix}`,
						timestamp: now,
						summary: 'Reviewed seeded group chat plan',
						participantName: 'Reviewer',
						participantColor: '#4f46e5',
						type: 'response',
						elapsedTimeMs: 1400,
						tokenCount: 1200,
						cost: 0.01,
						fullResponse: 'Reviewed README.md and confirmed the deterministic plan.',
					},
				],
			},
			{
				id: archivedChatId,
				name: 'Archived Room',
				createdAt: now - 1_000,
				updatedAt: now - 1_000,
				moderatorAgentId: 'codex',
				moderatorSessionId: `group-chat-archived-${idSuffix}`,
				archived: true,
				participants: [],
				messages: [
					{
						timestamp: new Date(now - 180_000).toISOString(),
						from: 'moderator',
						content: 'Archived room transcript remains readable.',
					},
				],
			},
		],
	};
}

test.describe('Seeded Group Chat workspace', () => {
	let window: Awaited<ReturnType<typeof helpers.launchAppWithState>>['window'];
	let cleanupApp: (() => Promise<void>) | undefined;

	test.beforeEach(async () => {
		const seeded = createGroupChatWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			groupChats: seeded.groupChats,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;
	});

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	async function openCoverageRoom() {
		await expect(window.getByText('Coverage Room').first()).toBeVisible();
		await window.getByText('Coverage Room').first().click();
		await expect(window.getByRole('button', { name: 'Group Chat: Coverage Room' })).toBeVisible();
	}

	async function openCoverageRoomContextMenu() {
		await expect(window.getByText('Coverage Room').first()).toBeVisible();
		await window.getByText('Coverage Room').first().click({ button: 'right' });
	}

	test('opens a persisted group chat and renders seeded messages', async () => {
		await openCoverageRoom();

		await expect(window.getByText('2 participants')).toBeVisible();
		await expect(window.getByText('Please review the seeded plan with @Reviewer.')).toBeVisible();
		await expect(window.getByText('Moderator routed the work to @Reviewer.')).toBeVisible();
		await expect(window.getByText('Reviewed README.md and found no blocker.')).toBeVisible();
		await expect(window.getByPlaceholder('Type a message... (@ to mention agent)')).toBeVisible();
		await expect(
			window.getByTitle("Toggle Read-Only mode (agents won't modify files)")
		).toBeVisible();
	});

	test('switches between participants and history in the Group Chat right panel', async () => {
		await openCoverageRoom();

		await expect(window.getByText('Moderator').first()).toBeVisible();
		await expect(window.getByText('Reviewer').first()).toBeVisible();
		await expect(window.getByText('Implementer').first()).toBeVisible();

		await window.getByTitle('View task history').click();
		await expect(window.getByText('Reviewed seeded group chat plan')).toBeVisible();

		await window.getByRole('button', { name: 'Response' }).click();
		await expect(window.getByText('No entries match the selected filters.')).toBeVisible();
		await window.getByRole('button', { name: 'Response' }).click();
		await expect(window.getByText('Reviewed seeded group chat plan')).toBeVisible();
	});

	test('opens Group Chat info and renames the chat from the header', async () => {
		await openCoverageRoom();

		await window.getByTitle('Info').click();
		const infoDialog = window.getByRole('dialog', { name: 'Group Chat Info' });
		await expect(infoDialog).toBeVisible();
		await expect(infoDialog.getByText('Group Chat ID')).toBeVisible();
		await expect(infoDialog.getByText('Moderator Agent')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(infoDialog).toBeHidden();

		await window.getByRole('button', { name: 'Rename' }).click();
		const renameDialog = window.getByRole('dialog', { name: 'Rename Group Chat' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByLabel('Chat Name').fill('Renamed Coverage Room');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(
			window.getByRole('button', { name: 'Group Chat: Renamed Coverage Room' })
		).toBeVisible();
	});

	test('opens the edit modal from the Left Bar context menu', async () => {
		await openCoverageRoomContextMenu();
		await window.getByRole('button', { name: 'Edit' }).click();

		const editDialog = window.getByRole('dialog', { name: 'Edit Group Chat' });
		await expect(editDialog).toBeVisible();
		await expect(editDialog.getByLabel('Chat Name')).toHaveValue('Coverage Room');
		await editDialog.getByLabel('Chat Name').fill('Edited Coverage Room');
		await editDialog.getByRole('button', { name: 'Save' }).click();

		await expect(editDialog).toBeHidden();
		await expect(window.getByText('Edited Coverage Room').first()).toBeVisible();
	});

	test('opens delete confirmation from the Left Bar context menu without deleting on cancel', async () => {
		await openCoverageRoomContextMenu();
		await window.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete Group Chat' });
		await expect(deleteDialog).toBeVisible();
		await expect(deleteDialog.getByText('Coverage Room')).toBeVisible();
		await expect(deleteDialog.getByText(/permanently delete/)).toBeVisible();
		await deleteDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(deleteDialog).toBeHidden();
		await expect(window.getByText('Coverage Room').first()).toBeVisible();
	});

	test('archives and restores a group chat from the Left Bar context menu', async () => {
		await expect(window.getByTitle('Show 1 archived chat')).toBeVisible();
		await openCoverageRoomContextMenu();
		await window.getByRole('button', { name: 'Archive' }).click();

		await expect(window.getByTitle('Show 2 archived chats')).toBeVisible();
		await window.getByTitle('Show 2 archived chats').click();
		await expect(window.getByText('Coverage Room').first()).toBeVisible();
		await window.getByText('Coverage Room').first().click({ button: 'right' });
		await window.getByRole('button', { name: 'Unarchive' }).click();

		await expect(window.getByTitle('Hide archived chats')).toBeVisible();
		await window.getByTitle('Hide archived chats').click();
		await expect(window.getByTitle('Show 1 archived chat')).toBeVisible();
		await expect(window.getByText('Archived Room')).toBeHidden();
	});

	test('shows archived chats and opens an archived room read-only transcript', async () => {
		await window.getByTitle('Show 1 archived chat').click();
		await window.getByText('Archived Room').click();

		await expect(window.getByRole('button', { name: 'Group Chat: Archived Room' })).toBeVisible();
		await expect(window.getByText('Archived room transcript remains readable.')).toBeVisible();
		await expect(window.getByText('0 participants')).toBeVisible();
	});

	test('collapses and restores the group chat right panel', async () => {
		await openCoverageRoom();

		await window.getByTitle(/Collapse Panel/).click();
		await expect(window.getByTitle('View task history')).toBeHidden();
		await window.getByTitle(/Show right panel/).click();

		await expect(window.getByTitle('View task history')).toBeVisible();
		await expect(window.getByText('Reviewer').first()).toBeVisible();
	});

	test('changes the history lookback from the activity graph menu', async () => {
		await openCoverageRoom();
		await window.getByTitle('View task history').click();

		await expect(window.getByTitle('24 hours (right-click to change)')).toBeVisible();
		await window.getByTitle('24 hours (right-click to change)').click({ button: 'right' });
		await window.getByRole('button', { name: 'All time' }).click();

		await expect(window.getByTitle('All time (right-click to change)')).toBeVisible();
		await expect(window.getByText('Reviewed seeded group chat plan')).toBeVisible();
	});
});
