import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Page } from '@playwright/test';

function createTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function shouldWriteDurableScreenshots(): boolean {
	return process.env.MAESTRO_WRITE_DURABLE_SCREENSHOTS === 'true';
}

async function writeDurableScreenshot(page: Page, fileName: string): Promise<void> {
	if (!shouldWriteDurableScreenshots()) {
		return;
	}

	const screenshotsDir = path.resolve(__dirname, '../docs/screenshots');
	fs.mkdirSync(screenshotsDir, { recursive: true });

	await page.screenshot({
		path: path.join(screenshotsDir, fileName),
		fullPage: true,
	});
}

test.describe('Bionify reading mode prototype', () => {
	test('applies Bionify spans to supported reading surfaces while excluding chat and terminal surfaces', async () => {
		const homeDir = createTempDir('maestro-bionify-home-');
		const projectDir = path.join(homeDir, 'project');
		const autoRunDir = path.join(projectDir, 'Auto Run Docs');
		const previewFilePath = path.join(projectDir, 'reading-mode-demo.md');
		const autoRunFilePath = path.join(autoRunDir, 'Phase 1.md');
		const previewPhrase = 'file preview prose clearly';
		const autoRunPhrase = 'auto run prose clearly';
		const terminalSnippet = 'terminal output remains plain text';
		const now = Date.now();
		const aiTabId = 'ai-tab-bionify';
		const fileTabId = 'file-tab-bionify';
		const terminalTabId = 'terminal-tab-bionify';

		fs.mkdirSync(autoRunDir, { recursive: true });

		const previewContent = `# File Preview

Reading mode should emphasize this ${previewPhrase}.

\`inline code\` stays literal in file preview.
`;

		const autoRunContent = `# Auto Run

Reading mode should emphasize this ${autoRunPhrase}.

- [ ] Preserve task syntax

\`inline code\` stays literal in Auto Run.
`;

		fs.writeFileSync(previewFilePath, previewContent, 'utf-8');
		fs.writeFileSync(autoRunFilePath, autoRunContent, 'utf-8');

		const readingSession = {
			id: 'session-bionify',
			name: 'Bionify Prototype',
			toolType: 'codex',
			state: 'idle',
			cwd: projectDir,
			fullPath: projectDir,
			projectRoot: projectDir,
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
					id: aiTabId,
					agentSessionId: null,
					name: 'Main',
					starred: false,
					logs: [],
					inputValue: 'Chat input plain text remains editable.',
					stagedImages: [],
					createdAt: now,
					state: 'idle',
				},
			],
			activeTabId: aiTabId,
			closedTabHistory: [],
			filePreviewTabs: [
				{
					id: fileTabId,
					path: previewFilePath,
					name: 'reading-mode-demo',
					extension: '.md',
					content: previewContent,
					scrollTop: 0,
					searchQuery: '',
					editMode: false,
					createdAt: now,
					lastModified: now,
				},
			],
			activeFileTabId: fileTabId,
			unifiedTabOrder: [
				{ type: 'ai', id: aiTabId },
				{ type: 'file', id: fileTabId },
			],
			unifiedClosedTabHistory: [],
			autoRunFolderPath: autoRunDir,
			autoRunSelectedFile: 'Phase 1',
			autoRunContent,
			autoRunContentVersion: 1,
			autoRunMode: 'preview',
			autoRunEditScrollPos: 0,
			autoRunPreviewScrollPos: 0,
			autoRunCursorPosition: 0,
		};

		const terminalSession = {
			id: 'session-bionify-terminal',
			name: 'Bionify Terminal Exclusion',
			toolType: 'terminal',
			state: 'idle',
			cwd: projectDir,
			fullPath: projectDir,
			projectRoot: projectDir,
			aiLogs: [],
			shellLogs: [
				{
					id: 'shell-log-bionify',
					timestamp: now,
					source: 'system',
					text: terminalSnippet,
				},
			],
			workLog: [],
			contextUsage: 0,
			inputMode: 'terminal',
			aiPid: 0,
			terminalPid: 456,
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
					id: terminalTabId,
					agentSessionId: null,
					name: 'Terminal',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: now,
					state: 'idle',
				},
			],
			activeTabId: terminalTabId,
			closedTabHistory: [],
			filePreviewTabs: [],
			activeFileTabId: null,
			unifiedTabOrder: [{ type: 'ai', id: terminalTabId }],
			unifiedClosedTabHistory: [],
		};

		const launchEnv = {
			...process.env,
			HOME: homeDir,
			ELECTRON_DISABLE_GPU: '1',
			NODE_ENV: 'test',
			MAESTRO_E2E_TEST: 'true',
		};

		const probeApp = await electron.launch({
			args: [path.join(__dirname, '../dist/main/index.js')],
			env: launchEnv,
			timeout: 30000,
		});

		await probeApp.firstWindow();
		const userDataPath = await probeApp.evaluate(({ app }) => app.getPath('userData'));
		await probeApp.close();

		fs.mkdirSync(userDataPath, { recursive: true });
		fs.writeFileSync(
			path.join(userDataPath, 'maestro-sessions.json'),
			JSON.stringify({ sessions: [readingSession, terminalSession] }, null, '\t'),
			'utf-8'
		);
		fs.writeFileSync(
			path.join(userDataPath, 'maestro-groups.json'),
			JSON.stringify({ groups: [] }, null, '\t'),
			'utf-8'
		);

		const app = await electron.launch({
			args: [path.join(__dirname, '../dist/main/index.js')],
			env: launchEnv,
			timeout: 30000,
		});

		try {
			const window = await app.firstWindow();
			await window.waitForLoadState('domcontentloaded');
			await window.setViewportSize({ width: 1440, height: 960 });
			await window.waitForTimeout(1000);

			await expect(window.getByText('Bionify Prototype').first()).toBeVisible();
			await expect(window.locator(`text=${previewPhrase}`)).toBeVisible();

			await window.locator('text=Auto Run').first().click();
			await expect(window.locator(`text=${autoRunPhrase}`)).toBeVisible();

			await window.keyboard.press('Meta+,');
			const settingsDialog = window.locator('[role="dialog"][aria-label="Settings"]');
			await expect(settingsDialog).toBeVisible();
			await settingsDialog.locator('button[title="Display"]').click();
			await settingsDialog.getByRole('button', { name: 'Bionify' }).click();
			await expect
				.poll(async () => {
					return await window.evaluate(async () => {
						return await window.maestro.settings.get('bionifyReadingMode');
					});
				})
				.toBe(true);
			await window.keyboard.press('Escape');
			await expect(settingsDialog).toBeHidden();
			await window.waitForTimeout(250);

			await writeDurableScreenshot(window, 'bionify-file-preview.png');

			await expect
				.poll(async () => {
					return await window.evaluate(
						([fileSnippet, autoRunSnippet, chatValue]) => {
							const blocks = Array.from(
								document.querySelectorAll('div, section, article, main, aside')
							);
							const fileSurface = blocks.find((node) => node.textContent?.includes(fileSnippet));
							const autoRunSurface = blocks.find((node) =>
								node.textContent?.includes(autoRunSnippet)
							);
							const composer = Array.from(document.querySelectorAll('textarea')).find((node) =>
								node.value.includes(chatValue)
							);

							return {
								total: document.querySelectorAll('.bionify-word').length,
								fileSurfaceWords: fileSurface?.querySelectorAll('.bionify-word').length ?? 0,
								autoRunSurfaceWords: autoRunSurface?.querySelectorAll('.bionify-word').length ?? 0,
								codeWords: document.querySelectorAll('code .bionify-word').length,
								composerWords: composer?.querySelectorAll('.bionify-word').length ?? 0,
							};
						},
						[previewPhrase, autoRunPhrase, 'Chat input plain text remains editable.']
					);
				})
				.toEqual({
					total: expect.any(Number),
					fileSurfaceWords: expect.any(Number),
					autoRunSurfaceWords: expect.any(Number),
					codeWords: 0,
					composerWords: 0,
				});

			const counts = await window.evaluate(
				([fileSnippet, autoRunSnippet, chatValue]) => {
					const blocks = Array.from(
						document.querySelectorAll('div, section, article, main, aside')
					);
					const fileSurface = blocks.find((node) => node.textContent?.includes(fileSnippet));
					const autoRunSurface = blocks.find((node) => node.textContent?.includes(autoRunSnippet));
					const composer = Array.from(document.querySelectorAll('textarea')).find((node) =>
						node.value.includes(chatValue)
					);

					return {
						total: document.querySelectorAll('.bionify-word').length,
						fileSurfaceWords: fileSurface?.querySelectorAll('.bionify-word').length ?? 0,
						autoRunSurfaceWords: autoRunSurface?.querySelectorAll('.bionify-word').length ?? 0,
						codeWords: document.querySelectorAll('code .bionify-word').length,
						composerWords: composer?.querySelectorAll('.bionify-word').length ?? 0,
					};
				},
				[previewPhrase, autoRunPhrase, 'Chat input plain text remains editable.']
			);

			expect(counts.total).toBeGreaterThan(0);
			expect(counts.fileSurfaceWords).toBeGreaterThan(0);
			expect(counts.autoRunSurfaceWords).toBeGreaterThan(0);
			expect(counts.codeWords).toBe(0);
			expect(counts.composerWords).toBe(0);

			await window.getByText('Bionify Terminal Exclusion').click();
			await expect(window.getByText(terminalSnippet)).toBeVisible();

			const terminalCounts = await window.evaluate((snippet) => {
				const blocks = Array.from(document.querySelectorAll('div, section, article, main, aside'));
				const terminalSurface = blocks.find((node) => node.textContent?.includes(snippet));

				return {
					terminalSurfaceWords: terminalSurface?.querySelectorAll('.bionify-word').length ?? 0,
					totalTerminalWords: Array.from(document.querySelectorAll('.bionify-word')).filter(
						(node) =>
							node.closest('textarea') === null &&
							node.closest('input') === null &&
							terminalSurface?.contains(node)
					).length,
				};
			}, terminalSnippet);

			expect(terminalCounts.terminalSurfaceWords).toBe(0);
			expect(terminalCounts.totalTerminalWords).toBe(0);

			await window.getByText('Bionify Prototype').click();
			await window.locator('text=Auto Run').first().click();
			await expect(window.locator(`text=${autoRunPhrase}`)).toBeVisible();
			await window.waitForTimeout(250);
			await writeDurableScreenshot(window, 'bionify-autorun.png');
		} finally {
			await app.close();
			fs.rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
