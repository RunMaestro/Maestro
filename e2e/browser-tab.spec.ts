import http from 'http';
import path from 'node:path';
import fs from 'node:fs';
import {
	_electron as electron,
	type ElectronApplication,
	type Locator,
	type Page,
} from '@playwright/test';
import { test, expect } from './fixtures/electron-app';

const LOCAL_TEST_PORT = 7101;
const LOCAL_TEST_TITLE = 'Browser Tab Local Test';
const SECOND_TEST_TITLE = 'Second Browser Page';

function createLocalTestServer(): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((request, res) => {
			const title = request.url === '/second' ? SECOND_TEST_TITLE : LOCAL_TEST_TITLE;
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(
				`<!doctype html><html><head><title>${title}</title><style>html{background:rgb(18,52,86)}</style></head><body><main>${title}</main></body></html>`
			);
		});

		server.once('error', reject);
		server.listen(LOCAL_TEST_PORT, '127.0.0.1', () => resolve(server));
	});
}

async function launchApp(
	appPath: string,
	testDataDir: string
): Promise<{
	app: ElectronApplication;
	window: Page;
}> {
	const sessionsPath = path.join(testDataDir, 'maestro-sessions.json');
	if (!fs.existsSync(sessionsPath)) {
		const session = {
			id: 'browser-test-session',
			name: 'Browser Test',
			toolType: 'claude-code',
			state: 'idle',
			cwd: testDataDir,
			fullPath: testDataDir,
			projectRoot: testDataDir,
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
			aiTabs: [
				{
					id: 'browser-test-ai-tab',
					agentSessionId: null,
					name: 'Seed Tab',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: Date.now(),
					state: 'idle',
				},
			],
			activeTabId: 'browser-test-ai-tab',
			closedTabHistory: [],
			filePreviewTabs: [],
			activeFileTabId: null,
			browserTabs: [],
			activeBrowserTabId: null,
			terminalTabs: [],
			activeTerminalTabId: null,
			unifiedTabOrder: [
				{
					type: 'ai',
					id: 'browser-test-ai-tab',
				},
			],
			unifiedClosedTabHistory: [],
		};
		fs.writeFileSync(
			sessionsPath,
			JSON.stringify({ sessions: [session], activeSessionId: session.id })
		);
		fs.writeFileSync(
			path.join(testDataDir, 'maestro-settings.json'),
			JSON.stringify({
				typographyPromptSeen: true,
				themePromptSeen: true,
				updatesPromptSeen: true,
				agentPowersPromptSeen: true,
				suppressWindowsWarning: true,
			})
		);
	}
	const app = await electron.launch({
		args: [appPath],
		env: {
			...process.env,
			MAESTRO_DEMO_DIR: testDataDir,
			MAESTRO_DATA_DIR: testDataDir,
			ELECTRON_DISABLE_GPU: '1',
			NODE_ENV: 'test',
			MAESTRO_E2E_TEST: 'true',
		},
		timeout: 30000,
	});

	try {
		const window = await app.firstWindow();
		await window.waitForLoadState('domcontentloaded');
		await window
			.getByText('Seed Tab', { exact: true })
			.waitFor({ state: 'visible', timeout: 30000 });
		return { app, window };
	} catch (error) {
		await app.close();
		throw error;
	}
}

async function createBrowserTab(window: Page): Promise<void> {
	await window.evaluate(async () => {
		const sessionId = await window.maestro.sessions.getActiveSessionId();
		window.dispatchEvent(
			new CustomEvent('maestro:openBrowserTab', {
				detail: { sessionId, url: 'about:blank' },
			})
		);
	});
	await expect(getVisibleAddressInput(window)).toBeVisible();
}

async function createTerminalTab(window: Page): Promise<void> {
	await window.getByTitle('New tab…').click();
	await window.getByRole('button', { name: 'New Terminal' }).click();
	await expect(getTabByTitle(window, 'Terminal 1')).toBeVisible();
}

async function openFileTab(window: Page, filePath: string): Promise<void> {
	await window.evaluate(async (targetPath) => {
		const sessionId = await window.maestro.sessions.getActiveSessionId();
		window.dispatchEvent(
			new CustomEvent('maestro:openFileTab', {
				detail: { sessionId, filePath: targetPath },
			})
		);
	}, filePath);
}

async function navigateBrowser(window: Page, value: string): Promise<void> {
	const address = getVisibleAddressInput(window);
	await address.fill(value);
	await address.press('Enter');
}

