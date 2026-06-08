/**
 * E2E Tests: debug, confirmation, and accessibility smoke tranches.
 *
 * These scenarios seed local state and stub update IPC. They avoid live
 * provider, network, and Playwright execution during the authoring phase.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const secondTrancheActiveScenarioMatrix = [
	{ id: 'DA-006', title: 'opens Create Debug Package from Quick Actions with preview rows' },
	{ id: 'DA-007', title: 'disables debug package generation when every category is excluded' },
	{ id: 'DA-008', title: 'creates a debug package with selected diagnostic options' },
	{ id: 'DA-009', title: 'falls back to default debug package categories after preview failure' },
	{ id: 'DA-010', title: 'surfaces debug package creation errors without closing the modal' },
	{ id: 'DA-011', title: 'returns debug package generation to idle after cancellation' },
] as const;

const debugPackagePreviewCategories = [
	{ id: 'logs', name: 'System Logs', included: true, sizeEstimate: '~50 KB' },
	{ id: 'errors', name: 'Error States', included: true, sizeEstimate: '< 10 KB' },
	{ id: 'sessions', name: 'Session Metadata', included: true, sizeEstimate: '~10 KB' },
	{ id: 'groupChats', name: 'Group Chat Metadata', included: true, sizeEstimate: '< 5 KB' },
	{ id: 'batchState', name: 'Auto Run State', included: true, sizeEstimate: '< 5 KB' },
];

type DebugPackageCreateOptions = {
	includeLogs?: boolean;
	includeErrors?: boolean;
	includeSessions?: boolean;
	includeGroupChats?: boolean;
	includeBatchState?: boolean;
};

type DebugPackageStubPayload = {
	previewMode: 'success' | 'error';
	createMode: 'success' | 'error' | 'cancelled';
	resultPath: string;
	categories: typeof debugPackagePreviewCategories;
};

function createDebugAccessibilityWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-debug-accessibility-'));
	const projectDir = path.join(homeDir, 'project');
	const now = Date.parse('2026-05-29T12:00:00.000Z');
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `debug-accessibility-${idSuffix}`;
	const aiTabId = `debug-accessibility-ai-${idSuffix}`;
	const aiLogs = [
		{
			id: `debug-accessibility-log-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: 'Debug accessibility seeded transcript sentinel.',
		},
	];

	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, 'README.md'),
		'# Debug Accessibility Fixture\n\nLocal fixture for modal and accessibility smoke coverage.\n',
		'utf-8'
	);

	return {
		homeDir,
		projectDir,
		sessions: [
			{
				id: sessionId,
				name: 'Debug Accessibility Agent',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs,
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
						id: aiTabId,
						agentSessionId: 'codex-debug-accessibility-tab',
						name: 'Main',
						starred: false,
						logs: aiLogs,
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: 'idle',
					},
				],
				activeTabId: aiTabId,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: aiTabId }],
				unifiedClosedTabHistory: [],
			},
		],
	};
}

async function launchDebugAccessibilityWorkbench() {
	const seeded = createDebugAccessibilityWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function openQuickActions(page: Page) {
	const quickActionsDialog = page.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await page.bringToFront();
		await page.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	await expect(
		quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
	).toBeVisible();
	return quickActionsDialog;
}

async function openSystemLogViewer(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View System Logs');
	await quickActionsDialog.getByRole('button', { name: /View System Logs/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const logViewer = page.getByRole('dialog', { name: 'System Log Viewer' });
	await expect(logViewer).toBeVisible();
	return logViewer;
}

async function seedSystemLogs(page: Page) {
	await page.evaluate(async () => {
		await window.maestro.logger.clearLogs();
		await window.maestro.logger.log('info', 'Debug accessibility info sentinel', 'E2EDebug', {
			marker: 'debug-accessibility-info',
		});
		await window.maestro.logger.log('error', 'Debug accessibility error sentinel', 'E2EDebug', {
			marker: 'debug-accessibility-error',
		});
	});
}

async function stubUpdateCheck(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('updates:check');
		ipcMain.handle('updates:check', async () => ({
			currentVersion: '0.15.3',
			latestVersion: '0.16.0',
			updateAvailable: true,
			versionsBehind: 1,
			assetsReady: true,
			releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
			releases: [
				{
					tag_name: 'v0.16.0',
					name: 'v0.16.0 | Debug Accessibility E2E',
					body: '### Deterministic release notes\n\n- Adds debug accessibility tranche coverage.',
					html_url: 'https://github.com/RunMaestro/Maestro/releases/tag/v0.16.0',
					published_at: '2026-05-29T12:00:00.000Z',
				},
			],
		}));
	});
}

async function stubDebugPackageHandlers(
	electronApp: ElectronApplication,
	options: Partial<Pick<DebugPackageStubPayload, 'previewMode' | 'createMode' | 'resultPath'>> = {}
) {
	const payload: DebugPackageStubPayload = {
		previewMode: options.previewMode ?? 'success',
		createMode: options.createMode ?? 'success',
		resultPath: options.resultPath ?? path.join(os.tmpdir(), 'maestro-debug-accessibility.zip'),
		categories: debugPackagePreviewCategories,
	};

	await electronApp.evaluate(({ ipcMain }, stubPayload: DebugPackageStubPayload) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eDebugPackageState?: {
				previewCalls: number;
				createOptions: DebugPackageCreateOptions[];
			};
		};
		state.__maestroE2eDebugPackageState = { previewCalls: 0, createOptions: [] };

		ipcMain.removeHandler('debug:previewPackage');
		ipcMain.handle('debug:previewPackage', async () => {
			state.__maestroE2eDebugPackageState!.previewCalls += 1;
			if (stubPayload.previewMode === 'error') {
				throw new Error('Debug package preview failure sentinel');
			}
			return { categories: stubPayload.categories };
		});

		ipcMain.removeHandler('debug:createPackage');
		ipcMain.handle(
			'debug:createPackage',
			async (_event, createOptions: DebugPackageCreateOptions) => {
				state.__maestroE2eDebugPackageState!.createOptions.push(createOptions ?? {});
				if (stubPayload.createMode === 'error') {
					return { success: false, error: 'Debug package create failure sentinel' };
				}
				if (stubPayload.createMode === 'cancelled') {
					return { cancelled: true };
				}
				return { success: true, path: stubPayload.resultPath };
			}
		);
	}, payload);
}

async function getStubbedDebugPackageState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eDebugPackageState?: {
				previewCalls: number;
				createOptions: DebugPackageCreateOptions[];
			};
		};
		return state.__maestroE2eDebugPackageState ?? null;
	});
}

async function openDebugPackageFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Create Debug Package');
	await quickActionsDialog.getByRole('button', { name: /Create Debug Package/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const debugPackageDialog = page.getByRole('dialog', { name: 'Create Debug Package' });
	await expect(debugPackageDialog).toBeVisible();
	return debugPackageDialog;
}

test.describe('Debug and accessibility smoke tranche', () => {
	test('opens About Maestro from Quick Actions with accessible dialog chrome', async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('About Maestro');
			await quickActionsDialog.getByRole('button', { name: /About Maestro/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			const aboutDialog = launched.window.getByRole('dialog', { name: 'About Maestro' });
			await expect(aboutDialog).toBeVisible();
			await expect(aboutDialog.getByRole('heading', { name: 'About Maestro' })).toBeVisible();
			await expect(aboutDialog.getByTitle('Documentation')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens keyboard shortcuts help and filters accessible command rows', async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('View Shortcuts');
			await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

			const shortcutsDialog = launched.window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
			await expect(shortcutsDialog).toBeVisible();
			await shortcutsDialog.getByPlaceholder('Search shortcuts...').fill('tab');
			await expect(shortcutsDialog.getByText('Tab Switcher')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('searches seeded System Log Viewer errors and restores hidden entries', async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.evaluate((element) => {
				element.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
				);
			});
			const searchInput = logViewer.getByPlaceholder('Search logs...');
			await expect(searchInput).toBeVisible();
			await searchInput.fill('error sentinel');
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeHidden();

			await launched.window.keyboard.press('Escape');
			await expect(searchInput).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels System Log Viewer clear confirmation without deleting logs', async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.getByTitle('Clear logs').click();
			const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(confirmDialog).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens stubbed update check modal without network access', async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateCheck(launched.electronApp);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Check for Updates');
			await quickActionsDialog.getByRole('button', { name: /Check for Updates/ }).click();

			const updateDialog = launched.window.getByRole('dialog', { name: 'Check for Updates' });
			await expect(updateDialog).toBeVisible();
			await expect(updateDialog.getByText('Update Available!')).toBeVisible();
			await expect(updateDialog.getByText('Debug Accessibility E2E')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[0].id} ${secondTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expect(debugPackageDialog.getByText('Privacy:')).toBeVisible();
			await expect(debugPackageDialog.getByText('Select what to include:')).toBeVisible();
			await expect(debugPackageDialog.getByText('5 of 5 selected')).toBeVisible();
			await expect(debugPackageDialog.getByText('System Logs', { exact: true })).toBeVisible();
			await expect(debugPackageDialog.getByText('Error States', { exact: true })).toBeVisible();
			expect(
				(await getStubbedDebugPackageState(launched.electronApp))?.previewCalls ?? 0
			).toBeGreaterThanOrEqual(1);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[1].id} ${secondTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			for (const category of debugPackagePreviewCategories) {
				await debugPackageDialog.getByText(category.name, { exact: true }).click();
			}

			await expect(debugPackageDialog.getByText('0 of 5 selected')).toBeVisible();
			await expect(
				debugPackageDialog.getByRole('button', { name: 'Generate Package' })
			).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[2].id} ${secondTrancheActiveScenarioMatrix[2].title}`, async () => {
		const resultPath = path.join(os.tmpdir(), 'maestro-debug-accessibility-success.zip');
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp, { resultPath });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await debugPackageDialog.getByText('System Logs', { exact: true }).click();
			await debugPackageDialog.getByText('Error States', { exact: true }).click();
			await expect(debugPackageDialog.getByText('3 of 5 selected')).toBeVisible();
			await debugPackageDialog.getByRole('button', { name: 'Generate Package' }).click();

			await expect(debugPackageDialog.getByText('Package created successfully!')).toBeVisible();
			await expect(debugPackageDialog.getByText(resultPath)).toBeVisible();
			await expect(debugPackageDialog.getByRole('button', { name: 'Done' })).toBeVisible();
			expect((await getStubbedDebugPackageState(launched.electronApp))?.createOptions).toEqual([
				{
					includeLogs: false,
					includeErrors: false,
					includeSessions: true,
					includeGroupChats: true,
					includeBatchState: true,
				},
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[3].id} ${secondTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp, { previewMode: 'error' });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expect(
				debugPackageDialog.getByText('System Information', { exact: true })
			).toBeVisible();
			await expect(
				debugPackageDialog.getByText('Agent Configurations', { exact: true })
			).toBeVisible();
			await expect(debugPackageDialog.getByText('8 of 8 selected')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[4].id} ${secondTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp, { createMode: 'error' });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await debugPackageDialog.getByRole('button', { name: 'Generate Package' }).click();
			await expect(debugPackageDialog.getByText('Failed to create package')).toBeVisible();
			await expect(
				debugPackageDialog.getByText('Debug package create failure sentinel')
			).toBeVisible();
			await expect(
				debugPackageDialog.getByRole('button', { name: 'Generate Package' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[5].id} ${secondTrancheActiveScenarioMatrix[5].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp, { createMode: 'cancelled' });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await debugPackageDialog.getByRole('button', { name: 'Generate Package' }).click();
			await expect(debugPackageDialog.getByText('Select what to include:')).toBeVisible();
			await expect(debugPackageDialog.getByText('Package created successfully!')).toHaveCount(0);
			await expect(debugPackageDialog.getByText('Failed to create package')).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});
});
