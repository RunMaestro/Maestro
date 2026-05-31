/**
 * E2E Tests: web/mobile bridge coverage.
 *
 * These tests launch Electron with deterministic state, start the embedded web
 * server, and exercise the browser/mobile control surface without remote
 * Cloudflare state.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

type WebWorkbench = ReturnType<typeof createWebMobileWorkbench>;
type WebSessionSummary = {
	id: string;
	name: string;
	usageStats?: {
		inputTokens?: number;
		outputTokens?: number;
		totalCostUsd?: number;
		contextWindow?: number;
	} | null;
	lastResponse?: {
		text: string;
		timestamp: number;
		source: string;
		fullLength: number;
	} | null;
	aiTabs?: Array<{
		id: string;
		name: string | null;
		starred: boolean;
		usageStats?: {
			inputTokens?: number;
			outputTokens?: number;
			totalCostUsd?: number;
			contextWindow?: number;
		} | null;
		logs?: unknown;
	}>;
};
type SeededHistoryEntry = {
	id: string;
	type: 'AUTO' | 'USER';
	timestamp: number;
	summary: string;
	fullResponse: string;
	agentSessionId: string;
	sessionName: string;
	projectPath: string;
	sessionId: string;
	contextUsage?: number;
	usageStats?: {
		inputTokens?: number;
		outputTokens?: number;
		totalCostUsd?: number;
		contextWindow?: number;
	};
	success?: boolean;
	elapsedTimeMs?: number;
	validated?: boolean;
};
type LiveServerResult = { success: boolean; url: string };
type LiveToggleResult = { live: boolean; url: string };
type LiveStatusResult = { live: boolean; url: string | null };
type LiveDisableResult = { success: boolean; count: number };
type LiveSessionSummary = { sessionId: string };
type StoredSession = ReturnType<typeof createSeededSession>;
type E2ESocketMessage = {
	type: string;
	message?: string;
	sessionId?: string;
	agentSessionId?: string;
	command?: string;
	inputMode?: string;
	theme?: { id?: string };
	enabled?: boolean;
	commands?: Array<{ command?: string }>;
	session?: { id?: string };
	sessions?: Array<{ id?: string; name?: string; state?: string; inputMode?: string }>;
};
type E2ESocketWindow = Window & {
	__maestroE2eSocketMessages?: E2ESocketMessage[];
	__maestroE2eSocketMessagesByName?: Record<string, E2ESocketMessage[]>;
	__maestroE2eSocket?: WebSocket;
	__maestroE2eSockets?: Record<string, WebSocket>;
};
type MaestroE2EWindow = Window & {
	maestro: {
		web: {
			broadcastUserInput: (
				sessionId: string,
				command: string,
				inputMode: 'ai' | 'terminal'
			) => Promise<boolean>;
			broadcastAutoRunState: (
				sessionId: string,
				state: {
					isRunning: boolean;
					totalTasks: number;
					completedTasks: number;
					currentTaskIndex: number;
					isStopping?: boolean;
					totalDocuments?: number;
					currentDocumentIndex?: number;
					totalTasksAcrossAllDocs?: number;
					completedTasksAcrossAllDocs?: number;
				} | null
			) => Promise<boolean>;
			broadcastTabsChange: (
				sessionId: string,
				aiTabs: Array<{
					id: string;
					agentSessionId: string | null;
					name: string | null;
					starred: boolean;
					inputValue: string;
					usageStats?: Record<string, unknown> | null;
					createdAt: number;
					state: 'idle' | 'busy';
					thinkingStartTime?: number | null;
				}>,
				activeTabId: string
			) => Promise<boolean>;
			broadcastSessionState: (
				sessionId: string,
				state: string,
				additionalData?: {
					name?: string;
					toolType?: string;
					inputMode?: string;
					cwd?: string;
				}
			) => Promise<boolean>;
		};
		live: {
			startServer: () => Promise<LiveServerResult>;
			stopServer: () => Promise<void>;
			toggle: (sessionId: string, agentSessionId: string) => Promise<LiveToggleResult>;
			getStatus: (sessionId: string) => Promise<LiveStatusResult>;
			getDashboardUrl: () => Promise<string | null>;
			getLiveSessions: () => Promise<LiveSessionSummary[]>;
			disableAll: () => Promise<LiveDisableResult>;
			persistCurrentToken: () => Promise<{ success: boolean; message?: string }>;
			clearPersistentToken: () => Promise<{ success: boolean; message?: string }>;
			broadcastActiveSession: (sessionId: string) => Promise<void>;
		};
		settings: {
			set: (key: string, value: unknown) => Promise<boolean>;
		};
		sessions: {
			getAll: () => Promise<StoredSession[]>;
			setAll: (sessions: StoredSession[]) => Promise<boolean>;
		};
		webserver: {
			getConnectedClients: () => Promise<number>;
		};
	};
	__maestroE2eOnlineState?: { value: boolean };
};

function createSeededSession({
	id,
	name,
	projectDir,
	createdAt,
	inputMode = 'ai',
	state = 'idle',
	groupId,
	bookmarked = false,
}: {
	id: string;
	name: string;
	projectDir: string;
	createdAt: number;
	inputMode?: 'ai' | 'terminal';
	state?: 'idle' | 'busy';
	groupId?: string;
	bookmarked?: boolean;
}) {
	const planTabId = `${id}-plan-tab`;
	const reviewTabId = `${id}-review-tab`;

	return {
		id,
		name,
		toolType: 'codex',
		state,
		cwd: projectDir,
		fullPath: projectDir,
		projectRoot: projectDir,
		groupId,
		createdAt,
		aiLogs: [],
		shellLogs: [
			{
				id: `${id}-shell-log`,
				timestamp: createdAt + 5,
				source: 'stdout',
				text: `${name} shell output for mobile bridge coverage.`,
			},
		],
		workLog: [],
		contextUsage: 0,
		inputMode,
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
		usageStats: {
			inputTokens: 1200,
			outputTokens: 800,
			totalCostUsd: 0.042,
			contextWindow: 8000,
		},
		agentSessionId: `${id}-agent-session`,
		thinkingStartTime: state === 'busy' ? createdAt : null,
		aiTabs: [
			{
				id: planTabId,
				agentSessionId: `${id}-agent-plan`,
				name: 'Plan',
				starred: true,
				logs: [
					{
						id: `${id}-user-plan`,
						timestamp: createdAt + 1,
						source: 'user',
						text: `${name} user prompt for plan tab.`,
					},
					{
						id: `${id}-thinking-plan`,
						timestamp: createdAt + 2,
						source: 'thinking',
						text: 'Hidden thinking should not reach the mobile web detail endpoint.',
					},
					{
						id: `${id}-tool-plan`,
						timestamp: createdAt + 3,
						source: 'tool',
						text: 'Hidden tool output should not reach the mobile web detail endpoint.',
					},
					{
						id: `${id}-stdout-plan`,
						timestamp: createdAt + 4,
						source: 'stdout',
						text: `${name} alpha response line one.\n${name} alpha response line two.`,
					},
				],
				inputValue: '',
				stagedImages: [],
				createdAt,
				state,
				usageStats: {
					inputTokens: 400,
					outputTokens: 250,
					totalCostUsd: 0.012,
					contextWindow: 8000,
				},
				thinkingStartTime: state === 'busy' ? createdAt : null,
			},
			{
				id: reviewTabId,
				agentSessionId: `${id}-agent-review`,
				name: 'Review',
				starred: false,
				logs: [
					{
						id: `${id}-stdout-review`,
						timestamp: createdAt + 6,
						source: 'stdout',
						text: `${name} review tab response only visible after tab selection.`,
					},
				],
				inputValue: '',
				stagedImages: [],
				createdAt: createdAt + 1,
				state: 'idle',
				usageStats: null,
				thinkingStartTime: null,
			},
		],
		activeTabId: planTabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [
			{ type: 'ai', id: planTabId },
			{ type: 'ai', id: reviewTabId },
		],
		unifiedClosedTabHistory: [],
		bookmarked,
	};
}

function createWebMobileWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-web-mobile-'));
	const projectDir = path.join(homeDir, 'project');
	const projectDirTwo = path.join(homeDir, 'project-two');
	const now = Date.now();
	const primarySessionId = `web-mobile-primary-${now}`;
	const secondarySessionId = `web-mobile-secondary-${now}`;
	const busySessionId = `web-mobile-busy-${now}`;
	const groupId = `mobile-group-${now}`;

	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(projectDirTwo, { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'README.md'), '# Mobile Bridge E2E\n', 'utf-8');

	return {
		homeDir,
		projectDir,
		primarySessionId,
		secondarySessionId,
		busySessionId,
		primaryPlanTabId: `${primarySessionId}-plan-tab`,
		primaryReviewTabId: `${primarySessionId}-review-tab`,
		sessions: [
			createSeededSession({
				id: primarySessionId,
				name: 'Mobile Primary',
				projectDir,
				createdAt: now,
				groupId,
				bookmarked: true,
			}),
			createSeededSession({
				id: secondarySessionId,
				name: 'Mobile Secondary',
				projectDir: projectDirTwo,
				createdAt: now + 10,
				inputMode: 'terminal',
			}),
			createSeededSession({
				id: busySessionId,
				name: 'Mobile Busy Agent',
				projectDir,
				createdAt: now + 20,
				state: 'busy',
			}),
		],
		groups: [
			{
				id: groupId,
				name: 'Mobile Ops',
				emoji: 'M',
				collapsed: false,
				order: 1,
				createdAt: now,
				updatedAt: now,
			},
		],
		settings: {
			activeThemeId: 'dracula',
			bionifyReadingMode: true,
			customAICommands: [
				{
					id: `web-mobile-command-${now}`,
					command: '/ship',
					description: 'Ship summary',
					prompt: 'Summarize the release state.',
				},
			],
		},
		historyEntries: [
			{
				id: `web-mobile-history-auto-${now}`,
				type: 'AUTO' as const,
				timestamp: now + 300,
				summary: 'Auto Run finished the mobile bridge checklist',
				fullResponse: 'Auto Run detailed mobile bridge release notes and validation output.',
				agentSessionId: `${primarySessionId}-agent-plan`,
				sessionName: 'Mobile Primary',
				projectPath: projectDir,
				sessionId: primarySessionId,
				contextUsage: 42,
				usageStats: {
					inputTokens: 2100,
					outputTokens: 950,
					totalCostUsd: 0.12,
					contextWindow: 16000,
				},
				success: true,
				elapsedTimeMs: 125000,
				validated: true,
			},
			{
				id: `web-mobile-history-user-${now}`,
				type: 'USER' as const,
				timestamp: now + 200,
				summary: 'User requested a mobile bridge release summary',
				fullResponse: 'User-facing mobile bridge release summary with follow-up context.',
				agentSessionId: `${primarySessionId}-agent-review`,
				sessionName: 'Mobile Primary',
				projectPath: projectDir,
				sessionId: primarySessionId,
				contextUsage: 21,
				usageStats: {
					inputTokens: 800,
					outputTokens: 320,
					totalCostUsd: 0.04,
					contextWindow: 8000,
				},
				success: true,
				elapsedTimeMs: 45000,
				validated: false,
			},
		],
	};
}

function toLoopbackUrl(value: string): string {
	const url = new URL(value);
	url.hostname = '127.0.0.1';
	return url.toString().replace(/\/$/, '');
}

function webSocketUrl(dashboardUrl: string, sessionId?: string): string {
	const url = new URL(dashboardUrl);
	url.protocol = 'ws:';
	url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
	if (sessionId) {
		url.searchParams.set('sessionId', sessionId);
	}
	return url.toString();
}

async function launchWebWorkbench(workbench: WebWorkbench) {
	const launched = await helpers.launchAppWithState({
		homeDir: workbench.homeDir,
		sessions: workbench.sessions,
		groups: workbench.groups,
		settings: workbench.settings,
	});
	seedHistory(
		launched.userDataPath,
		workbench.primarySessionId,
		workbench.projectDir,
		workbench.historyEntries
	);
	return launched;
}

function seedHistory(
	userDataPath: string,
	sessionId: string,
	projectPath: string,
	entries: SeededHistoryEntry[]
) {
	const historyDir = path.join(userDataPath, 'history');
	fs.mkdirSync(historyDir, { recursive: true });
	fs.writeFileSync(
		path.join(historyDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`),
		JSON.stringify({ version: 1, sessionId, projectPath, entries }, null, '\t'),
		'utf-8'
	);
}

async function startWebServer(appWindow: Page): Promise<string> {
	const result = await appWindow.evaluate(async () => {
		return (window as MaestroE2EWindow).maestro.live.startServer();
	});
	expect(result).toMatchObject({ success: true });
	expect(result.url).toMatch(/^http:\/\//);
	return toLoopbackUrl(result.url);
}

async function stopWebServer(appWindow: Page) {
	await appWindow.evaluate(async () => {
		await (window as MaestroE2EWindow).maestro.live.stopServer();
	});
}

async function toggleLive(appWindow: Page, sessionId: string): Promise<string> {
	const result = await appWindow.evaluate(async (id) => {
		return (window as MaestroE2EWindow).maestro.live.toggle(id, `${id}-agent-session`);
	}, sessionId);
	expect(result).toMatchObject({ live: true });
	return toLoopbackUrl(result.url);
}

async function getJson(page: Page, url: string) {
	const response = await page.request.get(url);
	expect(response.ok()).toBe(true);
	return response.json();
}

async function reloadAndExpectMobileHeading(page: Page, headingName: string) {
	await page.reload();
	const heading = page.getByRole('heading', { name: headingName });
	const retryButton = page.getByRole('button', { name: 'Retry Now' });
	let retryClicks = 0;
	await expect
		.poll(
			async () => {
				if (await heading.isVisible().catch(() => false)) {
					return true;
				}
				if (retryClicks < 3 && (await retryButton.isVisible().catch(() => false))) {
					retryClicks += 1;
					await retryButton.click().catch(() => {});
				}
				return await heading.isVisible().catch(() => false);
			},
			{ timeout: 30000, intervals: [250, 500, 1000] }
		)
		.toBe(true);
}

async function reconnectMobileIfNeeded(page: Page) {
	const retryButton = page.getByRole('button', { name: 'Retry Now' });
	if (await retryButton.isVisible().catch(() => false)) {
		await retryButton.click();
		await expect(page.getByText('Connection Lost')).toBeHidden({ timeout: 15000 });
	}
}

async function setMobileOnlineState(page: Page, isOnline: boolean) {
	await page.evaluate((online) => {
		const e2eWindow = window as MaestroE2EWindow;
		const onlineState = e2eWindow.__maestroE2eOnlineState || { value: online };
		onlineState.value = online;
		e2eWindow.__maestroE2eOnlineState = onlineState;
		Object.defineProperty(window.navigator, 'onLine', {
			configurable: true,
			get: () => onlineState.value,
		});
		window.dispatchEvent(new Event(online ? 'online' : 'offline'));
	}, isOnline);
}

async function getOfflineQueueLength(page: Page): Promise<number> {
	return page.evaluate(() => {
		const stored = window.localStorage.getItem('maestro-offline-queue');
		return stored ? JSON.parse(stored).length : 0;
	});
}

async function waitForWebSocketMessages(
	page: Page,
	url: string,
	actions: Array<Record<string, unknown>>,
	expectedTypes: string[]
) {
	return page.evaluate(
		async ({ socketUrl, queuedActions, types }) => {
			return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
				const messages: Array<Record<string, unknown>> = [];
				const socket = new WebSocket(socketUrl);
				const timeout = window.setTimeout(() => {
					socket.close();
					reject(new Error(`Timed out waiting for ${types.join(', ')}`));
				}, 10000);

				const maybeDone = () => {
					if (types.every((type) => messages.some((message) => message.type === type))) {
						window.clearTimeout(timeout);
						socket.close();
						resolve(messages);
					}
				};

				socket.addEventListener('open', () => {
					for (const action of queuedActions) {
						socket.send(JSON.stringify(action));
					}
				});
				socket.addEventListener('message', (event) => {
					messages.push(JSON.parse(event.data) as Record<string, unknown>);
					maybeDone();
				});
				socket.addEventListener('error', () => {
					window.clearTimeout(timeout);
					reject(new Error('WebSocket connection failed'));
				});
			});
		},
		{ socketUrl: url, queuedActions: actions, types: expectedTypes }
	);
}

test.describe('Web Mobile Bridge', () => {
	test('starts the embedded web server and exposes token-scoped session APIs', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);

			expect(sessionsPayload.count).toBe(3);
			expect(sessionsPayload.sessions[0]).toMatchObject({
				id: workbench.primarySessionId,
				name: 'Mobile Primary',
				groupName: 'Mobile Ops',
				groupEmoji: 'M',
				isLive: false,
				bookmarked: true,
			});

			const liveUrl = await toggleLive(appWindow, workbench.primarySessionId);
			expect(liveUrl).toContain(`/session/${workbench.primarySessionId}`);

			const liveSessions = await appWindow.evaluate(async () => {
				return (window as MaestroE2EWindow).maestro.live.getLiveSessions();
			});
			expect(liveSessions).toEqual(
				expect.arrayContaining([expect.objectContaining({ sessionId: workbench.primarySessionId })])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves tokenized PWA shell, manifest, service worker, and built assets', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const tokenPath = new URL(dashboardUrl).pathname.replace(/\/$/, '');
			const shellResponse = await page.request.get(dashboardUrl);
			expect(shellResponse.ok()).toBe(true);
			const shellHtml = await shellResponse.text();
			expect(shellHtml).toContain(`${tokenPath}/manifest.json`);
			expect(shellHtml).toContain(`${tokenPath}/assets/`);

			const manifestResponse = await page.request.get(`${dashboardUrl}/manifest.json`);
			expect(manifestResponse.ok()).toBe(true);
			expect(manifestResponse.headers()['content-type']).toContain('application/json');
			await expect(manifestResponse.json()).resolves.toMatchObject({
				name: expect.stringContaining('Maestro'),
			});

			const serviceWorkerResponse = await page.request.get(`${dashboardUrl}/sw.js`);
			expect(serviceWorkerResponse.ok()).toBe(true);
			expect(serviceWorkerResponse.headers()['content-type']).toContain('javascript');
			expect(await serviceWorkerResponse.text()).toContain('Maestro');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves health and redirects untokened or invalid-token routes', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const origin = new URL(dashboardUrl).origin;

			const healthResponse = await page.request.get(`${origin}/health`);
			expect(healthResponse.ok()).toBe(true);
			await expect(healthResponse.json()).resolves.toMatchObject({ status: 'ok' });

			const rootResponse = await page.request.get(`${origin}/`, { maxRedirects: 0 });
			expect(rootResponse.status()).toBe(302);
			expect(rootResponse.headers().location).toContain('runmaestro.ai');

			const invalidTokenResponse = await page.request.get(`${origin}/not-the-mobile-token`, {
				maxRedirects: 0,
			});
			expect(invalidTokenResponse.status()).toBe(302);
			expect(invalidTokenResponse.headers().location).toContain('runmaestro.ai');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('injects tokenized deep-link config and sanitizes unsafe tab ids', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const validDeepLink = await page.request.get(
				`${dashboardUrl}/session/${workbench.primarySessionId}?tabId=${workbench.primaryReviewTabId}`
			);
			expect(validDeepLink.ok()).toBe(true);
			const validHtml = await validDeepLink.text();
			expect(validHtml).toContain(`sessionId: "${workbench.primarySessionId}"`);
			expect(validHtml).toContain(`tabId: "${workbench.primaryReviewTabId}"`);
			expect(validHtml).toContain('apiBase:');
			expect(validHtml).toContain('wsUrl:');

			const unsafeDeepLink = await page.request.get(
				`${dashboardUrl}/session/${workbench.primarySessionId}?tabId=${encodeURIComponent(`${workbench.primaryReviewTabId}<script>alert(1)</script>`)}`
			);
			expect(unsafeDeepLink.ok()).toBe(true);
			const unsafeHtml = await unsafeDeepLink.text();
			expect(unsafeHtml).toContain(`sessionId: "${workbench.primarySessionId}"`);
			expect(unsafeHtml).toContain('tabId: null');
			expect(unsafeHtml).not.toContain('<script>alert(1)</script>');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves trailing token routes and sanitizes unsafe mobile session ids', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const trailingDashboard = await page.request.get(`${dashboardUrl}/`);
			expect(trailingDashboard.ok()).toBe(true);
			expect(await trailingDashboard.text()).toContain(
				`apiBase: "${new URL(dashboardUrl).pathname.replace(/\/$/, '')}/api"`
			);

			const safeSession = await page.request.get(
				`${dashboardUrl}/session/${workbench.primarySessionId}`
			);
			expect(safeSession.ok()).toBe(true);
			expect(await safeSession.text()).toContain(`sessionId: "${workbench.primarySessionId}"`);

			const unsafeSession = await page.request.get(
				`${dashboardUrl}/session/${encodeURIComponent('bad<script>alert(1)')}`
			);
			expect(unsafeSession.ok()).toBe(true);
			const unsafeHtml = await unsafeSession.text();
			expect(unsafeHtml).toContain('sessionId: null');
			expect(unsafeHtml).not.toContain('bad<script>alert(1)');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('exposes web-safe session summaries with response previews and tab metadata', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			) as WebSessionSummary | undefined;

			expect(primary).toBeDefined();
			expect(primary?.usageStats).toMatchObject({
				inputTokens: 1200,
				outputTokens: 800,
				totalCostUsd: 0.042,
				contextWindow: 8000,
			});
			expect(primary?.lastResponse).toMatchObject({
				source: 'stdout',
				fullLength: expect.any(Number),
			});
			expect(primary?.lastResponse?.text).toContain('Mobile Primary alpha response line one');
			expect(primary?.aiTabs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: workbench.primaryPlanTabId,
						name: 'Plan',
						starred: true,
						usageStats: expect.objectContaining({ inputTokens: 400, outputTokens: 250 }),
					}),
					expect.objectContaining({
						id: workbench.primaryReviewTabId,
						name: 'Review',
						starred: false,
					}),
				])
			);
			expect(primary?.aiTabs?.[0]).not.toHaveProperty('logs');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns tab-specific mobile details without thinking or tool transcript rows', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}?tabId=${workbench.primaryPlanTabId}`
			);
			const logText = detail.session.aiLogs.map((entry: { text: string }) => entry.text).join('\n');

			expect(logText).toContain('Mobile Primary alpha response line one');
			expect(logText).toContain('Mobile Primary user prompt for plan tab.');
			expect(logText).not.toContain('Hidden thinking');
			expect(logText).not.toContain('Hidden tool output');

			const reviewDetail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}?tabId=${workbench.primaryReviewTabId}`
			);
			expect(reviewDetail.session.aiLogs).toHaveLength(1);
			expect(reviewDetail.session.aiLogs[0].text).toContain('review tab response only');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('performs WebSocket initial sync, subscribe, ping, and sessions refresh', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl, workbench.primarySessionId),
				[
					{ type: 'subscribe', sessionId: workbench.primarySessionId },
					{ type: 'ping' },
					{ type: 'get_sessions' },
				],
				[
					'connected',
					'sessions_list',
					'theme',
					'bionify_reading_mode',
					'custom_commands',
					'subscribed',
					'pong',
				]
			);

			const connected = messages.find((message) => message.type === 'connected');
			const sessionsList = messages.find((message) => message.type === 'sessions_list');
			const customCommands = messages.find((message) => message.type === 'custom_commands');
			const readingMode = messages.find((message) => message.type === 'bionify_reading_mode');

			expect(connected).toMatchObject({ subscribedSessionId: workbench.primarySessionId });
			expect(sessionsList?.sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: workbench.primarySessionId, isLive: true }),
				])
			);
			expect(customCommands?.commands).toEqual(
				expect.arrayContaining([expect.objectContaining({ command: '/ship' })])
			);
			expect(readingMode).toMatchObject({ enabled: true });
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('broadcasts mobile live and offline toggles over WebSocket', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate((socketUrl) => {
				const e2eWindow = window as E2ESocketWindow;
				e2eWindow.__maestroE2eSocketMessages = [];
				e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
				e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
					e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
				};
			}, webSocketUrl(dashboardUrl));

			await expect
				.poll(async () =>
					page.evaluate(() =>
						(window as E2ESocketWindow).__maestroE2eSocketMessages?.some(
							(message) => message.type === 'connected'
						)
					)
				)
				.toBe(true);

			await appWindow.evaluate(async (sessionId) => {
				return (window as MaestroE2EWindow).maestro.live.toggle(
					sessionId,
					`${sessionId}-agent-session`
				);
			}, workbench.primarySessionId);
			await expect
				.poll(async () =>
					page.evaluate((sessionId) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.some(
							(message) =>
								message.type === 'session_live' &&
								message.sessionId === sessionId &&
								message.agentSessionId === `${sessionId}-agent-session`
						);
					}, workbench.primarySessionId)
				)
				.toBe(true);

			const offlineResult = await appWindow.evaluate(async (sessionId) => {
				return (window as MaestroE2EWindow).maestro.live.toggle(
					sessionId,
					`${sessionId}-agent-session`
				);
			}, workbench.primarySessionId);
			expect(offlineResult).toMatchObject({ live: false, url: null });
			await expect
				.poll(async () =>
					page.evaluate((sessionId) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.some(
							(message) => message.type === 'session_offline' && message.sessionId === sessionId
						);
					}, workbench.primarySessionId)
				)
				.toBe(true);
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('broadcasts desktop setting changes to mobile clients and slash commands', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate((socketUrl) => {
				const e2eWindow = window as E2ESocketWindow;
				e2eWindow.__maestroE2eSocketMessages = [];
				e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
				e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
					e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
				};
			}, webSocketUrl(dashboardUrl));

			await expect
				.poll(async () =>
					page.evaluate(() =>
						(window as E2ESocketWindow).__maestroE2eSocketMessages?.some(
							(message) => message.type === 'connected'
						)
					)
				)
				.toBe(true);

			await appWindow.evaluate(async () => {
				const maestro = (window as MaestroE2EWindow).maestro;
				await maestro.settings.set('activeThemeId', 'github-light');
				await maestro.settings.set('bionifyReadingMode', false);
				await maestro.settings.set('customAICommands', [
					{
						id: 'mobile-broadcast-command',
						command: '/audit',
						description: 'Audit mobile bridge',
						prompt: 'Audit the mobile web bridge.',
					},
				]);
			});

			await expect
				.poll(async () =>
					page.evaluate(() => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return {
							theme: messages.some(
								(message) => message.type === 'theme' && message.theme?.id === 'github-light'
							),
							bionify: messages.some(
								(message) => message.type === 'bionify_reading_mode' && message.enabled === false
							),
							command: messages.some(
								(message) =>
									message.type === 'custom_commands' &&
									message.commands?.some((command) => command.command === '/audit')
							),
						};
					})
				)
				.toEqual({ theme: true, bionify: true, command: true });
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('scopes mobile user-input broadcasts to subscribed WebSocket clients', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate(
				({ dashboardSocketUrl, primarySocketUrl }) => {
					const e2eWindow = window as E2ESocketWindow;
					e2eWindow.__maestroE2eSocketMessagesByName = { dashboard: [], primary: [] };
					e2eWindow.__maestroE2eSockets = {
						dashboard: new WebSocket(dashboardSocketUrl),
						primary: new WebSocket(primarySocketUrl),
					};
					for (const [name, socket] of Object.entries(e2eWindow.__maestroE2eSockets)) {
						socket.onmessage = (event: MessageEvent) => {
							e2eWindow.__maestroE2eSocketMessagesByName?.[name]?.push(JSON.parse(event.data));
						};
					}
				},
				{
					dashboardSocketUrl: webSocketUrl(dashboardUrl),
					primarySocketUrl: webSocketUrl(dashboardUrl, workbench.primarySessionId),
				}
			);

			await expect
				.poll(async () =>
					page.evaluate(() => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessagesByName || {};
						return {
							dashboard: messages.dashboard?.some((message) => message.type === 'connected'),
							primary: messages.primary?.some((message) => message.type === 'connected'),
						};
					})
				)
				.toEqual({ dashboard: true, primary: true });

			await appWindow.evaluate(
				async ({ primarySessionId, secondarySessionId }) => {
					const maestro = (window as MaestroE2EWindow).maestro;
					await maestro.web.broadcastUserInput(
						secondarySessionId,
						'Secondary scoped broadcast',
						'terminal'
					);
					await maestro.web.broadcastUserInput(primarySessionId, 'Primary scoped broadcast', 'ai');
				},
				{
					primarySessionId: workbench.primarySessionId,
					secondarySessionId: workbench.secondarySessionId,
				}
			);

			await expect
				.poll(async () =>
					page.evaluate(
						({ primarySessionId, secondarySessionId }) => {
							const messages = (window as E2ESocketWindow).__maestroE2eSocketMessagesByName || {};
							const dashboard = messages.dashboard || [];
							const primary = messages.primary || [];
							return {
								dashboardSecondary: dashboard.some(
									(message) =>
										message.type === 'user_input' &&
										message.sessionId === secondarySessionId &&
										message.command === 'Secondary scoped broadcast'
								),
								dashboardPrimary: dashboard.some(
									(message) =>
										message.type === 'user_input' &&
										message.sessionId === primarySessionId &&
										message.command === 'Primary scoped broadcast'
								),
								primarySecondary: primary.some(
									(message) =>
										message.type === 'user_input' &&
										message.sessionId === secondarySessionId &&
										message.command === 'Secondary scoped broadcast'
								),
								primaryPrimary: primary.some(
									(message) =>
										message.type === 'user_input' &&
										message.sessionId === primarySessionId &&
										message.command === 'Primary scoped broadcast'
								),
							};
						},
						{
							primarySessionId: workbench.primarySessionId,
							secondarySessionId: workbench.secondarySessionId,
						}
					)
				)
				.toEqual({
					dashboardSecondary: true,
					dashboardPrimary: true,
					primarySecondary: false,
					primaryPrimary: true,
				});
		} finally {
			await page
				.evaluate(() => {
					const sockets = (window as E2ESocketWindow).__maestroE2eSockets || {};
					Object.values(sockets).forEach((socket) => socket.close());
				})
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('routes WebSocket command, mode, selection, and busy rejection messages', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[
					{
						type: 'send_command',
						sessionId: workbench.primarySessionId,
						command: 'Mobile bridge command dispatch',
						inputMode: 'ai',
					},
					{ type: 'switch_mode', sessionId: workbench.primarySessionId, mode: 'terminal' },
					{ type: 'select_session', sessionId: workbench.secondarySessionId },
					{
						type: 'select_tab',
						sessionId: workbench.primarySessionId,
						tabId: workbench.primaryReviewTabId,
					},
					{
						type: 'send_command',
						sessionId: workbench.busySessionId,
						command: 'This should be rejected while busy',
						inputMode: 'ai',
					},
				],
				[
					'connected',
					'command_result',
					'mode_switch_result',
					'select_session_result',
					'select_tab_result',
					'error',
				]
			);

			expect(messages.find((message) => message.type === 'command_result')).toMatchObject({
				success: true,
				sessionId: workbench.primarySessionId,
			});
			expect(messages.find((message) => message.type === 'mode_switch_result')).toMatchObject({
				success: true,
				mode: 'terminal',
			});
			expect(messages.find((message) => message.type === 'select_session_result')).toMatchObject({
				success: true,
				sessionId: workbench.secondarySessionId,
			});
			expect(messages.find((message) => message.type === 'select_tab_result')).toMatchObject({
				success: true,
				tabId: workbench.primaryReviewTabId,
			});
			expect(messages.find((message) => message.type === 'error')).toMatchObject({
				message: 'Session is busy - please wait for the current operation to complete',
				sessionId: workbench.busySessionId,
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('routes WebSocket tab lifecycle, bookmark, and unknown messages', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[
					{ type: 'new_tab', sessionId: workbench.primarySessionId },
					{
						type: 'rename_tab',
						sessionId: workbench.primarySessionId,
						tabId: workbench.primaryReviewTabId,
						newName: 'Mobile Renamed Review',
					},
					{
						type: 'star_tab',
						sessionId: workbench.primarySessionId,
						tabId: workbench.primaryReviewTabId,
						starred: true,
					},
					{ type: 'reorder_tab', sessionId: workbench.primarySessionId, fromIndex: 1, toIndex: 0 },
					{
						type: 'close_tab',
						sessionId: workbench.primarySessionId,
						tabId: workbench.primaryReviewTabId,
					},
					{ type: 'toggle_bookmark', sessionId: workbench.secondarySessionId },
					{ type: 'mobile_e2e_unknown_message', payload: 'echo me' },
				],
				[
					'connected',
					'new_tab_result',
					'rename_tab_result',
					'star_tab_result',
					'reorder_tab_result',
					'close_tab_result',
					'toggle_bookmark_result',
					'echo',
				]
			);

			expect(messages.find((message) => message.type === 'new_tab_result')).toMatchObject({
				success: true,
				sessionId: workbench.primarySessionId,
			});
			expect(messages.find((message) => message.type === 'rename_tab_result')).toMatchObject({
				success: true,
				tabId: workbench.primaryReviewTabId,
				newName: 'Mobile Renamed Review',
			});
			expect(messages.find((message) => message.type === 'star_tab_result')).toMatchObject({
				success: true,
				tabId: workbench.primaryReviewTabId,
				starred: true,
			});
			expect(messages.find((message) => message.type === 'reorder_tab_result')).toMatchObject({
				success: true,
				fromIndex: 1,
				toIndex: 0,
			});
			expect(messages.find((message) => message.type === 'close_tab_result')).toMatchObject({
				success: true,
				tabId: workbench.primaryReviewTabId,
			});
			expect(messages.find((message) => message.type === 'toggle_bookmark_result')).toMatchObject({
				success: true,
				sessionId: workbench.secondarySessionId,
			});
			expect(messages.find((message) => message.type === 'echo')).toMatchObject({
				originalType: 'mobile_e2e_unknown_message',
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('manages live status, persistent token, and disable-all lifecycle', async () => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const initialStatus = await appWindow.evaluate(async (sessionId) => {
				return (window as MaestroE2EWindow).maestro.live.getStatus(sessionId);
			}, workbench.primarySessionId);
			expect(initialStatus).toMatchObject({ live: false, url: null });

			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			const liveStatus = await appWindow.evaluate(async (sessionId) => {
				return (window as MaestroE2EWindow).maestro.live.getStatus(sessionId);
			}, workbench.primarySessionId);
			expect(liveStatus.live).toBe(true);
			expect(toLoopbackUrl(liveStatus.url!)).toBe(sessionUrl);

			const dashboardStatusUrl = await appWindow.evaluate(async () => {
				return (window as MaestroE2EWindow).maestro.live.getDashboardUrl();
			});
			expect(toLoopbackUrl(dashboardStatusUrl!)).toBe(dashboardUrl);

			await expect(
				appWindow.evaluate(async () => {
					return (window as MaestroE2EWindow).maestro.live.persistCurrentToken();
				})
			).resolves.toMatchObject({ success: true });
			await expect(
				appWindow.evaluate(async () => {
					return (window as MaestroE2EWindow).maestro.live.clearPersistentToken();
				})
			).resolves.toMatchObject({ success: true });

			const disabled = await appWindow.evaluate(async () => {
				return (window as MaestroE2EWindow).maestro.live.disableAll();
			});
			expect(disabled).toMatchObject({ success: true, count: 1 });
			const finalStatus = await appWindow.evaluate(async (sessionId) => {
				return (window as MaestroE2EWindow).maestro.live.getStatus(sessionId);
			}, workbench.primarySessionId);
			expect(finalStatus).toMatchObject({ live: false, url: null });
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves theme data and session-detail errors through token APIs', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const themePayload = await getJson(page, `${dashboardUrl}/api/theme`);
			expect(themePayload.theme).toEqual(expect.objectContaining({ id: 'dracula' }));

			const missingSessionResponse = await page.request.get(
				`${dashboardUrl}/api/session/mobile-missing-session`
			);
			expect(missingSessionResponse.status()).toBe(404);
			await expect(missingSessionResponse.json()).resolves.toMatchObject({
				error: 'Not Found',
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves seeded mobile history through session and project token APIs', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionHistory = await getJson(
				page,
				`${dashboardUrl}/api/history?sessionId=${workbench.primarySessionId}`
			);
			expect(sessionHistory.count).toBe(2);
			expect(sessionHistory.entries[0]).toMatchObject({
				type: 'AUTO',
				summary: 'Auto Run finished the mobile bridge checklist',
				sessionId: workbench.primarySessionId,
			});

			const projectHistory = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(workbench.projectDir)}`
			);
			expect(projectHistory.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ summary: 'User requested a mobile bridge release summary' }),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns direct token API send failure without a running process and rejects non-string payloads', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sendResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`,
				{ data: { command: 'Mobile direct API command' } }
			);
			expect(sendResponse.status()).toBe(500);
			await expect(sendResponse.json()).resolves.toMatchObject({
				error: 'Internal Server Error',
				message: 'Failed to send command to session',
			});

			const badPayloadResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`,
				{ data: { command: 42 } }
			);
			expect(badPayloadResponse.status()).toBe(400);
			await expect(badPayloadResponse.json()).resolves.toMatchObject({
				error: 'Bad Request',
				message: 'Command is required and must be a string',
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('handles token API interrupt and error responses', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const interruptResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.primarySessionId}/interrupt`
			);
			expect(interruptResponse.ok()).toBe(true);
			expect(await interruptResponse.json()).toMatchObject({
				success: true,
				sessionId: workbench.primarySessionId,
			});

			const badCommandResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`,
				{ data: { command: '' } }
			);
			expect(badCommandResponse.status()).toBe(400);
			expect(await badCommandResponse.json()).toMatchObject({
				error: 'Bad Request',
				message: 'Command is required and must be a string',
			});

			const missingSessionResponse = await page.request.get(
				`${dashboardUrl}/api/session/not-a-real-mobile-session`
			);
			expect(missingSessionResponse.status()).toBe(404);
			expect(await missingSessionResponse.json()).toMatchObject({ error: 'Not Found' });
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns empty token API history for unmatched session and project filters', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionHistory = await getJson(
				page,
				`${dashboardUrl}/api/history?sessionId=mobile-history-missing`
			);
			expect(sessionHistory).toMatchObject({ count: 0, entries: [] });

			const projectHistory = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(path.join(workbench.homeDir, 'missing-project'))}`
			);
			expect(projectHistory).toMatchObject({ count: 0, entries: [] });
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('emits desktop session addition, active session, and removal broadcasts', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);
		const addedSessionId = `${workbench.primarySessionId}-desktop-added`;

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate((socketUrl) => {
				const e2eWindow = window as E2ESocketWindow;
				e2eWindow.__maestroE2eSocketMessages = [];
				e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
				e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
					e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
				};
			}, webSocketUrl(dashboardUrl));

			await expect
				.poll(async () =>
					page.evaluate(() =>
						(window as E2ESocketWindow).__maestroE2eSocketMessages?.some(
							(message) => message.type === 'connected'
						)
					)
				)
				.toBe(true);

			await appWindow.evaluate(async (sessionId) => {
				const maestro = (window as MaestroE2EWindow).maestro;
				const sessions = await maestro.sessions.getAll();
				const base = sessions[0];
				await maestro.sessions.setAll([
					...sessions,
					{
						...base,
						id: sessionId,
						name: 'Mobile Added Desktop',
						agentSessionId: `${sessionId}-agent-session`,
						activeTabId: null,
						aiTabs: [],
						aiLogs: [],
						shellLogs: [],
						bookmarked: false,
						createdAt: Date.now(),
					},
				]);
				await maestro.live.broadcastActiveSession(sessionId);
				const sessionsWithAddition = await maestro.sessions.getAll();
				await maestro.sessions.setAll(
					sessionsWithAddition.filter((session) => session.id !== sessionId)
				);
			}, addedSessionId);

			await expect
				.poll(async () =>
					page.evaluate((sessionId) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return {
							added: messages.some(
								(message) =>
									message.type === 'session_added' &&
									(message as E2ESocketMessage & { session?: { id?: string } }).session?.id ===
										sessionId
							),
							active: messages.some(
								(message) =>
									message.type === 'active_session_changed' &&
									(message as E2ESocketMessage & { sessionId?: string }).sessionId === sessionId
							),
							removed: messages.some(
								(message) =>
									message.type === 'session_removed' &&
									(message as E2ESocketMessage & { sessionId?: string }).sessionId === sessionId
							),
						};
					}, addedSessionId)
				)
				.toEqual({ added: true, active: true, removed: true });
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns WebSocket validation errors for incomplete client messages', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await page.evaluate(
				async ({ socketUrl, sessionId }) => {
					return new Promise<E2ESocketMessage[]>((resolve, reject) => {
						const collected: E2ESocketMessage[] = [];
						const socket = new WebSocket(socketUrl);
						const timeout = window.setTimeout(() => {
							socket.close();
							reject(new Error('Timed out waiting for WebSocket validation errors'));
						}, 10000);
						socket.addEventListener('open', () => {
							socket.send(JSON.stringify({ type: 'send_command', sessionId, command: '' }));
							socket.send(
								JSON.stringify({
									type: 'send_command',
									sessionId: 'missing-mobile-session',
									command: 'hello',
								})
							);
							socket.send(JSON.stringify({ type: 'switch_mode', sessionId }));
						});
						socket.addEventListener('message', (event) => {
							const message = JSON.parse(event.data) as E2ESocketMessage;
							collected.push(message);
							const errors = collected.filter((entry) => entry.type === 'error');
							if (errors.length >= 3) {
								window.clearTimeout(timeout);
								socket.close();
								resolve(collected);
							}
						});
						socket.addEventListener('error', () => {
							window.clearTimeout(timeout);
							reject(new Error('WebSocket connection failed'));
						});
					});
				},
				{
					socketUrl: webSocketUrl(dashboardUrl),
					sessionId: workbench.primarySessionId,
				}
			);
			const errors = messages
				.filter((message) => message.type === 'error')
				.map((message) => message.message);
			expect(errors).toEqual(
				expect.arrayContaining([
					'Missing sessionId or command',
					'Session not found',
					'Missing sessionId or mode',
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('reports malformed WebSocket messages and missing tab lifecycle fields', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await page.evaluate(async (socketUrl) => {
				return new Promise<E2ESocketMessage[]>((resolve, reject) => {
					const collected: E2ESocketMessage[] = [];
					const socket = new WebSocket(socketUrl);
					const timeout = window.setTimeout(() => {
						socket.close();
						reject(new Error('Timed out waiting for WebSocket validation responses'));
					}, 10000);

					socket.addEventListener('open', () => {
						socket.send('not-json');
						socket.send(JSON.stringify({ type: 'select_session' }));
						socket.send(JSON.stringify({ type: 'select_tab', sessionId: 'missing-tab-id' }));
						socket.send(JSON.stringify({ type: 'new_tab' }));
						socket.send(JSON.stringify({ type: 'close_tab', sessionId: 'missing-tab-id' }));
						socket.send(JSON.stringify({ type: 'rename_tab', sessionId: 'missing-tab-id' }));
						socket.send(JSON.stringify({ type: 'star_tab', sessionId: 'missing-tab-id' }));
						socket.send(JSON.stringify({ type: 'reorder_tab' }));
						socket.send(JSON.stringify({ type: 'toggle_bookmark' }));
					});
					socket.addEventListener('message', (event) => {
						const message = JSON.parse(event.data) as E2ESocketMessage;
						collected.push(message);
						if (collected.filter((entry) => entry.type === 'error').length >= 9) {
							window.clearTimeout(timeout);
							socket.close();
							resolve(collected);
						}
					});
					socket.addEventListener('error', () => {
						window.clearTimeout(timeout);
						reject(new Error('WebSocket connection failed'));
					});
				});
			}, webSocketUrl(dashboardUrl));
			const errors = messages
				.filter((message) => message.type === 'error')
				.map((message) => message.message);
			expect(errors).toEqual(
				expect.arrayContaining([
					'Invalid message format',
					'Missing sessionId',
					'Missing sessionId or tabId',
					'Missing sessionId, fromIndex, or toIndex',
				])
			);
			expect(errors.filter((message) => message === 'Missing sessionId or tabId')).toHaveLength(4);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('refreshes WebSocket sessions list after desktop session updates', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate((socketUrl) => {
				const e2eWindow = window as E2ESocketWindow;
				e2eWindow.__maestroE2eSocketMessages = [];
				e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
				e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
					e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
				};
			}, webSocketUrl(dashboardUrl));
			await expect
				.poll(async () =>
					page.evaluate(() =>
						(window as E2ESocketWindow).__maestroE2eSocketMessages?.some(
							(message) => message.type === 'connected'
						)
					)
				)
				.toBe(true);

			await appWindow.evaluate(async (sessionId) => {
				const maestro = (window as MaestroE2EWindow).maestro;
				const sessions = await maestro.sessions.getAll();
				await maestro.sessions.setAll(
					sessions.map((session) =>
						session.id === sessionId
							? { ...session, name: 'Mobile Primary Updated', inputMode: 'terminal' }
							: session
					)
				);
			}, workbench.primarySessionId);
			await page.evaluate(() => {
				(window as E2ESocketWindow).__maestroE2eSocket?.send(
					JSON.stringify({ type: 'get_sessions' })
				);
			});

			await expect
				.poll(async () =>
					page.evaluate((sessionId) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.some(
							(message) =>
								message.type === 'sessions_list' &&
								message.sessions?.some(
									(session) =>
										session.id === sessionId &&
										session.name === 'Mobile Primary Updated' &&
										session.inputMode === 'terminal'
								)
						);
					}, workbench.primarySessionId)
				)
				.toBe(true);
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('syncs desktop broadcasts into the mobile session shell', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await appWindow.evaluate(
				async ({ sessionId, planTabId, reviewTabId }) => {
					const maestro = (window as MaestroE2EWindow).maestro;
					await maestro.web.broadcastAutoRunState(sessionId, {
						isRunning: true,
						totalTasks: 5,
						completedTasks: 2,
						currentTaskIndex: 2,
						totalDocuments: 2,
						currentDocumentIndex: 1,
						totalTasksAcrossAllDocs: 9,
						completedTasksAcrossAllDocs: 4,
					});
					await maestro.web.broadcastSessionState(sessionId, 'busy', {
						name: 'Mobile Primary Busy',
						inputMode: 'ai',
					});
					await maestro.web.broadcastTabsChange(
						sessionId,
						[
							{
								id: planTabId,
								agentSessionId: `${sessionId}-agent-plan`,
								name: 'Broadcast Plan',
								starred: false,
								inputValue: '',
								usageStats: { totalCostUsd: 0.11, contextWindow: 16000 },
								createdAt: Date.now(),
								state: 'idle',
								thinkingStartTime: null,
							},
							{
								id: reviewTabId,
								agentSessionId: `${sessionId}-agent-review`,
								name: 'Broadcast Review',
								starred: true,
								inputValue: '',
								usageStats: { totalCostUsd: 0.22, contextWindow: 32000 },
								createdAt: Date.now() + 1,
								state: 'busy',
								thinkingStartTime: Date.now() - 5000,
							},
						],
						reviewTabId
					);
				},
				{
					sessionId: workbench.primarySessionId,
					planTabId: workbench.primaryPlanTabId,
					reviewTabId: workbench.primaryReviewTabId,
				}
			);

			await expect(page.getByText('AutoRun Active')).toBeVisible();
			await expect(page.getByText('Task 3 of 5')).toBeVisible();
			await expect(page.getByRole('button', { name: /Broadcast Review/ })).toBeVisible();
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();
			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastUserInput(
					sessionId,
					'Desktop mirrored command from E2E',
					'ai'
				);
			}, workbench.primarySessionId);
			await expect(page.getByText('Desktop mirrored command from E2E')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('renders the mobile session shell with seeded logs, tabs, usage, and command send', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await expect(page.getByText('Mobile Primary').first()).toBeVisible();
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await expect(page.locator('[title^="Context:"]').first()).toBeVisible();
			await expect(page.locator('[title^="Session cost:"]').first()).toBeVisible();
			await expect(page.getByRole('button', { name: /Plan/ })).toBeVisible();
			await expect(page.getByRole('button', { name: /Review/ })).toBeVisible();

			const input = page.getByLabel(/AI message input/i).first();
			await input.fill('Mobile browser command from E2E');
			await page.getByRole('button', { name: /Send command|Send message/i }).click();
			await expect(page.getByText('Mobile browser command from E2E')).toBeVisible();
			await expect(input).toHaveValue('');

			expect(
				await appWindow.evaluate(async () =>
					(window as MaestroE2EWindow).maestro.webserver.getConnectedClients()
				)
			).toBeGreaterThanOrEqual(1);
			expect(dashboardUrl).toContain(new URL(sessionUrl).origin);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('opens the dashboard route and selects a session from the pill bar', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(dashboardUrl);
			await reconnectMobileIfNeeded(page);

			await expect(page).toHaveURL(new RegExp(`/session/${workbench.primarySessionId}`));
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await reconnectMobileIfNeeded(page);
			await page
				.getByRole('button', { name: /Ungrouped group with 2 sessions/i })
				.first()
				.click();
			await page
				.getByRole('button', { name: /Mobile Secondary session, idle, terminal mode/i })
				.first()
				.click();
			await expect(page).toHaveURL(new RegExp(`/session/${workbench.secondarySessionId}`));
			await expect(
				page.getByText('Mobile Secondary shell output for mobile bridge coverage.')
			).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('navigates through the dashboard header route and restores the active session', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.locator('[title="Go to dashboard"]').click();
			await expect(page).toHaveURL(dashboardUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page).toHaveURL(new RegExp(`/session/${workbench.primarySessionId}`));
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('opens a missing mobile session deep link and recovers from All Agents', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(`${dashboardUrl}/session/not-a-real-mobile-session`);
			await reconnectMobileIfNeeded(page);

			await expect(page.getByText('Select a session above to get started')).toBeVisible();
			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			await page.getByPlaceholder('Search agents...').fill('primary');
			await expect(
				page.getByRole('button', { name: /Mobile Primary session/i }).last()
			).toBeVisible();
			await page
				.getByRole('button', { name: /Mobile Primary session/i })
				.last()
				.click();
			await expect(page).toHaveURL(new RegExp(`/session/${workbench.primarySessionId}`));
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows mobile history unmatched search and clear states', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await page.getByRole('button', { name: 'Search history' }).click();
			await page.getByPlaceholder('Search history...').fill('missing mobile history entry');
			await expect(page.getByText('0 found')).toBeVisible();
			await expect(page.getByText('No matching entries')).toBeVisible();
			await expect(
				page.getByText('No entries found matching "missing mobile history entry".')
			).toBeVisible();

			await page.getByRole('button', { name: 'Clear search' }).click();
			await expect(page.getByPlaceholder('Search history...')).toHaveValue('');
			await expect(page.getByText('Auto Run finished the mobile bridge checklist')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('syncs tab additions and removals from desktop broadcasts into the mobile tab bar', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await expect(page.locator('button[title="Search 2 tabs"]')).toBeVisible();

			await appWindow.evaluate(
				async ({ sessionId, planTabId, reviewTabId }) => {
					await (window as MaestroE2EWindow).maestro.web.broadcastTabsChange(
						sessionId,
						[
							{
								id: planTabId,
								agentSessionId: `${sessionId}-agent-plan`,
								name: 'Plan',
								starred: true,
								inputValue: '',
								usageStats: null,
								createdAt: Date.now(),
								state: 'idle',
								thinkingStartTime: null,
							},
							{
								id: reviewTabId,
								agentSessionId: `${sessionId}-agent-review`,
								name: 'Review',
								starred: false,
								inputValue: '',
								usageStats: null,
								createdAt: Date.now() + 1,
								state: 'idle',
								thinkingStartTime: null,
							},
							{
								id: `${sessionId}-broadcast-new-tab`,
								agentSessionId: null,
								name: 'Broadcast New',
								starred: false,
								inputValue: '',
								usageStats: null,
								createdAt: Date.now() + 2,
								state: 'idle',
								thinkingStartTime: null,
							},
						],
						`${sessionId}-broadcast-new-tab`
					);
				},
				{
					sessionId: workbench.primarySessionId,
					planTabId: workbench.primaryPlanTabId,
					reviewTabId: workbench.primaryReviewTabId,
				}
			);
			await expect(page.locator('button[title="Search 3 tabs"]')).toBeVisible();
			await expect(page.getByRole('button', { name: /Broadcast New/ })).toBeVisible();

			await appWindow.evaluate(
				async ({ sessionId, planTabId, reviewTabId }) => {
					await (window as MaestroE2EWindow).maestro.web.broadcastTabsChange(
						sessionId,
						[
							{
								id: planTabId,
								agentSessionId: `${sessionId}-agent-plan`,
								name: 'Plan',
								starred: true,
								inputValue: '',
								usageStats: null,
								createdAt: Date.now(),
								state: 'idle',
								thinkingStartTime: null,
							},
							{
								id: reviewTabId,
								agentSessionId: `${sessionId}-agent-review`,
								name: 'Review',
								starred: false,
								inputValue: '',
								usageStats: null,
								createdAt: Date.now() + 1,
								state: 'idle',
								thinkingStartTime: null,
							},
						],
						planTabId
					);
				},
				{
					sessionId: workbench.primarySessionId,
					planTabId: workbench.primaryPlanTabId,
					reviewTabId: workbench.primaryReviewTabId,
				}
			);
			await expect(page.locator('button[title="Search 2 tabs"]')).toBeVisible({
				timeout: 10000,
			});
			await expect(page.getByRole('button', { name: /Broadcast New/ })).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('syncs desktop-added sessions into All Agents and removes them', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);
		const addedSessionId = `${workbench.primarySessionId}-ui-added`;

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await reconnectMobileIfNeeded(page);

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				const maestro = (window as MaestroE2EWindow).maestro;
				const sessions = await maestro.sessions.getAll();
				const base = sessions[0];
				await maestro.sessions.setAll([
					...sessions,
					{
						...base,
						id: sessionId,
						name: 'Mobile Added UI',
						agentSessionId: `${sessionId}-agent-session`,
						activeTabId: null,
						aiTabs: [],
						aiLogs: [],
						shellLogs: [],
						bookmarked: false,
						groupId: null,
						createdAt: Date.now(),
					},
				]);
			}, addedSessionId);
			await page.getByPlaceholder('Search agents...').fill('Mobile Added');
			await expect(page.getByRole('button', { name: /Mobile Added UI session/i })).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				const maestro = (window as MaestroE2EWindow).maestro;
				const sessions = await maestro.sessions.getAll();
				await maestro.sessions.setAll(sessions.filter((session) => session.id !== sessionId));
			}, addedSessionId);
			await expect(page.getByRole('button', { name: /Mobile Added UI session/i })).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('clears the active mobile view when the active desktop session is removed', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);
		const removedSessionId = `${workbench.primarySessionId}-removed-active`;

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				const maestro = (window as MaestroE2EWindow).maestro;
				const sessions = await maestro.sessions.getAll();
				const base = sessions[0];
				await maestro.sessions.setAll([
					...sessions,
					{
						...base,
						id: sessionId,
						name: 'Mobile Removed Active',
						agentSessionId: `${sessionId}-agent-session`,
						createdAt: Date.now(),
					},
				]);
				await maestro.live.broadcastActiveSession(sessionId);
				const sessionsWithAddition = await maestro.sessions.getAll();
				await maestro.sessions.setAll(
					sessionsWithAddition.filter((session) => session.id !== sessionId)
				);
			}, removedSessionId);

			await expect(page.getByText('Select a session above to get started')).toBeVisible();
			await expect(page.getByText('Mobile Removed Active').first()).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('renames, stars, and reorders tabs from the mobile tab actions popover', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await expect(page.getByRole('button', { name: /Review/ })).toBeVisible();

			await page.getByRole('button', { name: /Review/ }).click({ button: 'right' });
			const reviewDialog = page.getByRole('dialog', { name: /Actions for tab Review/ });
			await expect(reviewDialog).toBeVisible();
			await reviewDialog.getByRole('button', { name: /Star$/ }).click();
			await expect(
				page.locator('button').filter({ hasText: '★' }).filter({ hasText: 'Review' })
			).toBeVisible();

			await page.getByRole('button', { name: /Review/ }).click({ button: 'right' });
			await page.getByRole('button', { name: /Rename/ }).click();
			await page.getByPlaceholder('Tab name').fill('QA Review');
			await page.getByRole('button', { name: 'Save' }).click();
			await expect(page.getByRole('button', { name: /QA Review/ })).toBeVisible({
				timeout: 10000,
			});

			await page.getByRole('button', { name: /QA Review/ }).click({ button: 'right' });
			await page.getByRole('button', { name: 'Move Left' }).click();
			await expect
				.poll(() =>
					page.locator('button').evaluateAll((buttons) =>
						buttons
							.map((button) => button.textContent?.replace('★', '').trim() || '')
							.filter((text) => text === 'Plan' || text === 'QA Review')
							.join('|')
					)
				)
				.toBe('QA Review|Plan');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('opens quick actions from send long-press and switches input modes', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page
				.getByLabel(/AI message input/i)
				.first()
				.fill('Switch mode from quick actions');
			const sendButton = page.getByRole('button', {
				name: 'Send command (long press for quick actions)',
			});
			await sendButton.dispatchEvent('touchstart');
			await page.waitForTimeout(650);
			await expect(page.getByRole('menu', { name: 'Quick actions' })).toBeVisible();
			await page.getByRole('menuitem', { name: 'Switch to Terminal' }).click();
			await expect(page.getByLabel('Shell command input')).toBeVisible();

			await page.getByLabel('Shell command input').fill('echo quick actions');
			await sendButton.dispatchEvent('touchstart');
			await page.waitForTimeout(650);
			await expect(page.getByRole('menu', { name: 'Quick actions' })).toBeVisible();
			await page.getByRole('menuitem', { name: 'Switch to AI' }).click();
			await expect(page.getByLabel(/AI message input/i).first()).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps AI and terminal drafts separate while sending terminal commands', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page
				.getByLabel(/AI message input/i)
				.first()
				.fill('Draft stays in AI mode');
			await page.getByRole('button', { name: /Switch to terminal mode/i }).click();
			await expect(page.getByLabel('Shell command input')).toBeVisible();
			await page.getByLabel('Shell command input').fill('pwd from mobile terminal');

			await page.getByRole('button', { name: /Switch to AI mode/i }).click();
			await expect(page.getByLabel(/AI message input/i).first()).toHaveValue(
				'Draft stays in AI mode'
			);
			await page.getByRole('button', { name: /Switch to terminal mode/i }).click();
			await expect(page.getByLabel('Shell command input')).toHaveValue('pwd from mobile terminal');

			await page
				.getByRole('button', { name: 'Send command (long press for quick actions)' })
				.click();
			await expect(page.getByText('pwd from mobile terminal')).toBeVisible();
			await expect(page.getByLabel('Shell command input')).toHaveValue('');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('syncs terminal mode desktop broadcasts into the mobile shell', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				const maestro = (window as MaestroE2EWindow).maestro;
				await maestro.web.broadcastSessionState(sessionId, 'idle', {
					name: 'Mobile Primary Terminal',
					inputMode: 'terminal',
					cwd: '/tmp/mobile-terminal-cwd',
				});
				await maestro.web.broadcastUserInput(
					sessionId,
					'desktop terminal command from broadcast',
					'terminal'
				);
			}, workbench.primarySessionId);

			await expect(page.getByText('Mobile Primary Terminal').first()).toBeVisible();
			await expect(page.getByLabel('Shell command input')).toBeVisible();
			await expect(
				page.getByText('Mobile Primary shell output for mobile bridge coverage.')
			).toBeVisible();
			await expect(page.getByText('desktop terminal command from broadcast')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows Auto Run stopping state and clears the mobile indicator', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastAutoRunState(sessionId, {
					isRunning: true,
					totalTasks: 5,
					completedTasks: 4,
					currentTaskIndex: 4,
					isStopping: true,
				});
			}, workbench.primarySessionId);

			await expect(page.getByText('Stopping...')).toBeVisible();
			await expect(page.getByText('Task 5 of 5 (4 done)')).toBeVisible();
			await expect(page.getByText('80%')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastAutoRunState(sessionId, null);
			}, workbench.primarySessionId);
			await expect(page.getByText('Stopping...')).toBeHidden();
			await expect(page.getByText('AutoRun Active')).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows Auto Run only for the active mobile session', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastAutoRunState(sessionId, {
					isRunning: true,
					totalTasks: 3,
					completedTasks: 1,
					currentTaskIndex: 1,
				});
			}, workbench.secondarySessionId);
			await expect(page.getByText('AutoRun Active')).toBeHidden();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.live.broadcastActiveSession(sessionId);
			}, workbench.secondarySessionId);
			await expect(page.getByLabel('Shell command input')).toBeVisible();
			await expect(page.getByText('AutoRun Active')).toBeVisible();
			await expect(page.getByText('Mobile Secondary - Task 2 of 3 (1 done)')).toBeVisible();
			await expect(page.getByText('33%')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastAutoRunState(sessionId, null);
			}, workbench.secondarySessionId);
			await expect(page.getByText('AutoRun Active')).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('switches mobile tabs and reloads the selected tab transcript', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await page.getByRole('button', { name: /Review/ }).click();
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`tabId=${workbench.primaryReviewTabId}`));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('truncates long mobile AI output and strips terminal escape codes', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const longMobileOutput = [
			'\u001b[31mMobile truncation line 1 keeps ANSI text readable\u001b[0m',
			'Mobile truncation line 2',
			'Mobile truncation line 3',
			'Mobile truncation line 4',
			'Mobile truncation line 5',
			'Mobile truncation line 6',
			'Mobile truncation line 7',
			'Mobile truncation line 8',
			'Mobile truncation line 9 appears after expansion',
			'Mobile truncation line 10 appears after expansion',
		].join('\n');
		workbench.sessions[0].aiTabs[0].logs.push({
			id: `${workbench.primarySessionId}-long-output`,
			timestamp: Date.now() + 50,
			source: 'stdout',
			text: longMobileOutput,
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await expect(
				page.getByText('Mobile truncation line 1 keeps ANSI text readable')
			).toBeVisible();
			const longMessage = page
				.locator('div[style*="cursor: pointer"]')
				.filter({ hasText: 'Mobile truncation line 1 keeps ANSI text readable' });
			await expect(page.getByText('\u001b[31m')).toBeHidden();
			await expect(page.getByText('Mobile truncation line 9 appears after expansion')).toBeHidden();
			await expect(page.getByText('... (tap to expand)')).toBeVisible();

			await longMessage.evaluate((element) => (element as HTMLElement).click());
			await expect(
				page.getByText('Mobile truncation line 9 appears after expansion')
			).toBeVisible();
			await expect(page.getByText('▼ collapse')).toBeVisible();

			await longMessage.evaluate((element) => (element as HTMLElement).click());
			await expect(page.getByText('Mobile truncation line 9 appears after expansion')).toBeHidden();
			await expect(page.getByText('▶ expand')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps busy mobile AI drafts while showing interrupt state', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.live.broadcastActiveSession(sessionId);
			}, workbench.busySessionId);

			const busyInput = page.getByLabel(/AI message input/i).first();
			await expect(page.getByText('Mobile Busy Agent alpha response line one')).toBeVisible();
			await expect(busyInput).toHaveAttribute(
				'placeholder',
				'AI thinking... (type your next message)'
			);
			await expect(
				page.getByRole('button', { name: 'Cancel running command or AI query' })
			).toBeVisible();
			await busyInput.fill('Draft written while the mobile AI session is busy');

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastSessionState(sessionId, 'idle');
			}, workbench.busySessionId);

			await expect(
				page.getByRole('button', { name: 'Send command (long press for quick actions)' })
			).toBeVisible();
			await expect(busyInput).toHaveValue('Draft written while the mobile AI session is busy');
			await page
				.getByRole('button', { name: 'Send command (long press for quick actions)' })
				.click();
			await expect(
				page.getByText('Draft written while the mobile AI session is busy')
			).toBeVisible();
			await expect(busyInput).toHaveValue('');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('opens tab search, filters tabs, and selects the matching tab', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.locator('button[title="Search 2 tabs"]').click();
			await expect(page.getByPlaceholder('Search 2 tabs...')).toBeVisible();
			await page.getByPlaceholder('Search 2 tabs...').fill('review');
			await expect(page.getByText('No tabs match your search')).toBeHidden();
			await page.locator('button').filter({ hasText: 'Review' }).last().click();

			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`tabId=${workbench.primaryReviewTabId}`));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows tab search empty, clear, and Escape close states', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.locator('button[title="Search 2 tabs"]').click();
			const tabSearch = page.getByPlaceholder('Search 2 tabs...');
			await expect(tabSearch).toBeVisible();
			await tabSearch.fill('missing mobile tab');
			await expect(page.getByText('No tabs match your search')).toBeVisible();

			await page.getByRole('button', { name: '×' }).click();
			await expect(tabSearch).toHaveValue('');
			await expect(page.getByText('No tabs match your search')).toBeHidden();

			await page.keyboard.press('Escape');
			await expect(tabSearch).toBeHidden();
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('transcribes mocked voice input into the mobile AI composer', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await page.addInitScript(() => {
				class FakeSpeechRecognition {
					continuous = false;
					interimResults = false;
					lang = 'en-US';
					maxAlternatives = 1;
					onstart: (() => void) | null = null;
					onresult:
						| ((event: {
								resultIndex: number;
								results: Array<Array<{ transcript: string }> & { isFinal: boolean }>;
						  }) => void)
						| null = null;
					onend: (() => void) | null = null;

					start() {
						this.onstart?.();
						window.setTimeout(() => {
							const result = [{ transcript: 'voice dictated mobile command' }] as Array<{
								transcript: string;
							}> & { isFinal: boolean };
							result.isFinal = true;
							this.onresult?.({ resultIndex: 0, results: [result] });
							this.onend?.();
						}, 250);
					}

					stop() {
						this.onend?.();
					}
				}

				const speechWindow = window as unknown as {
					SpeechRecognition: typeof FakeSpeechRecognition;
					webkitSpeechRecognition: typeof FakeSpeechRecognition;
				};
				speechWindow.SpeechRecognition = FakeSpeechRecognition;
				speechWindow.webkitSpeechRecognition = FakeSpeechRecognition;
			});
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const aiInput = page.getByLabel(/AI message input/i).first();
			await expect(page.getByRole('button', { name: 'Start voice input' })).toBeVisible();
			await page.getByRole('button', { name: 'Start voice input' }).click();
			await expect(page.getByRole('button', { name: 'Stop voice input' })).toBeVisible();
			await expect(aiInput).toHaveValue('voice dictated mobile command');
			await expect(page.getByRole('button', { name: 'Start voice input' })).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('sends a custom slash command from the mobile command picker', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: 'Open slash commands' }).click();
			await expect(page.getByText('Commands')).toBeVisible();
			await expect(page.getByText('Ship summary')).toBeVisible();
			await page.getByText('/ship').click();

			await expect(page.getByText('Ship summary')).toBeHidden();
			await expect(page.getByText('/ship')).toBeVisible();
			await expect(page.getByLabel(/AI message input/i).first()).toHaveValue('');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('filters and clears typed mobile AI slash commands', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const aiInput = page.getByLabel(/AI message input/i).first();
			await aiInput.fill('/h');
			await expect(page.getByText('Commands')).toBeVisible();
			await expect(page.getByText('/history', { exact: true })).toBeVisible();
			await expect(page.getByText('/clear', { exact: true })).toBeHidden();
			await expect(page.getByText('/jump', { exact: true })).toBeHidden();

			await page.keyboard.press('Escape');
			await expect(page.getByText('Commands')).toBeHidden();
			await expect(aiInput).toHaveValue('');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('submits terminal-only slash commands from the mobile terminal autocomplete', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: /Switch to terminal mode/i }).click();
			const shellInput = page.getByLabel('Shell command input');
			await shellInput.fill('/j');
			await expect(page.getByText('Commands')).toBeVisible();
			await expect(page.getByText('/jump', { exact: true })).toBeVisible();
			await expect(page.getByText('/history', { exact: true })).toBeHidden();

			await page.getByText('/jump', { exact: true }).click();
			await expect(page.getByText('Commands')).toBeHidden();
			await expect(shellInput).toHaveValue('');
			await expect(page.getByText('/jump', { exact: true })).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('submits mobile AI drafts with Cmd+Enter while plain Enter adds a newline', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const aiInput = page.getByLabel(/AI message input/i).first();
			await aiInput.fill('First mobile draft line');
			await page.keyboard.press('Enter');
			await expect(aiInput).toHaveValue('First mobile draft line\n');
			await page.keyboard.type('Second mobile draft line');
			await expect(aiInput).toHaveValue('First mobile draft line\nSecond mobile draft line');

			await page.keyboard.press('Meta+Enter');
			await expect(aiInput).toHaveValue('');
			await expect(page.getByText('First mobile draft line')).toBeVisible();
			await expect(page.getByText('Second mobile draft line')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('collapses and expands mobile session groups from the pill bar', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const ungroupedHeader = page
				.getByRole('button', { name: /Ungrouped group with 2 sessions/i })
				.first();
			await expect(ungroupedHeader).toBeVisible();
			await expect(page.getByRole('button', { name: /Mobile Secondary session/i })).toBeHidden();

			await ungroupedHeader.click();
			await expect(page.getByRole('button', { name: /Mobile Secondary session/i })).toBeVisible();
			await expect(page.getByRole('button', { name: /Mobile Busy Agent session/i })).toBeVisible();

			await ungroupedHeader.click();
			await expect(page.getByRole('button', { name: /Mobile Secondary session/i })).toBeHidden();
			await expect(page.getByRole('button', { name: /Mobile Busy Agent session/i })).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('dismisses mobile session info popover with close button and Escape', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const primaryPill = page
				.getByRole('button', { name: /Mobile Primary session, idle, ai mode, active/i })
				.first();
			await primaryPill.click({ button: 'right' });
			const dialog = page.getByRole('dialog', { name: /Session info for Mobile Primary/ });
			await expect(dialog).toBeVisible();
			await page.getByRole('button', { name: 'Close popover' }).click();
			await expect(dialog).toBeHidden();

			await primaryPill.click({ button: 'right' });
			await expect(dialog).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows All Agents grouping, empty search, clear search, and close states', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			await expect(
				page.getByRole('button', { name: /Bookmarks group with 1 sessions/i }).last()
			).toBeVisible();
			await expect(
				page.getByRole('button', { name: /Mobile Ops group with 1 sessions/i }).last()
			).toBeVisible();
			await page
				.getByRole('button', { name: /Mobile Ops group with 1 sessions/i })
				.last()
				.click();
			await expect(
				page.getByRole('button', { name: /Mobile Primary session, Ready, ai mode, active/i }).last()
			).toBeVisible();

			await page.getByPlaceholder('Search agents...').fill('missing mobile agent');
			await expect(page.getByText('No sessions found')).toBeVisible();
			await expect(page.getByText('No sessions match "missing mobile agent"')).toBeVisible();
			await page.getByRole('button', { name: 'Clear search' }).click();
			await expect(page.getByPlaceholder('Search agents...')).toHaveValue('');
			await page.getByRole('button', { name: 'Close All Agents view' }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('opens All Agents, filters sessions, and selects a terminal session', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			await page.getByPlaceholder('Search agents...').fill('secondary');
			await expect(page.getByRole('button', { name: /Mobile Secondary session/i })).toBeVisible();
			await page.getByRole('button', { name: /Mobile Secondary session/i }).click();

			await expect(page.getByLabel('Shell command input')).toBeVisible();
			await expect(
				page.getByText('Mobile Secondary shell output for mobile bridge coverage.')
			).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`/session/${workbench.secondarySessionId}`));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('opens session info from the pill bar and toggles bookmarks', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const primaryPill = page
				.getByRole('button', { name: /Mobile Primary session, idle, ai mode, active/i })
				.first();
			await primaryPill.click({ button: 'right' });
			await expect(
				page.getByRole('dialog', { name: /Session info for Mobile Primary/ })
			).toBeVisible();
			await expect(page.getByText('Working Directory')).toBeVisible();
			await page.getByRole('button', { name: /Remove Bookmark/ }).click();
			await expect(
				page.getByRole('dialog', { name: /Session info for Mobile Primary/ })
			).toBeHidden();

			await primaryPill.click({ button: 'right' });
			await expect(page.getByRole('button', { name: /Bookmark$/ })).toBeVisible();
			await page.getByRole('button', { name: /Bookmark$/ }).click();
			await expect(
				page.getByRole('dialog', { name: /Session info for Mobile Primary/ })
			).toBeHidden();
			await primaryPill.click({ button: 'right' });
			await expect(page.getByRole('button', { name: /Remove Bookmark/ })).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('persists mobile All Agents and history search state across reloads', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			await page.waitForTimeout(450);
			await reloadAndExpectMobileHeading(page, 'All Agents');
			await page.getByRole('button', { name: 'Close All Agents view' }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeHidden();
			await reconnectMobileIfNeeded(page);
			await page.waitForTimeout(700);

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await page.getByRole('button', { name: 'Search history' }).click();
			await page.getByPlaceholder('Search history...').fill('release');
			await page.getByRole('button', { name: 'AUTO 1' }).click();
			await page.waitForTimeout(700);
			await reloadAndExpectMobileHeading(page, 'History');
			await expect(page.getByPlaceholder('Search history...')).toHaveValue('release');
			await expect(page.getByText('Auto Run finished the mobile bridge checklist')).toBeVisible();
			await expect(page.getByText('User requested a mobile bridge release summary')).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('opens mobile history, filters, searches, and opens entry details', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await expect(page.getByText('Auto Run finished the mobile bridge checklist')).toBeVisible();
			await expect(page.getByText('User requested a mobile bridge release summary')).toBeVisible();

			await page.getByRole('button', { name: /AUTO\s+1/ }).click();
			await expect(page.getByText('Auto Run finished the mobile bridge checklist')).toBeVisible();
			await expect(page.getByText('User requested a mobile bridge release summary')).toBeHidden();

			await page.getByRole('button', { name: 'Search history' }).click();
			await page.getByPlaceholder('Search history...').fill('release notes');
			await expect(page.getByText('1 found')).toBeVisible();
			await page.getByText('Auto Run finished the mobile bridge checklist').click();
			await expect(
				page.getByText('Auto Run detailed mobile bridge release notes and validation output.')
			).toBeVisible();
			await page.getByRole('button', { name: 'Close detail view' }).click();
			await page.getByRole('button', { name: 'Close history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('navigates mobile history detail entries with controls and keyboard', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await page.getByText('Auto Run finished the mobile bridge checklist').click();
			await expect(
				page.getByText('Auto Run detailed mobile bridge release notes and validation output.')
			).toBeVisible();
			await expect(page.getByText('1 / 2')).toBeVisible();
			await expect(page.getByText('42%')).toBeVisible();
			await expect(page.getByText('In: 2,100')).toBeVisible();
			await expect(page.getByText('Out: 950')).toBeVisible();
			await expect(page.getByText('$0.12').last()).toBeVisible();
			await expect(page.getByRole('button', { name: 'Previous entry' })).toBeDisabled();

			await page.getByRole('button', { name: 'Next entry' }).click();
			await expect(
				page.getByText('User-facing mobile bridge release summary with follow-up context.')
			).toBeVisible();
			await expect(page.getByText('2 / 2')).toBeVisible();
			await expect(page.getByRole('button', { name: 'Next entry' })).toBeDisabled();

			await page.keyboard.press('ArrowLeft');
			await expect(
				page.getByText('Auto Run detailed mobile bridge release notes and validation output.')
			).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByText('Auto Run detailed mobile bridge release notes')).toBeHidden();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows mobile history API errors inside the history panel', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await page.evaluate(() => {
				const originalFetch = window.fetch.bind(window);
				window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
					const url =
						typeof input === 'string'
							? input
							: input instanceof Request
								? input.url
								: input.toString();
					if (url.includes('/api/history')) {
						return Promise.resolve(
							new Response(JSON.stringify({ error: 'history unavailable during E2E' }), {
								status: 503,
								statusText: 'Service Unavailable',
								headers: { 'content-type': 'application/json' },
							})
						);
					}
					return originalFetch(input, init);
				}) as typeof window.fetch;
			});

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await expect(page.getByText(/Failed to fetch history/)).toBeVisible();
			await expect(page.getByText('Make sure the desktop app is running')).toBeVisible();
			await page.getByRole('button', { name: 'Close history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows offline fallback and restores the active mobile session when online', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await setMobileOnlineState(page, false);
			await expect(page.getByRole('heading', { name: "You're Offline" })).toBeVisible();
			await expect(page.getByLabel(/AI message input/i).first()).toHaveAttribute(
				'placeholder',
				'Offline...'
			);

			await setMobileOnlineState(page, true);
			await expect(page.getByRole('heading', { name: "You're Offline" })).toBeHidden();
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('uses mobile keyboard shortcuts to cycle tabs and toggle input mode', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.keyboard.press('Meta+]');
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`tabId=${workbench.primaryReviewTabId}`));

			await page.keyboard.press('Meta+[');
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`tabId=${workbench.primaryPlanTabId}`));

			await page.evaluate(() => {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
			});
			await expect(page.getByLabel('Shell command input')).toBeVisible();
			await page.evaluate(() => {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
			});
			await expect(page.getByLabel(/AI message input/i).first()).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows connection lost fallback when the server stops', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await stopWebServer(appWindow);
			await expect(page.getByText('Connection Lost')).toBeVisible({ timeout: 15000 });
			await expect(page.getByLabel(/AI message input/i).first()).toHaveAttribute(
				'placeholder',
				'Connecting...'
			);
			await expect(page.getByRole('button', { name: /Send command|Send message/i })).toBeDisabled();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('expands offline queued commands and removes a queued command', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await setMobileOnlineState(page, false);
			await page
				.getByLabel(/AI message input/i)
				.first()
				.fill('Queued command to inspect and remove');
			await page.getByRole('button', { name: /Send command|Send message/i }).click();
			await expect(page.getByText('1 command queued')).toBeVisible();
			await page.getByText('1 command queued').click();
			await expect(page.getByText('Queued command to inspect and remove')).toBeVisible();

			await page.getByRole('button', { name: 'Remove command' }).click();
			await expect(page.getByText('1 command queued')).toBeHidden();
			await expect.poll(() => getOfflineQueueLength(page)).toBe(0);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('queues a mobile command while offline and clears the queue after reconnect', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await setMobileOnlineState(page, false);
			await page
				.getByLabel(/AI message input/i)
				.first()
				.fill('Queued while mobile offline');
			await page.getByRole('button', { name: /Send command|Send message/i }).click();
			await expect(page.getByText('Commands will be sent when you reconnect.')).toBeVisible();
			expect(await getOfflineQueueLength(page)).toBe(1);

			await setMobileOnlineState(page, true);
			await expect(page.getByText('Commands will be sent when you reconnect.')).toBeHidden({
				timeout: 10000,
			});
			await expect.poll(() => getOfflineQueueLength(page), { timeout: 10000 }).toBe(0);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('queues mixed AI and terminal commands offline and clears the queue', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await setMobileOnlineState(page, false);
			await page
				.getByLabel(/AI message input/i)
				.first()
				.fill('Queued AI offline command');
			await page.getByRole('button', { name: /Send command|Send message/i }).click();
			await expect(page.getByText('1 command queued')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastSessionState(sessionId, 'idle', {
					inputMode: 'terminal',
				});
			}, workbench.primarySessionId);
			await expect(page.getByLabel('Shell command input')).toBeVisible();
			await page.getByLabel('Shell command input').fill('queued terminal offline command');
			await page.getByRole('button', { name: /Send command|Send message/i }).click();
			await expect(page.getByText('2 commands queued')).toBeVisible();

			await page.getByText('2 commands queued').click();
			await expect(page.getByText('Queued AI offline command')).toBeVisible();
			await expect(page.getByText('queued terminal offline command')).toBeVisible();
			await expect(page.getByText('AI').last()).toBeVisible();
			await expect(page.getByText('CLI').last()).toBeVisible();
			expect(await getOfflineQueueLength(page)).toBe(2);

			await page.getByRole('button', { name: 'Clear' }).click();
			await expect(page.getByText('2 commands queued')).toBeHidden();
			await expect.poll(() => getOfflineQueueLength(page)).toBe(0);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('persists offline queued commands across a mobile reload', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await setMobileOnlineState(page, false);
			await page
				.getByLabel(/AI message input/i)
				.first()
				.fill('Persisted offline queue command');
			await page.getByRole('button', { name: /Send command|Send message/i }).click();
			await expect(page.getByText('1 command queued')).toBeVisible();
			expect(await getOfflineQueueLength(page)).toBe(1);

			await page.addInitScript(() => {
				Object.defineProperty(window.navigator, 'onLine', {
					configurable: true,
					get: () => false,
				});
			});
			await page.reload();
			await expect(page.getByText('1 command queued')).toBeVisible();
			await page.getByText('1 command queued').click();
			await expect(page.getByText('Persisted offline queue command')).toBeVisible();
			expect(await getOfflineQueueLength(page)).toBe(1);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});
});
