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
type LiveToggleResult = { live: boolean; url: string | null };
type LiveStatusResult = { live: boolean; url: string | null };
type LiveDisableResult = { success: boolean; count: number };
type LiveSessionSummary = { sessionId: string; agentSessionId?: string; enabledAt?: number };
type StoredSession = ReturnType<typeof createSeededSession>;
type E2ESocketMessage = {
	type: string;
	message?: string;
	sessionId?: string;
	agentSessionId?: string;
	command?: string;
	inputMode?: string;
	state?: string;
	toolType?: string;
	cwd?: string;
	activeTabId?: string;
	subscribedSessionId?: string;
	clientId?: string;
	theme?: { id?: string };
	enabled?: boolean;
	commands?: Array<{ command?: string }>;
	session?: { id?: string };
	aiTabs?: Array<{ id?: string; name?: string | null; state?: string; starred?: boolean }>;
	sessions?: Array<{
		id?: string;
		name?: string;
		state?: string;
		inputMode?: string;
		agentSessionId?: string;
		isLive?: boolean;
		liveEnabledAt?: number;
	}>;
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
			toggle: (sessionId: string, agentSessionId?: string) => Promise<LiveToggleResult>;
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
		projectDirTwo,
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

function appendPrimaryPlanStdout(workbench: WebWorkbench, text: string, suffix: string) {
	const primaryTab = workbench.sessions[0].aiTabs?.find(
		(tab) => tab.id === workbench.primaryPlanTabId
	);
	expect(primaryTab).toBeTruthy();
	primaryTab!.logs.push({
		id: `${workbench.primarySessionId}-${suffix}`,
		timestamp: Date.now() + 40,
		source: 'stdout',
		text,
	});
}

function addMobileWorktreeSession(
	workbench: WebWorkbench,
	{
		suffix,
		branch,
		useParentLink = true,
	}: {
		suffix: string;
		branch: string;
		useParentLink?: boolean;
	}
) {
	const safeBranch = branch.replace(/[^a-z0-9-]+/gi, '-');
	const worktreeDir = path.join(workbench.homeDir, 'project-WorkTrees', safeBranch);
	const sessionId = `${workbench.primarySessionId}-${suffix}`;

	fs.mkdirSync(worktreeDir, { recursive: true });
	workbench.sessions.push({
		...createSeededSession({
			id: sessionId,
			name: branch,
			projectDir: worktreeDir,
			createdAt: Date.now() + 30,
		}),
		parentSessionId: useParentLink ? workbench.primarySessionId : null,
		worktreeBranch: branch,
	} as StoredSession);

	return { sessionId, worktreeDir };
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
	expect(result.url).toEqual(expect.any(String));
	return toLoopbackUrl(result.url!);
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
	let hardReloads = 0;
	await expect
		.poll(
			async () => {
				if (await heading.isVisible().catch(() => false)) {
					return true;
				}
				if (retryClicks < 4 && (await retryButton.isVisible().catch(() => false))) {
					retryClicks += 1;
					await retryButton.click().catch(() => {});
				} else if (hardReloads < 2 && (await retryButton.isVisible().catch(() => false))) {
					hardReloads += 1;
					retryClicks = 0;
					await page.reload().catch(() => {});
				}
				return await heading.isVisible().catch(() => false);
			},
			{ timeout: 45000, intervals: [250, 500, 1000] }
		)
		.toBe(true);
}

async function reconnectMobileIfNeeded(page: Page) {
	const retryButton = page.getByRole('button', { name: 'Retry Now' });
	const connectionLost = page.getByText('Connection Lost');
	let retryClicks = 0;
	await expect
		.poll(
			async () => {
				if (await connectionLost.isHidden().catch(() => true)) {
					return true;
				}
				if (retryClicks < 4 && (await retryButton.isVisible().catch(() => false))) {
					retryClicks += 1;
					await retryButton.click().catch(() => {});
				}
				return await connectionLost.isHidden().catch(() => true);
			},
			{ timeout: 15000, intervals: [250, 500, 1000] }
		)
		.toBe(true);
}

async function collapseMobileComposer(page: Page) {
	await reconnectMobileIfNeeded(page);
	const composer = page.getByTestId('mobile-command-input-bar');
	const history = page.getByTestId('mobile-message-history-scroll');
	await expect(composer).toBeVisible();
	await expect(history).toBeVisible();
	await page
		.getByRole('textbox', { name: 'AI message input. Press the send button to submit.' })
		.evaluate((input) => (input as HTMLTextAreaElement).blur())
		.catch(() => {});
	await history.click({ position: { x: 10, y: 10 }, force: true });
	await expect
		.poll(
			async () => {
				const box = await composer.boundingBox();
				return box?.height ?? 0;
			},
			{ timeout: 10000 }
		)
		.toBeLessThan(160);
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
			const newTabMessages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[{ type: 'new_tab', sessionId: workbench.primarySessionId }],
				['connected', 'new_tab_result']
			);
			const lifecycleMessages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[
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
					'rename_tab_result',
					'star_tab_result',
					'reorder_tab_result',
					'close_tab_result',
					'toggle_bookmark_result',
					'echo',
				]
			);
			const messages = [...newTabMessages, ...lifecycleMessages];

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

	test('reuses persisted mobile web token after server restart', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const firstDashboardUrl = await startWebServer(appWindow);
			await expect(
				appWindow.evaluate(async () => {
					return (window as MaestroE2EWindow).maestro.live.persistCurrentToken();
				})
			).resolves.toMatchObject({ success: true });

			await stopWebServer(appWindow);
			const restartedDashboardUrl = await startWebServer(appWindow);
			expect(new URL(restartedDashboardUrl).pathname).toBe(new URL(firstDashboardUrl).pathname);

			const sessionsPayload = await getJson(page, `${restartedDashboardUrl}/api/sessions`);
			expect(sessionsPayload.sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: workbench.primarySessionId, name: 'Mobile Primary' }),
				])
			);
		} finally {
			await appWindow
				.evaluate(async () => {
					return (window as MaestroE2EWindow).maestro.live.clearPersistentToken();
				})
				.catch(() => {});
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

	test('opens the mobile full response viewer from the last response preview', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await expect(
				page.getByRole('status', {
					name: /Current session: Mobile Primary, status: idle/i,
				})
			).toBeVisible();
			await page.getByRole('button', { name: 'Expand last response' }).click();
			await page.getByRole('button', { name: 'Tap to view full response' }).click();

			const responseDialog = page.getByRole('dialog', { name: 'Full response viewer' });
			await expect(responseDialog).toBeVisible();
			await expect(
				responseDialog.getByText('Mobile Primary alpha response line one')
			).toBeVisible();
			await expect(responseDialog.locator('[aria-label="Response 3 of 3"]')).toBeVisible();

			await page.keyboard.press('ArrowLeft');
			await expect(
				responseDialog.getByText('Mobile Secondary alpha response line one')
			).toBeVisible();
			await expect(responseDialog.locator('[aria-label="Response 2 of 3"]')).toBeVisible();

			await page.keyboard.press('Escape');
			await expect(responseDialog).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('navigates the mobile response viewer with pagination dots and close button', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: 'Expand last response' }).click();
			await page.getByRole('button', { name: 'Tap to view full response' }).click();

			const responseDialog = page.getByRole('dialog', { name: 'Full response viewer' });
			await expect(responseDialog).toBeVisible();
			await expect(responseDialog.locator('[aria-label="Response 3 of 3"]')).toBeVisible();

			await responseDialog.getByRole('button', { name: 'Go to response 1' }).click();
			await expect(
				responseDialog.getByText('Mobile Busy Agent alpha response line one')
			).toBeVisible();
			await expect(responseDialog.locator('[aria-label="Response 1 of 3"]')).toBeVisible();

			await responseDialog.getByRole('button', { name: 'Go to response 2' }).click();
			await expect(
				responseDialog.getByText('Mobile Secondary alpha response line one')
			).toBeVisible();
			await expect(responseDialog.locator('[aria-label="Response 2 of 3"]')).toBeVisible();

			await responseDialog.getByRole('button', { name: 'Close response viewer' }).click();
			await expect(responseDialog).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('copies and collapses the mobile last response preview from the status banner', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						(window as typeof window & { __maestroCopiedText?: string }).__maestroCopiedText = text;
					},
				},
			});
		});

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: 'Copy response to clipboard' }).click();
			await expect(page.getByRole('button', { name: 'Copied to clipboard' })).toBeVisible();
			await expect
				.poll(() =>
					page.evaluate(
						() => (window as typeof window & { __maestroCopiedText?: string }).__maestroCopiedText
					)
				)
				.toContain('Mobile Primary alpha response line one');

			await page.getByRole('button', { name: 'Expand last response' }).click();
			const fullResponseButton = page.getByRole('button', { name: 'Tap to view full response' });
			await expect(fullResponseButton).toBeVisible();
			await expect(fullResponseButton).toContainText('Mobile Primary alpha response line one');

			await page.getByRole('button', { name: 'Collapse last response' }).click();
			await expect(fullResponseButton).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows status-banner copy failure when mobile clipboard write fails', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async () => {
						throw new Error('Clipboard denied by E2E stub');
					},
				},
			});
		});

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: 'Copy response to clipboard' }).click();
			await expect(page.getByRole('button', { name: 'Failed to copy' })).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows the mobile response viewer preview truncation notice', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		appendPrimaryPlanStdout(
			workbench,
			[
				'Mobile Primary long response first preview line.',
				'Mobile Primary long response second preview line.',
				'Mobile Primary long response third preview line.',
				'Mobile Primary hidden fourth line beyond the preview.',
			].join('\n'),
			'long-response-log'
		);
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(
				page.getByText('Mobile Primary long response first preview line.')
			).toBeVisible();

			await page.getByRole('button', { name: 'Expand last response' }).click();
			await page.getByRole('button', { name: 'Tap to view full response' }).click();

			const responseDialog = page.getByRole('dialog', { name: 'Full response viewer' });
			await expect(responseDialog).toBeVisible();
			await expect(
				responseDialog.getByText(/Showing preview \(\d+ of \d+ characters\)\./)
			).toBeVisible();
			await expect(responseDialog.getByText('Full response loading not available.')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('copies code blocks rendered in the mobile response viewer', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		appendPrimaryPlanStdout(
			workbench,
			['```ts', 'const copiedSnippet = "mobile";', '```'].join('\n'),
			'code-response-log'
		);
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						(window as typeof window & { __maestroCopiedCode?: string }).__maestroCopiedCode = text;
					},
				},
			});
		});

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('const copiedSnippet')).toBeVisible();

			await page.getByRole('button', { name: 'Expand last response' }).click();
			await page.getByRole('button', { name: 'Tap to view full response' }).click();

			const responseDialog = page.getByRole('dialog', { name: 'Full response viewer' });
			await expect(responseDialog).toBeVisible();
			await expect(responseDialog.getByText('typescript')).toBeVisible();
			await responseDialog.getByRole('button', { name: 'Copy code' }).click();
			await expect(responseDialog.getByRole('button', { name: 'Copied!' })).toBeVisible();
			await expect
				.poll(() =>
					page.evaluate(
						() => (window as typeof window & { __maestroCopiedCode?: string }).__maestroCopiedCode
					)
				)
				.toBe('const copiedSnippet = "mobile";');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('renders mobile markdown AI output with tables links and code copy', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		appendPrimaryPlanStdout(
			workbench,
			[
				'# Mobile Markdown Release',
				'| Area | Status |',
				'| --- | --- |',
				'| Renderer | Green |',
				'[Docs](https://docs.runmaestro.ai)',
				'```ts',
				'const markdownSnippet = "copied";',
				'```',
			].join('\n'),
			'markdown-response-log'
		);
		appendPrimaryPlanStdout(workbench, 'Mobile Markdown copy spacer.', 'markdown-spacer-log');
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						(
							window as typeof window & { __maestroCopiedMarkdown?: string }
						).__maestroCopiedMarkdown = text;
					},
				},
			});
		});

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 520, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);

			await expect(page.getByRole('heading', { name: 'Mobile Markdown Release' })).toBeVisible();
			await expect(page.getByRole('cell', { name: 'Renderer' })).toBeVisible();
			await expect(page.getByRole('cell', { name: 'Green' })).toBeVisible();

			const docsLink = page.getByRole('link', { name: 'Docs' });
			await expect(docsLink).toHaveAttribute('href', 'https://docs.runmaestro.ai');
			await expect(docsLink).toHaveAttribute('target', '_blank');
			await expect(docsLink).toHaveAttribute('rel', 'noopener noreferrer');
			await expect(page.getByText('Mobile Markdown copy spacer.')).toBeVisible();

			const copyCodeButton = page.getByRole('button', { name: 'Copy code' });
			await copyCodeButton.evaluate((button) =>
				button.scrollIntoView({ block: 'center', inline: 'nearest' })
			);
			await copyCodeButton.click();
			await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(window as typeof window & { __maestroCopiedMarkdown?: string })
								.__maestroCopiedMarkdown
					)
				)
				.toBe('const markdownSnippet = "copied";');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps bottom mobile transcript code actions above the phone composer', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		for (let index = 1; index <= 8; index += 1) {
			appendPrimaryPlanStdout(
				workbench,
				`Phone transcript filler ${index} keeps the final code action near the bottom.`,
				`phone-clearance-filler-${index}`
			);
		}
		appendPrimaryPlanStdout(
			workbench,
			['# Phone Composer Clearance', '```ts', 'const phoneComposerCopy = "visible";', '```'].join(
				'\n'
			),
			'phone-clearance-code-log'
		);
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						(
							window as typeof window & { __maestroPhoneComposerCopy?: string }
						).__maestroPhoneComposerCopy = text;
					},
				},
			});
		});

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);

			await expect(page.getByRole('heading', { name: 'Phone Composer Clearance' })).toBeVisible();
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Connection Lost')).toBeHidden({ timeout: 15000 });
			await collapseMobileComposer(page);

			const copyCodeButton = page.getByRole('button', { name: 'Copy code' });

			const copyBox = await copyCodeButton.boundingBox();
			const composerBox = await page.getByTestId('mobile-command-input-bar').boundingBox();
			if (!copyBox || !composerBox) {
				throw new Error('Expected transcript copy control and mobile composer boxes to exist');
			}
			expect(copyBox.y + copyBox.height).toBeLessThan(composerBox.y - 8);

			await copyCodeButton.click();
			await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(window as typeof window & { __maestroPhoneComposerCopy?: string })
								.__maestroPhoneComposerCopy
					)
				)
				.toBe('const phoneComposerCopy = "visible";');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows mobile new-message indicator when desktop input arrives while scrolled away', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		for (let index = 1; index <= 20; index += 1) {
			const paddedIndex = String(index).padStart(2, '0');
			appendPrimaryPlanStdout(
				workbench,
				`Scroll seed response ${paddedIndex} keeps the mobile transcript scrollable.`,
				`new-message-scroll-seed-${paddedIndex}`
			);
		}
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Connection Lost')).toBeHidden({ timeout: 15000 });
			await expect
				.poll(async () =>
					appWindow.evaluate(async () =>
						(window as MaestroE2EWindow).maestro.webserver.getConnectedClients()
					)
				)
				.toBeGreaterThanOrEqual(1);
			await collapseMobileComposer(page);

			await expect(page.getByText('Scroll seed response 20')).toBeVisible();
			const history = page.getByTestId('mobile-message-history-scroll');
			await history.evaluate((container) => {
				container.scrollTop = 0;
				container.dispatchEvent(new Event('scroll', { bubbles: true }));
			});
			await expect.poll(() => history.evaluate((container) => container.scrollTop)).toBe(0);
			await expect(page.getByText('Scroll seed response 01')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastUserInput(
					sessionId,
					'Desktop follow-up while mobile is scrolled away',
					'ai'
				);
			}, workbench.primarySessionId);

			const indicator = page.getByRole('button', { name: 'Scroll to new messages' });
			await expect(indicator).toBeVisible();
			await expect(indicator).toContainText('1');
			await indicator.click();
			await expect(page.getByText('Desktop follow-up while mobile is scrolled away')).toBeVisible();
			await expect(indicator).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('counts queued mobile new messages and clears them after manual bottom scroll', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		for (let index = 1; index <= 22; index += 1) {
			const paddedIndex = String(index).padStart(2, '0');
			appendPrimaryPlanStdout(
				workbench,
				`Queued scroll seed response ${paddedIndex} keeps the transcript scrollable.`,
				`queued-new-message-scroll-seed-${paddedIndex}`
			);
		}
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Connection Lost')).toBeHidden({ timeout: 15000 });
			await expect
				.poll(async () =>
					appWindow.evaluate(async () =>
						(window as MaestroE2EWindow).maestro.webserver.getConnectedClients()
					)
				)
				.toBeGreaterThanOrEqual(1);
			await collapseMobileComposer(page);

			await expect(page.getByText('Queued scroll seed response 22')).toBeVisible();
			const history = page.getByTestId('mobile-message-history-scroll');
			await history.evaluate((container) => {
				container.scrollTop = 0;
				container.dispatchEvent(new Event('scroll', { bubbles: true }));
			});
			await expect.poll(() => history.evaluate((container) => container.scrollTop)).toBe(0);
			await expect(page.getByText('Queued scroll seed response 01')).toBeVisible();

			for (const message of [
				'Desktop queued update one while mobile is scrolled away',
				'Desktop queued update two while mobile is scrolled away',
			]) {
				await appWindow.evaluate(
					async ({ sessionId, messageText }) => {
						await (window as MaestroE2EWindow).maestro.web.broadcastUserInput(
							sessionId,
							messageText,
							'ai'
						);
					},
					{ sessionId: workbench.primarySessionId, messageText: message }
				);
			}

			const indicator = page.getByRole('button', { name: 'Scroll to new messages' });
			await expect(indicator).toBeVisible();
			await expect(indicator).toContainText('2');

			await history.evaluate((container) => {
				container.scrollTop = container.scrollHeight;
				container.dispatchEvent(new Event('scroll', { bubbles: true }));
			});
			await expect
				.poll(() =>
					history.evaluate(
						(container) => container.scrollHeight - container.scrollTop - container.clientHeight
					)
				)
				.toBeLessThan(50);
			await expect(
				page.getByText('Desktop queued update two while mobile is scrolled away')
			).toBeVisible();
			await expect(indicator).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('caps queued mobile new-message badge at 99 plus while scrolled away', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		for (let index = 1; index <= 22; index += 1) {
			const paddedIndex = String(index).padStart(2, '0');
			appendPrimaryPlanStdout(
				workbench,
				`Overflow badge seed response ${paddedIndex} keeps the transcript scrollable.`,
				`overflow-new-message-scroll-seed-${paddedIndex}`
			);
		}
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Connection Lost')).toBeHidden({ timeout: 15000 });
			await expect
				.poll(async () =>
					appWindow.evaluate(async () =>
						(window as MaestroE2EWindow).maestro.webserver.getConnectedClients()
					)
				)
				.toBeGreaterThanOrEqual(1);
			await collapseMobileComposer(page);

			await expect(page.getByText('Overflow badge seed response 22')).toBeVisible();
			const history = page.getByTestId('mobile-message-history-scroll');
			await history.evaluate((container) => {
				container.scrollTop = 0;
				container.dispatchEvent(new Event('scroll', { bubbles: true }));
			});
			await expect.poll(() => history.evaluate((container) => container.scrollTop)).toBe(0);
			await expect(page.getByText('Overflow badge seed response 01')).toBeVisible();

			await appWindow.evaluate(async (sessionId) => {
				for (let index = 1; index <= 105; index += 1) {
					await (window as MaestroE2EWindow).maestro.web.broadcastUserInput(
						sessionId,
						`Desktop overflow badge update ${String(index).padStart(3, '0')}`,
						'ai'
					);
				}
			}, workbench.primarySessionId);

			const indicator = page.getByRole('button', { name: 'Scroll to new messages' });
			await expect(indicator).toBeVisible();
			await expect(indicator).toContainText('99+');
			await indicator.click();
			await expect(page.getByText('Desktop overflow badge update 105')).toBeVisible();
			await expect(indicator).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('auto-scrolls mobile transcript without a badge when desktop input arrives at bottom', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		for (let index = 1; index <= 18; index += 1) {
			const paddedIndex = String(index).padStart(2, '0');
			appendPrimaryPlanStdout(
				workbench,
				`Bottom scroll seed response ${paddedIndex} keeps the transcript scrollable.`,
				`bottom-new-message-scroll-seed-${paddedIndex}`
			);
		}
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await reconnectMobileIfNeeded(page);
			await expect(page.getByText('Connection Lost')).toBeHidden({ timeout: 15000 });
			await expect
				.poll(async () =>
					appWindow.evaluate(async () =>
						(window as MaestroE2EWindow).maestro.webserver.getConnectedClients()
					)
				)
				.toBeGreaterThanOrEqual(1);
			await collapseMobileComposer(page);

			await expect(page.getByText('Bottom scroll seed response 18')).toBeVisible();
			const history = page.getByTestId('mobile-message-history-scroll');
			await history.evaluate((container) => {
				container.scrollTop = container.scrollHeight;
				container.dispatchEvent(new Event('scroll', { bubbles: true }));
			});
			await expect
				.poll(() =>
					history.evaluate(
						(container) => container.scrollHeight - container.scrollTop - container.clientHeight
					)
				)
				.toBeLessThan(50);

			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastUserInput(
					sessionId,
					'Desktop auto-scroll update while mobile stays at bottom',
					'ai'
				);
			}, workbench.primarySessionId);

			await expect(
				page.getByText('Desktop auto-scroll update while mobile stays at bottom')
			).toBeVisible();
			await expect(page.getByRole('button', { name: 'Scroll to new messages' })).toBeHidden();
			await expect
				.poll(() =>
					history.evaluate(
						(container) => container.scrollHeight - container.scrollTop - container.clientHeight
					)
				)
				.toBeLessThan(50);
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
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const dashboardNavigation = page.waitForEvent('framenavigated', { timeout: 10000 });
			await page.locator('[title="Go to dashboard"]').click();
			await dashboardNavigation;
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

	test('shows the empty mobile session state when every desktop session is removed', async ({
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

			await appWindow.evaluate(async () => {
				await (window as MaestroE2EWindow).maestro.sessions.setAll([]);
			});

			await expect(page.getByText('Select a session above to get started')).toBeVisible();
			await expect(page.getByRole('button', { name: /Search \d+ sessions/i })).toBeHidden();
			await expect(page.getByPlaceholder('Select a session first...')).toBeDisabled();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('restores the mobile session picker after sessions return from empty state', async ({
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

			const originalSessions = await appWindow.evaluate(async () => {
				const maestro = (window as MaestroE2EWindow).maestro;
				const sessions = await maestro.sessions.getAll();
				await maestro.sessions.setAll([]);
				return sessions;
			});
			await expect(page.getByText('Select a session above to get started')).toBeVisible();

			await appWindow.evaluate(
				async ({ sessions, activeSessionId }) => {
					const maestro = (window as MaestroE2EWindow).maestro;
					await maestro.sessions.setAll(sessions);
					await maestro.live.broadcastActiveSession(activeSessionId);
				},
				{ sessions: originalSessions, activeSessionId: workbench.primarySessionId }
			);
			await reconnectMobileIfNeeded(page);

			await expect(page.getByRole('button', { name: /Search 3 sessions/i })).toBeVisible();
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await expect(page.getByLabel(/AI message input/i).first()).toBeEnabled();
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

	test('closes the active mobile tab and shows the remaining tab transcript', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await expect(page.getByRole('button', { name: /Plan/ })).toBeVisible();
			await expect(page.getByRole('button', { name: /Review/ })).toBeVisible();
			await page.getByRole('button', { name: /Review/ }).click();
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();

			await page.getByRole('button', { name: 'Close tab' }).click();

			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible({
				timeout: 10000,
			});
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeHidden();
			await expect(page.locator('button[title="Search 2 tabs"]')).toBeHidden();
			await expect
				.poll(async () => {
					return appWindow.evaluate(async (sessionId) => {
						const sessions = await (window as MaestroE2EWindow).maestro.sessions.getAll();
						const session = sessions.find((item) => item.id === sessionId);
						return {
							activeTabId: session?.activeTabId ?? null,
							tabIds: session?.aiTabs.map((tab) => tab.id) ?? [],
						};
					}, workbench.primarySessionId);
				})
				.toEqual({
					activeTabId: workbench.primaryPlanTabId,
					tabIds: [workbench.primaryPlanTabId],
				});
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
				await (window as MaestroE2EWindow).maestro.web.broadcastSessionState(sessionId, 'idle', {
					name: 'Mobile Primary Terminal',
					inputMode: 'terminal',
					cwd: '/tmp/mobile-terminal-cwd',
				});
			}, workbench.primarySessionId);

			await expect(page.getByText('Mobile Primary Terminal').first()).toBeVisible();
			await expect(page.getByLabel('Shell command input')).toBeVisible();
			await expect(
				page.getByText('Mobile Primary shell output for mobile bridge coverage.')
			).toBeVisible();
			await appWindow.evaluate(async (sessionId) => {
				await (window as MaestroE2EWindow).maestro.web.broadcastUserInput(
					sessionId,
					'desktop terminal command from broadcast',
					'terminal'
				);
			}, workbench.primarySessionId);
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

	test('opens a mobile session deep link directly to a non-default tab', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			const reviewUrl = new URL(sessionUrl);
			reviewUrl.searchParams.set('tabId', workbench.primaryReviewTabId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(reviewUrl.toString());
			await reconnectMobileIfNeeded(page);

			await expect(page).toHaveURL(new RegExp(`tabId=${workbench.primaryReviewTabId}`));
			await expect(page.getByRole('button', { name: /Review/ })).toBeVisible();
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeHidden();
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
				const maestro = (window as MaestroE2EWindow).maestro;
				await maestro.live.broadcastActiveSession(sessionId);
				await maestro.web.broadcastSessionState(sessionId, 'busy', {
					inputMode: 'ai',
				});
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

	test('shows parent-linked worktree children under inherited All Agents groups', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { sessionId: worktreeSessionId } = addMobileWorktreeSession(workbench, {
			suffix: 'worktree-child',
			branch: 'feature/mobile-web',
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: /Search 4 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			await expect(
				page.getByRole('button', { name: /Mobile Ops group with 2 sessions/i }).last()
			).toBeVisible();

			await page.getByPlaceholder('Search agents...').fill('feature/mobile-web');
			const worktreeCard = page.getByRole('button', {
				name: /Mobile Primary: feature\/mobile-web session, Ready, ai mode/i,
			});
			await expect(worktreeCard).toBeVisible();
			await worktreeCard.click();

			await expect(page).toHaveURL(new RegExp(`/session/${worktreeSessionId}`));
			await expect(page.getByText('feature/mobile-web alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('infers legacy mobile worktree parents from cwd in All Agents', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { sessionId: legacyWorktreeSessionId } = addMobileWorktreeSession(workbench, {
			suffix: 'legacy-worktree-child',
			branch: 'legacy-fix',
			useParentLink: false,
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.getByRole('button', { name: /Search 4 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			await expect(
				page.getByRole('button', { name: /Mobile Ops group with 2 sessions/i }).last()
			).toBeVisible();

			await page.getByPlaceholder('Search agents...').fill('legacy-fix');
			const legacyWorktreeCard = page.getByRole('button', {
				name: /Mobile Primary: legacy-fix session, Ready, ai mode/i,
			});
			await expect(legacyWorktreeCard).toBeVisible();
			await legacyWorktreeCard.click();

			await expect(page).toHaveURL(new RegExp(`/session/${legacyWorktreeSessionId}`));
			await expect(page.getByText('legacy-fix alpha response line one')).toBeVisible();
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

	test('persists mobile All Agents view across reloads', async ({ page }) => {
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
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('persists mobile history search and filter state across reloads', async ({ page }) => {
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

	test('filters mobile history to user entries', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			const userFilter = page.getByRole('button', { name: /USER\s+1/ });
			await userFilter.click();
			await expect(userFilter).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByText('User requested a mobile bridge release summary')).toBeVisible();
			await expect(page.getByText('Auto Run finished the mobile bridge checklist')).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows empty mobile history when no entries exist', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.historyEntries.splice(0, workbench.historyEntries.length);
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await expect(page.getByRole('button', { name: /All\s+0/ })).toBeVisible();
			await expect(page.getByText('No history entries')).toBeVisible();
			await expect(page.getByText('Run batch tasks or use /history to add entries.')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows type-specific empty mobile history after filtering', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.historyEntries = workbench.historyEntries.filter((entry) => entry.type === 'AUTO');
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await expect(page.getByText('Auto Run finished the mobile bridge checklist')).toBeVisible();
			const userFilter = page.getByRole('button', { name: /USER\s+0/ });
			await userFilter.click();
			await expect(userFilter).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByText('No history entries')).toBeVisible();
			await expect(page.getByText('No USER entries found. Try changing the filter.')).toBeVisible();
			await expect(page.getByText('Auto Run finished the mobile bridge checklist')).toBeHidden();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows failed Auto Run history indicators and detail stats', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.historyEntries.unshift({
			id: `${workbench.primarySessionId}-history-auto-failed`,
			type: 'AUTO' as const,
			timestamp: workbench.historyEntries[0].timestamp + 100,
			summary: 'Auto Run failed the mobile bridge deployment',
			fullResponse: 'Auto Run stopped after mobile bridge smoke checks failed.',
			agentSessionId: `${workbench.primarySessionId}-agent-failed`,
			sessionName: 'Mobile Primary',
			projectPath: workbench.projectDir,
			sessionId: workbench.primarySessionId,
			contextUsage: 93,
			usageStats: {
				inputTokens: 1400,
				outputTokens: 120,
				totalCostUsd: 0.03,
				contextWindow: 8000,
			},
			success: false,
			elapsedTimeMs: 120000,
			validated: false,
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: 'View history' }).click();
			await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
			await expect(page.getByRole('button', { name: /AUTO\s+2/ })).toBeVisible();
			await expect(page.locator('[title="Task failed"]')).toBeVisible();
			await page.getByText('Auto Run failed the mobile bridge deployment').click();
			await expect(
				page.getByText('Auto Run stopped after mobile bridge smoke checks failed.')
			).toBeVisible();
			await expect(page.getByText('93%')).toBeVisible();
			await expect(page.getByText('2m 0s').last()).toBeVisible();
			await expect(page.getByText('In: 1,400')).toBeVisible();
			await expect(page.getByText('Out: 120')).toBeVisible();
			await expect(page.getByText('$0.03').last()).toBeVisible();
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
			await reconnectMobileIfNeeded(page);
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

	test('keeps mobile session summary order, live flags, and input modes in sync', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const sessions = sessionsPayload.sessions as Array<{
				id: string;
				name: string;
				state: string;
				inputMode: string;
				isLive?: boolean;
				activeTabId?: string;
				bookmarked?: boolean;
			}>;

			expect(sessions.map((session) => session.id)).toEqual([
				workbench.primarySessionId,
				workbench.secondarySessionId,
				workbench.busySessionId,
			]);
			expect(sessions[0]).toMatchObject({
				name: 'Mobile Primary',
				state: 'idle',
				inputMode: 'ai',
				isLive: true,
				activeTabId: workbench.primaryPlanTabId,
				bookmarked: true,
			});
			expect(sessions[1]).toMatchObject({
				name: 'Mobile Secondary',
				inputMode: 'terminal',
				isLive: false,
			});
			expect(sessions[2]).toMatchObject({
				name: 'Mobile Busy Agent',
				state: 'busy',
				inputMode: 'ai',
				isLive: false,
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns active-tab mobile details and terminal shell logs from token APIs', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const primaryDetail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}`
			);
			const activeLogText = primaryDetail.session.aiLogs
				.map((entry: { text: string }) => entry.text)
				.join('\n');

			expect(primaryDetail.session).toMatchObject({
				id: workbench.primarySessionId,
				activeTabId: workbench.primaryPlanTabId,
				inputMode: 'ai',
			});
			expect(activeLogText).toContain('Mobile Primary alpha response line one');
			expect(activeLogText).not.toContain('review tab response only');

			const terminalDetail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.secondarySessionId}`
			);
			expect(terminalDetail.session).toMatchObject({
				id: workbench.secondarySessionId,
				inputMode: 'terminal',
			});
			expect(terminalDetail.session.shellLogs.map((entry: { text: string }) => entry.text)).toEqual(
				expect.arrayContaining([
					expect.stringContaining('Mobile Secondary shell output for mobile bridge coverage.'),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('orders global mobile history newest first with usage metadata', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const historyPayload = await getJson(page, `${dashboardUrl}/api/history`);

			expect(historyPayload.count).toBe(2);
			expect(historyPayload.entries[0]).toMatchObject({
				type: 'AUTO',
				summary: 'Auto Run finished the mobile bridge checklist',
				sessionId: workbench.primarySessionId,
				success: true,
				usageStats: expect.objectContaining({ inputTokens: 2100, outputTokens: 950 }),
			});
			expect(historyPayload.entries[1]).toMatchObject({
				type: 'USER',
				summary: 'User requested a mobile bridge release summary',
				validated: false,
				usageStats: expect.objectContaining({ totalCostUsd: 0.04 }),
			});
			expect(historyPayload.entries[0].timestamp).toBeGreaterThan(
				historyPayload.entries[1].timestamp
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('exposes parent-linked mobile worktree metadata through session summaries', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		addMobileWorktreeSession(workbench, {
			suffix: 'review-worktree',
			branch: 'feature/mobile-review',
		});
		addMobileWorktreeSession(workbench, {
			suffix: 'orphan-worktree',
			branch: 'feature/mobile-orphan',
			useParentLink: false,
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const sessions = sessionsPayload.sessions as Array<{
				name: string;
				parentSessionId?: string | null;
				worktreeBranch?: string | null;
				cwd: string;
			}>;
			const linkedWorktree = sessions.find((session) => session.name === 'feature/mobile-review');
			const orphanWorktree = sessions.find((session) => session.name === 'feature/mobile-orphan');

			expect(linkedWorktree).toMatchObject({
				parentSessionId: workbench.primarySessionId,
				worktreeBranch: 'feature/mobile-review',
			});
			expect(linkedWorktree?.cwd).toContain('project-WorkTrees/feature-mobile-review');
			expect(orphanWorktree).toMatchObject({
				parentSessionId: null,
				worktreeBranch: 'feature/mobile-orphan',
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('disables every live mobile session and clears per-session status', async () => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			await toggleLive(appWindow, workbench.secondarySessionId);

			const beforeDisable = await appWindow.evaluate(async () => {
				return (window as unknown as MaestroE2EWindow).maestro.live.getLiveSessions();
			});
			expect(beforeDisable).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ sessionId: workbench.primarySessionId }),
					expect.objectContaining({ sessionId: workbench.secondarySessionId }),
				])
			);

			const disabled = await appWindow.evaluate(async () => {
				return (window as unknown as MaestroE2EWindow).maestro.live.disableAll();
			});
			expect(disabled).toMatchObject({ success: true, count: 2 });

			const statuses = await appWindow.evaluate(
				async ([primaryId, secondaryId]) => {
					const live = (window as unknown as MaestroE2EWindow).maestro.live;
					return Promise.all([live.getStatus(primaryId), live.getStatus(secondaryId)]);
				},
				[workbench.primarySessionId, workbench.secondarySessionId]
			);
			expect(statuses).toEqual([
				expect.objectContaining({ live: false, url: null }),
				expect.objectContaining({ live: false, url: null }),
			]);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('exposes group metadata and null group fields in mobile session summaries', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const sessions = sessionsPayload.sessions as Array<{
				id: string;
				groupId?: string | null;
				groupName?: string | null;
				groupEmoji?: string | null;
			}>;
			const primary = sessions.find((session) => session.id === workbench.primarySessionId);
			const secondary = sessions.find((session) => session.id === workbench.secondarySessionId);

			expect(primary).toMatchObject({
				groupId: workbench.groups[0].id,
				groupName: 'Mobile Ops',
				groupEmoji: 'M',
			});
			expect(secondary).toMatchObject({
				groupId: null,
				groupName: null,
				groupEmoji: null,
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('truncates active-tab mobile response previews in session summaries', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const longResponse = [
			'Mobile bridge preview line one',
			'Mobile bridge preview line two',
			'Mobile bridge preview line three',
			'Mobile bridge preview line four',
		].join('\n');
		appendPrimaryPlanStdout(workbench, longResponse, 'preview-truncation');
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			) as WebSessionSummary | undefined;

			expect(primary?.lastResponse).toMatchObject({
				source: 'stdout',
				fullLength: longResponse.length,
			});
			expect(primary?.lastResponse?.text).toBe(
				[
					'Mobile bridge preview line one',
					'Mobile bridge preview line two',
					'Mobile bridge preview line three...',
				].join('\n')
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('falls back to first-tab logs when mobile detail receives an unknown tab id', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);
		const unknownTabId = `${workbench.primarySessionId}-missing-tab`;

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}?tabId=${unknownTabId}`
			);
			const logText = detail.session.aiLogs.map((entry: { text: string }) => entry.text).join('\n');

			expect(detail.session.activeTabId).toBe(unknownTabId);
			expect(logText).toContain('Mobile Primary user prompt for plan tab.');
			expect(logText).toContain('Mobile Primary alpha response line one');
			expect(logText).not.toContain('review tab response only');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('enriches mobile summary and detail APIs with live agent metadata', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);
		const liveAgentSessionId = `${workbench.primarySessionId}-mobile-live-agent`;

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await appWindow.evaluate(
				async ([sessionId, agentSessionId]) => {
					return (window as MaestroE2EWindow).maestro.live.toggle(sessionId, agentSessionId);
				},
				[workbench.primarySessionId, liveAgentSessionId]
			);

			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: { id: string }) => session.id === workbench.primarySessionId
			) as
				| {
						agentSessionId?: string | null;
						isLive?: boolean;
						liveEnabledAt?: number;
				  }
				| undefined;
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}`
			);

			expect(primary).toMatchObject({
				agentSessionId: liveAgentSessionId,
				isLive: true,
				liveEnabledAt: expect.any(Number),
			});
			expect(detail.session).toMatchObject({
				agentSessionId: liveAgentSessionId,
				isLive: true,
				liveEnabledAt: expect.any(Number),
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('prefers session history filters over mismatched project filters', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const mixedFilterHistory = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(path.join(workbench.homeDir, 'missing-project'))}&sessionId=${workbench.primarySessionId}`
			);
			expect(mixedFilterHistory.count).toBe(2);
			expect(mixedFilterHistory.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionId: workbench.primarySessionId,
						summary: 'Auto Run finished the mobile bridge checklist',
					}),
					expect.objectContaining({
						sessionId: workbench.primarySessionId,
						summary: 'User requested a mobile bridge release summary',
					}),
				])
			);

			const secondaryHistory = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(workbench.projectDir)}&sessionId=${workbench.secondarySessionId}`
			);
			expect(secondaryHistory).toMatchObject({ count: 0, entries: [] });
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns timestamped token API payloads across mobile bridge resources', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const beforeRequests = Date.now();
			const [sessionsPayload, detailPayload, themePayload, historyPayload] = await Promise.all([
				getJson(page, `${dashboardUrl}/api/sessions`),
				getJson(page, `${dashboardUrl}/api/session/${workbench.primarySessionId}`),
				getJson(page, `${dashboardUrl}/api/theme`),
				getJson(page, `${dashboardUrl}/api/history`),
			]);

			for (const payload of [sessionsPayload, detailPayload, themePayload, historyPayload]) {
				expect(payload.timestamp).toEqual(expect.any(Number));
				expect(payload.timestamp).toBeGreaterThanOrEqual(beforeRequests);
			}
			expect(sessionsPayload.count).toBe(3);
			expect(detailPayload.session.id).toBe(workbench.primarySessionId);
			expect(themePayload.theme.id).toBe('dracula');
			expect(historyPayload.count).toBe(2);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('reflects desktop theme changes through the mobile token theme API', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await expect(getJson(page, `${dashboardUrl}/api/theme`)).resolves.toMatchObject({
				theme: { id: 'dracula' },
			});

			await appWindow.evaluate(async () => {
				await (window as unknown as MaestroE2EWindow).maestro.settings.set(
					'activeThemeId',
					'github-light'
				);
			});

			await expect(getJson(page, `${dashboardUrl}/api/theme`)).resolves.toMatchObject({
				theme: { id: 'github-light' },
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('sends initial Auto Run states to newly connected mobile WebSocket clients', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await appWindow.evaluate(
				async ({
					primarySessionId,
					secondarySessionId,
				}: {
					primarySessionId: string;
					secondarySessionId: string;
				}) => {
					const maestro = (window as unknown as MaestroE2EWindow).maestro;
					await maestro.web.broadcastAutoRunState(primarySessionId, {
						isRunning: true,
						totalTasks: 4,
						completedTasks: 1,
						currentTaskIndex: 1,
					});
					await maestro.web.broadcastAutoRunState(secondarySessionId, {
						isRunning: true,
						totalTasks: 2,
						completedTasks: 0,
						currentTaskIndex: 0,
					});
				},
				{
					primarySessionId: workbench.primarySessionId,
					secondarySessionId: workbench.secondarySessionId,
				}
			);

			const messages = await page.evaluate(async (socketUrl: string) => {
				return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
					const collected: Array<Record<string, unknown>> = [];
					const socket = new WebSocket(socketUrl);
					const timeout = window.setTimeout(() => {
						socket.close();
						reject(new Error('Timed out waiting for initial Auto Run states'));
					}, 10000);

					socket.addEventListener('message', (event) => {
						const message = JSON.parse(event.data) as Record<string, unknown>;
						collected.push(message);
						if (collected.filter((entry) => entry.type === 'autorun_state').length >= 2) {
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
			const autorunStates = messages.filter(
				(message: Record<string, unknown>) => message.type === 'autorun_state'
			);

			expect(autorunStates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionId: workbench.primarySessionId,
						state: expect.objectContaining({ totalTasks: 4, completedTasks: 1 }),
					}),
					expect.objectContaining({
						sessionId: workbench.secondarySessionId,
						state: expect.objectContaining({ totalTasks: 2, completedTasks: 0 }),
					}),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('applies WebSocket subscribe changes before scoped mobile broadcasts', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate(
				({ socketUrl, secondarySessionId }: { socketUrl: string; secondarySessionId: string }) => {
					const e2eWindow = window as E2ESocketWindow;
					e2eWindow.__maestroE2eSocketMessages = [];
					e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
					e2eWindow.__maestroE2eSocket.onopen = () => {
						e2eWindow.__maestroE2eSocket?.send(
							JSON.stringify({ type: 'subscribe', sessionId: secondarySessionId })
						);
					};
					e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
						e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
					};
				},
				{
					socketUrl: webSocketUrl(dashboardUrl),
					secondarySessionId: workbench.secondarySessionId,
				}
			);
			await expect
				.poll(async () =>
					page.evaluate((secondarySessionId: string) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.some(
							(message) => message.type === 'subscribed' && message.sessionId === secondarySessionId
						);
					}, workbench.secondarySessionId)
				)
				.toBe(true);

			await appWindow.evaluate(
				async ({
					primarySessionId,
					secondarySessionId,
				}: {
					primarySessionId: string;
					secondarySessionId: string;
				}) => {
					const maestro = (window as unknown as MaestroE2EWindow).maestro;
					await maestro.web.broadcastUserInput(
						primarySessionId,
						'Primary message after mobile subscribe switch',
						'ai'
					);
					await maestro.web.broadcastUserInput(
						secondarySessionId,
						'Secondary message after mobile subscribe switch',
						'terminal'
					);
				},
				{
					primarySessionId: workbench.primarySessionId,
					secondarySessionId: workbench.secondarySessionId,
				}
			);

			await expect
				.poll(async () =>
					page.evaluate(
						({
							primarySessionId,
							secondarySessionId,
						}: {
							primarySessionId: string;
							secondarySessionId: string;
						}) => {
							const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
							return {
								primary: messages.some(
									(message) =>
										message.type === 'user_input' && message.sessionId === primarySessionId
								),
								secondary: messages.some(
									(message) =>
										message.type === 'user_input' &&
										message.sessionId === secondarySessionId &&
										message.command === 'Secondary message after mobile subscribe switch'
								),
							};
						},
						{
							primarySessionId: workbench.primarySessionId,
							secondarySessionId: workbench.secondarySessionId,
						}
					)
				)
				.toEqual({ primary: false, secondary: true });
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('reports mobile dashboard URL and client count through server lifecycle changes', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const reportedDashboardUrl = await appWindow.evaluate(async () => {
				return (window as unknown as MaestroE2EWindow).maestro.live.getDashboardUrl();
			});
			expect(toLoopbackUrl(reportedDashboardUrl!)).toBe(dashboardUrl);

			await page.evaluate((socketUrl: string) => {
				const e2eWindow = window as E2ESocketWindow;
				e2eWindow.__maestroE2eSocketMessages = [];
				e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
				e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
					e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
				};
			}, webSocketUrl(dashboardUrl));
			await expect
				.poll(async () =>
					appWindow.evaluate(async () => {
						return (window as unknown as MaestroE2EWindow).maestro.webserver.getConnectedClients();
					})
				)
				.toBe(1);

			await stopWebServer(appWindow);
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getDashboardUrl();
				})
			).resolves.toBeNull();
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getStatus(
						'missing-mobile-session'
					);
				})
			).resolves.toMatchObject({ live: false, url: null });
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.webserver.getConnectedClients();
				})
			).resolves.toBe(0);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('tracks connected mobile WebSocket clients for the desktop bridge', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate(
				(socketUrl) => {
					const e2eWindow = window as E2ESocketWindow;
					e2eWindow.__maestroE2eSocketMessages = [];
					e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
					e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
						e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
					};
				},
				webSocketUrl(dashboardUrl, workbench.primarySessionId)
			);

			await expect
				.poll(async () =>
					page.evaluate(() =>
						(window as E2ESocketWindow).__maestroE2eSocketMessages?.some(
							(message) => message.type === 'connected'
						)
					)
				)
				.toBe(true);
			await expect
				.poll(async () =>
					appWindow.evaluate(async () => {
						return (window as MaestroE2EWindow).maestro.webserver.getConnectedClients();
					})
				)
				.toBe(1);

			await page.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close());
			await expect
				.poll(
					async () =>
						appWindow.evaluate(async () => {
							return (window as MaestroE2EWindow).maestro.webserver.getConnectedClients();
						}),
					{ timeout: 10000 }
				)
				.toBe(0);
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('persists and clears mobile web tokens through live settings APIs', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const persistedToken = new URL(dashboardUrl).pathname.split('/').filter(Boolean)[0];
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.persistCurrentToken();
				})
			).resolves.toMatchObject({ success: true });

			await stopWebServer(appWindow);
			const restartedUrl = await startWebServer(appWindow);
			expect(new URL(restartedUrl).pathname.split('/').filter(Boolean)[0]).toBe(persistedToken);

			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.clearPersistentToken();
				})
			).resolves.toMatchObject({ success: true });
			await stopWebServer(appWindow);
			const clearedUrl = await startWebServer(appWindow);
			expect(new URL(clearedUrl).pathname.split('/').filter(Boolean)[0]).not.toBe(persistedToken);

			await expect(getJson(page, `${clearedUrl}/api/sessions`)).resolves.toMatchObject({
				count: 3,
			});
		} finally {
			await appWindow
				.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.clearPersistentToken();
				})
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('lists live mobile sessions and toggles one session offline', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const primaryUrl = await toggleLive(appWindow, workbench.primarySessionId);
			const secondaryUrl = await toggleLive(appWindow, workbench.secondarySessionId);

			const liveSessions = await appWindow.evaluate(async () => {
				return (window as unknown as MaestroE2EWindow).maestro.live.getLiveSessions();
			});
			expect(liveSessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionId: workbench.primarySessionId,
						agentSessionId: `${workbench.primarySessionId}-agent-session`,
						enabledAt: expect.any(Number),
					}),
					expect.objectContaining({
						sessionId: workbench.secondarySessionId,
						agentSessionId: `${workbench.secondarySessionId}-agent-session`,
						enabledAt: expect.any(Number),
					}),
				])
			);
			expect(toLoopbackUrl(primaryUrl)).toContain(`/session/${workbench.primarySessionId}`);
			expect(toLoopbackUrl(secondaryUrl)).toContain(`/session/${workbench.secondarySessionId}`);

			const disabledPrimary = await appWindow.evaluate(async (sessionId) => {
				return (window as unknown as MaestroE2EWindow).maestro.live.toggle(sessionId);
			}, workbench.primarySessionId);
			expect(disabledPrimary).toMatchObject({ live: false, url: null });
			await expect(
				appWindow.evaluate(async (sessionId) => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getStatus(sessionId);
				}, workbench.primarySessionId)
			).resolves.toMatchObject({ live: false, url: null });

			await expect(
				getJson(page, `${dashboardUrl}/api/session/${workbench.secondarySessionId}`)
			).resolves.toMatchObject({
				session: { id: workbench.secondarySessionId },
			});
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getLiveSessions();
				})
			).resolves.toEqual([expect.objectContaining({ sessionId: workbench.secondarySessionId })]);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('broadcasts mobile session state metadata to dashboard WebSocket clients', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate((socketUrl: string) => {
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

			await expect(
				appWindow.evaluate(
					async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
						return (window as unknown as MaestroE2EWindow).maestro.web.broadcastSessionState(
							sessionId,
							'busy',
							{
								name: 'Mobile Primary Busy',
								toolType: 'codex',
								inputMode: 'terminal',
								cwd,
							}
						);
					},
					{ sessionId: workbench.primarySessionId, cwd: workbench.projectDir }
				)
			).resolves.toBe(true);

			await expect
				.poll(async () =>
					page.evaluate((sessionId: string) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.find(
							(message) =>
								message.type === 'session_state_change' && message.sessionId === sessionId
						);
					}, workbench.primarySessionId)
				)
				.toMatchObject({
					sessionId: workbench.primarySessionId,
					state: 'busy',
					name: 'Mobile Primary Busy',
					toolType: 'codex',
					inputMode: 'terminal',
					cwd: workbench.projectDir,
				});
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('broadcasts mobile tab changes with active tab metadata', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate(
				(socketUrl: string) => {
					const e2eWindow = window as E2ESocketWindow;
					e2eWindow.__maestroE2eSocketMessages = [];
					e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
					e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
						e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
					};
				},
				webSocketUrl(dashboardUrl, workbench.primarySessionId)
			);
			await expect
				.poll(async () =>
					page.evaluate(() =>
						(window as E2ESocketWindow).__maestroE2eSocketMessages?.some(
							(message) => message.type === 'connected'
						)
					)
				)
				.toBe(true);

			const primaryTabs: Array<{
				id: string;
				agentSessionId: string | null;
				name: string | null;
				starred: boolean;
				inputValue: string;
				usageStats?: Record<string, unknown> | null;
				createdAt: number;
				state: 'idle' | 'busy';
				thinkingStartTime?: number | null;
			}> = workbench.sessions[0].aiTabs!.map((tab) => ({
				id: tab.id,
				agentSessionId: tab.agentSessionId ?? null,
				name: tab.name ?? null,
				starred: tab.starred,
				inputValue: tab.id === workbench.primaryReviewTabId ? 'Review draft from desktop' : '',
				usageStats: tab.usageStats as Record<string, unknown> | null,
				createdAt: tab.createdAt,
				state: (tab.id === workbench.primaryReviewTabId ? 'busy' : tab.state) as 'idle' | 'busy',
				thinkingStartTime: tab.id === workbench.primaryReviewTabId ? Date.now() : null,
			}));
			await expect(
				appWindow.evaluate(
					async ({
						sessionId,
						tabs,
						activeTabId,
					}: {
						sessionId: string;
						tabs: typeof primaryTabs;
						activeTabId: string;
					}) => {
						return (window as unknown as MaestroE2EWindow).maestro.web.broadcastTabsChange(
							sessionId,
							tabs,
							activeTabId
						);
					},
					{
						sessionId: workbench.primarySessionId,
						tabs: primaryTabs,
						activeTabId: workbench.primaryReviewTabId,
					}
				)
			).resolves.toBe(true);

			await expect
				.poll(async () =>
					page.evaluate((activeTabId: string) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.find(
							(message) => message.type === 'tabs_changed' && message.activeTabId === activeTabId
						);
					}, workbench.primaryReviewTabId)
				)
				.toMatchObject({
					sessionId: workbench.primarySessionId,
					activeTabId: workbench.primaryReviewTabId,
					aiTabs: expect.arrayContaining([
						expect.objectContaining({
							id: workbench.primaryReviewTabId,
							name: 'Review',
							state: 'busy',
							starred: false,
						}),
					]),
				});
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('broadcasts active mobile session changes to dashboard clients', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate((socketUrl: string) => {
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
				await (window as unknown as MaestroE2EWindow).maestro.live.broadcastActiveSession(
					sessionId
				);
			}, workbench.secondarySessionId);

			await expect
				.poll(async () =>
					page.evaluate((sessionId: string) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.some(
							(message) =>
								message.type === 'active_session_changed' && message.sessionId === sessionId
						);
					}, workbench.secondarySessionId)
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

	test('keeps no-client bridge broadcasts deterministic while storing Auto Run state', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const bridgeResults = await appWindow.evaluate(
				async ({
					primarySessionId,
					primaryPlanTabId,
				}: {
					primarySessionId: string;
					primaryPlanTabId: string;
				}) => {
					const maestro = (window as unknown as MaestroE2EWindow).maestro;
					return {
						userInput: await maestro.web.broadcastUserInput(
							primarySessionId,
							'No-client mobile command',
							'ai'
						),
						sessionState: await maestro.web.broadcastSessionState(primarySessionId, 'busy'),
						tabs: await maestro.web.broadcastTabsChange(
							primarySessionId,
							[
								{
									id: primaryPlanTabId,
									agentSessionId: `${primarySessionId}-agent-plan`,
									name: 'Plan',
									starred: true,
									inputValue: '',
									createdAt: Date.now(),
									state: 'idle',
									thinkingStartTime: null,
								},
							],
							primaryPlanTabId
						),
						autoRun: await maestro.web.broadcastAutoRunState(primarySessionId, {
							isRunning: true,
							totalTasks: 7,
							completedTasks: 3,
							currentTaskIndex: 3,
							totalDocuments: 2,
							currentDocumentIndex: 1,
							totalTasksAcrossAllDocs: 14,
							completedTasksAcrossAllDocs: 6,
						}),
					};
				},
				{
					primarySessionId: workbench.primarySessionId,
					primaryPlanTabId: workbench.primaryPlanTabId,
				}
			);
			expect(bridgeResults).toEqual({
				userInput: false,
				sessionState: false,
				tabs: false,
				autoRun: true,
			});

			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[],
				['autorun_state']
			);
			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'autorun_state',
						sessionId: workbench.primarySessionId,
						state: expect.objectContaining({
							totalTasks: 7,
							completedTasks: 3,
							totalTasksAcrossAllDocs: 14,
							completedTasksAcrossAllDocs: 6,
						}),
					}),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('reports inactive mobile bridge status before the web server starts', async () => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getDashboardUrl();
				})
			).resolves.toBeNull();
			await expect(
				appWindow.evaluate(async (sessionId) => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getStatus(sessionId);
				}, workbench.primarySessionId)
			).resolves.toMatchObject({ live: false, url: null });
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getLiveSessions();
				})
			).resolves.toEqual([]);
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.persistCurrentToken();
				})
			).resolves.toMatchObject({
				success: false,
				message: 'Web server is not running.',
			});
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.webserver.getConnectedClients();
				})
			).resolves.toBe(0);
		} finally {
			await electronApp.close();
		}
	});

	test('returns false for desktop bridge broadcasts before server initialization', async () => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const results = await appWindow.evaluate(
				async ({
					primarySessionId,
					primaryPlanTabId,
				}: {
					primarySessionId: string;
					primaryPlanTabId: string;
				}) => {
					const maestro = (window as unknown as MaestroE2EWindow).maestro;
					return {
						userInput: await maestro.web.broadcastUserInput(
							primarySessionId,
							'Pre-start mobile command',
							'ai'
						),
						autoRun: await maestro.web.broadcastAutoRunState(primarySessionId, {
							isRunning: true,
							totalTasks: 2,
							completedTasks: 1,
							currentTaskIndex: 1,
						}),
						sessionState: await maestro.web.broadcastSessionState(primarySessionId, 'busy'),
						tabs: await maestro.web.broadcastTabsChange(
							primarySessionId,
							[
								{
									id: primaryPlanTabId,
									agentSessionId: `${primarySessionId}-agent-plan`,
									name: 'Plan',
									starred: true,
									inputValue: '',
									createdAt: Date.now(),
									state: 'idle',
									thinkingStartTime: null,
								},
							],
							primaryPlanTabId
						),
					};
				},
				{
					primarySessionId: workbench.primarySessionId,
					primaryPlanTabId: workbench.primaryPlanTabId,
				}
			);
			expect(results).toEqual({
				userInput: false,
				autoRun: false,
				sessionState: false,
				tabs: false,
			});
		} finally {
			await electronApp.close();
		}
	});

	test('broadcasts mobile live and offline events to dashboard clients', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate((socketUrl: string) => {
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

			await toggleLive(appWindow, workbench.primarySessionId);
			await expect
				.poll(async () =>
					page.evaluate((sessionId: string) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.find(
							(message) => message.type === 'session_live' && message.sessionId === sessionId
						);
					}, workbench.primarySessionId)
				)
				.toMatchObject({
					sessionId: workbench.primarySessionId,
					agentSessionId: `${workbench.primarySessionId}-agent-session`,
				});

			await appWindow.evaluate(async (sessionId) => {
				await (window as unknown as MaestroE2EWindow).maestro.live.toggle(sessionId);
			}, workbench.primarySessionId);
			await expect
				.poll(async () =>
					page.evaluate((sessionId: string) => {
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

	test('sends initial sessions list with live metadata to new mobile clients', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			await toggleLive(appWindow, workbench.secondarySessionId);

			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[],
				['sessions_list']
			);
			const sessionsList = messages.find((message) => message.type === 'sessions_list');
			expect(sessionsList).toMatchObject({
				sessions: expect.arrayContaining([
					expect.objectContaining({
						id: workbench.primarySessionId,
						isLive: true,
						agentSessionId: `${workbench.primarySessionId}-agent-session`,
						liveEnabledAt: expect.any(Number),
					}),
					expect.objectContaining({
						id: workbench.secondarySessionId,
						isLive: true,
						agentSessionId: `${workbench.secondarySessionId}-agent-session`,
						liveEnabledAt: expect.any(Number),
					}),
					expect.objectContaining({
						id: workbench.busySessionId,
						isLive: false,
					}),
				]),
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('reports session-scoped WebSocket connection metadata for mobile deep links', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl, workbench.secondarySessionId),
				[],
				['connected']
			);
			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'connected',
						clientId: expect.any(String),
						subscribedSessionId: workbench.secondarySessionId,
					}),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns true when connected mobile clients receive desktop user input broadcasts', async ({
		page,
	}: {
		page: Page;
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate(
				(socketUrl) => {
					const e2eWindow = window as E2ESocketWindow;
					e2eWindow.__maestroE2eSocketMessages = [];
					e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
					e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
						e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
					};
				},
				webSocketUrl(dashboardUrl, workbench.primarySessionId)
			);
			await expect
				.poll(async () =>
					page.evaluate(() =>
						(window as E2ESocketWindow).__maestroE2eSocketMessages?.some(
							(message) => message.type === 'connected'
						)
					)
				)
				.toBe(true);

			await expect(
				appWindow.evaluate(async (sessionId) => {
					return (window as unknown as MaestroE2EWindow).maestro.web.broadcastUserInput(
						sessionId,
						'Connected mobile client command',
						'terminal'
					);
				}, workbench.primarySessionId)
			).resolves.toBe(true);
			await expect
				.poll(async () =>
					page.evaluate((sessionId: string) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						return messages.find(
							(message) =>
								message.type === 'user_input' &&
								message.sessionId === sessionId &&
								message.command === 'Connected mobile client command'
						);
					}, workbench.primarySessionId)
				)
				.toMatchObject({
					inputMode: 'terminal',
				});
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('updates mobile REST session live metadata after toggles', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const liveUrl = await toggleLive(appWindow, workbench.primarySessionId);
			const livePayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const livePrimary = livePayload.sessions.find(
				(session: { id: string }) => session.id === workbench.primarySessionId
			);

			expect(livePrimary).toMatchObject({
				id: workbench.primarySessionId,
				isLive: true,
				agentSessionId: `${workbench.primarySessionId}-agent-session`,
				liveEnabledAt: expect.any(Number),
			});
			expect(toLoopbackUrl(liveUrl)).toContain(`/session/${workbench.primarySessionId}`);

			await appWindow.evaluate(async (sessionId) => {
				await (window as unknown as MaestroE2EWindow).maestro.live.toggle(sessionId);
			}, workbench.primarySessionId);
			const offlinePayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const offlinePrimary = offlinePayload.sessions.find(
				(session: { id: string }) => session.id === workbench.primarySessionId
			);
			expect(offlinePrimary).toMatchObject({
				id: workbench.primarySessionId,
				isLive: false,
				agentSessionId: `${workbench.primarySessionId}-agent-session`,
			});
			expect(offlinePrimary.liveEnabledAt).toBeUndefined();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns timestamped REST error bodies for missing sessions and bad commands', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const missingResponse = await page.request.get(
				`${dashboardUrl}/api/session/rest-missing-mobile-session`
			);
			const missingBody = await missingResponse.json();
			expect(missingResponse.status()).toBe(404);
			expect(missingBody).toMatchObject({
				error: 'Not Found',
				message: "Session with id 'rest-missing-mobile-session' not found",
				timestamp: expect.any(Number),
			});

			const badCommandResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`,
				{ data: {} }
			);
			const badCommandBody = await badCommandResponse.json();
			expect(badCommandResponse.status()).toBe(400);
			expect(badCommandBody).toMatchObject({
				error: 'Bad Request',
				message: 'Command is required and must be a string',
				timestamp: expect.any(Number),
			});
			expect(badCommandBody.timestamp).toBeGreaterThanOrEqual(missingBody.timestamp);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps mobile theme REST payloads timestamped after desktop setting changes', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const beforeTheme = await getJson(page, `${dashboardUrl}/api/theme`);
			expect(beforeTheme).toMatchObject({
				theme: { id: 'dracula' },
				timestamp: expect.any(Number),
			});

			await appWindow.evaluate(async () => {
				await (window as unknown as MaestroE2EWindow).maestro.settings.set(
					'activeThemeId',
					'github-light'
				);
			});
			const afterTheme = await getJson(page, `${dashboardUrl}/api/theme`);
			expect(afterTheme).toMatchObject({
				theme: { id: 'github-light' },
				timestamp: expect.any(Number),
			});
			expect(afterTheme.timestamp).toBeGreaterThanOrEqual(beforeTheme.timestamp);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns timestamped mobile history for matching session and project filters', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const filteredHistory = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(workbench.projectDir)}&sessionId=${workbench.primarySessionId}`
			);

			expect(filteredHistory).toMatchObject({
				count: 2,
				timestamp: expect.any(Number),
			});
			expect(filteredHistory.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionId: workbench.primarySessionId,
						projectPath: workbench.projectDir,
					}),
				])
			);
			expect(
				filteredHistory.entries.every(
					(entry: { sessionId: string; projectPath: string }) =>
						entry.sessionId === workbench.primarySessionId &&
						entry.projectPath === workbench.projectDir
				)
			).toBe(true);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns timestamped mobile interrupt success for busy sessions', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const interruptResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.busySessionId}/interrupt`
			);
			const interruptBody = await interruptResponse.json();
			expect(interruptResponse.ok()).toBe(true);
			expect(interruptBody).toMatchObject({
				success: true,
				message: 'Interrupt signal sent successfully',
				sessionId: workbench.busySessionId,
				timestamp: expect.any(Number),
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('rejects null and array mobile command payloads through token APIs', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const nullCommandResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`,
				{ data: { command: null } }
			);
			const arrayCommandResponse = await page.request.post(
				`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`,
				{ data: { command: ['not', 'a', 'string'] } }
			);

			for (const response of [nullCommandResponse, arrayCommandResponse]) {
				expect(response.status()).toBe(400);
				await expect(response.json()).resolves.toMatchObject({
					error: 'Bad Request',
					message: 'Command is required and must be a string',
					timestamp: expect.any(Number),
				});
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('injects exact mobile dashboard config for token root routes', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const tokenPath = new URL(dashboardUrl).pathname.replace(/\/$/, '');
			const token = tokenPath.replace('/', '');
			const response = await page.request.get(dashboardUrl);
			expect(response.ok()).toBe(true);
			const html = await response.text();

			expect(html).toContain(`securityToken: "${token}"`);
			expect(html).toContain('sessionId: null');
			expect(html).toContain('tabId: null');
			expect(html).toContain(`apiBase: "${tokenPath}/api"`);
			expect(html).toContain(`wsUrl: "${tokenPath}/ws"`);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('injects mobile session config with default tab state for session routes', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const response = await page.request.get(
				`${dashboardUrl}/session/${workbench.secondarySessionId}`
			);
			expect(response.ok()).toBe(true);
			const html = await response.text();

			expect(html).toContain(`sessionId: "${workbench.secondarySessionId}"`);
			expect(html).toContain('tabId: null');
			expect(html).toContain(`apiBase: "${new URL(dashboardUrl).pathname}/api"`);
			expect(html).toContain(`wsUrl: "${new URL(dashboardUrl).pathname}/ws"`);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves standalone mobile manifest metadata and shortcut icons', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const manifestResponse = await page.request.get(`${dashboardUrl}/manifest.json`);
			expect(manifestResponse.ok()).toBe(true);
			const manifest = await manifestResponse.json();

			expect(manifest).toMatchObject({
				name: 'Maestro Remote',
				short_name: 'Maestro',
				display: 'standalone',
				scope: './',
				prefer_related_applications: false,
			});
			expect(manifest.categories).toEqual(
				expect.arrayContaining(['developer-tools', 'productivity', 'utilities'])
			);
			expect(manifest.icons).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ sizes: '192x192', purpose: 'any maskable' }),
					expect.objectContaining({ sizes: '512x512', purpose: 'any maskable' }),
				])
			);
			expect(manifest.shortcuts[0]).toMatchObject({
				name: 'Send Command',
				short_name: 'Send',
				url: './',
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves mobile service worker cache and offline API rules', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const response = await page.request.get(`${dashboardUrl}/sw.js`);
			expect(response.ok()).toBe(true);
			expect(response.headers()['content-type']).toContain('javascript');
			const serviceWorker = await response.text();

			expect(serviceWorker).toContain("CACHE_NAME = 'maestro-mobile-v1'");
			expect(serviceWorker).toContain("'./manifest.json'");
			expect(serviceWorker).toContain("url.pathname.includes('/api/')");
			expect(serviceWorker).toContain("url.pathname.includes('/ws/')");
			expect(serviceWorker).toContain("error: 'offline'");
			expect(serviceWorker).toContain('function isStaticAsset');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves tokenized mobile icon assets with PNG content types', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			for (const iconName of ['icon-96x96.png', 'icon-192x192.png']) {
				const response = await page.request.get(`${dashboardUrl}/icons/${iconName}`);
				expect(response.ok()).toBe(true);
				expect(response.headers()['content-type']).toContain('image/png');
				expect((await response.body()).byteLength).toBeGreaterThan(0);
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves unauthenticated mobile health with timestamped status', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const origin = new URL(dashboardUrl).origin;
			const beforeRequest = Date.now();
			const response = await page.request.get(`${origin}/health`);
			expect(response.ok()).toBe(true);
			await expect(response.json()).resolves.toMatchObject({
				status: 'ok',
				timestamp: expect.any(Number),
			});
			const body = await (await page.request.get(`${origin}/health`)).json();
			expect(body.timestamp).toBeGreaterThanOrEqual(beforeRequest);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns default mobile detail with active tab metadata when no tab query is provided', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}`
			);
			const logText = detail.session.aiLogs.map((entry: { text: string }) => entry.text).join('\n');

			expect(detail.session).toMatchObject({
				id: workbench.primarySessionId,
				name: 'Mobile Primary',
				inputMode: 'ai',
				activeTabId: workbench.primaryPlanTabId,
				agentSessionId: `${workbench.primarySessionId}-agent-session`,
			});
			expect(logText).toContain('Mobile Primary alpha response line one');
			expect(logText).not.toContain('review tab response only visible after tab selection');
			expect(detail.timestamp).toEqual(expect.any(Number));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns global mobile history sorted by timestamp with count metadata', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const globalHistory = await getJson(page, `${dashboardUrl}/api/history`);

			expect(globalHistory.count).toBe(2);
			expect(globalHistory.entries).toHaveLength(2);
			expect(globalHistory.entries[0]).toMatchObject({
				type: 'AUTO',
				summary: 'Auto Run finished the mobile bridge checklist',
			});
			expect(globalHistory.entries[1]).toMatchObject({
				type: 'USER',
				summary: 'User requested a mobile bridge release summary',
			});
			expect(globalHistory.entries[0].timestamp).toBeGreaterThan(
				globalHistory.entries[1].timestamp
			);
			expect(globalHistory.timestamp).toEqual(expect.any(Number));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('rejects invalid-token mobile manifest and service worker subroutes', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const origin = new URL(dashboardUrl).origin;

			for (const route of ['/invalid-mobile-token/manifest.json', '/invalid-mobile-token/sw.js']) {
				const response = await page.request.get(`${origin}${route}`, { maxRedirects: 0 });
				expect(response.status()).toBe(404);
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('reuses the running mobile dashboard URL on repeated server starts', async () => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const repeatedStart = await appWindow.evaluate(async () => {
				return (window as unknown as MaestroE2EWindow).maestro.live.startServer();
			});

			expect(repeatedStart).toMatchObject({ success: true });
			expect(toLoopbackUrl(repeatedStart.url)).toBe(dashboardUrl);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('toggles a live mobile session offline without stopping the dashboard server', async () => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			const disabled = await appWindow.evaluate(async (sessionId) => {
				return (window as unknown as MaestroE2EWindow).maestro.live.toggle(sessionId);
			}, workbench.primarySessionId);

			expect(disabled).toMatchObject({ live: false, url: null });
			await expect(
				appWindow.evaluate(async () => {
					return (window as unknown as MaestroE2EWindow).maestro.live.getLiveSessions();
				})
			).resolves.toEqual([]);
			const dashboardStatusUrl = await appWindow.evaluate(async () => {
				return (window as unknown as MaestroE2EWindow).maestro.live.getDashboardUrl();
			});
			expect(toLoopbackUrl(dashboardStatusUrl!)).toBe(dashboardUrl);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns timestamped send failure metadata for missing mobile sessions', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const beforeRequest = Date.now();
			const response = await page.request.post(
				`${dashboardUrl}/api/session/mobile-missing-send/send`,
				{
					data: { command: 'Mobile command for a missing session' },
				}
			);
			const body = await response.json();

			expect(response.status()).toBe(500);
			expect(body).toMatchObject({
				error: 'Internal Server Error',
				message: 'Failed to send command to session',
				timestamp: expect.any(Number),
			});
			expect(body.timestamp).toBeGreaterThanOrEqual(beforeRequest);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('exposes terminal session detail with shell logs through token APIs', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.secondarySessionId}`
			);

			expect(detail.session).toMatchObject({
				id: workbench.secondarySessionId,
				name: 'Mobile Secondary',
				inputMode: 'terminal',
				activeTabId: `${workbench.secondarySessionId}-plan-tab`,
			});
			expect(detail.session.shellLogs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						source: 'stdout',
						text: 'Mobile Secondary shell output for mobile bridge coverage.',
					}),
				])
			);
			expect(detail.timestamp).toEqual(expect.any(Number));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('adds REST session rows after desktop session store updates', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const addedSession = createSeededSession({
				id: `web-mobile-added-rest-${Date.now()}`,
				name: 'Mobile REST Added',
				projectDir: workbench.projectDir,
				createdAt: Date.now(),
				inputMode: 'terminal',
			});
			await expect(
				appWindow.evaluate(async (session) => {
					const maestro = (window as unknown as MaestroE2EWindow).maestro;
					const sessions = await maestro.sessions.getAll();
					return maestro.sessions.setAll([...sessions, session]);
				}, addedSession)
			).resolves.toBe(true);

			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			expect(sessionsPayload.count).toBe(4);
			expect(sessionsPayload.sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: addedSession.id,
						name: 'Mobile REST Added',
						inputMode: 'terminal',
						isLive: false,
					}),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('prioritizes session history filters over project path filters', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const historyPayload = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(path.join(workbench.homeDir, 'missing-project'))}&sessionId=${workbench.primarySessionId}`
			);

			expect(historyPayload.count).toBe(2);
			expect(historyPayload.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionId: workbench.primarySessionId,
						summary: 'Auto Run finished the mobile bridge checklist',
					}),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('rewrites dashboard HTML asset references to tokenized mobile routes', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const tokenPath = new URL(dashboardUrl).pathname.replace(/\/$/, '');
			const response = await page.request.get(dashboardUrl);
			const html = await response.text();

			expect(response.ok()).toBe(true);
			expect(html).toContain(`${tokenPath}/assets/`);
			expect(html).toContain(`${tokenPath}/manifest.json`);
			expect(html).toContain(`${tokenPath}/icons/`);
			expect(html).not.toContain('./assets/');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('enriches session detail with live metadata after mobile live toggles', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}`
			);

			expect(detail.session).toMatchObject({
				id: workbench.primarySessionId,
				isLive: true,
				agentSessionId: `${workbench.primarySessionId}-agent-session`,
				liveEnabledAt: expect.any(Number),
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves remaining tokenized mobile icon sizes with PNG content types', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			for (const iconName of [
				'icon-72x72.png',
				'icon-128x128.png',
				'icon-384x384.png',
				'icon-512x512.png',
			]) {
				const response = await page.request.get(`${dashboardUrl}/icons/${iconName}`);
				expect(response.ok()).toBe(true);
				expect(response.headers()['content-type']).toContain('image/png');
				expect((await response.body()).byteLength).toBeGreaterThan(0);
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('rejects stale persistent mobile token nested routes after replacement', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const staleToken = 'stale-mobile-token';
		(workbench.settings as Record<string, unknown>).persistentWebLink = true;
		(workbench.settings as Record<string, unknown>).webAuthToken = staleToken;
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const url = new URL(dashboardUrl);
			expect(url.pathname).not.toContain(staleToken);

			for (const route of ['/api/sessions', '/assets/mobile-stale.js', '/icons/stale.png']) {
				const response = await page.request.get(`${url.origin}/${staleToken}${route}`, {
					maxRedirects: 0,
				});
				expect(response.status()).toBe(404);
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('serves tokenized mobile bundle assets and rejects untokened asset access', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const origin = new URL(dashboardUrl).origin;
			const shellResponse = await page.request.get(dashboardUrl);
			expect(shellResponse.ok()).toBe(true);
			const html = await shellResponse.text();
			const tokenizedAssetMatch = html.match(/\/[^/"']+\/assets\/[^"']+\.js/);
			expect(tokenizedAssetMatch).not.toBeNull();

			const tokenizedAssetPath = tokenizedAssetMatch![0];
			const assetResponse = await page.request.get(`${origin}${tokenizedAssetPath}`);
			expect(assetResponse.ok()).toBe(true);
			expect(assetResponse.headers()['content-type']).toContain('javascript');
			expect((await assetResponse.body()).byteLength).toBeGreaterThan(0);

			const untokenedAssetPath = tokenizedAssetPath.replace(/^\/[^/]+/, '');
			const untokenedAssetResponse = await page.request.get(`${origin}${untokenedAssetPath}`, {
				maxRedirects: 0,
			});
			expect(untokenedAssetResponse.status()).toBe(404);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns not found for missing tokenized mobile static assets', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			for (const route of [
				'/assets/mobile-bridge-missing.js',
				'/icons/mobile-bridge-missing.png',
			]) {
				const response = await page.request.get(`${dashboardUrl}${route}`);
				expect(response.status()).toBe(404);
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns not found for valid-token unknown mobile API and session subroutes', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			for (const route of [
				'/api/mobile-bridge-missing',
				`/session/${workbench.primarySessionId}/extra`,
			]) {
				const response = await page.request.get(`${dashboardUrl}${route}`, {
					maxRedirects: 0,
				});
				expect(response.status()).toBe(404);
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('rejects mobile command payloads with missing command properties', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const responses = await Promise.all([
				page.request.post(`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`, {
					data: {},
				}),
				page.request.post(`${dashboardUrl}/api/session/${workbench.primarySessionId}/send`, {
					data: { text: 'missing command property' },
				}),
			]);

			for (const response of responses) {
				expect(response.status()).toBe(400);
				await expect(response.json()).resolves.toMatchObject({
					error: 'Bad Request',
					message: 'Command is required and must be a string',
					timestamp: expect.any(Number),
				});
			}
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('replaces invalid persistent mobile tokens before serving routes', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		(workbench.settings as Record<string, unknown>).persistentWebLink = true;
		(workbench.settings as Record<string, unknown>).webAuthToken = 'not-a-valid-mobile-token';
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const url = new URL(dashboardUrl);
			const token = url.pathname.replace(/^\/|\/$/g, '');
			expect(token).not.toBe('not-a-valid-mobile-token');
			expect(token).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
			);

			const staleTokenResponse = await page.request.get(`${url.origin}/not-a-valid-mobile-token`, {
				maxRedirects: 0,
			});
			expect(staleTokenResponse.status()).toBe(302);
			expect(staleTokenResponse.headers().location).toContain('runmaestro.ai');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('falls back to the session input mode for WebSocket commands without client mode', async ({
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
						sessionId: workbench.secondarySessionId,
						command: 'echo websocket fallback terminal mode',
					},
				],
				['connected', 'command_result']
			);

			expect(messages.find((message) => message.type === 'command_result')).toMatchObject({
				success: true,
				sessionId: workbench.secondarySessionId,
			});
			await expect
				.poll(async () => {
					return appWindow.evaluate(async (sessionId) => {
						const sessions = await (
							window as unknown as MaestroE2EWindow
						).maestro.sessions.getAll();
						const session = sessions.find((item) => item.id === sessionId);
						return session?.shellLogs.some(
							(log) => log.source === 'user' && log.text === 'echo websocket fallback terminal mode'
						);
					}, workbench.secondarySessionId);
				})
				.toBe(true);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('clears mobile tab names when WebSocket rename receives an empty name', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[
					{
						type: 'rename_tab',
						sessionId: workbench.primarySessionId,
						tabId: workbench.primaryReviewTabId,
						newName: '',
					},
				],
				['connected', 'rename_tab_result']
			);

			expect(messages.find((message) => message.type === 'rename_tab_result')).toMatchObject({
				success: true,
				sessionId: workbench.primarySessionId,
				tabId: workbench.primaryReviewTabId,
				newName: '',
			});
			await expect
				.poll(async () => {
					return appWindow.evaluate(
						async ({ sessionId, tabId }) => {
							const sessions = await (
								window as unknown as MaestroE2EWindow
							).maestro.sessions.getAll();
							const session = sessions.find((item) => item.id === sessionId);
							return session?.aiTabs.find((tab) => tab.id === tabId)?.name;
						},
						{ sessionId: workbench.primarySessionId, tabId: workbench.primaryReviewTabId }
					);
				})
				.toBeNull();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('echoes false when mobile tabs are unstarred over WebSocket', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[
					{
						type: 'star_tab',
						sessionId: workbench.primarySessionId,
						tabId: workbench.primaryPlanTabId,
						starred: false,
					},
				],
				['connected', 'star_tab_result']
			);

			expect(messages.find((message) => message.type === 'star_tab_result')).toMatchObject({
				success: true,
				sessionId: workbench.primarySessionId,
				tabId: workbench.primaryPlanTabId,
				starred: false,
			});
			await expect
				.poll(async () => {
					return appWindow.evaluate(
						async ({ sessionId, tabId }) => {
							const sessions = await (
								window as unknown as MaestroE2EWindow
							).maestro.sessions.getAll();
							const session = sessions.find((item) => item.id === sessionId);
							return session?.aiTabs.find((tab) => tab.id === tabId)?.starred;
						},
						{ sessionId: workbench.primarySessionId, tabId: workbench.primaryPlanTabId }
					);
				})
				.toBe(false);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('reports offline WebSocket sessions without stale live-enabled timestamps', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await toggleLive(appWindow, workbench.primarySessionId);
			await appWindow.evaluate(async (sessionId) => {
				return (window as unknown as MaestroE2EWindow).maestro.live.toggle(sessionId);
			}, workbench.primarySessionId);

			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[{ type: 'get_sessions' }],
				['connected', 'sessions_list']
			);
			const sessionsList = messages.find((message) => message.type === 'sessions_list') as
				{ sessions?: Array<{ id?: string; isLive?: boolean; liveEnabledAt?: number }> } | undefined;
			const primary = sessionsList?.sessions?.find(
				(session) => session.id === workbench.primarySessionId
			);

			expect(primary).toMatchObject({
				id: workbench.primarySessionId,
				isLive: false,
			});
			expect(primary?.liveEnabledAt).toBeUndefined();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns stable empty mobile detail payloads for sessions without AI tabs', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const noTabsSession = {
			...createSeededSession({
				id: `web-mobile-no-tabs-${Date.now()}`,
				name: 'Mobile No Tabs',
				projectDir: workbench.projectDir,
				createdAt: Date.now(),
			}),
			activeTabId: null,
			aiTabs: [],
			unifiedTabOrder: [],
		} as unknown as StoredSession;
		workbench.sessions.push(noTabsSession);
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(page, `${dashboardUrl}/api/session/${noTabsSession.id}`);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const summary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === noTabsSession.id
			) as (WebSessionSummary & { activeTabId?: string }) | undefined;

			expect(detail.session).toMatchObject({
				id: noTabsSession.id,
				name: 'Mobile No Tabs',
				aiLogs: [],
			});
			expect(detail.session.activeTabId).toBeNull();
			expect(summary).toMatchObject({
				id: noTabsSession.id,
				aiTabs: [],
				lastResponse: null,
			});
			expect(summary?.activeTabId).toBeUndefined();
			expect(detail.timestamp).toEqual(expect.any(Number));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns null mobile last response when the active tab has no output logs', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const activeTab = workbench.sessions[0].aiTabs.find(
			(tab) => tab.id === workbench.primaryPlanTabId
		);
		expect(activeTab).toBeTruthy();
		activeTab!.logs = activeTab!.logs.filter((log) => log.source !== 'stdout');
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			) as WebSessionSummary | undefined;

			expect(primary).toMatchObject({
				id: workbench.primarySessionId,
				lastResponse: null,
			});
			expect(primary?.aiTabs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: workbench.primaryPlanTabId,
						name: 'Plan',
					}),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('hides mobile voice input when speech recognition is unsupported', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await page.addInitScript(() => {
				const speechWindow = window as unknown as {
					SpeechRecognition?: unknown;
					webkitSpeechRecognition?: unknown;
				};
				delete speechWindow.SpeechRecognition;
				delete speechWindow.webkitSpeechRecognition;
			});
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await expect(page.getByRole('button', { name: 'Start voice input' })).toBeHidden();
			await expect(page.getByRole('button', { name: 'Open slash commands' })).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps mobile AI drafts when speech recognition reports an error', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await page.addInitScript(() => {
				class ErrorSpeechRecognition {
					continuous = false;
					interimResults = false;
					lang = 'en-US';
					maxAlternatives = 1;
					onstart: (() => void) | null = null;
					onerror: ((event: { error: string }) => void) | null = null;

					start() {
						this.onstart?.();
						window.setTimeout(() => {
							this.onerror?.({ error: 'network' });
						}, 250);
					}

					stop() {}
				}

				const speechWindow = window as unknown as {
					SpeechRecognition: typeof ErrorSpeechRecognition;
					webkitSpeechRecognition: typeof ErrorSpeechRecognition;
				};
				speechWindow.SpeechRecognition = ErrorSpeechRecognition;
				speechWindow.webkitSpeechRecognition = ErrorSpeechRecognition;
			});
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const aiInput = page.getByLabel(/AI message input/i).first();
			await aiInput.fill('Draft before voice failure');
			await page.getByRole('button', { name: 'Start voice input' }).click();
			await expect(page.getByRole('button', { name: 'Stop voice input' })).toBeVisible();
			await expect(page.getByRole('button', { name: 'Start voice input' })).toBeVisible();
			await expect(aiInput).toHaveValue('Draft before voice failure');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('appends mobile voice transcripts to an existing AI draft', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await page.addInitScript(() => {
				class AppendSpeechRecognition {
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
							const result = [{ transcript: 'appended voice phrase' }] as Array<{
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
					SpeechRecognition: typeof AppendSpeechRecognition;
					webkitSpeechRecognition: typeof AppendSpeechRecognition;
				};
				speechWindow.SpeechRecognition = AppendSpeechRecognition;
				speechWindow.webkitSpeechRecognition = AppendSpeechRecognition;
			});
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const aiInput = page.getByLabel(/AI message input/i).first();
			await aiInput.fill('Existing mobile draft');
			await page.getByRole('button', { name: 'Start voice input' }).click();
			await expect(aiInput).toHaveValue('Existing mobile draft appended voice phrase');
			await expect(page.getByRole('button', { name: 'Start voice input' })).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('wraps mobile tab keyboard shortcuts at the first and last tab', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			await page.keyboard.press('Meta+[');
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`tabId=${workbench.primaryReviewTabId}`));

			await page.keyboard.press('Meta+]');
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
			await expect(page).toHaveURL(new RegExp(`tabId=${workbench.primaryPlanTabId}`));
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps mobile AI drafts isolated per active tab', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 768, height: 820 });
			await page.goto(sessionUrl);
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();

			const aiInput = page.getByLabel(/AI message input/i).first();
			await aiInput.fill('Plan tab mobile draft');
			await page.getByRole('button', { name: /Review/ }).click();
			await expect(page.getByText('Mobile Primary review tab response only visible')).toBeVisible();
			await expect(aiInput).toHaveValue('');
			await aiInput.fill('Review tab mobile draft');

			await page.getByRole('button', { name: /Plan/ }).click();
			await expect(aiInput).toHaveValue('Plan tab mobile draft');
			await page.getByRole('button', { name: /Review/ }).click();
			await expect(aiInput).toHaveValue('Review tab mobile draft');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('navigates mobile history detail entries with swipe gestures', async ({ page }) => {
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
			const autoDetail = page.getByText(
				'Auto Run detailed mobile bridge release notes and validation output.'
			);
			await expect(autoDetail).toBeVisible();

			await autoDetail.dispatchEvent('touchstart', {
				touches: [{ identifier: 0, clientX: 360, clientY: 360 }],
			});
			await autoDetail.dispatchEvent('touchmove', {
				touches: [{ identifier: 0, clientX: 250, clientY: 360 }],
			});
			await autoDetail.dispatchEvent('touchend', {
				changedTouches: [{ identifier: 0, clientX: 250, clientY: 360 }],
			});
			const userDetail = page.getByText(
				'User-facing mobile bridge release summary with follow-up context.'
			);
			await expect(userDetail).toBeVisible();
			await expect(page.getByText('2 / 2')).toBeVisible();

			await userDetail.dispatchEvent('touchstart', {
				touches: [{ identifier: 0, clientX: 80, clientY: 360 }],
			});
			await userDetail.dispatchEvent('touchmove', {
				touches: [{ identifier: 0, clientX: 190, clientY: 360 }],
			});
			await userDetail.dispatchEvent('touchend', {
				changedTouches: [{ identifier: 0, clientX: 190, clientY: 360 }],
			});
			await expect(autoDetail).toBeVisible();
			await expect(page.getByText('1 / 2')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('timestamps initial mobile WebSocket handshake metadata', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[],
				['connected', 'sessions_list', 'theme', 'bionify_reading_mode', 'custom_commands']
			);

			for (const type of [
				'connected',
				'sessions_list',
				'theme',
				'bionify_reading_mode',
				'custom_commands',
			]) {
				expect(messages.find((message) => message.type === type)).toMatchObject({
					timestamp: expect.any(Number),
				});
			}
			const connected = messages.find((message) => message.type === 'connected');
			expect(connected).toMatchObject({
				message: 'Connected to Maestro Web Interface',
			});
			expect(connected).not.toHaveProperty('subscribedSessionId');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('sends all seeded sessions in the initial dashboard WebSocket list', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const messages = await waitForWebSocketMessages(
				page,
				webSocketUrl(dashboardUrl),
				[],
				['sessions_list']
			);
			const sessionsList = messages.find((message) => message.type === 'sessions_list') as
				| {
						sessions?: Array<{
							id?: string;
							inputMode?: string;
							isLive?: boolean;
							liveEnabledAt?: number;
						}>;
				  }
				| undefined;

			expect(sessionsList?.sessions).toHaveLength(3);
			expect(sessionsList?.sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: workbench.primarySessionId,
						inputMode: 'ai',
						isLive: false,
					}),
					expect.objectContaining({
						id: workbench.secondarySessionId,
						inputMode: 'terminal',
						isLive: false,
					}),
					expect.objectContaining({
						id: workbench.busySessionId,
						isLive: false,
					}),
				])
			);
			expect(sessionsList?.sessions?.every((session) => session.liveEnabledAt === undefined)).toBe(
				true
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps mobile WebSocket connections usable after malformed messages', async ({ page }) => {
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
						reject(new Error('Timed out waiting for malformed-message recovery'));
					}, 10000);

					socket.addEventListener('open', () => {
						socket.send('not-json');
						socket.send(JSON.stringify({ type: 'ping' }));
					});
					socket.addEventListener('message', (event) => {
						const message = JSON.parse(event.data) as E2ESocketMessage;
						collected.push(message);
						if (
							collected.some((entry) => entry.type === 'error') &&
							collected.some((entry) => entry.type === 'pong')
						) {
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

			expect(messages.find((message) => message.type === 'error')).toMatchObject({
				message: 'Invalid message format',
			});
			expect(messages.find((message) => message.type === 'pong')).toMatchObject({
				timestamp: expect.any(Number),
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns timestamped echo metadata for unknown mobile WebSocket messages', async ({
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
						type: 'mobile_e2e_unknown_metadata',
						payload: { source: 'metadata tranche' },
					},
				],
				['connected', 'echo']
			);
			const echo = messages.find((message) => message.type === 'echo') as
				| { data?: { payload?: { source?: string } }; originalType?: string; timestamp?: number }
				| undefined;

			expect(echo).toMatchObject({
				originalType: 'mobile_e2e_unknown_metadata',
				data: { payload: { source: 'metadata tranche' } },
				timestamp: expect.any(Number),
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('timestamps mobile live and offline WebSocket broadcasts', async ({ page }) => {
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
				return (window as unknown as MaestroE2EWindow).maestro.live.toggle(
					sessionId,
					`${sessionId}-agent-session`
				);
			}, workbench.primarySessionId);
			await appWindow.evaluate(async (sessionId) => {
				return (window as unknown as MaestroE2EWindow).maestro.live.toggle(
					sessionId,
					`${sessionId}-agent-session`
				);
			}, workbench.primarySessionId);

			await expect
				.poll(async () =>
					page.evaluate((sessionId) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						const live = messages.find(
							(message) => message.type === 'session_live' && message.sessionId === sessionId
						);
						const offline = messages.find(
							(message) => message.type === 'session_offline' && message.sessionId === sessionId
						);
						return {
							liveTimestamp: typeof live?.timestamp,
							offlineTimestamp: typeof offline?.timestamp,
						};
					}, workbench.primarySessionId)
				)
				.toEqual({ liveTimestamp: 'number', offlineTimestamp: 'number' });
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('timestamps desktop user-input broadcasts to subscribed mobile sockets', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			await page.evaluate(
				(socketUrl) => {
					const e2eWindow = window as E2ESocketWindow;
					e2eWindow.__maestroE2eSocketMessages = [];
					e2eWindow.__maestroE2eSocket = new WebSocket(socketUrl);
					e2eWindow.__maestroE2eSocket.onmessage = (event: MessageEvent) => {
						e2eWindow.__maestroE2eSocketMessages?.push(JSON.parse(event.data));
					};
				},
				webSocketUrl(dashboardUrl, workbench.primarySessionId)
			);
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
				return (window as unknown as MaestroE2EWindow).maestro.web.broadcastUserInput(
					sessionId,
					'Timestamped desktop input broadcast',
					'ai'
				);
			}, workbench.primarySessionId);

			await expect
				.poll(async () =>
					page.evaluate((sessionId) => {
						const messages = (window as E2ESocketWindow).__maestroE2eSocketMessages || [];
						const input = messages.find(
							(message) =>
								message.type === 'user_input' &&
								message.sessionId === sessionId &&
								message.command === 'Timestamped desktop input broadcast'
						);
						return {
							inputMode: input?.inputMode,
							timestampType: typeof input?.timestamp,
						};
					}, workbench.primarySessionId)
				)
				.toEqual({ inputMode: 'ai', timestampType: 'number' });
		} finally {
			await page
				.evaluate(() => (window as E2ESocketWindow).__maestroE2eSocket?.close())
				.catch(() => {});
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('closes the mobile All Agents view with Escape', async ({ page }) => {
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
			await page.keyboard.press('Escape');

			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeHidden();
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('closes the mobile history list with Escape before detail selection', async ({ page }) => {
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
			await page.keyboard.press('Escape');

			await expect(page.getByRole('heading', { name: 'History' })).toBeHidden();
			await expect(page.getByText('Mobile Primary alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('uses stderr output as the latest mobile response preview', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const primaryTab = workbench.sessions[0].aiTabs.find(
			(tab) => tab.id === workbench.primaryPlanTabId
		);
		expect(primaryTab).toBeTruthy();
		primaryTab!.logs.push({
			id: `${workbench.primarySessionId}-stderr-preview`,
			timestamp: Date.now() + 80,
			source: 'stderr',
			text: 'Mobile bridge stderr preview line one\nMobile bridge stderr preview line two',
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			) as WebSessionSummary | undefined;

			expect(primary?.lastResponse).toMatchObject({
				source: 'stderr',
				text: 'Mobile bridge stderr preview line one\nMobile bridge stderr preview line two',
				fullLength: 'Mobile bridge stderr preview line one\nMobile bridge stderr preview line two'
					.length,
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('includes stderr mobile detail rows while hiding thinking and tool rows', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const primaryTab = workbench.sessions[0].aiTabs.find(
			(tab) => tab.id === workbench.primaryPlanTabId
		);
		expect(primaryTab).toBeTruthy();
		primaryTab!.logs.push({
			id: `${workbench.primarySessionId}-stderr-detail`,
			timestamp: Date.now() + 90,
			source: 'stderr',
			text: 'Mobile bridge stderr detail output',
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}?tabId=${workbench.primaryPlanTabId}`
			);
			const logText = detail.session.aiLogs.map((entry: { text: string }) => entry.text).join('\n');

			expect(logText).toContain('Mobile bridge stderr detail output');
			expect(logText).toContain('Mobile Primary alpha response line one');
			expect(logText).not.toContain('Hidden thinking');
			expect(logText).not.toContain('Hidden tool output');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('falls back to first-tab mobile previews when the stored active tab is stale', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const staleTabId = `${workbench.primarySessionId}-stale-active-tab`;
		workbench.sessions[0].activeTabId = staleTabId;
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary & { activeTabId?: string }) =>
					session.id === workbench.primarySessionId
			) as (WebSessionSummary & { activeTabId?: string }) | undefined;

			expect(primary).toMatchObject({
				id: workbench.primarySessionId,
				activeTabId: staleTabId,
			});
			expect(primary?.lastResponse).toMatchObject({
				source: 'stdout',
			});
			expect(primary?.lastResponse?.text).toContain('Mobile Primary alpha response line one');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('falls back to first-tab mobile detail logs when the stored active tab is stale', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const staleTabId = `${workbench.primarySessionId}-stale-detail-tab`;
		workbench.sessions[0].activeTabId = staleTabId;
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}`
			);
			const logText = detail.session.aiLogs.map((entry: { text: string }) => entry.text).join('\n');

			expect(detail.session.activeTabId).toBe(staleTabId);
			expect(logText).toContain('Mobile Primary user prompt for plan tab.');
			expect(logText).toContain('Mobile Primary alpha response line one');
			expect(logText).not.toContain('review tab response only');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('toggles collapsed regular groups inside the mobile All Agents view', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.sessions[0].bookmarked = false;
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			const mobileOpsGroup = page
				.getByRole('button', {
					name: /Mobile Ops group with 1 sessions/i,
				})
				.last();
			await expect(mobileOpsGroup).toHaveAttribute('aria-expanded', 'false');

			await mobileOpsGroup.click();
			await expect(mobileOpsGroup).toHaveAttribute('aria-expanded', 'true');
			await expect(
				page.getByRole('button', { name: /Mobile Primary session, Ready, ai mode, active/i }).last()
			).toBeVisible();

			await mobileOpsGroup.click();
			await expect(mobileOpsGroup).toHaveAttribute('aria-expanded', 'false');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('auto-expands matching collapsed groups while searching All Agents', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.sessions[0].bookmarked = false;
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			const mobileOpsGroup = page
				.getByRole('button', {
					name: /Mobile Ops group with 1 sessions/i,
				})
				.last();
			await expect(mobileOpsGroup).toHaveAttribute('aria-expanded', 'false');

			await page.getByPlaceholder('Search agents...').fill('primary');
			await expect(mobileOpsGroup).toHaveAttribute('aria-expanded', 'true');
			await expect(
				page.getByRole('button', { name: /Mobile Primary session, Ready, ai mode, active/i }).last()
			).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('exposes busy mobile thinking metadata in session summaries', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const busy = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.busySessionId
			) as
				| (WebSessionSummary & {
						state: string;
						thinkingStartTime?: number | null;
						aiTabs?: Array<{ id: string; state?: string; thinkingStartTime?: number | null }>;
				  })
				| undefined;
			const busyPlanTab = busy?.aiTabs?.find(
				(tab) => tab.id === `${workbench.busySessionId}-plan-tab`
			);

			expect(busy).toMatchObject({
				id: workbench.busySessionId,
				state: 'busy',
				thinkingStartTime: expect.any(Number),
			});
			expect(busyPlanTab).toMatchObject({
				state: 'busy',
				thinkingStartTime: expect.any(Number),
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('preserves git and usage metadata in mobile session detail payloads', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.sessions[0].isGitRepo = true;
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}`
			);

			expect(detail.session).toMatchObject({
				id: workbench.primarySessionId,
				isGitRepo: true,
				usageStats: {
					inputTokens: 1200,
					outputTokens: 800,
					totalCostUsd: 0.042,
					contextWindow: 8000,
				},
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns web-safe AI tab drafts and thinking metadata in mobile summaries', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const reviewTab = workbench.sessions[0].aiTabs.find(
			(tab) => tab.id === workbench.primaryReviewTabId
		);
		expect(reviewTab).toBeTruthy();
		reviewTab!.inputValue = 'REST summary review draft';
		reviewTab!.state = 'busy';
		reviewTab!.thinkingStartTime = Date.now() - 3000;
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			) as
				| (WebSessionSummary & {
						aiTabs?: Array<{
							id: string;
							agentSessionId: string | null;
							inputValue: string;
							state: string;
							thinkingStartTime?: number | null;
							createdAt?: number;
							logs?: unknown;
						}>;
				  })
				| undefined;
			const summaryReviewTab = primary?.aiTabs?.find(
				(tab) => tab.id === workbench.primaryReviewTabId
			);

			expect(summaryReviewTab).toMatchObject({
				agentSessionId: `${workbench.primarySessionId}-agent-review`,
				inputValue: 'REST summary review draft',
				state: 'busy',
				thinkingStartTime: expect.any(Number),
				createdAt: expect.any(Number),
			});
			expect(summaryReviewTab).not.toHaveProperty('logs');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps mobile summary previews scoped to the stored active tab', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const reviewTab = workbench.sessions[0].aiTabs.find(
			(tab) => tab.id === workbench.primaryReviewTabId
		);
		expect(reviewTab).toBeTruthy();
		reviewTab!.logs.push({
			id: `${workbench.primarySessionId}-inactive-newer-review-output`,
			timestamp: Date.now() + 120,
			source: 'stdout',
			text: 'Inactive review tab newer output should not replace the active preview.',
		});
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			) as WebSessionSummary | undefined;

			expect(primary?.lastResponse?.text).toContain('Mobile Primary alpha response line one');
			expect(primary?.lastResponse?.text).not.toContain('Inactive review tab newer output');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('keeps bookmarked All Agents groups expanded while regular groups start collapsed', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			await expect(page.getByRole('heading', { name: 'All Agents' })).toBeVisible();
			await expect(
				page.getByRole('button', { name: /Bookmarks group with 1 sessions/i }).last()
			).toHaveAttribute('aria-expanded', 'true');
			await expect(
				page.getByRole('button', { name: /Mobile Ops group with 1 sessions/i }).last()
			).toHaveAttribute('aria-expanded', 'false');
			await expect(
				page.getByRole('button', { name: /Ungrouped group with 2 sessions/i }).last()
			).toHaveAttribute('aria-expanded', 'false');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('selects a busy ungrouped session from the expanded All Agents group', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page.getByRole('button', { name: /Search 3 sessions/i }).click();
			const ungrouped = page
				.getByRole('button', {
					name: /Ungrouped group with 2 sessions/i,
				})
				.last();
			await expect(ungrouped).toHaveAttribute('aria-expanded', 'false');
			await ungrouped.click();
			await expect(ungrouped).toHaveAttribute('aria-expanded', 'true');
			await page
				.getByRole('button', { name: /Mobile Busy Agent session, Thinking.+ai mode/i })
				.last()
				.click();

			await expect(page).toHaveURL(new RegExp(`/session/${workbench.busySessionId}`));
			await expect(page.getByText('Mobile Busy Agent alpha response line one')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns encoded mobile history for project paths with spaces', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const specialProjectPath = path.join(workbench.homeDir, 'project with spaces');
		fs.mkdirSync(specialProjectPath, { recursive: true });
		const specialSessionId = `web-mobile-history-spaces-${Date.now()}`;
		const launched = await launchWebWorkbench(workbench);
		const { electronApp, window: appWindow, userDataPath } = launched;
		seedHistory(userDataPath, specialSessionId, specialProjectPath, [
			{
				id: `${specialSessionId}-entry`,
				type: 'USER',
				timestamp: Date.now() + 700,
				summary: 'Encoded project path mobile history entry',
				fullResponse: 'Encoded project path response body.',
				agentSessionId: `${specialSessionId}-agent`,
				sessionName: 'Encoded Project Session',
				projectPath: specialProjectPath,
				sessionId: specialSessionId,
				validated: false,
			},
		]);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const historyPayload = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(specialProjectPath)}`
			);

			expect(historyPayload).toMatchObject({
				count: 1,
				entries: [
					expect.objectContaining({
						sessionId: specialSessionId,
						projectPath: specialProjectPath,
						summary: 'Encoded project path mobile history entry',
					}),
				],
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('merges global mobile history across multiple session files newest first', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const secondaryHistoryId = `${workbench.secondarySessionId}-history-newest`;
		const launched = await launchWebWorkbench(workbench);
		const { electronApp, window: appWindow, userDataPath } = launched;
		seedHistory(userDataPath, workbench.secondarySessionId, workbench.projectDir, [
			{
				id: secondaryHistoryId,
				type: 'AUTO',
				timestamp: Date.now() + 800,
				summary: 'Secondary mobile history is newest',
				fullResponse: 'Secondary global history response.',
				agentSessionId: `${workbench.secondarySessionId}-agent-history`,
				sessionName: 'Mobile Secondary',
				projectPath: workbench.projectDir,
				sessionId: workbench.secondarySessionId,
				success: true,
			},
		]);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const historyPayload = await getJson(page, `${dashboardUrl}/api/history`);

			expect(historyPayload.count).toBe(3);
			expect(historyPayload.entries[0]).toMatchObject({
				id: secondaryHistoryId,
				sessionId: workbench.secondarySessionId,
				summary: 'Secondary mobile history is newest',
			});
			expect(historyPayload.entries[0].timestamp).toBeGreaterThan(
				historyPayload.entries[1].timestamp
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns secondary mobile history from an independent session file', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const secondaryHistoryId = `${workbench.secondarySessionId}-history-only`;
		const launched = await launchWebWorkbench(workbench);
		const { electronApp, window: appWindow, userDataPath } = launched;
		seedHistory(userDataPath, workbench.secondarySessionId, workbench.projectDirTwo, [
			{
				id: secondaryHistoryId,
				type: 'USER',
				timestamp: Date.now() + 650,
				summary: 'Secondary session-only mobile history',
				fullResponse: 'Secondary session-only response body.',
				agentSessionId: `${workbench.secondarySessionId}-agent-history`,
				sessionName: 'Mobile Secondary',
				projectPath: workbench.projectDirTwo,
				sessionId: workbench.secondarySessionId,
				validated: true,
			},
		]);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const historyPayload = await getJson(
				page,
				`${dashboardUrl}/api/history?sessionId=${workbench.secondarySessionId}`
			);

			expect(historyPayload).toMatchObject({
				count: 1,
				entries: [
					expect.objectContaining({
						id: secondaryHistoryId,
						projectPath: workbench.projectDirTwo,
						validated: true,
					}),
				],
			});
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('returns project-filtered mobile history across multiple session files', async ({
		page,
	}) => {
		const workbench = createWebMobileWorkbench();
		const secondaryHistoryId = `${workbench.secondarySessionId}-shared-project-history`;
		const launched = await launchWebWorkbench(workbench);
		const { electronApp, window: appWindow, userDataPath } = launched;
		seedHistory(userDataPath, workbench.secondarySessionId, workbench.projectDir, [
			{
				id: secondaryHistoryId,
				type: 'AUTO',
				timestamp: Date.now() + 750,
				summary: 'Secondary shared-project mobile history',
				fullResponse: 'Secondary shared-project response body.',
				agentSessionId: `${workbench.secondarySessionId}-agent-history`,
				sessionName: 'Mobile Secondary',
				projectPath: workbench.projectDir,
				sessionId: workbench.secondarySessionId,
				success: true,
			},
		]);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const historyPayload = await getJson(
				page,
				`${dashboardUrl}/api/history?projectPath=${encodeURIComponent(workbench.projectDir)}`
			);

			expect(historyPayload.count).toBe(3);
			expect(historyPayload.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: secondaryHistoryId,
						sessionId: workbench.secondarySessionId,
						projectPath: workbench.projectDir,
					}),
				])
			);
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows ready AI metadata in the mobile session info popover', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page
				.getByRole('button', { name: /Mobile Primary session, idle, ai mode, active/i })
				.first()
				.click({ button: 'right' });
			const dialog = page.getByRole('dialog', { name: /Session info for Mobile Primary/ });

			await expect(dialog.getByText('Ready')).toBeVisible();
			await expect(dialog.getByText('Codex')).toBeVisible();
			await expect(dialog.getByText('AI Assistant')).toBeVisible();
			await expect(dialog.locator(`[title="${workbench.projectDir}"]`)).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows terminal metadata in the mobile session info popover', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page
				.getByRole('button', { name: /Ungrouped group with 2 sessions/i })
				.first()
				.click();
			await page
				.getByRole('button', { name: /Mobile Secondary session, idle, terminal mode/i })
				.click({ button: 'right' });
			const dialog = page.getByRole('dialog', { name: /Session info for Mobile Secondary/ });

			await expect(dialog.getByText('Ready')).toBeVisible();
			await expect(dialog.getByText('Codex')).toBeVisible();
			await expect(dialog.getByText('Command Terminal')).toBeVisible();
			await expect(dialog.locator(`[title="${workbench.projectDirTwo}"]`)).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows busy metadata in the mobile session info popover', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page
				.getByRole('button', { name: /Ungrouped group with 2 sessions/i })
				.first()
				.click();
			await page
				.getByRole('button', { name: /Mobile Busy Agent session, busy, ai mode/i })
				.click({ button: 'right' });
			const dialog = page.getByRole('dialog', { name: /Session info for Mobile Busy Agent/ });

			await expect(dialog.getByText('Thinking...')).toBeVisible();
			await expect(dialog.getByText('AI Assistant')).toBeVisible();
			await expect(dialog.locator(`[title="${workbench.projectDir}"]`)).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows connecting metadata in the mobile session info popover', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.sessions[0].state = 'connecting';
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page
				.getByRole('button', { name: /Mobile Primary session, connecting, ai mode, active/i })
				.first()
				.click({ button: 'right' });
			const dialog = page.getByRole('dialog', { name: /Session info for Mobile Primary/ });

			await expect(dialog.getByText('Connecting...')).toBeVisible();
			await expect(dialog.getByText('AI Assistant')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('shows error metadata in the mobile session info popover', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		workbench.sessions[0].state = 'error';
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			await startWebServer(appWindow);
			const sessionUrl = await toggleLive(appWindow, workbench.primarySessionId);
			await page.setViewportSize({ width: 430, height: 820 });
			await page.goto(sessionUrl);

			await page
				.getByRole('button', { name: /Mobile Primary session, error, ai mode, active/i })
				.first()
				.click({ button: 'right' });
			const dialog = page.getByRole('dialog', { name: /Session info for Mobile Primary/ });

			await expect(dialog.getByText('Error')).toBeVisible();
			await expect(dialog.getByText('AI Assistant')).toBeVisible();
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('omits desktop-only fields from mobile session summaries', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			);

			expect(primary).not.toHaveProperty('fullPath');
			expect(primary).not.toHaveProperty('projectRoot');
			expect(primary).not.toHaveProperty('aiPid');
			expect(primary).not.toHaveProperty('terminalPid');
			expect(primary).not.toHaveProperty('fileTree');
			expect(primary).not.toHaveProperty('executionQueue');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('omits desktop-only fields from mobile session detail payloads', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const detail = await getJson(
				page,
				`${dashboardUrl}/api/session/${workbench.primarySessionId}`
			);

			expect(detail.session).not.toHaveProperty('fullPath');
			expect(detail.session).not.toHaveProperty('projectRoot');
			expect(detail.session).not.toHaveProperty('aiPid');
			expect(detail.session).not.toHaveProperty('terminalPid');
			expect(detail.session).not.toHaveProperty('fileTree');
			expect(detail.session).not.toHaveProperty('executionQueue');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});

	test('omits raw transcript arrays from mobile session summaries', async ({ page }) => {
		const workbench = createWebMobileWorkbench();
		const { electronApp, window: appWindow } = await launchWebWorkbench(workbench);

		try {
			const dashboardUrl = await startWebServer(appWindow);
			const sessionsPayload = await getJson(page, `${dashboardUrl}/api/sessions`);
			const primary = sessionsPayload.sessions.find(
				(session: WebSessionSummary) => session.id === workbench.primarySessionId
			) as WebSessionSummary | undefined;

			expect(primary).not.toHaveProperty('aiLogs');
			expect(primary).not.toHaveProperty('shellLogs');
			expect(primary?.aiTabs?.[0]).not.toHaveProperty('logs');
			expect(primary?.aiTabs?.[0]).not.toHaveProperty('stagedImages');
		} finally {
			await stopWebServer(appWindow).catch(() => {});
			await electronApp.close();
		}
	});
});