async function executeInActiveBrowserPage<T>(window: Page, source: string): Promise<T> {
	return window.evaluate(async (script) => {
		const sessionId = await window.maestro.sessions.getActiveSessionId();
		const tabId = document
			.querySelector('[role="tab"][aria-selected="true"]')
			?.getAttribute('data-tab-id');
		if (!tabId) throw new Error('Active browser tab is not available');
		return (await window.maestro.browserSession.pageAction(
			{ sessionId, tabId },
			{ kind: 'eval', code: script }
		)) as T;
	}, source);
}

function getVisibleAddressInput(window: Page): Locator {
	return window.locator('input[placeholder="Enter a URL or search term"]:visible').first();
}

function getTabByTitle(window: Page, title: string) {
	return window.locator('div[data-tab-id][role="tab"]').filter({ hasText: title }).first();
}

async function selectTab(window: Page, title: string): Promise<void> {
	await getTabByTitle(window, title).evaluate((element) => {
		(element as HTMLElement).click();
	});
}

test.describe('Browser Tab Prototype', () => {
	test('keeps browser, ai, terminal, and file tabs unified across creation, switching, restore, and close', async ({
		appPath,
		testDataDir,
	}) => {
		const server = await createLocalTestServer();
		let firstApp: ElectronApplication | null = null;
		let secondApp: ElectronApplication | null = null;

		try {
			const firstLaunch = await launchApp(appPath, testDataDir);
			firstApp = firstLaunch.app;
			let window = firstLaunch.window;

			await expect(window.getByText('Something went wrong')).toHaveCount(0);

			await createBrowserTab(window);

			await navigateBrowser(window, `127.0.0.1:${LOCAL_TEST_PORT}`);
			await expect(window.locator('body')).toContainText(LOCAL_TEST_TITLE, { timeout: 15000 });
			await expect(getVisibleAddressInput(window)).toHaveValue(
				`http://127.0.0.1:${LOCAL_TEST_PORT}/`
			);
			await expect(getTabByTitle(window, LOCAL_TEST_TITLE)).toBeVisible({ timeout: 15000 });
			await expect
				.poll(
					() =>
						window.locator('[data-maestro-browser-tab] img:visible').evaluate((image) => {
							if (!(image instanceof HTMLImageElement) || !image.naturalWidth) return false;
							const canvas = document.createElement('canvas');
							canvas.width = canvas.height = 1;
							const context = canvas.getContext('2d')!;
							context.drawImage(image, 0, 0);
							const pixel = context.getImageData(0, 0, 1, 1).data;
							return (
								[18, 52, 86].every((value, index) => Math.abs(pixel[index] - value) <= 3) &&
								pixel[3] === 255
							);
						}),
					{ timeout: 15000 }
				)
				.toBe(true);

			await createBrowserTab(window);
			await navigateBrowser(window, `http://127.0.0.1:${LOCAL_TEST_PORT}/second`);
			await expect(getTabByTitle(window, SECOND_TEST_TITLE)).toBeVisible({
				timeout: 20000,
			});
			await selectTab(window, SECOND_TEST_TITLE);
			await expect(getVisibleAddressInput(window)).toHaveValue(
				`http://127.0.0.1:${LOCAL_TEST_PORT}/second`
			);

			await createTerminalTab(window);
			await expect(getTabByTitle(window, 'Terminal 1')).toBeVisible();
			const terminalTabId = await getTabByTitle(window, 'Terminal 1').getAttribute('data-tab-id');

			await openFileTab(window, path.join(process.cwd(), 'ARCHITECTURE.md'));
			await expect(getTabByTitle(window, 'ARCHITECTURE')).toBeVisible({ timeout: 10000 });
			await expect(getVisibleAddressInput(window)).toHaveCount(0);

			await selectTab(window, 'Terminal 1');
			await expect(getVisibleAddressInput(window)).toHaveCount(0);

			await window.getByText('Seed Tab', { exact: true }).click();
			await expect(getVisibleAddressInput(window)).toHaveCount(0);

			await selectTab(window, SECOND_TEST_TITLE);
			await expect(getVisibleAddressInput(window)).toHaveValue(
				`http://127.0.0.1:${LOCAL_TEST_PORT}/second`
			);

			await window.getByTitle(/Reload|Stop/).click({ force: true });
			await expect(getVisibleAddressInput(window)).toHaveValue(
				`http://127.0.0.1:${LOCAL_TEST_PORT}/second`
			);

			await expect
				.poll(
					() =>
						window.evaluate(async (terminalTabId) => {
							const session = (await window.maestro.sessions.getAll()).find(
								(entry) => entry.id === 'browser-test-session'
							);
							return {
								urls: session?.browserTabs?.map((tab) => tab.url),
								terminal: session?.terminalTabs?.some((tab) => tab.id === terminalTabId),
								file: session?.filePreviewTabs?.some((tab) => tab.path.endsWith('ARCHITECTURE.md')),
							};
						}, terminalTabId),
					{ timeout: 10000 }
				)
				.toMatchObject({
					urls: expect.arrayContaining([
						`http://127.0.0.1:${LOCAL_TEST_PORT}/`,
						`http://127.0.0.1:${LOCAL_TEST_PORT}/second`,
					]),
					terminal: true,
					file: true,
				});
			await firstApp.close();
			firstApp = null;

			const secondLaunch = await launchApp(appPath, testDataDir);
			secondApp = secondLaunch.app;
			window = secondLaunch.window;

			await expect(window.getByText('Something went wrong')).toHaveCount(0);
			await expect(getTabByTitle(window, SECOND_TEST_TITLE)).toBeVisible({
				timeout: 15000,
			});
			await expect(getTabByTitle(window, 'ARCHITECTURE')).toBeVisible({ timeout: 15000 });
			await selectTab(window, SECOND_TEST_TITLE);
			await expect(getVisibleAddressInput(window)).toHaveValue(
				`http://127.0.0.1:${LOCAL_TEST_PORT}/second`
			);

			const allTabs = window.locator('div[data-tab-id][role="tab"]');
			const tabCountBeforeClose = await allTabs.count();
			await window.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
			await expect(allTabs).toHaveCount(tabCountBeforeClose - 1);

			await selectTab(window, 'ARCHITECTURE');
			await window.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
			await expect(getTabByTitle(window, 'ARCHITECTURE')).toHaveCount(0);
			await expect(window.getByText('Seed Tab', { exact: true })).toBeVisible();
		} finally {
			server.close();
			if (firstApp) {
				await firstApp.close().catch(() => {});
			}
			if (secondApp) {
				await secondApp.close().catch(() => {});
			}
		}
	});

	test('blocks popup and permission edge cases while preserving browser tab usability', async ({
		appPath,
		testDataDir,
	}) => {
		const server = await createLocalTestServer();
		let app: ElectronApplication | null = null;

		try {
			const launch = await launchApp(appPath, testDataDir);
			app = launch.app;
			const window = launch.window;

			await expect(window.getByText('Something went wrong')).toHaveCount(0);

			await createBrowserTab(window);
			await navigateBrowser(window, `127.0.0.1:${LOCAL_TEST_PORT}`);
			await expect(getTabByTitle(window, LOCAL_TEST_TITLE)).toBeVisible({ timeout: 15000 });

			const windowCount = app.windows().length;
			expect(
				await executeInActiveBrowserPage(
					window,
					'window.open("https://popup.example.com/", "_blank") === null'
				)
			).toBe(true);
			expect(app.windows()).toHaveLength(windowCount);

			const permissionResult = await executeInActiveBrowserPage<string>(
				window,
				`
					(async () => {
						if (!navigator.clipboard?.readText) {
							return 'unsupported';
						}
						try {
							await navigator.clipboard.readText();
							return 'granted';
						} catch (error) {
							return error instanceof Error ? error.name : String(error);
						}
					})()
				`
			);
			expect(['NotAllowedError', 'SecurityError', 'unsupported']).toContain(permissionResult);

			await navigateBrowser(window, 'javascript:alert(1)');
			expect(await executeInActiveBrowserPage(window, 'location.protocol')).toBe('http:');
			await expect(getTabByTitle(window, LOCAL_TEST_TITLE)).toBeVisible();

			await navigateBrowser(window, 'http://127.0.0.1:9/');
			await expect(getVisibleAddressInput(window)).toHaveValue('http://127.0.0.1:9/');
			await expect(window.getByTestId('browser-tab-view')).toBeVisible();
			await expect(window.getByText('Something went wrong')).toHaveCount(0);

			await createTerminalTab(window);
			await selectTab(window, 'Terminal 1');
			await expect(getVisibleAddressInput(window)).toHaveCount(0);
			await selectTab(window, '127.0.0.1:9');
			await expect(getVisibleAddressInput(window)).toHaveValue('http://127.0.0.1:9/');
		} finally {
			server.close();
			if (app) {
				await app.close().catch(() => {});
			}
		}
	});
});
