import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test.describe('Bionify reading mode prototype', () => {
	test('applies Bionify spans to seeded File Preview and Auto Run prose without changing the chat input', async () => {
		const homeDir = createTempDir('maestro-bionify-home-');
		const projectDir = path.join(homeDir, 'project');
		const autoRunDir = path.join(projectDir, 'Auto Run Docs');
		const previewFilePath = path.join(projectDir, 'reading-mode-demo.md');
		const autoRunFilePath = path.join(autoRunDir, 'Phase 1.md');
		const previewPhrase = 'file preview prose clearly';
		const autoRunPhrase = 'auto run prose clearly';
		const now = Date.now();
		const aiTabId = 'ai-tab-bionify';
		const fileTabId = 'file-tab-bionify';

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

		const session = {
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
			JSON.stringify({ sessions: [session] }, null, '\t'),
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

			await expect
				.poll(async () => {
					return await window.evaluate(
						([fileSnippet, autoRunSnippet]) => {
							const blocks = Array.from(
								document.querySelectorAll('div, section, article, main, aside')
							);
							const fileSurface = blocks.find((node) => node.textContent?.includes(fileSnippet));
							const autoRunSurface = blocks.find((node) =>
								node.textContent?.includes(autoRunSnippet)
							);

							return {
								total: document.querySelectorAll('.bionify-word').length,
								fileSurfaceWords: fileSurface?.querySelectorAll('.bionify-word').length ?? 0,
								autoRunSurfaceWords: autoRunSurface?.querySelectorAll('.bionify-word').length ?? 0,
								codeWords: document.querySelectorAll('code .bionify-word').length,
							};
						},
						[previewPhrase, autoRunPhrase]
					);
				})
				.toEqual({
					total: expect.any(Number),
					fileSurfaceWords: expect.any(Number),
					autoRunSurfaceWords: expect.any(Number),
					codeWords: 0,
				});

			const counts = await window.evaluate(
				([fileSnippet, autoRunSnippet]) => {
					const blocks = Array.from(
						document.querySelectorAll('div, section, article, main, aside')
					);
					const fileSurface = blocks.find((node) => node.textContent?.includes(fileSnippet));
					const autoRunSurface = blocks.find((node) => node.textContent?.includes(autoRunSnippet));

					return {
						total: document.querySelectorAll('.bionify-word').length,
						fileSurfaceWords: fileSurface?.querySelectorAll('.bionify-word').length ?? 0,
						autoRunSurfaceWords: autoRunSurface?.querySelectorAll('.bionify-word').length ?? 0,
						codeWords: document.querySelectorAll('code .bionify-word').length,
					};
				},
				[previewPhrase, autoRunPhrase]
			);

			expect(counts.total).toBeGreaterThan(0);
			expect(counts.fileSurfaceWords).toBeGreaterThan(0);
			expect(counts.autoRunSurfaceWords).toBeGreaterThan(0);
			expect(counts.codeWords).toBe(0);
		} finally {
			await app.close();
			fs.rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
