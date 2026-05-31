/**
 * E2E Tests: seeded group chat coverage.
 *
 * These tests exercise persisted Group Chat UI without launching live AI agents.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

type GroupChatModeratorCall = {
	groupChatId: string;
	content: string;
	images?: string[];
	readOnly?: boolean;
};

type GroupChatResetCall = {
	groupChatId: string;
	participantName: string;
	cwd?: string;
};

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

async function openQuickActions(window: Page) {
	const quickActionsDialog = window.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await window.bringToFront();
		await window.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	await expect(
		quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
	).toBeVisible();
	return quickActionsDialog;
}

async function openProcessMonitor(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View System Processes');
	await quickActionsDialog.getByRole('button', { name: /View System Processes/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const processMonitor = window.getByRole('dialog', { name: 'System Processes' });
	await expect(processMonitor).toBeVisible();
	return processMonitor;
}

async function stubGroupChatProcessMonitor(
	electronApp: ElectronApplication,
	seeded: ReturnType<typeof createGroupChatWorkbench>
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eGroupChatProcesses?: Array<{
					sessionId: string;
					toolType: string;
					pid: number;
					cwd: string;
					isTerminal: boolean;
					isBatchMode: boolean;
					startTime: number;
					command: string;
					args: string[];
				}>;
			};
			state.__maestroE2eGroupChatProcesses = [
				{
					sessionId: `group-chat-${payload.chatId}-moderator-${payload.suffix}`,
					toolType: 'codex',
					pid: 42001,
					cwd: payload.cwd,
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now() - 60_000,
					command: 'codex',
					args: ['--group-moderator'],
				},
				{
					sessionId: `group-chat-${payload.chatId}-moderator-synthesis-${payload.suffix}`,
					toolType: 'codex',
					pid: 42002,
					cwd: payload.cwd,
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now() - 45_000,
					command: 'codex',
					args: ['--group-synthesis'],
				},
				{
					sessionId: `group-chat-${payload.chatId}-participant-Reviewer-${payload.suffix}`,
					toolType: 'codex',
					pid: 42003,
					cwd: payload.cwd,
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now() - 30_000,
					command: 'codex',
					args: ['--group-participant', 'Reviewer'],
				},
			];

			ipcMain.removeHandler('process:getActiveProcesses');
			ipcMain.handle('process:getActiveProcesses', async () => {
				return state.__maestroE2eGroupChatProcesses || [];
			});

			ipcMain.removeHandler('process:kill');
			ipcMain.handle('process:kill', async (_event, sessionId: string) => {
				state.__maestroE2eGroupChatProcesses =
					state.__maestroE2eGroupChatProcesses?.filter(
						(process) => process.sessionId !== sessionId
					) || [];
				return true;
			});
		},
		{
			chatId: seeded.groupChats[0].id,
			cwd: seeded.sessions[0].cwd,
			suffix: 'a11ce001',
		}
	);
}

async function stubGroupChatIpcActions(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatModeratorCalls?: GroupChatModeratorCall[];
			__maestroE2eGroupChatStopAllCalls?: string[];
			__maestroE2eGroupChatResetCalls?: GroupChatResetCall[];
			__maestroE2eGroupChatRemoveCalls?: Array<{ groupChatId: string; participantName: string }>;
		};

		state.__maestroE2eGroupChatModeratorCalls = [];
		state.__maestroE2eGroupChatStopAllCalls = [];
		state.__maestroE2eGroupChatResetCalls = [];
		state.__maestroE2eGroupChatRemoveCalls = [];

		ipcMain.removeHandler('groupChat:sendToModerator');
		ipcMain.handle(
			'groupChat:sendToModerator',
			async (
				_event,
				groupChatId: string,
				content: string,
				images?: string[],
				readOnly?: boolean
			) => {
				state.__maestroE2eGroupChatModeratorCalls?.push({
					groupChatId,
					content,
					images,
					readOnly,
				});
				return true;
			}
		);

		ipcMain.removeHandler('groupChat:stopAll');
		ipcMain.handle('groupChat:stopAll', async (_event, groupChatId: string) => {
			state.__maestroE2eGroupChatStopAllCalls?.push(groupChatId);
			return true;
		});

		ipcMain.removeHandler('groupChat:resetParticipantContext');
		ipcMain.handle(
			'groupChat:resetParticipantContext',
			async (_event, groupChatId: string, participantName: string, cwd?: string) => {
				state.__maestroE2eGroupChatResetCalls?.push({ groupChatId, participantName, cwd });
				return { newAgentSessionId: `reset-${participantName}` };
			}
		);

		ipcMain.removeHandler('groupChat:removeParticipant');
		ipcMain.handle(
			'groupChat:removeParticipant',
			async (_event, groupChatId: string, participantName: string) => {
				state.__maestroE2eGroupChatRemoveCalls?.push({ groupChatId, participantName });
			}
		);
	});
}

async function getStubbedGroupChatIpcActions(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatModeratorCalls?: GroupChatModeratorCall[];
			__maestroE2eGroupChatStopAllCalls?: string[];
			__maestroE2eGroupChatResetCalls?: GroupChatResetCall[];
			__maestroE2eGroupChatRemoveCalls?: Array<{ groupChatId: string; participantName: string }>;
		};

		return {
			sendToModerator: state.__maestroE2eGroupChatModeratorCalls || [],
			stopAll: state.__maestroE2eGroupChatStopAllCalls || [],
			resetParticipantContext: state.__maestroE2eGroupChatResetCalls || [],
			removeParticipant: state.__maestroE2eGroupChatRemoveCalls || [],
		};
	});
}

async function emitGroupChatLiveOutput(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; participantName: string; chunk: string }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:participantLiveOutput',
			eventPayload.groupChatId,
			eventPayload.participantName,
			eventPayload.chunk
		);
	}, payload);
}

test.describe('Seeded Group Chat workspace', () => {
	let window: Awaited<ReturnType<typeof helpers.launchAppWithState>>['window'];
	let electronApp: ElectronApplication;
	let cleanupApp: (() => Promise<void>) | undefined;
	let seededWorkbench: ReturnType<typeof createGroupChatWorkbench>;

	test.beforeEach(async () => {
		seededWorkbench = createGroupChatWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seededWorkbench.homeDir,
			sessions: seededWorkbench.sessions,
			groupChats: seededWorkbench.groupChats,
		});
		window = launched.window;
		electronApp = launched.electronApp;
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

	test('renders group chat moderator and participant processes in Process Monitor', async () => {
		await stubGroupChatProcessMonitor(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('3 active')).toBeVisible();
		await expect(processMonitor.getByText('GROUP CHATS')).toBeVisible();
		await expect(processMonitor.getByText('Coverage Room')).toBeVisible();
		await expect(processMonitor.getByText('Moderator', { exact: true })).toBeVisible();
		await expect(processMonitor.getByText('Moderator (Synthesis)')).toBeVisible();
		await expect(processMonitor.getByText('Reviewer', { exact: true })).toBeVisible();
		await expect(processMonitor.getByText('MODERATOR', { exact: true })).toHaveCount(2);
		await expect(processMonitor.getByText('PARTICIPANT', { exact: true })).toBeVisible();

		await processMonitor.getByText('Reviewer', { exact: true }).dblclick();
		const details = window.getByRole('dialog', { name: 'Process Details' });
		await expect(details).toBeVisible();
		await expect(
			details.getByText(
				`group-chat-${seededWorkbench.groupChats[0].id}-participant-Reviewer-a11ce001`
			)
		).toBeVisible();
		await expect(details.getByText('Process Type')).toBeVisible();
		await expect(
			details
				.locator('span')
				.filter({ hasText: /^participant$/ })
				.first()
		).toBeVisible();
		await expect(details.getByText('codex --group-participant Reviewer')).toBeVisible();
	});

	test('filters mention suggestions and inserts a selected participant', async () => {
		await openCoverageRoom();

		const input = window.locator('textarea').first();
		await input.fill('@Imp');

		await expect(window.getByRole('button', { name: /@Implementer/ })).toBeVisible();
		await expect(window.getByRole('button', { name: /@Reviewer/ })).toHaveCount(0);
		await input.press('Enter');

		await expect(input).toHaveValue('@Implementer ');
	});

	test('sends a trimmed read-only moderator message through IPC', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		const input = window.locator('textarea').first();
		await window.getByTitle("Toggle Read-Only mode (agents won't modify files)").click();
		await input.fill('  Please summarize the risk.  ');
		await window.getByTitle('Send message').click();

		await expect(input).toHaveValue('');
		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.sendToModerator).toEqual([
			{
				groupChatId: seededWorkbench.groupChats[0].id,
				content: 'Please summarize the risk.',
				images: undefined,
				readOnly: true,
			},
		]);
	});

	test('queues a second message while moderator is busy and removes it after confirmation', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		await window
			.getByPlaceholder('Type a message... (@ to mention agent)')
			.fill('Start the review pass.');
		await window.getByTitle('Send message').click();
		await expect(window.getByPlaceholder('Type to queue message...')).toBeVisible();

		await window.getByPlaceholder('Type to queue message...').fill('Queue follow-up context.');
		await window.getByTitle('Queue message').click();

		await expect(window.getByText('QUEUED (1)')).toBeVisible();
		await expect(window.getByText('Queue follow-up context.')).toBeVisible();
		await window.getByTitle('Remove from queue').click();
		await expect(window.getByText('Remove Queued Message?')).toBeVisible();
		await window
			.getByText('Remove Queued Message?')
			.locator('xpath=ancestor::div[contains(@class, "shadow-xl")][1]')
			.getByRole('button', { name: 'Remove' })
			.click();

		await expect(window.getByText('QUEUED (1)')).toBeHidden();
		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.sendToModerator).toHaveLength(1);
	});

	test('routes Stop All for an active group chat', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		await window
			.getByPlaceholder('Type a message... (@ to mention agent)')
			.fill('Start then stop all group activity.');
		await window.getByTitle('Send message').click();
		await window.getByTitle('Stop all moderator and participant activity').click();

		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.stopAll).toEqual([seededWorkbench.groupChats[0].id]);
	});

	test('routes participant reset and removal controls from the right panel', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		const reviewerCard = window
			.locator('.rounded-lg.border.p-3')
			.filter({ has: window.getByText('Reviewer', { exact: true }) })
			.first();
		await reviewerCard.getByRole('button', { name: 'Reset' }).click();
		await reviewerCard.getByRole('button', { name: 'Remove' }).click();
		await reviewerCard.getByRole('button', { name: 'Confirm' }).click();

		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.resetParticipantContext).toEqual([
			{
				groupChatId: seededWorkbench.groupChats[0].id,
				participantName: 'Reviewer',
				cwd: undefined,
			},
		]);
		expect(calls.removeParticipant).toEqual([
			{
				groupChatId: seededWorkbench.groupChats[0].id,
				participantName: 'Reviewer',
			},
		]);
	});

	test('shows streamed participant output in the Peek panel', async () => {
		await openCoverageRoom();
		await emitGroupChatLiveOutput(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Reviewer',
			chunk: 'Running deterministic review...\nNo blocker found.',
		});

		const reviewerCard = window
			.locator('.rounded-lg.border.p-3')
			.filter({ has: window.getByText('Reviewer', { exact: true }) })
			.first();
		await reviewerCard.getByRole('button', { name: 'Peek' }).click();

		await expect(reviewerCard.getByText('Running deterministic review...')).toBeVisible();
		await expect(reviewerCard.getByText('No blocker found.')).toBeVisible();
	});
});
