/**
 * E2E Tests: debug, confirmation, and accessibility smoke first tranche.
 *
 * These scenarios seed local state and stub update IPC. They avoid live
 * provider, network, and Playwright execution during the authoring phase.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
});
