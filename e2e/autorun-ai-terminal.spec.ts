import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

type CodexProcessSpawnCall = {
	sessionId: string;
	toolType?: string;
	prompt?: string;
	readOnlyMode?: boolean;
};

function createLaneWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-autorun-ai-'));
	const projectDir = path.join(homeDir, 'project');
	const autoRunFolder = path.join(projectDir, 'Auto Run Docs');
	const phaseOnePath = path.join(autoRunFolder, 'Phase 1.md');
	const phaseTwoPath = path.join(autoRunFolder, 'Phase 2.md');
	const now = Date.now();
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `session-autorun-ai-${idSuffix}`;
	const aiTabId = `ai-tab-autorun-ai-${idSuffix}`;
	const codexLogs = [
		{
			id: `ai-log-autorun-ai-system-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: '# Codex Lane Transcript\n\nCodex lane seeded response is visible.',
		},
		{
			id: `ai-log-autorun-ai-user-${idSuffix}`,
			timestamp: now + 1,
			source: 'user',
			text: 'Review Auto Run lane coverage without a live provider',
			delivered: true,
		},
	];
	const phaseOneContent = `# Phase 1: Lane Setup

## Tasks

- [ ] Wire deterministic Auto Run coverage
- [x] Keep Codex provider execution stubbed
- [ ] Record lane progress

Codex auto-run lane sentinel.
`;

	fs.mkdirSync(autoRunFolder, { recursive: true });
	fs.writeFileSync(phaseOnePath, phaseOneContent, 'utf-8');
	fs.writeFileSync(
		phaseTwoPath,
		`# Phase 2: Lane Follow-up

## Tasks

- [ ] Expand remaining Auto Run matrix
- [ ] Expand remaining Codex terminal matrix

Codex second document sentinel.
`,
		'utf-8'
	);
	fs.writeFileSync(path.join(projectDir, 'README.md'), '# Auto Run Codex Project\n', 'utf-8');

	return {
		homeDir,
		projectDir,
		autoRunFolder,
		phaseOnePath,
		phaseOneContent,
		sessions: [
			{
				id: sessionId,
				name: 'Auto Run Codex E2E',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs: codexLogs,
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
						agentSessionId: 'thread_autorun_ai_terminal_seed',
						name: 'Main',
						starred: false,
						logs: codexLogs,
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
				autoRunFolderPath: autoRunFolder,
				autoRunSelectedFile: 'Phase 1',
				autoRunContent: phaseOneContent,
				autoRunContentVersion: 1,
				autoRunMode: 'preview',
				autoRunEditScrollPos: 0,
				autoRunPreviewScrollPos: 0,
				autoRunCursorPosition: 0,
			},
		],
	};
}

async function launchLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

function createQueuedLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]!;
	const activeTab = session.aiTabs[0]!;
	const longQueuedPrompt = Array.from(
		{ length: 18 },
		(_, index) =>
			`Codex queued long prompt line ${String(index + 1).padStart(2, '0')} for Auto Run lane coverage`
	).join('\n');

	session.executionQueue = [
		{
			id: 'queued-autorun-ai-long-message',
			timestamp: Date.now() - 1_000,
			tabId: activeTab.id,
			type: 'message',
			text: longQueuedPrompt,
			images: ['data:image/png;base64,iVBORw0KGgo='],
			tabName: activeTab.name || 'Main',
			readOnlyMode: true,
		},
		{
			id: 'queued-autorun-ai-command',
			timestamp: Date.now() - 500,
			tabId: activeTab.id,
			type: 'command',
			command: '/history',
			commandDescription: 'Generate a synopsis of this agent history',
			tabName: activeTab.name || 'Main',
		},
	];

	return { ...seeded, longQueuedPrompt };
}

async function launchQueuedLaneWorkbench() {
	const seeded = createQueuedLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function openAutoRunPanel(page: Page) {
	await helpers.openRightPanelTab(page, 'Auto Run');
	await expect(page.locator('[data-tour="autorun-panel"]')).toBeVisible();
}

async function waitForSeededAutoRunDocumentList(page: Page) {
	const selector = page.locator('[data-tour="autorun-document-selector"]');
	await selector
		.getByRole('button', { name: /Phase 1\.md/ })
		.first()
		.click();
	await expect(page.getByRole('button', { name: /Phase 2\.md/ })).toBeVisible();
	await page.keyboard.press('Escape');
	return selector;
}

async function openCodexAiTerminal(page: Page) {
	await page
		.locator('[data-tour="session-list"]')
		.getByText('Auto Run Codex E2E', { exact: true })
		.first()
		.click();
	await page.getByText('Main', { exact: true }).click();
	await expect(page.getByText('Codex lane seeded response is visible.')).toBeVisible();
	const promptInput = page.getByPlaceholder(/Talking to Auto Run Codex E2E powered by Codex/);
	await expect(promptInput).toBeVisible();
	return promptInput;
}

async function stubCodexProcessSpawn(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eCodexSpawnCalls?: CodexProcessSpawnCall[];
		};
		state.__maestroE2eCodexSpawnCalls = [];

		ipcMain.removeHandler('process:spawn');
		ipcMain.handle('process:spawn', async (event, config: CodexProcessSpawnCall) => {
			state.__maestroE2eCodexSpawnCalls?.push(config);
			event.sender.send(
				'process:data',
				config.sessionId,
				'Codex lane stubbed spawn response sentinel\n'
			);
			event.sender.send('process:exit', config.sessionId, 0);
			return { pid: 41042, success: true };
		});
	});
}

async function getStubbedCodexProcessSpawnCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eCodexSpawnCalls?: CodexProcessSpawnCall[];
		};
		return state.__maestroE2eCodexSpawnCalls || [];
	});
}

test.describe('Auto Run and Codex AI Terminal', () => {
	test('renders a seeded Codex Auto Run document with task progress', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await expect(
				launched.window.getByRole('heading', { name: 'Phase 1: Lane Setup' })
			).toBeVisible();
			await expect(launched.window.getByText('Codex auto-run lane sentinel.')).toBeVisible();
			await expect(launched.window.getByText('1 of 3 tasks completed').first()).toBeVisible();
			await expect(helpers.getRunButton(launched.window).first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('saves Auto Run edits for the selected Codex document', async () => {
		const launched = await launchLaneWorkbench();
		const editedContent = `${launched.phaseOneContent}
## Saved Edit

- [ ] Saved from deterministic lane test
`;

		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);
			await expect(editor).toBeEditable();

			await editor.fill(editedContent);
			await launched.window.getByTitle(/Save changes/).click();

			await expect
				.poll(() => fs.readFileSync(launched.phaseOnePath, 'utf-8'))
				.toContain('Saved from deterministic lane test');
			await launched.window.getByTitle('Preview document').click();
			await expect(launched.window.getByText('Saved from deterministic lane test')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens the Auto Run batch configuration without starting a live provider', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await helpers.getRunButton(launched.window).first().click();

			const dialog = launched.window.getByRole('dialog', { name: 'Auto Run Configuration' });
			await expect(dialog).toBeVisible();
			await expect(dialog.getByText('Phase 1.md')).toBeVisible();
			await expect(dialog.getByText('Agent Prompt')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Go' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('renders seeded Codex AI terminal transcript controls', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('AI Terminal')).toBeVisible();
			await expect(promptInput).toHaveAttribute(
				'placeholder',
				'Talking to Auto Run Codex E2E powered by Codex'
			);
			await expect(launched.window.getByTitle(/Open Prompt Composer/)).toBeVisible();
			await expect(launched.window.getByTitle('Attach Image')).toBeVisible();
			await expect(
				launched.window.getByTitle("Toggle Read-Only mode (agent won't modify files)")
			).toBeVisible();
			await expect(launched.window.getByTitle('Send message')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('dispatches a Codex AI terminal prompt through the stubbed process path', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await stubCodexProcessSpawn(launched.electronApp);
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Codex Auto Run terminal prompt sentinel');
			await launched.window.getByTitle('Send message').click();

			await expect(
				launched.window.getByText('Codex Auto Run terminal prompt sentinel')
			).toBeVisible();
			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);
			const calls = await getStubbedCodexProcessSpawnCalls(launched.electronApp);
			expect(calls).toHaveLength(1);
			expect(calls[0].toolType).toBe('codex');
			expect(calls[0].prompt).toContain('Codex Auto Run terminal prompt sentinel');
			await expect(
				launched.window.getByText('Codex lane stubbed spawn response sentinel')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('prevents duplicate Auto Run document creation in a Codex lane agent', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await expect(dialog).toBeVisible();
			await dialog.getByLabel('Document Name').fill('Phase 1');

			await expect(dialog.getByText('A document with this name already exists')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a file-backed Auto Run document for the Codex lane agent', async () => {
		const launched = await launchLaneWorkbench();
		const phaseThreePath = path.join(launched.autoRunFolder, 'Phase 3.md');
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.getByLabel('Document Name').fill('Phase 3');
			await dialog.getByRole('button', { name: 'Create' }).click();

			await expect(dialog).toBeHidden();
			await expect.poll(() => fs.existsSync(phaseThreePath)).toBe(true);
			await expect(launched.window.getByText('Phase 3.md')).toBeVisible();
			await expect(launched.window.getByPlaceholder(/Capture notes/)).toBeEditable();
		} finally {
			await launched.cleanup();
		}
	});

	test('refreshes externally added Auto Run documents for the Codex lane agent', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);

			fs.writeFileSync(
				path.join(launched.autoRunFolder, 'Phase 3.md'),
				`# Phase 3: External Refresh

## Tasks

- [ ] Verify refreshed Codex lane document

Externally refreshed Codex Auto Run sentinel.
`,
				'utf-8'
			);
			await launched.window.getByTitle('Refresh document list').click();

			await expect(launched.window.getByText('Found 1 new document')).toBeVisible();
			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();
			await launched.window.getByRole('button', { name: /Phase 3\.md/ }).click();
			await expect(
				launched.window.getByRole('heading', { name: 'Phase 3: External Refresh' })
			).toBeVisible();
			await expect(
				launched.window.getByText('Externally refreshed Codex Auto Run sentinel.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('expands a long queued Codex prompt with attachment count in the lane terminal', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
			await expect(launched.window.getByText('1 image attached')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued long prompt line 18 for Auto Run lane coverage')
			).toBeHidden();

			await launched.window.getByRole('button', { name: /Show all/ }).click();
			await expect(
				launched.window.getByText('Codex queued long prompt line 18 for Auto Run lane coverage')
			).toBeVisible();

			await launched.window.getByRole('button', { name: 'Show less' }).click();
			await expect(
				launched.window.getByText('Codex queued long prompt line 18 for Auto Run lane coverage')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes a queued Codex prompt only after confirmation in the lane terminal', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
			await launched.window.getByTitle('Remove from queue').first().click();
			const confirmDialog = launched.window.getByText('Remove Queued Message?').locator('..');
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();

			await launched.window.getByTitle('Remove from queue').first().click();
			await confirmDialog.getByRole('button', { name: 'Remove' }).click();

			await expect(launched.window.getByText('QUEUED (1)')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued long prompt line 01 for Auto Run lane coverage')
			).toBeHidden();
			await expect(launched.window.getByText('/history')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});
});
