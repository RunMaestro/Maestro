/**
 * E2E Tests: seeded group chat coverage.
 *
 * These tests exercise persisted Group Chat UI without launching live AI agents.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import crypto from 'crypto';
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

type GroupChatCreateCall = {
	name: string;
	moderatorAgentId: string;
	moderatorConfig?: Record<string, unknown>;
};

type GroupChatUpdateCall = {
	id: string;
	updates: {
		name?: string;
		moderatorAgentId?: string;
		moderatorConfig?: Record<string, unknown>;
	};
};

type GroupChatAgentConfigCall = {
	agentId: string;
	config: Record<string, unknown>;
};

type GroupChatAgentErrorPayload = {
	sessionId: string;
	error: {
		type: string;
		message: string;
		recoverable: boolean;
		agentId: string;
		sessionId: string;
		timestamp: number;
		raw?: Record<string, unknown>;
	};
};

type ShellPathCall = {
	type: 'openPath';
	itemPath: string;
};

type GroupChatExportCapture = {
	download?: string;
	href?: string;
	html?: string;
};

type GroupChatHistoryEntryPayload = {
	id: string;
	timestamp: number;
	summary: string;
	participantName: string;
	participantColor?: string;
	type: 'delegation' | 'response' | 'synthesis' | 'error';
	elapsedTimeMs?: number;
	tokenCount?: number;
	cost?: number;
	fullResponse?: string;
};

type GroupChatParticipantPayload = {
	name: string;
	agentId: string;
	sessionId: string;
	addedAt: number;
	agentSessionId?: string;
	contextUsage?: number;
	tokenCount?: number;
	messageCount?: number;
	totalCost?: number;
	sshRemoteName?: string;
};

type GroupChatModeratorUsagePayload = {
	contextUsage: number;
	totalCost: number;
	tokenCount: number;
};

type GroupChatMessagePayload = {
	timestamp: string;
	from: string;
	content: string;
	images?: string[];
};

type GroupChatStatePayload = 'idle' | 'moderator-thinking' | 'agent-working';

type GroupChatAutoRunCompleteCall = {
	groupChatId: string;
	participantName: string;
	summary: string;
};

function createGroupChatWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-group-chat-'));
	const projectDir = path.join(homeDir, 'project');
	const imageFilePath = path.join(projectDir, 'group-chat-image.png');
	const now = Date.now();
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const chatId = crypto.randomUUID();
	const archivedChatId = crypto.randomUUID();
	const moderatorSessionId = `group-chat-${chatId}-moderator-${now}`;
	const reviewerSessionId = `session-group-reviewer-${idSuffix}`;
	const implementerSessionId = `session-group-implementer-${idSuffix}`;

	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'README.md'), '# Group Chat Coverage\n', 'utf-8');
	fs.writeFileSync(
		imageFilePath,
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
			'base64'
		)
	);

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

async function stubGroupChatDeletion(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatDeleteCalls?: string[];
		};
		state.__maestroE2eGroupChatDeleteCalls = [];

		ipcMain.removeHandler('groupChat:delete');
		ipcMain.handle('groupChat:delete', async (_event, groupChatId: string) => {
			state.__maestroE2eGroupChatDeleteCalls?.push(groupChatId);
			return true;
		});
	});
}

async function getStubbedGroupChatDeletionCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatDeleteCalls?: string[];
		};

		return state.__maestroE2eGroupChatDeleteCalls || [];
	});
}

async function stubGroupChatShellPath(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatShellPathCalls?: ShellPathCall[];
		};
		state.__maestroE2eGroupChatShellPathCalls = [];

		ipcMain.removeHandler('shell:openPath');
		ipcMain.handle('shell:openPath', async (_event, itemPath: string) => {
			state.__maestroE2eGroupChatShellPathCalls?.push({ type: 'openPath', itemPath });
			return '';
		});
	});
}

async function getStubbedGroupChatShellPathCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatShellPathCalls?: ShellPathCall[];
		};

		return state.__maestroE2eGroupChatShellPathCalls || [];
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

async function emitGroupChatAgentError(
	electronApp: ElectronApplication,
	payload: GroupChatAgentErrorPayload
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'agent:error',
			eventPayload.sessionId,
			eventPayload.error
		);
	}, payload);
}

async function emitGroupChatHistoryEntry(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; entry: GroupChatHistoryEntryPayload }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:historyEntry',
			eventPayload.groupChatId,
			eventPayload.entry
		);
	}, payload);
}

async function emitGroupChatParticipantState(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; participantName: string; state: 'idle' | 'working' }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:participantState',
			eventPayload.groupChatId,
			eventPayload.participantName,
			eventPayload.state
		);
	}, payload);
}

async function emitGroupChatParticipantsChanged(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; participants: GroupChatParticipantPayload[] }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:participantsChanged',
			eventPayload.groupChatId,
			eventPayload.participants
		);
	}, payload);
}

async function emitGroupChatModeratorUsage(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; usage: GroupChatModeratorUsagePayload }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:moderatorUsage',
			eventPayload.groupChatId,
			eventPayload.usage
		);
	}, payload);
}

async function emitGroupChatMessage(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; message: GroupChatMessagePayload }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:message',
			eventPayload.groupChatId,
			eventPayload.message
		);
	}, payload);
}

async function emitGroupChatStateChange(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; state: GroupChatStatePayload }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:stateChange',
			eventPayload.groupChatId,
			eventPayload.state
		);
	}, payload);
}

async function emitGroupChatModeratorSessionIdChanged(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; sessionId: string }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:moderatorSessionIdChanged',
			eventPayload.groupChatId,
			eventPayload.sessionId
		);
	}, payload);
}

async function emitGroupChatAutoRunTriggered(
	electronApp: ElectronApplication,
	payload: { groupChatId: string; participantName: string; targetFilename?: string }
) {
	await electronApp.evaluate(({ BrowserWindow }, eventPayload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'groupChat:autoRunTriggered',
			eventPayload.groupChatId,
			eventPayload.participantName,
			eventPayload.targetFilename
		);
	}, payload);
}

async function stubGroupChatAutoRunReport(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatAutoRunReports?: GroupChatAutoRunCompleteCall[];
		};

		state.__maestroE2eGroupChatAutoRunReports = [];

		ipcMain.removeHandler('groupChat:reportAutoRunComplete');
		ipcMain.handle(
			'groupChat:reportAutoRunComplete',
			async (_event, groupChatId: string, participantName: string, summary: string) => {
				state.__maestroE2eGroupChatAutoRunReports?.push({
					groupChatId,
					participantName,
					summary,
				});
				return true;
			}
		);

		ipcMain.removeHandler('autorun:listDocs');
		ipcMain.handle('autorun:listDocs', async () => ({ files: [], tree: [] }));
	});
}

async function getStubbedGroupChatAutoRunReports(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatAutoRunReports?: GroupChatAutoRunCompleteCall[];
		};

		return state.__maestroE2eGroupChatAutoRunReports || [];
	});
}

async function installGroupChatExportCapture(window: Page) {
	await window.evaluate(() => {
		const state = window as typeof window & {
			__maestroE2eGroupChatExport?: GroupChatExportCapture;
		};
		state.__maestroE2eGroupChatExport = {};

		URL.createObjectURL = (blob: Blob) => {
			void blob.text().then((html) => {
				state.__maestroE2eGroupChatExport = {
					...state.__maestroE2eGroupChatExport,
					html,
				};
			});
			return 'blob:maestro-e2e-group-chat-export';
		};
		URL.revokeObjectURL = () => {};

		const createElement = document.createElement.bind(document);
		document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
			const element = createElement(tagName, options);
			if (tagName.toLowerCase() === 'a') {
				const anchor = element as HTMLAnchorElement;
				anchor.click = () => {
					state.__maestroE2eGroupChatExport = {
						...state.__maestroE2eGroupChatExport,
						download: anchor.download,
						href: anchor.href,
					};
				};
			}
			return element;
		}) as typeof document.createElement;
	});
}

async function getGroupChatExportCapture(window: Page) {
	return window.evaluate(() => {
		const state = window as typeof window & {
			__maestroE2eGroupChatExport?: GroupChatExportCapture;
		};

		return state.__maestroE2eGroupChatExport || {};
	});
}

async function stubGroupChatModalAgents(
	electronApp: ElectronApplication,
	hasAgents = true,
	sshRemotes: Array<Record<string, unknown>> = []
) {
	await electronApp.evaluate(
		({ ipcMain }, options) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eGroupChatAgentConfigCalls?: GroupChatAgentConfigCall[];
			};
			state.__maestroE2eGroupChatAgentConfigCalls = [];
			const { agentsAvailable, remoteConfigs } = options;

			const codexAgent = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				command: 'codex',
				args: [],
				available: true,
				hidden: false,
				path: '/usr/local/bin/codex',
				capabilities: {
					supportsBatchMode: true,
					supportsModelSelection: false,
				},
				configOptions: [],
			};

			ipcMain.removeHandler('agents:detect');
			ipcMain.handle('agents:detect', async () => (agentsAvailable ? [codexAgent] : []));
			ipcMain.removeHandler('agents:refresh');
			ipcMain.handle('agents:refresh', async () => (agentsAvailable ? codexAgent : undefined));
			ipcMain.removeHandler('agents:getConfig');
			ipcMain.handle('agents:getConfig', async () => ({}));
			ipcMain.removeHandler('agents:setConfig');
			ipcMain.handle(
				'agents:setConfig',
				async (_event, agentId: string, config: Record<string, unknown>) => {
					state.__maestroE2eGroupChatAgentConfigCalls?.push({ agentId, config });
					return true;
				}
			);
			ipcMain.removeHandler('agents:getModels');
			ipcMain.handle('agents:getModels', async () => []);
			ipcMain.removeHandler('ssh-remote:getConfigs');
			ipcMain.handle('ssh-remote:getConfigs', async () => ({
				success: true,
				configs: remoteConfigs,
			}));
		},
		{ agentsAvailable: hasAgents, remoteConfigs: sshRemotes }
	);
}

async function stubGroupChatCreationHandlers(
	electronApp: ElectronApplication,
	seeded: ReturnType<typeof createGroupChatWorkbench>
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eGroupChatCreateCalls?: GroupChatCreateCall[];
				__maestroE2eGroupChatStartCalls?: string[];
				__maestroE2eCreatedGroupChats?: Record<string, Record<string, unknown>>;
			};
			state.__maestroE2eGroupChatCreateCalls = [];
			state.__maestroE2eGroupChatStartCalls = [];
			state.__maestroE2eCreatedGroupChats = {};

			ipcMain.removeHandler('groupChat:create');
			ipcMain.handle(
				'groupChat:create',
				async (
					_event,
					name: string,
					moderatorAgentId: string,
					moderatorConfig?: Record<string, unknown>
				) => {
					state.__maestroE2eGroupChatCreateCalls?.push({
						name,
						moderatorAgentId,
						moderatorConfig,
					});
					const id = `created-group-chat-${state.__maestroE2eGroupChatCreateCalls?.length || 1}`;
					const chat = {
						id,
						name,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						moderatorAgentId,
						moderatorSessionId: `group-chat-${id}-moderator`,
						moderatorConfig,
						participants: [],
						logPath: `${payload.cwd}/${id}.log`,
						imagesDir: `${payload.cwd}/${id}-images`,
					};
					state.__maestroE2eCreatedGroupChats![id] = chat;
					return chat;
				}
			);

			ipcMain.removeHandler('groupChat:load');
			ipcMain.handle('groupChat:load', async (_event, id: string) => {
				return state.__maestroE2eCreatedGroupChats?.[id] || null;
			});

			ipcMain.removeHandler('groupChat:getMessages');
			ipcMain.handle('groupChat:getMessages', async () => []);

			ipcMain.removeHandler('groupChat:startModerator');
			ipcMain.handle('groupChat:startModerator', async (_event, id: string) => {
				state.__maestroE2eGroupChatStartCalls?.push(id);
				return `started-${id}-moderator`;
			});
		},
		{ cwd: seeded.sessions[0].cwd }
	);
}

async function stubGroupChatUpdateHandler(
	electronApp: ElectronApplication,
	seeded: ReturnType<typeof createGroupChatWorkbench>
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eGroupChatUpdateCalls?: GroupChatUpdateCall[];
			};
			state.__maestroE2eGroupChatUpdateCalls = [];

			ipcMain.removeHandler('groupChat:update');
			ipcMain.handle(
				'groupChat:update',
				async (
					_event,
					id: string,
					updates: {
						name?: string;
						moderatorAgentId?: string;
						moderatorConfig?: Record<string, unknown>;
					}
				) => {
					state.__maestroE2eGroupChatUpdateCalls?.push({ id, updates });
					return {
						...payload.chat,
						...updates,
						updatedAt: Date.now(),
					};
				}
			);
		},
		{ chat: seeded.groupChats[0] }
	);
}

async function getStubbedGroupChatUpdateCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatUpdateCalls?: GroupChatUpdateCall[];
		};

		return state.__maestroE2eGroupChatUpdateCalls || [];
	});
}

async function getStubbedGroupChatModalActions(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eGroupChatCreateCalls?: GroupChatCreateCall[];
			__maestroE2eGroupChatStartCalls?: string[];
			__maestroE2eGroupChatAgentConfigCalls?: GroupChatAgentConfigCall[];
		};

		return {
			create: state.__maestroE2eGroupChatCreateCalls || [],
			startModerator: state.__maestroE2eGroupChatStartCalls || [],
			setConfig: state.__maestroE2eGroupChatAgentConfigCalls || [],
		};
	});
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

	function groupChatListItem(name: string) {
		return window.locator('div.cursor-pointer').filter({ hasText: name }).first();
	}

	function participantCard(name: string) {
		return window
			.locator('.rounded-lg.border.p-3')
			.filter({ has: window.getByText(name, { exact: true }) })
			.first();
	}

	function groupChatMessage(text: string) {
		return window.locator('[data-message-timestamp]').filter({ hasText: text }).first();
	}

	async function openGroupChatHistorySearch(historyPanel: Locator) {
		await historyPanel.focus();
		await expect(historyPanel).toBeFocused();
		await historyPanel.press('Control+f');

		const searchInput = window.getByPlaceholder('Filter group chat history...');
		if (!(await searchInput.isVisible({ timeout: 1000 }).catch(() => false))) {
			await historyPanel.press('Meta+f');
		}
		await expect(searchInput).toBeVisible();
		return searchInput;
	}

	function groupChatImagePath() {
		return path.join(seededWorkbench.sessions[0].cwd, 'group-chat-image.png');
	}

	function promptComposerDialog() {
		return window
			.getByText('Prompt Composer')
			.locator('xpath=ancestor::div[contains(@class, "z-10")][1]');
	}

	function groupChatSshRemote() {
		return {
			id: 'remote-group-chat-e2e',
			name: 'E2E Build Host',
			host: 'build.example.local',
			port: 22,
			username: 'maestro',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
		};
	}

	async function openCoverageRoom() {
		const listItem = groupChatListItem('Coverage Room');
		await expect(listItem).toBeVisible();
		await listItem.click();
		await expect(window.getByRole('button', { name: 'Group Chat: Coverage Room' })).toBeVisible();
	}

	async function openCoverageRoomContextMenu() {
		const listItem = groupChatListItem('Coverage Room');
		await expect(listItem).toBeVisible();
		await listItem.click({ button: 'right' });
	}

	async function openNewGroupChatModal() {
		await window.getByTitle('New Group Chat').click();
		const dialog = window.getByRole('dialog', { name: 'New Group Chat' });
		await expect(dialog).toBeVisible();
		return dialog;
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

	test('updates participant working state and clears peek output when idle', async () => {
		await openCoverageRoom();

		const implementerCard = participantCard('Implementer');
		await emitGroupChatLiveOutput(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Implementer',
			chunk: 'Implementer is drafting live output.',
		});
		await implementerCard.getByRole('button', { name: 'Peek' }).click();
		await expect(implementerCard.getByText('Implementer is drafting live output.')).toBeVisible();

		await emitGroupChatParticipantState(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Implementer',
			state: 'working',
		});
		await expect(implementerCard.getByTitle('Working')).toBeVisible();

		await emitGroupChatParticipantState(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Implementer',
			state: 'idle',
		});
		await expect(implementerCard.getByTitle('Idle')).toBeVisible();
		await expect(implementerCard.getByText('(no live output yet)')).toBeVisible();
	});

	test('updates participants and moderator usage from Group Chat IPC events', async () => {
		await openCoverageRoom();

		await emitGroupChatParticipantsChanged(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participants: [
				...seededWorkbench.groupChats[0].participants,
				{
					name: 'Architect',
					agentId: 'codex',
					sessionId: 'session-group-architect-e2e',
					agentSessionId: 'architect-agent-session-e2e',
					addedAt: Date.now(),
					contextUsage: 31,
					tokenCount: 2200,
					messageCount: 2,
					totalCost: 0.06,
					sshRemoteName: 'builder',
				},
			],
		});

		const architectCard = participantCard('Architect');
		await expect(architectCard).toBeVisible();
		await expect(architectCard.getByText('BUILDER')).toBeVisible();
		await expect(architectCard.getByText('31%')).toBeVisible();
		await expect(architectCard.getByText('0.06')).toBeVisible();

		await emitGroupChatModeratorUsage(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			usage: { contextUsage: 55, totalCost: 0.07, tokenCount: 7700 },
		});

		const moderatorCard = participantCard('Moderator');
		await expect(moderatorCard.getByText('55%')).toBeVisible();
		await expect(moderatorCard.getByText('0.07')).toBeVisible();
		await expect(window.getByTitle('Total accumulated cost')).toContainText('0.16');
	});

	test('updates the moderator session id from IPC and copies it', async () => {
		await openCoverageRoom();
		await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));

		const moderatorCard = participantCard('Moderator');
		await expect(moderatorCard.getByText('pending')).toBeVisible();

		const sessionId = 'abc12345-moderator-session-e2e';
		await emitGroupChatModeratorSessionIdChanged(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			sessionId,
		});

		await expect(moderatorCard.getByText('ABC12345')).toBeVisible();
		await moderatorCard.locator(`button[title*="${sessionId}"]`).click();
		await expect
			.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(sessionId);
	});

	test('copies a live participant session id from the right panel', async () => {
		await openCoverageRoom();
		await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));

		const sessionId = 'agent9876-architect-session-e2e';
		await emitGroupChatParticipantsChanged(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participants: [
				...seededWorkbench.groupChats[0].participants,
				{
					name: 'Architect',
					agentId: 'codex',
					sessionId: 'session-group-architect-copy-e2e',
					agentSessionId: sessionId,
					addedAt: Date.now(),
					contextUsage: 22,
					messageCount: 1,
				},
			],
		});

		const architectCard = participantCard('Architect');
		await expect(architectCard.getByText('AGENT987')).toBeVisible();
		await architectCard.locator(`button[title*="${sessionId}"]`).click();
		await expect
			.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(sessionId);
	});

	test('appends live Group Chat messages and toggles long-message expansion', async () => {
		await openCoverageRoom();

		const longMessage = Array.from(
			{ length: 35 },
			(_, index) => `Live message line ${index + 1}`
		).join('\n');
		await emitGroupChatMessage(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			message: {
				timestamp: new Date().toISOString(),
				from: 'Implementer',
				content: longMessage,
			},
		});

		const message = groupChatMessage('Live message line 1');
		await expect(message.getByText('Implementer')).toBeVisible();
		await expect(message.getByText('Live message line 1')).toBeVisible();
		await expect(message.getByText('Live message line 35')).toBeHidden();

		await message.getByRole('button', { name: 'Show all 35 lines' }).click();
		await expect(message.getByText('Live message line 35')).toBeVisible();

		await message.getByRole('button', { name: 'Show less' }).click();
		await expect(message.getByRole('button', { name: 'Show all 35 lines' })).toBeVisible();
		await expect(message.getByText('Live message line 35')).toBeHidden();
	});

	test('shows Group Chat state typing indicators from IPC events', async () => {
		await openCoverageRoom();

		await emitGroupChatStateChange(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			state: 'moderator-thinking',
		});
		await expect(window.getByText('Moderator is thinking...')).toBeVisible();

		await emitGroupChatStateChange(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			state: 'agent-working',
		});
		await expect(window.getByText('Agent is working...')).toBeVisible();

		await emitGroupChatStateChange(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			state: 'idle',
		});
		await expect(window.getByText('Agent is working...')).toBeHidden();
		await expect(window.getByText('Moderator is thinking...')).toBeHidden();
	});

	test('toggles Group Chat message plain text and copies transcript text', async () => {
		await openCoverageRoom();
		await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));

		const moderatorMessage = groupChatMessage('Moderator routed the work to @Reviewer.');
		await moderatorMessage.hover();
		await moderatorMessage.getByTitle(/Show plain text/).click();
		await expect(moderatorMessage.getByTitle(/Show formatted/)).toBeVisible();

		await moderatorMessage.hover();
		await moderatorMessage.getByTitle('Copy to clipboard').click();
		await expect
			.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe('Moderator routed the work to @Reviewer.');

		await moderatorMessage.getByTitle(/Show formatted/).click();
		await expect(moderatorMessage.getByTitle(/Show plain text/)).toBeVisible();
	});

	test('filters Group Chat history with search and Escape restores entries', async () => {
		await openCoverageRoom();
		await window.getByTitle('View task history').click();

		const historyPanel = window
			.locator('div[tabindex="0"]')
			.filter({ hasText: 'Reviewed seeded group chat plan' })
			.last();
		const searchInput = await openGroupChatHistorySearch(historyPanel);
		await searchInput.click();
		await searchInput.fill('seeded group chat plan');
		await expect(searchInput).toHaveValue('seeded group chat plan');
		await expect(window.getByText('1 result')).toBeVisible();
		await expect(window.getByText('Reviewed seeded group chat plan')).toBeVisible();

		await searchInput.click();
		await searchInput.fill('missing-history-entry');
		await expect(searchInput).toHaveValue('missing-history-entry');
		await expect(window.getByText('No entries match "missing-history-entry"')).toBeVisible();

		await searchInput.press('Escape');
		await expect(searchInput).toBeHidden();
		await expect(window.getByText('Reviewed seeded group chat plan')).toBeVisible();
	});

	test('prepends live Group Chat history entries from IPC', async () => {
		await openCoverageRoom();
		await window.getByTitle('View task history').click();

		await emitGroupChatHistoryEntry(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			entry: {
				id: 'history-live-e2e',
				timestamp: Date.now(),
				summary: 'Live emitted history entry',
				participantName: 'Implementer',
				participantColor: '#059669',
				type: 'response',
				elapsedTimeMs: 2400,
				tokenCount: 900,
				cost: 0.04,
				fullResponse: 'Live history response body from IPC.',
			},
		});

		const liveHistoryEntry = window.locator('[data-entry-id="history-live-e2e"]');
		await expect(liveHistoryEntry.getByText('Live emitted history entry')).toBeVisible();
		await expect(liveHistoryEntry.getByText('Implementer')).toBeVisible();
		await expect(liveHistoryEntry.getByText('$0.04')).toBeVisible();
	});

	test('jumps from a Group Chat history entry to the nearest transcript message', async () => {
		await openCoverageRoom();
		await window.getByTitle('View task history').click();

		const reviewerMessage = groupChatMessage('Reviewed README.md and found no blocker.');
		await expect(reviewerMessage).toBeVisible();
		await window
			.locator('[data-entry-id]')
			.filter({ hasText: 'Reviewed seeded group chat plan' })
			.click();

		await expect
			.poll(() =>
				reviewerMessage.evaluate((element) => (element as HTMLElement).style.backgroundColor)
			)
			.toBe('rgba(255, 255, 255, 0.1)');
	});

	test('filters Group Chat history by participant and full response text', async () => {
		await openCoverageRoom();
		await window.getByTitle('View task history').click();

		await emitGroupChatHistoryEntry(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			entry: {
				id: 'history-search-e2e',
				timestamp: Date.now(),
				summary: 'Implemented live search coverage',
				participantName: 'Implementer',
				participantColor: '#059669',
				type: 'response',
				fullResponse: 'Full response marker from emitted Group Chat history.',
			},
		});

		const historyPanel = window
			.locator('div[tabindex="0"]')
			.filter({ hasText: 'Implemented live search coverage' })
			.last();
		const searchInput = await openGroupChatHistorySearch(historyPanel);
		await searchInput.fill('Implementer');
		await expect(window.getByText('1 result')).toBeVisible();
		await expect(window.getByText('Implemented live search coverage')).toBeVisible();
		await expect(window.getByText('Reviewed seeded group chat plan')).toBeHidden();

		await searchInput.fill('Full response marker');
		await expect(window.getByText('1 result')).toBeVisible();
		await expect(window.getByText('Implemented live search coverage')).toBeVisible();
	});

	test('toggles emitted Group Chat history type filters', async () => {
		await openCoverageRoom();
		await window.getByTitle('View task history').click();

		await emitGroupChatHistoryEntry(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			entry: {
				id: 'history-delegation-e2e',
				timestamp: Date.now(),
				summary: 'Delegated branch work to Reviewer',
				participantName: 'Moderator',
				type: 'delegation',
			},
		});
		await emitGroupChatHistoryEntry(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			entry: {
				id: 'history-synthesis-e2e',
				timestamp: Date.now() + 1,
				summary: 'Synthesized group chat result',
				participantName: 'Moderator',
				type: 'synthesis',
			},
		});
		await emitGroupChatHistoryEntry(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			entry: {
				id: 'history-error-e2e',
				timestamp: Date.now() + 2,
				summary: 'Reported group chat failure',
				participantName: 'Reviewer',
				type: 'error',
			},
		});

		await expect(window.getByText('Delegated branch work to Reviewer')).toBeVisible();
		await expect(window.getByText('Synthesized group chat result')).toBeVisible();
		await expect(window.getByText('Reported group chat failure')).toBeVisible();

		await window.getByRole('button', { name: 'Delegation' }).click();
		await expect(window.getByText('Delegated branch work to Reviewer')).toBeHidden();
		await expect(window.getByText('Synthesized group chat result')).toBeVisible();

		await window.getByRole('button', { name: 'Error' }).click();
		await expect(window.getByText('Reported group chat failure')).toBeHidden();
		await expect(window.getByText('Synthesized group chat result')).toBeVisible();

		await window.getByRole('button', { name: 'Delegation' }).click();
		await expect(window.getByText('Delegated branch work to Reviewer')).toBeVisible();
	});

	test('persists the Group Chat history lookback preference after tab remount', async () => {
		await openCoverageRoom();
		await window.getByTitle('View task history').click();

		await window.getByTitle('24 hours (right-click to change)').click({ button: 'right' });
		await window.getByRole('button', { name: '1 week' }).click();
		await expect(window.getByTitle('1 week (right-click to change)')).toBeVisible();

		await window.getByTitle('View participants').click();
		await window.getByTitle('View task history').click();

		await expect(window.getByTitle('1 week (right-click to change)')).toBeVisible();
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

	test('copies Group Chat info metadata and opens the chat folder', async () => {
		await stubGroupChatShellPath(electronApp);
		await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
		await openCoverageRoom();
		await window.getByTitle('Info').click();

		const infoDialog = window.getByRole('dialog', { name: 'Group Chat Info' });
		await expect(infoDialog).toBeVisible();
		const idRow = infoDialog
			.getByText('Group Chat ID')
			.locator('xpath=ancestor::div[contains(@class, "py-2")][1]');
		await idRow.getByTitle('Copy to clipboard').click();
		await expect
			.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(seededWorkbench.groupChats[0].id);

		const logRow = infoDialog
			.getByText('Chat Log')
			.locator('xpath=ancestor::div[contains(@class, "py-2")][1]');
		await logRow.getByTitle('Copy to clipboard').click();
		await expect
			.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
			.toContain(`/group-chats/${seededWorkbench.groupChats[0].id}/chat.log`);

		await infoDialog.getByRole('button', { name: 'Open in Finder' }).click();
		const shellCalls = await getStubbedGroupChatShellPathCalls(electronApp);
		expect(shellCalls).toEqual([
			{
				type: 'openPath',
				itemPath: expect.stringContaining(`/group-chats/${seededWorkbench.groupChats[0].id}`),
			},
		]);
	});

	test('exports the Group Chat info overlay transcript as an HTML download', async () => {
		await installGroupChatExportCapture(window);
		await openCoverageRoom();
		await window.getByTitle('Info').click();

		const infoDialog = window.getByRole('dialog', { name: 'Group Chat Info' });
		await expect(infoDialog).toBeVisible();
		await infoDialog.getByRole('button', { name: 'Export HTML' }).click();

		await expect
			.poll(async () => (await getGroupChatExportCapture(window)).html || '')
			.toContain('Coverage Room - Maestro Group Chat Export');
		const exportCapture = await getGroupChatExportCapture(window);
		expect(exportCapture.download).toBe('coverage-room-export.html');
		expect(exportCapture.href).toBe('blob:maestro-e2e-group-chat-export');
		expect(exportCapture.html).toContain('Reviewed README.md and found no blocker.');
		expect(exportCapture.html).toContain('Reviewer');
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

	test('keeps unchanged Group Chat edits disabled and cancels without update IPC', async () => {
		await stubGroupChatModalAgents(electronApp);
		await stubGroupChatUpdateHandler(electronApp, seededWorkbench);
		await openCoverageRoomContextMenu();
		await window.getByRole('button', { name: 'Edit' }).click();

		const editDialog = window.getByRole('dialog', { name: 'Edit Group Chat' });
		await expect(editDialog).toBeVisible();
		await expect(editDialog.getByRole('button', { name: 'Save' })).toBeDisabled();
		await editDialog.getByLabel('Chat Name').fill('Canceled Edit Coverage Room');
		await expect(editDialog.getByRole('button', { name: 'Save' })).toBeEnabled();
		await editDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(editDialog).toBeHidden();
		expect(await getStubbedGroupChatUpdateCalls(electronApp)).toEqual([]);
		await expect(groupChatListItem('Coverage Room')).toBeVisible();
	});

	test('saves edited Group Chat moderator configuration through update IPC', async () => {
		const remote = groupChatSshRemote();
		await stubGroupChatModalAgents(electronApp, true, [remote]);
		await stubGroupChatUpdateHandler(electronApp, seededWorkbench);
		await openCoverageRoomContextMenu();
		await window.getByRole('button', { name: 'Edit' }).click();

		const editDialog = window.getByRole('dialog', { name: 'Edit Group Chat' });
		await expect(editDialog).toBeVisible();
		await editDialog.getByLabel('Chat Name').fill('  Configured Edit Room  ');
		await expect(editDialog.getByText('SSH Remote Execution')).toBeVisible();
		await editDialog.locator('select').nth(1).selectOption(remote.id);
		await expect(editDialog.getByText('Agent will run on')).toBeVisible();
		await editDialog.getByTitle('Customize moderator settings').click();
		await editDialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/bin/codex');
		await editDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model gpt-5-codex --sandbox read-only');
		await editDialog.getByRole('button', { name: 'Add Variable' }).click();
		await editDialog.getByPlaceholder('VARIABLE_NAME').fill('GROUP_CHAT_EDIT_E2E');
		await editDialog.getByPlaceholder('value', { exact: true }).fill('enabled');
		await editDialog.getByRole('button', { name: 'Save' }).click();

		await expect(editDialog).toBeHidden();
		expect(await getStubbedGroupChatUpdateCalls(electronApp)).toEqual([
			{
				id: seededWorkbench.groupChats[0].id,
				updates: {
					name: 'Configured Edit Room',
					moderatorAgentId: 'codex',
					moderatorConfig: {
						customPath: '/opt/maestro/bin/codex',
						customArgs: '--model gpt-5-codex --sandbox read-only',
						customEnvVars: {
							GROUP_CHAT_EDIT_E2E: 'enabled',
						},
						sshRemoteConfig: {
							enabled: true,
							remoteId: remote.id,
						},
					},
				},
			},
		]);
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

	test('confirms deletion from the Left Bar context menu and clears the active group chat', async () => {
		await stubGroupChatDeletion(electronApp);
		await openCoverageRoom();
		await openCoverageRoomContextMenu();
		await window.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete Group Chat' });
		await expect(deleteDialog).toBeVisible();
		await deleteDialog.getByRole('button', { name: 'Delete' }).click();

		await expect(deleteDialog).toBeHidden();
		await expect(window.getByRole('button', { name: 'Group Chat: Coverage Room' })).toBeHidden();
		await expect(window.getByText('Coverage Room').first()).toBeHidden();
		const calls = await getStubbedGroupChatDeletionCalls(electronApp);
		expect(calls).toEqual([seededWorkbench.groupChats[0].id]);
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

	test('opens the active group chat from Process Monitor', async () => {
		await stubGroupChatProcessMonitor(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		const groupChatRow = processMonitor
			.getByRole('treeitem')
			.filter({ hasText: 'Coverage Room' })
			.first();
		await expect(groupChatRow).toBeVisible();
		await groupChatRow.getByRole('button', { name: 'Open' }).click();

		await expect(processMonitor).toBeHidden();
		await expect(window.getByRole('button', { name: 'Group Chat: Coverage Room' })).toBeVisible();
		await expect(window.getByText('Reviewed README.md and found no blocker.')).toBeVisible();
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

	test('trims pasted Group Chat text and sends with Enter mode', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		const input = window.locator('textarea').first();
		await input.fill('Prefix: ');
		await input.evaluate((textarea) => {
			const target = textarea as HTMLTextAreaElement;
			target.setSelectionRange(target.value.length, target.value.length);
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('text/plain', '  pasted group chat text  \n\n');
			target.dispatchEvent(
				new ClipboardEvent('paste', {
					clipboardData: dataTransfer,
					bubbles: true,
					cancelable: true,
				})
			);
		});
		await expect(input).toHaveValue('Prefix: pasted group chat text');

		await window.getByTitle('Switch to Enter to send').click();
		await input.press('Enter');

		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.sendToModerator).toEqual([
			{
				groupChatId: seededWorkbench.groupChats[0].id,
				content: 'Prefix: pasted group chat text',
				images: undefined,
				readOnly: false,
			},
		]);
	});

	test('stages deduplicates lightboxes and removes Group Chat image attachments', async () => {
		await openCoverageRoom();

		const imageInput = window.locator('#group-chat-image-input');
		await imageInput.setInputFiles(groupChatImagePath());
		const stagedImage = window.getByAltText('Staged image');
		await expect(stagedImage).toBeVisible();

		await imageInput.setInputFiles(groupChatImagePath());
		await expect(stagedImage).toHaveCount(1);
		await expect(window.getByText('Duplicate image ignored')).toBeVisible();

		const input = window.locator('textarea').first();
		await input.focus();
		await input.press('Meta+Y');
		const lightbox = window.getByRole('dialog', { name: 'Image Lightbox' });
		await expect(lightbox).toBeVisible();
		await expect(lightbox.getByRole('img', { name: 'Expanded image preview' })).toBeVisible();

		await lightbox.getByTitle('Delete image (Delete key)').click();
		await window
			.getByRole('dialog', { name: 'Confirm' })
			.getByRole('button', { name: 'Confirm' })
			.click();
		await expect(lightbox).toBeHidden();
		await expect(stagedImage).toBeHidden();
	});

	test('sends Group Chat image attachments through moderator IPC', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		await window.locator('#group-chat-image-input').setInputFiles(groupChatImagePath());
		await expect(window.getByAltText('Staged image')).toBeVisible();

		const input = window.locator('textarea').first();
		await input.fill('Please inspect the attached image.');
		await window.getByTitle('Send message').click();

		await expect(input).toHaveValue('');
		await expect(window.getByAltText('Staged image')).toBeHidden();
		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.sendToModerator).toHaveLength(1);
		expect(calls.sendToModerator[0]).toMatchObject({
			groupChatId: seededWorkbench.groupChats[0].id,
			content: 'Please inspect the attached image.',
			readOnly: false,
		});
		expect(calls.sendToModerator[0].images).toHaveLength(1);
		expect(calls.sendToModerator[0].images?.[0]).toMatch(/^data:image\/png;base64,/);
	});

	test('sends Group Chat Prompt Composer drafts through moderator IPC', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		await window.getByTitle(/Open Prompt Composer/).click();
		const composerDialog = promptComposerDialog();
		await expect(composerDialog).toBeVisible();
		await composerDialog
			.getByPlaceholder(/Write your prompt here/)
			.fill('Prompt Composer group chat dispatch.');
		await composerDialog.getByRole('button', { name: 'Send' }).click();

		await expect(composerDialog).toBeHidden();
		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.sendToModerator).toEqual([
			{
				groupChatId: seededWorkbench.groupChats[0].id,
				content: 'Prompt Composer group chat dispatch.',
				images: undefined,
				readOnly: false,
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

	test('expands and collapses a long queued Group Chat message', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		await window
			.getByPlaceholder('Type a message... (@ to mention agent)')
			.fill('Start the long queue coverage pass.');
		await window.getByTitle('Send message').click();

		const longQueuedMessage = [
			'Queue line 1: summarize the pending architecture decision.',
			'Queue line 2: verify the renderer state transition.',
			'Queue line 3: confirm that the moderator sees the full follow-up.',
			'Queue line 4: preserve this final marker for expansion coverage.',
		].join('\n');
		await window.getByPlaceholder('Type to queue message...').fill(longQueuedMessage);
		await window.getByTitle('Queue message').click();

		await expect(window.getByText('QUEUED (1)')).toBeVisible();
		await expect(window.getByText('Queue line 4: preserve this final marker')).toBeHidden();
		await window.getByRole('button', { name: /Show all/ }).click();
		await expect(window.getByText('Queue line 4: preserve this final marker')).toBeVisible();
		await window.getByRole('button', { name: 'Show less' }).click();
		await expect(window.getByText('Queue line 4: preserve this final marker')).toBeHidden();
	});

	test('shows image attachment counts for queued Group Chat messages', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		await window
			.getByPlaceholder('Type a message... (@ to mention agent)')
			.fill('Start image queue coverage.');
		await window.getByTitle('Send message').click();
		await expect(window.getByPlaceholder('Type to queue message...')).toBeVisible();

		await window.locator('#group-chat-image-input').setInputFiles(groupChatImagePath());
		await expect(window.getByAltText('Staged image')).toBeVisible();
		await window.getByPlaceholder('Type to queue message...').fill('Queue the attached image.');
		await window.getByTitle('Queue message').click();

		await expect(window.getByText('QUEUED (1)')).toBeVisible();
		await expect(window.getByText('Queue the attached image.')).toBeVisible();
		await expect(window.getByText('1 image attached')).toBeVisible();
		await expect(window.getByAltText('Staged image')).toBeHidden();
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

	test('cancels participant removal without invoking IPC', async () => {
		await stubGroupChatIpcActions(electronApp);
		await openCoverageRoom();

		const reviewerCard = participantCard('Reviewer');
		await reviewerCard.getByRole('button', { name: 'Remove' }).click();
		await expect(reviewerCard.getByRole('button', { name: 'Confirm' })).toBeVisible();
		await reviewerCard.getByRole('button', { name: 'Cancel' }).click();

		await expect(reviewerCard.getByRole('button', { name: 'Confirm' })).toBeHidden();
		await expect(reviewerCard.getByRole('button', { name: 'Remove' })).toBeVisible();
		const calls = await getStubbedGroupChatIpcActions(electronApp);
		expect(calls.removeParticipant).toEqual([]);
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

	test('surfaces recoverable participant errors in the group chat Agent Error modal', async () => {
		await openCoverageRoom();
		const sessionId = `group-chat-${seededWorkbench.groupChats[0].id}-Reviewer-${Date.now()}`;

		await emitGroupChatAgentError(electronApp, {
			sessionId,
			error: {
				type: 'rate_limited',
				message: 'Reviewer hit deterministic rate limit.',
				recoverable: true,
				agentId: 'codex',
				sessionId,
				timestamp: Date.now(),
				raw: { stderr: 'rate limited' },
			},
		});

		const dialog = window.getByRole('dialog', { name: 'Rate Limit Exceeded' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText('Reviewer • Coverage Room')).toBeVisible();
		await expect(dialog.getByText('Reviewer hit deterministic rate limit.')).toBeVisible();
		await expect(
			window.getByText('Reviewer error: Reviewer hit deterministic rate limit.')
		).toBeVisible();
		await dialog.getByRole('button', { name: 'Try Again' }).click();

		await expect(dialog).toBeHidden();
	});

	test('reports Group Chat Auto Run trigger failures to the moderator', async () => {
		await stubGroupChatAutoRunReport(electronApp);
		await openCoverageRoom();

		await emitGroupChatAutoRunTriggered(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Missing Agent',
			targetFilename: 'Phase 1.md',
		});

		await expect.poll(() => getStubbedGroupChatAutoRunReports(electronApp)).toHaveLength(1);
		let reports = await getStubbedGroupChatAutoRunReports(electronApp);
		expect(reports[0]).toMatchObject({
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Missing Agent',
		});
		expect(reports[0].summary).toContain(
			'No Maestro agent named "Missing Agent" found. Make sure the agent exists and is open.'
		);

		await emitGroupChatAutoRunTriggered(electronApp, {
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Reviewer',
		});

		await expect.poll(() => getStubbedGroupChatAutoRunReports(electronApp)).toHaveLength(2);
		reports = await getStubbedGroupChatAutoRunReports(electronApp);
		expect(reports[1]).toMatchObject({
			groupChatId: seededWorkbench.groupChats[0].id,
			participantName: 'Reviewer',
		});
		expect(reports[1].summary).toContain('No Auto Run documents found in');
		expect(reports[1].summary).toContain('Create a document in the Auto Run tab first.');
	});

	test('shows the New Group Chat no-agent state without enabling creation', async () => {
		await stubGroupChatModalAgents(electronApp, false);
		const dialog = await openNewGroupChatModal();

		await expect(
			dialog.getByText(
				'No agents available. Please install Claude Code, OpenCode, Codex, or Factory Droid.'
			)
		).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
	});

	test('cancels New Group Chat creation without invoking IPC', async () => {
		await stubGroupChatModalAgents(electronApp);
		await stubGroupChatCreationHandlers(electronApp, seededWorkbench);
		const dialog = await openNewGroupChatModal();

		await dialog.getByLabel('Chat Name').fill('Canceled Coverage Room');
		await dialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(dialog).toBeHidden();
		const calls = await getStubbedGroupChatModalActions(electronApp);
		expect(calls.create).toEqual([]);
	});

	test('creates a trimmed Codex group chat from the New Group Chat modal', async () => {
		await stubGroupChatModalAgents(electronApp);
		await stubGroupChatCreationHandlers(electronApp, seededWorkbench);
		const dialog = await openNewGroupChatModal();

		await expect(dialog.getByLabel('Select moderator agent')).toHaveValue('codex');
		await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
		await dialog.getByLabel('Chat Name').fill('  Modal Coverage Room  ');
		await dialog.getByRole('button', { name: 'Create' }).click();

		await expect(
			window.getByRole('button', { name: 'Group Chat: Modal Coverage Room' })
		).toBeVisible();
		await expect
			.poll(async () => (await getStubbedGroupChatModalActions(electronApp)).create)
			.toEqual([
				{
					name: 'Modal Coverage Room',
					moderatorAgentId: 'codex',
					moderatorConfig: undefined,
				},
			]);
		await expect
			.poll(async () => (await getStubbedGroupChatModalActions(electronApp)).startModerator)
			.toEqual(['created-group-chat-1']);
	});

	test('creates a group chat with SSH remote moderator execution', async () => {
		const remote = groupChatSshRemote();
		await stubGroupChatModalAgents(electronApp, true, [remote]);
		await stubGroupChatCreationHandlers(electronApp, seededWorkbench);
		const dialog = await openNewGroupChatModal();

		await expect(dialog.getByText('SSH Remote Execution')).toBeVisible();
		await dialog.locator('select').nth(1).selectOption(remote.id);
		await expect(dialog.getByText('Agent will run on')).toBeVisible();
		await dialog.getByLabel('Chat Name').fill('Remote Coverage Room');
		await dialog.getByRole('button', { name: 'Create' }).click();

		await expect
			.poll(async () => (await getStubbedGroupChatModalActions(electronApp)).create)
			.toEqual([
				{
					name: 'Remote Coverage Room',
					moderatorAgentId: 'codex',
					moderatorConfig: {
						sshRemoteConfig: {
							enabled: true,
							remoteId: remote.id,
						},
					},
				},
			]);
		await expect
			.poll(async () => (await getStubbedGroupChatModalActions(electronApp)).startModerator)
			.toEqual(['created-group-chat-1']);
	});

	test('creates a group chat with custom moderator path args and environment', async () => {
		await stubGroupChatModalAgents(electronApp);
		await stubGroupChatCreationHandlers(electronApp, seededWorkbench);
		const dialog = await openNewGroupChatModal();

		await dialog.getByTitle('Customize moderator settings').click();
		await dialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/bin/codex');
		await dialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model gpt-5-codex --sandbox read-only');
		await dialog.getByRole('button', { name: 'Add Variable' }).click();
		await dialog.getByPlaceholder('VARIABLE_NAME').fill('MAESTRO_E2E_MODE');
		await dialog.getByPlaceholder('value', { exact: true }).fill('group-chat');
		await dialog.getByLabel('Chat Name').fill('Configured Coverage Room');
		await dialog.getByRole('button', { name: 'Create' }).click();

		const calls = await getStubbedGroupChatModalActions(electronApp);
		expect(calls.create).toEqual([
			{
				name: 'Configured Coverage Room',
				moderatorAgentId: 'codex',
				moderatorConfig: {
					customPath: '/opt/maestro/bin/codex',
					customArgs: '--model gpt-5-codex --sandbox read-only',
					customEnvVars: {
						MAESTRO_E2E_MODE: 'group-chat',
					},
				},
			},
		]);
	});
});
