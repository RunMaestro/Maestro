import http from 'http';
import {
	_electron as electron,
	type ElectronApplication,
	type Locator,
	type Page,
} from '@playwright/test';
import { test, expect } from './fixtures/electron-app';

const LOCAL_TEST_PORT = 7101;
const LOCAL_TEST_TITLE = 'Browser Tab Local Test';
const EXTERNAL_TEST_TITLE = 'Example Domain';

function createLocalTestServer(): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(
				`<!doctype html><html><head><title>${LOCAL_TEST_TITLE}</title></head><body><main>${LOCAL_TEST_TITLE}</main></body></html>`
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
	const app = await electron.launch({
		args: [appPath],
		env: {
			...process.env,
			MAESTRO_DATA_DIR: testDataDir,
			ELECTRON_DISABLE_GPU: '1',
			NODE_ENV: 'test',
			MAESTRO_E2E_TEST: 'true',
		},
		timeout: 30000,
	});

	const window = await app.firstWindow();
	await window.waitForLoadState('domcontentloaded');
	await window.waitForTimeout(1500);

	return { app, window };
}

async function createBrowserTab(window: Page): Promise<void> {
	await window.getByTitle('New tab…').click();
	await window.getByRole('button', { name: /New Browser/ }).click();
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

async function executeInActiveWebview<T>(window: Page, source: string): Promise<T> {
	return window.evaluate(async (script) => {
		const webview = document.querySelector('webview') as
			| (HTMLElement & {
					executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
			  })
			| null;

		if (!webview?.executeJavaScript) {
			throw new Error('Active browser tab webview is not available');
		}

		return (await webview.executeJavaScript(script, true)) as T;
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
			await expect(getTabByTitle(window, 'New Tab')).toBeVisible();

			await navigateBrowser(window, `127.0.0.1:${LOCAL_TEST_PORT}`);
			await expect(window.locator('body')).toContainText(LOCAL_TEST_TITLE, { timeout: 15000 });
			await expect(getVisibleAddressInput(window)).toHaveValue(
				`http://127.0.0.1:${LOCAL_TEST_PORT}/`
			);
			await expect(getTabByTitle(window, LOCAL_TEST_TITLE)).toBeVisible({ timeout: 15000 });

			await createBrowserTab(window);
			await navigateBrowser(window, 'example.com');
			await expect(getTabByTitle(window, EXTERNAL_TEST_TITLE)).toBeVisible({
				timeout: 20000,
			});
			await selectTab(window, EXTERNAL_TEST_TITLE);
			await expect(getVisibleAddressInput(window)).toHaveValue('https://example.com/');

			await createTerminalTab(window);
			await expect(getTabByTitle(window, 'Terminal 1')).toBeVisible();

			await openFileTab(
				window,
				'/Users/jeffscottward/Github/tools/Maestro-worktrees/browser-tab/ARCHITECTURE.md'
			);
			await expect(getTabByTitle(window, 'ARCHITECTURE')).toBeVisible({ timeout: 10000 });
			await expect(getVisibleAddressInput(window)).toHaveCount(0);

			await selectTab(window, 'Terminal 1');
			await expect(getVisibleAddressInput(window)).toHaveCount(0);

			await window.getByText('Seed Tab', { exact: true }).click();
			await expect(getVisibleAddressInput(window)).toHaveCount(0);

			await selectTab(window, EXTERNAL_TEST_TITLE);
			await expect(getVisibleAddressInput(window)).toHaveValue('https://example.com/');

			await window.getByTitle(/Reload|Stop/).click({ force: true });
			await expect(getVisibleAddressInput(window)).toHaveValue('https://example.com/');

			await firstApp.close();
			firstApp = null;

			const secondLaunch = await launchApp(appPath, testDataDir);
			secondApp = secondLaunch.app;
			window = secondLaunch.window;

			await expect(window.getByText('Something went wrong')).toHaveCount(0);
			await expect(getTabByTitle(window, EXTERNAL_TEST_TITLE)).toBeVisible({
				timeout: 15000,
			});
			await expect(getTabByTitle(window, 'Terminal 1')).toBeVisible({ timeout: 15000 });
			await expect(getTabByTitle(window, 'ARCHITECTURE')).toBeVisible({ timeout: 15000 });
			await selectTab(window, EXTERNAL_TEST_TITLE);
			await expect(getVisibleAddressInput(window)).toHaveValue('https://example.com/');

			const allTabs = window.locator('div[data-tab-id][role="tab"]');
			const tabCountBeforeClose = await allTabs.count();
			await window.keyboard.press('Meta+W');
			await expect(allTabs).toHaveCount(tabCountBeforeClose - 1);

			await selectTab(window, 'ARCHITECTURE');
			await window.keyboard.press('Meta+W');
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

			await window.evaluate(() => {
				const shellApi = window.maestro.shell as typeof window.maestro.shell & {
					__openExternalCalls?: string[];
				};
				shellApi.__openExternalCalls = [];
				shellApi.openExternal = async (url: string) => {
					shellApi.__openExternalCalls?.push(url);
				};
			});

			await executeInActiveWebview(window, 'window.open("https://popup.example.com/", "_blank");');
			await window.waitForTimeout(500);
			await expect
				.poll(() =>
					window.evaluate(() =>
						(
							(
								window.maestro.shell as typeof window.maestro.shell & {
									__openExternalCalls?: string[];
								}
							).__openExternalCalls || []
						).slice()
					)
				)
				.toEqual([]);

			const permissionResult = await executeInActiveWebview<string>(
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
			await expect(window.getByRole('alert')).toContainText(
				'Protocol not allowed in browser tabs: javascript:'
			);
			await expect(getVisibleAddressInput(window)).toHaveValue('javascript:alert(1)');
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
