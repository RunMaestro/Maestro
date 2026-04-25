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
					logs: [
						{
							id: 'ai-log-bionify',
							timestamp: now,
							source: 'stdout',
							text: '# AI Chat\n\nReading mode should emphasize this ai chat prose clearly.',
						},
					],
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

		const aiChatSession = {
			id: 'session-bionify-ai-chat',
			name: 'Bionify AI Chat',
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
					id: 'ai-tab-chat-only',
					agentSessionId: null,
					name: 'Chat Only',
					starred: false,
					logs: [
						{
							id: 'ai-log-chat-only',
							timestamp: now,
							source: 'stdout',
							text: '# AI Chat\n\nReading mode should emphasize this ai chat prose clearly.',
						},
					],
					inputValue: 'Chat input plain text remains editable.',
					stagedImages: [],
					createdAt: now,
					state: 'idle',
				},
			],
			activeTabId: 'ai-tab-chat-only',
			closedTabHistory: [],
			filePreviewTabs: [],
			activeFileTabId: null,
			unifiedTabOrder: [{ type: 'ai', id: 'ai-tab-chat-only' }],
			unifiedClosedTabHistory: [],
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
			JSON.stringify({ sessions: [readingSession, aiChatSession, terminalSession] }, null, '\t'),
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
			await writeDurableScreenshot(window, 'bionify-settings-default.png');
			await settingsDialog.getByRole('button', { name: 'Strong' }).click();
			await settingsDialog.getByLabel('Bionify algorithm').fill('+ 1 1 2 2 0.55');
			await settingsDialog.getByLabel('Bionify algorithm').press('Tab');
			await expect
				.poll(async () => {
					return await window.evaluate(async () => {
						return {
							intensity: await window.maestro.settings.get('bionifyIntensity'),
							algorithm: await window.maestro.settings.get('bionifyAlgorithm'),
						};
					});
				})
				.toEqual({
					intensity: 1.35,
					algorithm: '+ 1 1 2 2 0.55',
				});
			await settingsDialog.getByRole('button', { name: 'Info' }).click();
			const infoDialog = window.getByRole('dialog', { name: 'Bionify Algorithm Reference' });
			await expect(infoDialog).toBeVisible();
			await writeDurableScreenshot(window, 'bionify-settings-info.png');
			await infoDialog.getByRole('button', { name: 'Close modal' }).click();
			await expect(infoDialog).toBeHidden();
			await window.keyboard.press('Escape');
			await expect(settingsDialog).toBeHidden();
			await window.waitForTimeout(250);

			const bionifyButtons = window
				.locator('button')
				.filter({ has: window.locator('span', { hasText: /^B$/ }) });
			const filePreviewBeforeButton = bionifyButtons.first();
			await writeDurableScreenshot(window, 'bionify-file-preview-before.png');
			const filePreviewButtonMetrics = await Promise.all([
				filePreviewBeforeButton.boundingBox(),
				window.getByTitle('Copy content to clipboard').boundingBox(),
			]);
			expect(filePreviewButtonMetrics[0]?.height).toBeCloseTo(
				filePreviewButtonMetrics[1]?.height ?? 0,
				0
			);
			expect(filePreviewButtonMetrics[0]?.width).toBeCloseTo(
				filePreviewButtonMetrics[1]?.width ?? 0,
				0
			);
			await filePreviewBeforeButton.click();
			await writeDurableScreenshot(window, 'bionify-file-preview-after.png');

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

			const previewStyleMetrics = await window.evaluate((snippet) => {
				const blocks = Array.from(document.querySelectorAll('div, section, article, main, aside'));
				const fileSurface = blocks.find((node) => node.textContent?.includes(snippet));
				const emphasis = fileSurface?.querySelector('.bionify-word-emphasis');
				const rest = fileSurface?.querySelector('.bionify-word-rest');
				if (!emphasis || !rest) {
					return null;
				}
				const emphasisStyle = window.getComputedStyle(emphasis);
				const restStyle = window.getComputedStyle(rest);
				return {
					emphasisWeight: emphasisStyle.fontWeight,
					restOpacity: restStyle.opacity,
				};
			}, previewPhrase);

			expect(previewStyleMetrics).toEqual({
				emphasisWeight: expect.stringMatching(/7|8/),
				restOpacity: expect.stringMatching(/^0\.[2-5]/),
			});

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
			await writeDurableScreenshot(window, 'bionify-autorun-before.png');
			const autoRunBionifyButton = bionifyButtons.nth(1);
			const autoRunButtonMetrics = await Promise.all([
				autoRunBionifyButton.boundingBox(),
				window.getByTitle('Create new document').boundingBox(),
			]);
			expect(autoRunButtonMetrics[0]?.height).toBeCloseTo(autoRunButtonMetrics[1]?.height ?? 0, 0);
			expect(autoRunButtonMetrics[0]?.width).toBeCloseTo(autoRunButtonMetrics[1]?.width ?? 0, 0);
			await autoRunBionifyButton.click();
			await window.waitForTimeout(250);
			await writeDurableScreenshot(window, 'bionify-autorun-after.png');

			await window.getByText('Bionify AI Chat').click();
			await expect(window.getByText('ai chat prose clearly')).toBeVisible();
			await writeDurableScreenshot(window, 'bionify-ai-chat-before.png');
			await window.keyboard.press('Meta+,');
			await expect(settingsDialog).toBeVisible();
			await settingsDialog.locator('button[title="Display"]').click();
			await settingsDialog.getByRole('button', { name: 'Bionify' }).click();
			await expect
				.poll(async () => {
					return await window.evaluate((snippet) => {
						const blocks = Array.from(
							document.querySelectorAll('div, section, article, main, aside')
						);
						const chatSurface = blocks.find((node) => node.textContent?.includes(snippet));
						return chatSurface?.querySelectorAll('.bionify-word-emphasis').length ?? 0;
					}, 'ai chat prose clearly');
				})
				.toBeGreaterThan(0);
			await expect
				.poll(async () => {
					return await window.evaluate(async () => {
						return await window.maestro.settings.get('bionifyReadingMode');
					});
				})
				.toBe(true);
			await window.keyboard.press('Escape');
			await expect(settingsDialog).toBeHidden();
			await writeDurableScreenshot(window, 'bionify-ai-chat-after.png');

			const aiChatStyleMetrics = await window.evaluate((snippet) => {
				const blocks = Array.from(document.querySelectorAll('div, section, article, main, aside'));
				const chatSurface = blocks.find((node) => node.textContent?.includes(snippet));
				const emphasis = chatSurface?.querySelector('.bionify-word-emphasis');
				const rest = chatSurface?.querySelector('.bionify-word-rest');
				if (!emphasis || !rest) {
					return null;
				}
				const emphasisStyle = window.getComputedStyle(emphasis);
				const restStyle = window.getComputedStyle(rest);
				return {
					emphasisWeight: emphasisStyle.fontWeight,
					restOpacity: restStyle.opacity,
				};
			}, 'ai chat prose clearly');

			expect(aiChatStyleMetrics).toEqual({
				emphasisWeight: expect.stringMatching(/7|8/),
				restOpacity: expect.stringMatching(/^0\.[2-5]/),
			});
		} finally {
			await app.close();
			fs.rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
