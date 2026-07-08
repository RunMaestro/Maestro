/**
 * E2E Tests: debug, confirmation, and accessibility smoke tranches.
 *
 * These scenarios seed local state and stub update IPC. They avoid live
 * provider, network, and Playwright execution during the authoring phase.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
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

const thirdTrancheActiveScenarioMatrix = [
	{ id: 'DA-012', title: 'filters System Log Viewer entries by severity buttons' },
	{ id: 'DA-013', title: 'expands and collapses System Log Viewer structured details' },
	{ id: 'DA-014', title: 'shows update check errors with manual release fallback' },
	{ id: 'DA-015', title: 'rechecks current-version state when beta updates are enabled' },
	{ id: 'DA-016', title: 'keeps update modal open after download failure' },
] as const;

const fourthTrancheActiveScenarioMatrix = [
	{ id: 'DA-017', title: 'confirms System Log Viewer destructive clear action' },
	{ id: 'DA-018', title: 'closes System Log Viewer search from inline keyboard affordance' },
	{ id: 'DA-019', title: 'toggles all System Log Viewer filters off and back on' },
	{ id: 'DA-020', title: 'refreshes update checks from the modal header without network access' },
	{ id: 'DA-021', title: 'opens manual release fallback after update check errors' },
] as const;

const fifthTrancheActiveScenarioMatrix = [
	{ id: 'DA-022', title: 'opens manual release fallback from available update state' },
	{ id: 'DA-023', title: 'opens release history from current update state' },
	{ id: 'DA-024', title: 'opens manual download fallback after update download failure' },
	{ id: 'DA-025', title: 'shows update assets building fallback with release page link' },
	{ id: 'DA-026', title: 'reveals created debug packages through the process runner' },
] as const;

const sixthTrancheActiveScenarioMatrix = [
	{ id: 'DA-027', title: 'renders active AI and terminal processes in Process Monitor' },
	{ id: 'DA-028', title: 'opens Process Monitor details from keyboard selection' },
	{ id: 'DA-029', title: 'refreshes Process Monitor from button and keyboard shortcut' },
	{ id: 'DA-030', title: 'cancels Process Monitor kill confirmation with Escape' },
	{ id: 'DA-031', title: 'confirms Process Monitor kill confirmation with Enter' },
] as const;

const seventhTrancheActiveScenarioMatrix = [
	{ id: 'DA-032', title: 'opens active network error modal with JSON details' },
	{ id: 'DA-033', title: 'dismisses active error details without clearing the banner' },
	{ id: 'DA-034', title: 'hides dismiss controls for non-recoverable permission errors' },
	{ id: 'DA-035', title: 'shows authentication recovery actions for expired credentials' },
	{ id: 'DA-036', title: 'shows crash recovery actions for failed agent processes' },
] as const;

const eighthTrancheActiveScenarioMatrix = [
	{ id: 'DA-037', title: 'clears recoverable active errors from the banner control' },
	{ id: 'DA-038', title: 'shows context-limit recovery actions for token exhaustion' },
	{ id: 'DA-039', title: 'shows retry guidance for rate-limited agent errors' },
	{ id: 'DA-040', title: 'shows generic recovery for missing provider sessions' },
	{ id: 'DA-041', title: 'shows generic recovery for unknown agent errors' },
] as const;

const ninthTrancheActiveScenarioMatrix = [
	{ id: 'DA-042', title: 'toggles active error JSON details closed after expanding' },
	{ id: 'DA-043', title: 'omits JSON detail controls when structured details are unavailable' },
	{ id: 'DA-044', title: 'closes recoverable error details from the modal header' },
	{ id: 'DA-045', title: 'closes recoverable error details with Escape' },
	{ id: 'DA-046', title: 'hides the header close control for non-recoverable errors' },
] as const;

const tenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-047', title: 'opens the Maestro website from the About modal header' },
	{ id: 'DA-048', title: 'opens Discord from the About modal header' },
	{ id: 'DA-049', title: 'opens documentation from the About modal header' },
	{ id: 'DA-050', title: 'opens the project GitHub link from the About modal body' },
	{ id: 'DA-051', title: 'opens the creator LinkedIn link from the About modal body' },
] as const;

const eleventhTrancheActiveScenarioMatrix = [
	{ id: 'DA-052', title: 'opens the creator GitHub link from the About modal body' },
	{ id: 'DA-053', title: 'closes the About modal from the header control' },
	{ id: 'DA-054', title: 'closes the About modal with Escape' },
	{ id: 'DA-055', title: 'opens leaderboard registration from the About modal' },
	{ id: 'DA-056', title: 'closes leaderboard registration opened from About with Escape' },
] as const;

const twelfthTrancheActiveScenarioMatrix = [
	{ id: 'DA-057', title: 'collapses auto-expanded update release notes' },
	{ id: 'DA-058', title: 're-expands collapsed update release notes' },
	{ id: 'DA-059', title: 'closes the update check modal with Escape' },
	{ id: 'DA-060', title: 'closes the debug package modal from footer cancel' },
	{ id: 'DA-061', title: 'closes the successful debug package modal with Done' },
] as const;

const thirteenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-062', title: 'toggles update pre-release checks back to stable releases' },
	{ id: 'DA-063', title: 'refreshes update check errors from the modal header' },
	{ id: 'DA-064', title: 'closes update check errors with Escape' },
	{ id: 'DA-065', title: 'closes debug package creation errors from footer cancel' },
	{ id: 'DA-066', title: 'copies successful debug package paths from the success state' },
] as const;

const fourteenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-067', title: 'shows the empty Process Monitor state without active processes' },
	{ id: 'DA-068', title: 'collapses all Process Monitor process rows' },
	{ id: 'DA-069', title: 'returns from Process Monitor details with Escape' },
	{ id: 'DA-070', title: 'returns from Process Monitor details with the Back control' },
	{ id: 'DA-071', title: 'closes the Process Monitor from the header control' },
] as const;

const fifteenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-072', title: 'closes the System Log Viewer from the header control' },
	{ id: 'DA-073', title: 'closes the System Log Viewer with Escape' },
	{ id: 'DA-074', title: 'shows individual System Log Viewer structured details' },
	{ id: 'DA-075', title: 'hides individual System Log Viewer structured details' },
	{ id: 'DA-076', title: 'shows unmatched System Log Viewer search state' },
] as const;

const sixteenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-077', title: 'cancels Process Monitor kill confirmation from the button' },
	{ id: 'DA-078', title: 'dismisses Process Monitor kill confirmation from the backdrop' },
	{ id: 'DA-079', title: 'confirms Process Monitor kill confirmation from the button' },
	{ id: 'DA-080', title: 'keeps Process Monitor entries after cancelled kill refresh' },
	{ id: 'DA-081', title: 'kills only the selected Process Monitor process' },
] as const;

const seventeenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-082', title: 'cancels System Log clear confirmation with Escape' },
	{ id: 'DA-083', title: 'closes System Log clear confirmation from the header control' },
	{ id: 'DA-084', title: 'keeps System Log clear confirmation open after backdrop clicks' },
	{ id: 'DA-085', title: 'confirms System Log clear action from focused Enter' },
	{ id: 'DA-086', title: 'preserves severity filters after cancelled System Log clear' },
] as const;

const eighteenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-087', title: 'closes Process Monitor list view with Escape' },
	{ id: 'DA-088', title: 'shows Process Monitor keyboard navigation help' },
	{ id: 'DA-089', title: 'opens Process Monitor details through arrow-key navigation' },
	{ id: 'DA-090', title: 'collapses selected Process Monitor groups with Space' },
	{ id: 'DA-091', title: 'restores selected Process Monitor groups with Enter' },
] as const;

const nineteenthTrancheActiveScenarioMatrix = [
	{ id: 'DA-092', title: 'opens terminal process details with ArrowUp selection' },
	{ id: 'DA-093', title: 'collapses selected Process Monitor groups with ArrowLeft' },
	{ id: 'DA-094', title: 'expands selected Process Monitor groups with ArrowRight' },
	{ id: 'DA-095', title: 'moves Process Monitor selection to child sessions with ArrowRight' },
	{ id: 'DA-096', title: 'refreshes Process Monitor with lowercase keyboard shortcut' },
] as const;

const twentiethTrancheActiveScenarioMatrix = [
	{ id: 'DA-097', title: 'opens Process Monitor details from double-clicked process rows' },
	{ id: 'DA-098', title: 'closes Process Monitor from the process detail header control' },
	{ id: 'DA-099', title: 'shows terminal process metadata in Process Monitor details' },
	{ id: 'DA-100', title: 'navigates from Process Monitor rows to the owning session' },
	{ id: 'DA-101', title: 'reports Process Monitor session totals and running status' },
] as const;

const twentyFirstTrancheActiveScenarioMatrix = [
	{ id: 'DA-102', title: 'selects the first Process Monitor node with ArrowDown' },
	{ id: 'DA-103', title: 'moves Process Monitor child selection back to its parent' },
	{ id: 'DA-104', title: 'opens Process Monitor details with Space on selected processes' },
	{ id: 'DA-105', title: 'restores collapsed Process Monitor rows from Expand all' },
	{ id: 'DA-106', title: 'opens clicked Process Monitor rows with Enter' },
] as const;

const twentySecondTrancheActiveScenarioMatrix = [
	{ id: 'DA-107', title: 'shows the empty System Log Viewer state without logs' },
	{ id: 'DA-108', title: 'reports seeded System Log Viewer entry counts' },
	{ id: 'DA-109', title: 'focuses System Log Viewer search from keyboard shortcut' },
	{ id: 'DA-110', title: 'hides System Log Viewer footer hint while search is open' },
	{ id: 'DA-111', title: 'updates System Log Viewer expand collapse disabled states' },
] as const;

const twentyThirdTrancheActiveScenarioMatrix = [
	{ id: 'DA-112', title: 'shows Debug Package privacy exclusion copy' },
	{ id: 'DA-113', title: 'exposes Debug Package categories as checked checkboxes' },
	{ id: 'DA-114', title: 'toggles Debug Package categories through checkbox roles' },
	{ id: 'DA-115', title: 'restores Debug Package category selection from checkboxes' },
	{ id: 'DA-116', title: 'shows Debug Package submission instructions' },
] as const;

const twentyFourthTrancheActiveScenarioMatrix = [
	{ id: 'DA-117', title: 'shows update modal version delta copy' },
	{ id: 'DA-118', title: 'shows auto-expanded update release notes content' },
	{ id: 'DA-119', title: 'shows available update download and manual controls' },
	{ id: 'DA-120', title: 'toggles update pre-release setting through checkbox role' },
	{ id: 'DA-121', title: 'shows current update release history affordance' },
] as const;

const twentyFifthTrancheActiveScenarioMatrix = [
	{ id: 'DA-122', title: 'reports update download progress from status events' },
	{ id: 'DA-123', title: 'disables the update download action while downloading' },
	{ id: 'DA-124', title: 'shows restart action after update download completes' },
	{ id: 'DA-125', title: 'invokes update install from the restart action' },
	{ id: 'DA-126', title: 'clears stale update download errors after refresh' },
] as const;

const twentySixthTrancheActiveScenarioMatrix = [
	{ id: 'DA-127', title: 'shows unmatched Quick Actions search state' },
	{ id: 'DA-128', title: 'keeps Quick Actions open when returning from group mode' },
	{ id: 'DA-129', title: 'shows Quick Actions group destination controls' },
	{ id: 'DA-130', title: 'shows unmatched Keyboard Shortcuts search state' },
	{ id: 'DA-131', title: 'reports Keyboard Shortcuts mastery progress' },
] as const;

const twentySeventhTrancheActiveScenarioMatrix = [
	{ id: 'DA-132', title: 'hides Quick Actions debug commands by default' },
	{ id: 'DA-133', title: 'reveals Quick Actions debug commands from debug search' },
	{ id: 'DA-134', title: 'opens Quick Actions commands with Enter selection' },
	{ id: 'DA-135', title: 'opens Quick Actions commands with number hotkeys' },
	{ id: 'DA-136', title: 'routes Quick Actions website command through shell open' },
] as const;

const twentyEighthTrancheActiveScenarioMatrix = [
	{ id: 'DA-137', title: 'opens Settings from Quick Actions' },
	{ id: 'DA-138', title: 'opens Settings theme tab from Quick Actions' },
	{ id: 'DA-139', title: 'opens global environment settings from Quick Actions' },
	{ id: 'DA-140', title: 'routes Quick Actions documentation command through shell open' },
	{ id: 'DA-141', title: 'routes Quick Actions Discord command through shell open' },
] as const;

const twentyNinthTrancheActiveScenarioMatrix = [
	{ id: 'DA-142', title: 'exposes Quick Actions accessible dialog semantics' },
	{ id: 'DA-143', title: 'auto-focuses Quick Actions command search' },
	{ id: 'DA-144', title: 'keeps Quick Actions Escape hint visible for keyboard users' },
	{ id: 'DA-145', title: 'moves Quick Actions selection with ArrowDown' },
	{ id: 'DA-146', title: 'closes Quick Actions with Escape from the search field' },
] as const;

const thirtiethTrancheActiveScenarioMatrix = [
	{ id: 'DA-147', title: 'exposes Keyboard Shortcuts accessible dialog semantics' },
	{ id: 'DA-148', title: 'labels Keyboard Shortcuts search for filtering' },
	{ id: 'DA-149', title: 'exposes Keyboard Shortcuts close control by accessible name' },
	{ id: 'DA-150', title: 'keeps Keyboard Shortcuts shortcut rows keyboard-readable' },
	{ id: 'DA-151', title: 'closes Keyboard Shortcuts with Escape' },
] as const;

const thirtyFirstTrancheActiveScenarioMatrix = [
	{ id: 'DA-152', title: 'exposes System Log Viewer accessible dialog semantics' },
	{ id: 'DA-153', title: 'labels System Log Viewer header icon controls' },
	{ id: 'DA-154', title: 'labels System Log Viewer severity filter buttons' },
	{ id: 'DA-155', title: 'preserves System Log Viewer search field accessibility' },
	{ id: 'DA-156', title: 'exposes System Log Viewer empty state accessibly' },
] as const;

const thirtySecondTrancheActiveScenarioMatrix = [
	{ id: 'DA-157', title: 'exposes System Log clear confirmation semantics' },
	{ id: 'DA-158', title: 'focuses System Log clear confirm button by default' },
	{ id: 'DA-159', title: 'keeps System Log clear cancel action keyboard reachable' },
	{ id: 'DA-160', title: 'keeps System Log clear confirm action keyboard reachable' },
	{ id: 'DA-161', title: 'keeps System Log clear confirmation above the parent dialog' },
] as const;

const thirtyThirdTrancheActiveScenarioMatrix = [
	{ id: 'DA-162', title: 'exposes Process Monitor accessible dialog semantics' },
	{ id: 'DA-163', title: 'labels Process Monitor header controls' },
	{ id: 'DA-164', title: 'exposes Process Monitor footer keyboard hint' },
	{ id: 'DA-165', title: 'reports Process Monitor active count accessibly' },
	{ id: 'DA-166', title: 'exposes Process Monitor empty state accessibly' },
] as const;

const thirtyFourthTrancheActiveScenarioMatrix = [
	{ id: 'DA-167', title: 'exposes Process Monitor kill confirmation copy' },
	{ id: 'DA-168', title: 'focuses Process Monitor kill confirmation container' },
	{ id: 'DA-169', title: 'keeps Process Monitor kill cancel action keyboard reachable' },
	{ id: 'DA-170', title: 'keeps Process Monitor kill confirm action keyboard reachable' },
	{ id: 'DA-171', title: 'keeps Process Monitor kill confirmation above the parent dialog' },
] as const;

const thirtyFifthTrancheActiveScenarioMatrix = [
	{ id: 'DA-172', title: 'exposes Debug Package accessible dialog semantics' },
	{ id: 'DA-173', title: 'labels Debug Package category checkboxes' },
	{ id: 'DA-174', title: 'keeps Debug Package generate button disabled with no categories' },
	{ id: 'DA-175', title: 'keeps Debug Package cancel action keyboard reachable' },
	{ id: 'DA-176', title: 'exposes Debug Package privacy warning text' },
] as const;

const thirtySixthTrancheActiveScenarioMatrix = [
	{ id: 'DA-177', title: 'exposes update check accessible dialog semantics' },
	{ id: 'DA-178', title: 'labels update check beta opt-in checkbox' },
	{ id: 'DA-179', title: 'keeps update download action keyboard reachable' },
	{ id: 'DA-180', title: 'keeps update manual download action keyboard reachable' },
	{ id: 'DA-181', title: 'closes update check with the accessible close control' },
] as const;

const thirtySeventhTrancheActiveScenarioMatrix = [
	{ id: 'DA-182', title: 'exposes About Maestro accessible dialog semantics' },
	{ id: 'DA-183', title: 'labels About Maestro documentation link control' },
	{ id: 'DA-184', title: 'labels About Maestro website link control' },
	{ id: 'DA-185', title: 'keeps About Maestro close action keyboard reachable' },
	{ id: 'DA-186', title: 'closes About Maestro with Escape' },
] as const;

const thirtyEighthTrancheActiveScenarioMatrix = [
	{ id: 'DA-187', title: 'keeps Quick Actions Settings result accessible by button role' },
	{ id: 'DA-188', title: 'keeps Quick Actions System Logs result accessible by button role' },
	{ id: 'DA-189', title: 'keeps Quick Actions Process Monitor result accessible by button role' },
	{ id: 'DA-190', title: 'keeps Quick Actions About result accessible by button role' },
	{ id: 'DA-191', title: 'keeps Quick Actions Debug Package result accessible by button role' },
] as const;

const thirtyNinthTrancheActiveScenarioMatrix = [
	{ id: 'DA-192', title: 'keeps final Quick Actions no-result state accessible' },
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

type UpdateCheckStubPayload = {
	checkMode: 'available' | 'current' | 'error';
	downloadMode: 'success' | 'error';
	assetsReady: boolean;
};

type StubbedUpdateState = {
	checkCalls: boolean[];
	downloadCalls: number;
	installCalls: number;
};

type StubbedUpdateStatus = {
	status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
	progress?: {
		percent: number;
		bytesPerSecond: number;
		total: number;
		transferred: number;
	};
	error?: string;
	info?: {
		version: string;
	};
};

type StubbedShellOpenExternalState = {
	urls: string[];
};

type StubbedProcessRunCommandConfig = {
	sessionId?: string;
	command?: string;
	cwd?: string;
	shell?: string;
};

type StubbedProcessRunCommandState = {
	configs: StubbedProcessRunCommandConfig[];
};

type StubbedActiveProcess = {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime: number;
	command?: string;
	args?: string[];
};

async function toggleDebugPackageCategory(debugPackageDialog: Locator, categoryName: string) {
	await expect(
		debugPackageDialog.getByRole('checkbox', { name: new RegExp(categoryName) })
	).toBeAttached();
	await debugPackageDialog.getByText(categoryName, { exact: true }).click();
}

type StubbedActiveProcessState = {
	processes: StubbedActiveProcess[];
	getCalls: number;
	killCalls: string[];
};

type DebugAccessibilityAgentErrorType =
	| 'auth_expired'
	| 'token_exhaustion'
	| 'rate_limited'
	| 'network_error'
	| 'agent_crashed'
	| 'permission_denied'
	| 'session_not_found'
	| 'unknown';

type DebugAccessibilityAgentError = {
	type: DebugAccessibilityAgentErrorType;
	message: string;
	recoverable: boolean;
	agentId: string;
	sessionId: string;
	timestamp: number;
	raw?: {
		exitCode?: number;
		stderr?: string;
		stdout?: string;
		errorLine?: string;
	};
	parsedJson?: unknown;
};

type DebugAccessibilityWorkbenchOptions = {
	agentError?: Partial<DebugAccessibilityAgentError> &
		Pick<DebugAccessibilityAgentError, 'type' | 'message' | 'recoverable'>;
	settings?: Record<string, unknown>;
};

function createDebugAccessibilityWorkbench(options: DebugAccessibilityWorkbenchOptions = {}) {
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
	const agentError: DebugAccessibilityAgentError | undefined = options.agentError
		? {
				agentId: 'codex',
				sessionId,
				timestamp: now + 250,
				raw: {
					exitCode: 7,
					stderr: 'debug accessibility active error stderr sentinel',
				},
				parsedJson: {
					code: 'debug_accessibility_active_error',
					retryable: options.agentError.recoverable,
				},
				...options.agentError,
			}
		: undefined;

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
				state: agentError ? 'error' : 'idle',
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
						agentError,
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: agentError ? 'error' : 'idle',
					},
				],
				activeTabId: aiTabId,
				agentError,
				agentErrorTabId: agentError ? aiTabId : undefined,
				agentErrorPaused: !!agentError,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: aiTabId }],
				unifiedClosedTabHistory: [],
			},
		],
	};
}

async function launchDebugAccessibilityWorkbench(options: DebugAccessibilityWorkbenchOptions = {}) {
	const seeded = createDebugAccessibilityWorkbench(options);
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
		settings: options.settings,
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

async function openSystemLogClearConfirmation(page: Page, logViewer: Locator) {
	await logViewer.getByTitle('Clear logs').click();
	const confirmDialog = page.getByRole('dialog', { name: 'Confirm' });
	await expect(confirmDialog).toBeVisible();
	return confirmDialog;
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

function getSystemLogEntry(logViewer: Locator, message: string) {
	return logViewer
		.getByText(message, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "rounded") and contains(@class, "border")][1]');
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

async function stubUpdateWorkflowHandlers(
	electronApp: ElectronApplication,
	options: Partial<UpdateCheckStubPayload> = {}
) {
	const payload: UpdateCheckStubPayload = {
		checkMode: options.checkMode ?? 'available',
		downloadMode: options.downloadMode ?? 'success',
		assetsReady: options.assetsReady ?? true,
	};

	await electronApp.evaluate(({ ipcMain }, stubPayload: UpdateCheckStubPayload) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eUpdateState?: StubbedUpdateState;
		};
		state.__maestroE2eUpdateState = { checkCalls: [], downloadCalls: 0, installCalls: 0 };

		ipcMain.removeHandler('updates:check');
		ipcMain.handle('updates:check', async (_event, includePrerelease: boolean = false) => {
			state.__maestroE2eUpdateState!.checkCalls.push(includePrerelease);
			if (stubPayload.checkMode === 'error') {
				throw new Error('Update check failure sentinel');
			}
			if (stubPayload.checkMode === 'current') {
				const version = includePrerelease ? '0.16.0-beta.1' : '0.16.0';
				return {
					currentVersion: version,
					latestVersion: version,
					updateAvailable: false,
					versionsBehind: 0,
					assetsReady: stubPayload.assetsReady,
					releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
					releases: [],
				};
			}

			return {
				currentVersion: '0.15.3',
				latestVersion: '0.16.0',
				updateAvailable: true,
				versionsBehind: 1,
				assetsReady: stubPayload.assetsReady,
				releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
				releases: [
					{
						tag_name: 'v0.16.0',
						name: 'v0.16.0 | Debug Accessibility Fallback',
						body: '### Deterministic release notes\n\n- Adds update fallback coverage.',
						html_url: 'https://github.com/RunMaestro/Maestro/releases/tag/v0.16.0',
						published_at: '2026-05-29T12:00:00.000Z',
					},
				],
			};
		});

		ipcMain.removeHandler('updates:download');
		ipcMain.handle('updates:download', async () => {
			state.__maestroE2eUpdateState!.downloadCalls += 1;
			if (stubPayload.downloadMode === 'error') {
				return { success: false, error: 'Update download failure sentinel' };
			}
			return { success: true };
		});

		ipcMain.removeHandler('updates:install');
		ipcMain.handle('updates:install', async () => {
			state.__maestroE2eUpdateState!.installCalls += 1;
		});

		ipcMain.removeHandler('updates:getStatus');
		ipcMain.handle('updates:getStatus', async () => ({ status: 'idle' }));
	}, payload);
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

async function getStubbedUpdateState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eUpdateState?: StubbedUpdateState;
		};
		return state.__maestroE2eUpdateState ?? null;
	});
}

async function emitStubbedUpdateStatus(
	electronApp: ElectronApplication,
	status: StubbedUpdateStatus
) {
	await electronApp.evaluate(({ BrowserWindow }, updateStatus: StubbedUpdateStatus) => {
		const appWindow = BrowserWindow.getAllWindows()[0];
		appWindow?.webContents.send('updates:status', updateStatus);
	}, status);
}

async function stubShellOpenExternal(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eShellOpenExternalState?: StubbedShellOpenExternalState;
		};
		state.__maestroE2eShellOpenExternalState = { urls: [] };

		ipcMain.removeHandler('shell:openExternal');
		ipcMain.handle('shell:openExternal', async (_event, url: string) => {
			state.__maestroE2eShellOpenExternalState!.urls.push(url);
			return { success: true };
		});
	});
}

async function getStubbedShellOpenExternalState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eShellOpenExternalState?: StubbedShellOpenExternalState;
		};
		return state.__maestroE2eShellOpenExternalState ?? null;
	});
}

async function stubProcessRunCommand(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessRunCommandState?: StubbedProcessRunCommandState;
		};
		state.__maestroE2eProcessRunCommandState = { configs: [] };

		ipcMain.removeHandler('process:runCommand');
		ipcMain.handle('process:runCommand', async (_event, config: StubbedProcessRunCommandConfig) => {
			state.__maestroE2eProcessRunCommandState!.configs.push(config);
			return { exitCode: 0 };
		});
	});
}

async function getStubbedProcessRunCommandState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessRunCommandState?: StubbedProcessRunCommandState;
		};
		return state.__maestroE2eProcessRunCommandState ?? null;
	});
}

async function stubActiveProcesses(
	electronApp: ElectronApplication,
	processes: StubbedActiveProcess[]
) {
	await electronApp.evaluate(({ ipcMain }, seededProcesses: StubbedActiveProcess[]) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eActiveProcessState?: StubbedActiveProcessState;
		};
		state.__maestroE2eActiveProcessState = {
			processes: seededProcesses,
			getCalls: 0,
			killCalls: [],
		};

		ipcMain.removeHandler('process:getActiveProcesses');
		ipcMain.handle('process:getActiveProcesses', async () => {
			state.__maestroE2eActiveProcessState!.getCalls += 1;
			return state.__maestroE2eActiveProcessState!.processes;
		});

		ipcMain.removeHandler('process:kill');
		ipcMain.handle('process:kill', async (_event, sessionId: string) => {
			state.__maestroE2eActiveProcessState!.killCalls.push(sessionId);
			state.__maestroE2eActiveProcessState!.processes =
				state.__maestroE2eActiveProcessState!.processes.filter(
					(process) => process.sessionId !== sessionId
				);
			return true;
		});
	}, processes);
}

async function getStubbedActiveProcessState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eActiveProcessState?: StubbedActiveProcessState;
		};
		return state.__maestroE2eActiveProcessState ?? null;
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

async function openUpdateCheckFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Check for Updates');
	await quickActionsDialog.getByRole('button', { name: /Check for Updates/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const updateDialog = page.getByRole('dialog', { name: 'Check for Updates' });
	await expect(updateDialog).toBeVisible();
	return updateDialog;
}

async function openShortcutsFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View Shortcuts');
	await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const shortcutsDialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
	await expect(shortcutsDialog).toBeVisible();
	return shortcutsDialog;
}

async function openProcessMonitorFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View System Processes');
	await quickActionsDialog.getByRole('button', { name: /View System Processes/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const processMonitor = page.getByRole('dialog', { name: 'System Processes' });
	await expect(processMonitor).toBeVisible();
	return processMonitor;
}

async function openProcessKillConfirmation(page: Page, processMonitor: Locator) {
	await processMonitor.getByTitle('Expand all').click();
	const aiProcessRow = processMonitor
		.locator('[tabindex="0"]')
		.filter({ hasText: 'Debug Accessibility Agent - AI Agent (codex)' })
		.first();
	await aiProcessRow.hover();
	await aiProcessRow.getByTitle('Kill process').click();
	const confirmDialog = page
		.getByText('Kill Process?', { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
	await expect(confirmDialog).toBeVisible();
	return confirmDialog;
}

async function selectFirstProcessRowWithKeyboard(page: Page, processMonitor: Locator) {
	await processMonitor.focus();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
}

async function openAboutFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('About Maestro');
	await quickActionsDialog.getByRole('button', { name: /About Maestro/ }).click();

	const aboutDialog = page.getByRole('dialog', { name: 'About Maestro' });
	await expect(aboutDialog).toBeVisible();
	return aboutDialog;
}

async function expectDialogSemantics(dialog: Locator, label: string) {
	await expect(dialog).toHaveAttribute('role', 'dialog');
	await expect(dialog).toHaveAttribute('aria-modal', 'true');
	await expect(dialog).toHaveAttribute('aria-label', label);
}

function createStubbedActiveProcesses(
	session: ReturnType<typeof createDebugAccessibilityWorkbench>['sessions'][number],
	projectDir: string
): StubbedActiveProcess[] {
	const aiTabId = session.activeTabId!;
	return [
		{
			sessionId: `${session.id}-ai-${aiTabId}`,
			toolType: 'codex',
			pid: 4242,
			cwd: projectDir,
			isTerminal: false,
			isBatchMode: false,
			startTime: Date.parse('2026-05-29T11:55:00.000Z'),
			command: 'codex',
			args: ['exec', '--cd', projectDir],
		},
		{
			sessionId: `${session.id}-terminal`,
			toolType: 'terminal',
			pid: 4343,
			cwd: projectDir,
			isTerminal: true,
			isBatchMode: false,
			startTime: Date.parse('2026-05-29T11:58:00.000Z'),
			command: '/bin/zsh',
			args: ['-l'],
		},
	];
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

	test(`${thirdTrancheActiveScenarioMatrix[0].id} ${thirdTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.getByRole('button', { name: 'INFO' }).click();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();

			await logViewer.getByRole('button', { name: 'ERROR' }).click();
			await expect(logViewer.getByText('No logs match your filter')).toBeVisible();

			await logViewer.getByRole('button', { name: 'ALL', exact: true }).click();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[1].id} ${thirdTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.getByTitle('Expand all').click();
			await expect(
				logViewer.locator('pre').filter({ hasText: 'debug-accessibility-info' })
			).toBeVisible();
			await expect(
				logViewer.locator('pre').filter({ hasText: 'debug-accessibility-error' })
			).toBeVisible();

			await logViewer.getByTitle('Collapse all').click();
			await expect(
				logViewer.locator('pre').filter({ hasText: 'debug-accessibility-info' })
			).toBeHidden();
			await expect(
				logViewer.locator('pre').filter({ hasText: 'debug-accessibility-error' })
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[2].id} ${thirdTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'error' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText('Update check failure sentinel')).toBeVisible();
			await expect(
				updateDialog.getByRole('button', { name: /Check releases manually/ })
			).toBeVisible();
			expect((await getStubbedUpdateState(launched.electronApp))?.checkCalls).toContain(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[3].id} ${thirdTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'current' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText("You're up to date!")).toBeVisible();
			await expect(updateDialog.getByText('Maestro v0.16.0')).toBeVisible();
			await updateDialog.getByText('Include pre-release updates').click();
			await expect
				.poll(async () => {
					const state = await getStubbedUpdateState(launched.electronApp);
					return state?.checkCalls.some((includePrerelease) => includePrerelease) ?? false;
				})
				.toBe(true);
			await expect(updateDialog.getByText('Maestro v0.16.0-beta.1')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[4].id} ${thirdTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { downloadMode: 'error' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText('Update Available!')).toBeVisible();
			await updateDialog.getByRole('button', { name: 'Download and Install Update' }).click();
			await expect(updateDialog.getByText('Download failed')).toBeVisible();
			await expect(updateDialog.getByText('Update download failure sentinel')).toBeVisible();
			await expect(
				updateDialog.getByRole('button', { name: /Download manually from GitHub/ })
			).toBeVisible();
			expect((await getStubbedUpdateState(launched.electronApp))?.downloadCalls).toBe(1);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[0].id} ${fourthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.getByTitle('Clear logs').click();
			const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
			await expect(confirmDialog).toBeVisible();
			await expect(
				confirmDialog.getByText(
					'Are you sure you want to clear all Maestro system logs? This action cannot be undone.'
				)
			).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Confirm' }).click();

			await expect(confirmDialog).toBeHidden();
			await expect(logViewer.getByText('No logs yet')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toHaveCount(0);
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[1].id} ${fourthTrancheActiveScenarioMatrix[1].title}`, async () => {
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
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeHidden();

			await logViewer.getByRole('button', { name: 'ESC' }).click();
			await expect(searchInput).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[2].id} ${fourthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.getByRole('button', { name: 'INFO', exact: true }).click();
			await logViewer.getByRole('button', { name: 'ERROR', exact: true }).click();
			await expect(logViewer.getByText('No logs match your filter')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeHidden();

			await logViewer.getByRole('button', { name: 'ALL' }).click();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[3].id} ${fourthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			await expect(updateDialog.getByText('Update Available!')).toBeVisible();
			expect((await getStubbedUpdateState(launched.electronApp))?.checkCalls).toEqual([false]);

			await updateDialog.getByTitle('Refresh').click();
			await expect
				.poll(async () => (await getStubbedUpdateState(launched.electronApp))?.checkCalls.length)
				.toBe(2);
			expect((await getStubbedUpdateState(launched.electronApp))?.checkCalls).toEqual([
				false,
				false,
			]);
			await expect(updateDialog.getByText('Update Available!')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[4].id} ${fourthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'error' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText('Update check failure sentinel')).toBeVisible();
			await updateDialog.getByRole('button', { name: /Check releases manually/ }).click();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://github.com/RunMaestro/Maestro/releases',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[0].id} ${fifthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText('Update Available!')).toBeVisible();
			await updateDialog.getByRole('button', { name: /Or download manually from GitHub/ }).click();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://github.com/RunMaestro/Maestro/releases',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[1].id} ${fifthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'current' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText("You're up to date!")).toBeVisible();
			await updateDialog.getByRole('button', { name: /View all releases/ }).click();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://github.com/RunMaestro/Maestro/releases',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[2].id} ${fifthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			await stubUpdateWorkflowHandlers(launched.electronApp, { downloadMode: 'error' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await updateDialog.getByRole('button', { name: 'Download and Install Update' }).click();
			await expect(updateDialog.getByText('Download failed')).toBeVisible();
			await updateDialog.getByRole('button', { name: /Download manually from GitHub/ }).click();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://github.com/RunMaestro/Maestro/releases',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[3].id} ${fifthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			await stubUpdateWorkflowHandlers(launched.electronApp, { assetsReady: false });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText('Binaries are still building...')).toBeVisible();
			await updateDialog.getByRole('button', { name: /Check release page for updates/ }).click();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://github.com/RunMaestro/Maestro/releases',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[4].id} ${fifthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const resultPath = path.join(os.tmpdir(), 'maestro-debug-accessibility-reveal.zip');
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubProcessRunCommand(launched.electronApp);
			await stubDebugPackageHandlers(launched.electronApp, { resultPath });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await debugPackageDialog.getByRole('button', { name: 'Generate Package' }).click();
			await expect(debugPackageDialog.getByText('Package created successfully!')).toBeVisible();
			await debugPackageDialog.getByRole('button', { name: 'Show in Finder' }).click();
			expect((await getStubbedProcessRunCommandState(launched.electronApp))?.configs).toEqual([
				{
					sessionId: 'debug-package',
					command: `open -R "${resultPath}"`,
					cwd: '/',
					shell: '/bin/bash',
				},
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[0].id} ${sixthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(processMonitor.getByText('2 active')).toBeVisible();
			await processMonitor.getByTitle('Expand all').click();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();
			await expect(processMonitor.getByText('PID: 4242')).toBeVisible();
			await expect(processMonitor.getByText('PID: 4343')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[1].id} ${sixthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await processMonitor.getByTitle('Expand all').click();
			const aiProcessRow = processMonitor
				.locator('[tabindex="0"]')
				.filter({ hasText: 'Debug Accessibility Agent - AI Agent (codex)' })
				.first();
			await aiProcessRow.focus();
			await launched.window.keyboard.press('Enter');

			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();
			await expect(detailView.getByText('Process Session ID')).toBeVisible();
			await expect(detailView.getByText(`${launched.sessions[0].id}-ai-`)).toBeVisible();
			await expect(detailView.getByText('Agent Session ID')).toBeVisible();
			await expect(detailView.getByText('codex-debug-accessibility-tab')).toBeVisible();
			await expect(detailView.getByText('Command Line')).toBeVisible();
			await expect(detailView.getByText('codex exec --cd')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[2].id} ${sixthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.getCalls)
				.toBeGreaterThanOrEqual(1);

			await processMonitor.getByTitle('Refresh (R)').click();
			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.getCalls)
				.toBeGreaterThanOrEqual(2);

			await launched.window.keyboard.press('R');
			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.getCalls)
				.toBeGreaterThanOrEqual(3);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[3].id} ${sixthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await processMonitor.getByTitle('Expand all').click();
			await processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)').hover();
			await processMonitor.getByTitle('Kill process').click();
			await expect(launched.window.getByText('Kill Process?')).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(launched.window.getByText('Kill Process?')).toBeHidden();
			expect((await getStubbedActiveProcessState(launched.electronApp))?.killCalls).toEqual([]);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[4].id} ${sixthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await processMonitor.getByTitle('Expand all').click();
			await processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)').hover();
			await processMonitor.getByTitle('Kill process').click();
			await expect(launched.window.getByText('Kill Process?')).toBeVisible();
			await launched.window.keyboard.press('Enter');

			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.killCalls)
				.toEqual([aiProcess.sessionId]);
			await expect(processMonitor.getByText('No running processes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[0].id} ${seventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'network_error',
				message: 'Debug accessibility active network error sentinel',
				recoverable: true,
			},
		});
		try {
			await expect(
				launched.window.getByText('Debug accessibility active network error sentinel')
			).toBeVisible();
			await launched.window.getByRole('button', { name: 'View Details' }).click();

			const errorModal = launched.window.getByRole('dialog', { name: 'Connection Error' });
			await expect(errorModal).toBeVisible();
			await expect(errorModal.getByText('Debug Accessibility Agent')).toBeVisible();
			await expect(errorModal.getByText('Retry Connection')).toBeVisible();
			await expect(errorModal.getByRole('button', { name: 'Dismiss' })).toBeVisible();
			await errorModal.getByRole('button', { name: 'Error Details (JSON)' }).click();
			await expect(errorModal.getByText('debug_accessibility_active_error')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[1].id} ${seventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'network_error',
				message: 'Debug accessibility dismissible details sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Connection Error' });
			await expect(errorModal).toBeVisible();

			await errorModal.getByRole('button', { name: 'Dismiss' }).click();
			await expect(errorModal).toBeHidden();
			await expect(
				launched.window.getByText('Debug accessibility dismissible details sentinel')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[2].id} ${seventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'permission_denied',
				message: 'Debug accessibility non-recoverable permission sentinel',
				recoverable: false,
			},
		});
		try {
			await expect(
				launched.window.getByText('Debug accessibility non-recoverable permission sentinel')
			).toBeVisible();
			await expect(launched.window.getByTitle('Dismiss error')).toHaveCount(0);
			await launched.window.getByRole('button', { name: 'View Details' }).click();

			const errorModal = launched.window.getByRole('dialog', { name: 'Permission Denied' });
			await expect(errorModal).toBeVisible();
			await expect(errorModal.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
			await expect(errorModal.getByText('Try Again')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[3].id} ${seventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'auth_expired',
				message: 'Debug accessibility expired credentials sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Authentication Required' });

			await expect(
				errorModal.getByText('Debug accessibility expired credentials sentinel')
			).toBeVisible();
			await expect(errorModal.getByText('Re-authenticate')).toBeVisible();
			await expect(errorModal.getByText('Log in again to restore access')).toBeVisible();
			await expect(errorModal.getByText('Start New Session')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[4].id} ${seventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'agent_crashed',
				message: 'Debug accessibility crashed process sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Agent Error' });

			await expect(
				errorModal.getByText('Debug accessibility crashed process sentinel')
			).toBeVisible();
			await expect(errorModal.getByText('Restart Agent')).toBeVisible();
			await expect(errorModal.getByText('Respawn the agent process')).toBeVisible();
			await expect(errorModal.getByText('Start New Session')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[0].id} ${eighthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'network_error',
				message: 'Debug accessibility clearable banner sentinel',
				recoverable: true,
			},
		});
		try {
			await expect(
				launched.window.getByText('Debug accessibility clearable banner sentinel')
			).toBeVisible();
			await launched.window.getByTitle('Dismiss error').click();

			await expect(
				launched.window.getByText('Debug accessibility clearable banner sentinel')
			).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[1].id} ${eighthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'token_exhaustion',
				message: 'Debug accessibility context limit sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Context Limit Reached' });

			await expect(
				errorModal.getByText('Debug accessibility context limit sentinel')
			).toBeVisible();
			await expect(errorModal.getByText('Start New Session')).toBeVisible();
			await expect(
				errorModal.getByText('Begin a fresh conversation with full context')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[2].id} ${eighthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'rate_limited',
				message: 'Debug accessibility rate limit sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Rate Limit Exceeded' });

			await expect(errorModal.getByText('Debug accessibility rate limit sentinel')).toBeVisible();
			await expect(errorModal.getByText('Try Again')).toBeVisible();
			await expect(errorModal.getByText('Wait a moment and retry')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[3].id} ${eighthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'session_not_found',
				message: 'Debug accessibility missing session sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Error' });

			await expect(
				errorModal.getByText('Debug accessibility missing session sentinel')
			).toBeVisible();
			await expect(errorModal.getByText('Try Again')).toBeVisible();
			await expect(errorModal.getByText('Retry the operation')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[4].id} ${eighthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'unknown',
				message: 'Debug accessibility unknown error sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Error' });

			await expect(
				errorModal.getByText('Debug accessibility unknown error sentinel')
			).toBeVisible();
			await expect(errorModal.getByText('Try Again')).toBeVisible();
			await expect(errorModal.getByRole('button', { name: 'Dismiss' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[0].id} ${ninthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'network_error',
				message: 'Debug accessibility JSON toggle sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Connection Error' });
			const detailsToggle = errorModal.getByRole('button', { name: 'Error Details (JSON)' });

			await detailsToggle.click();
			await expect(errorModal.getByText('debug_accessibility_active_error')).toBeVisible();
			await detailsToggle.click();
			await expect(errorModal.getByText('debug_accessibility_active_error')).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[1].id} ${ninthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'network_error',
				message: 'Debug accessibility unstructured error sentinel',
				recoverable: true,
				parsedJson: undefined,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Connection Error' });

			await expect(
				errorModal.getByText('Debug accessibility unstructured error sentinel')
			).toBeVisible();
			await expect(errorModal.getByRole('button', { name: 'Error Details (JSON)' })).toHaveCount(0);
			await expect(errorModal.getByText('Retry Connection')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[2].id} ${ninthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'network_error',
				message: 'Debug accessibility header close sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Connection Error' });
			await expect(errorModal).toBeVisible();

			await errorModal.getByRole('button', { name: 'Close modal' }).click();
			await expect(errorModal).toBeHidden();
			await expect(
				launched.window.getByText('Debug accessibility header close sentinel')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[3].id} ${ninthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'network_error',
				message: 'Debug accessibility escape close sentinel',
				recoverable: true,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Connection Error' });
			await expect(errorModal).toBeVisible();

			await launched.window.keyboard.press('Escape');
			await expect(errorModal).toBeHidden();
			await expect(
				launched.window.getByText('Debug accessibility escape close sentinel')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${ninthTrancheActiveScenarioMatrix[4].id} ${ninthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			agentError: {
				type: 'permission_denied',
				message: 'Debug accessibility locked modal sentinel',
				recoverable: false,
			},
		});
		try {
			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const errorModal = launched.window.getByRole('dialog', { name: 'Permission Denied' });

			await expect(errorModal.getByText('Debug accessibility locked modal sentinel')).toBeVisible();
			await expect(errorModal.getByRole('button', { name: 'Close modal' })).toHaveCount(0);
			await expect(errorModal.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[0].id} ${tenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await aboutDialog.getByTitle('Visit runmaestro.ai').click();

			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://runmaestro.ai',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[1].id} ${tenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await aboutDialog.getByTitle('Join our Discord').click();

			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://runmaestro.ai/discord',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[2].id} ${tenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await aboutDialog.getByTitle('Documentation').click();

			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://docs.runmaestro.ai/',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[3].id} ${tenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await aboutDialog
				.getByRole('button', { name: /GitHub/ })
				.first()
				.click();

			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://github.com/RunMaestro/Maestro',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${tenthTrancheActiveScenarioMatrix[4].id} ${tenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await aboutDialog.getByRole('button', { name: 'LinkedIn' }).click();

			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://www.linkedin.com/in/pedramamini/',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[0].id} ${eleventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await aboutDialog.getByRole('button', { name: 'GitHub' }).nth(1).click();

			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://github.com/pedramamini',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[1].id} ${eleventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);
			await expect(aboutDialog).toBeVisible();

			await aboutDialog.getByRole('button', { name: 'Close modal' }).click();

			await expect(aboutDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[2].id} ${eleventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);
			await expect(aboutDialog).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(aboutDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[3].id} ${eleventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await aboutDialog.getByRole('button', { name: 'Join Leaderboard' }).click();

			await expect(aboutDialog).toBeHidden();
			await expect(
				launched.window.getByRole('dialog', { name: 'Register for Leaderboard' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eleventhTrancheActiveScenarioMatrix[4].id} ${eleventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);
			await aboutDialog.getByRole('button', { name: 'Join Leaderboard' }).click();
			const leaderboardDialog = launched.window.getByRole('dialog', {
				name: 'Register for Leaderboard',
			});
			await expect(leaderboardDialog).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(leaderboardDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[0].id} ${twelfthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			const releaseNotes = updateDialog.getByText('Adds update fallback coverage.');

			await expect(releaseNotes).toBeVisible();
			await updateDialog.getByRole('button', { name: /v0\.16\.0/ }).click();

			await expect(releaseNotes).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[1].id} ${twelfthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			const releaseNotes = updateDialog.getByText('Adds update fallback coverage.');
			const releaseToggle = updateDialog.getByRole('button', { name: /v0\.16\.0/ });

			await expect(releaseNotes).toBeVisible();
			await releaseToggle.click();
			await expect(releaseNotes).toBeHidden();
			await releaseToggle.click();

			await expect(releaseNotes).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[2].id} ${twelfthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			await expect(updateDialog).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(updateDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[3].id} ${twelfthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);
			await expect(debugPackageDialog).toBeVisible();

			await debugPackageDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(debugPackageDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twelfthTrancheActiveScenarioMatrix[4].id} ${twelfthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const resultPath = path.join(os.tmpdir(), 'maestro-debug-accessibility-done.zip');
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp, { resultPath });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await debugPackageDialog.getByRole('button', { name: 'Generate Package' }).click();
			await expect(debugPackageDialog.getByText('Package created successfully!')).toBeVisible();
			await debugPackageDialog.getByRole('button', { name: 'Done' }).click();

			await expect(debugPackageDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[0].id} ${thirteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'current' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			const betaToggle = updateDialog.getByText('Include pre-release updates');

			await expect(updateDialog.getByText('Maestro v0.16.0')).toBeVisible();
			await betaToggle.click();
			await expect
				.poll(async () => (await getStubbedUpdateState(launched.electronApp))?.checkCalls)
				.toEqual([false, true]);
			await expect(updateDialog.getByText('Maestro v0.16.0-beta.1')).toBeVisible();
			await betaToggle.click();

			await expect
				.poll(async () => (await getStubbedUpdateState(launched.electronApp))?.checkCalls)
				.toEqual([false, true, false]);
			await expect(updateDialog.getByText('Maestro v0.16.0')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[1].id} ${thirteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'error' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			await expect(updateDialog.getByText('Update check failure sentinel')).toBeVisible();
			expect((await getStubbedUpdateState(launched.electronApp))?.checkCalls).toEqual([false]);

			await updateDialog.getByTitle('Refresh').click();

			await expect
				.poll(async () => (await getStubbedUpdateState(launched.electronApp))?.checkCalls.length)
				.toBe(2);
			expect((await getStubbedUpdateState(launched.electronApp))?.checkCalls).toEqual([
				false,
				false,
			]);
			await expect(updateDialog.getByText('Update check failure sentinel')).toBeVisible();
			await expect(
				updateDialog.getByRole('button', { name: /Check releases manually/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[2].id} ${thirteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'error' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			await expect(updateDialog.getByText('Update check failure sentinel')).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(updateDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[3].id} ${thirteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp, { createMode: 'error' });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await debugPackageDialog.getByRole('button', { name: 'Generate Package' }).click();
			await expect(debugPackageDialog.getByText('Failed to create package')).toBeVisible();
			await debugPackageDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(debugPackageDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirteenthTrancheActiveScenarioMatrix[4].id} ${thirteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const resultPath = path.join(os.tmpdir(), 'maestro-debug-accessibility-copy.zip');
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await launched.window.evaluate(() => {
				Object.defineProperty(navigator, 'clipboard', {
					configurable: true,
					value: {
						writeText: async (text: string) => {
							(
								window as typeof window & { __maestroDebugPackageCopiedPath?: string }
							).__maestroDebugPackageCopiedPath = text;
						},
					},
				});
			});
			await stubDebugPackageHandlers(launched.electronApp, { resultPath });
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await debugPackageDialog.getByRole('button', { name: 'Generate Package' }).click();
			await expect(debugPackageDialog.getByText('Package created successfully!')).toBeVisible();
			await debugPackageDialog.getByTitle('Copy file path to clipboard').click();

			await expect
				.poll(() =>
					launched.window.evaluate(
						() =>
							(window as typeof window & { __maestroDebugPackageCopiedPath?: string })
								.__maestroDebugPackageCopiedPath
					)
				)
				.toBe(resultPath);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[0].id} ${fourteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(launched.electronApp, []);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(processMonitor.getByText('System Processes')).toBeVisible();
			await expect(processMonitor.getByText('No running processes')).toBeVisible();
			await expect(processMonitor.getByText('0 active')).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[1].id} ${fourteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await processMonitor.getByTitle('Expand all').click();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
			await processMonitor.getByTitle('Collapse all').click();

			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[2].id} ${fourteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await processMonitor.getByTitle('Expand all').click();
			const aiProcessRow = processMonitor
				.locator('[tabindex="0"]')
				.filter({ hasText: 'Debug Accessibility Agent - AI Agent (codex)' })
				.first();
			await aiProcessRow.focus();
			await launched.window.keyboard.press('Enter');
			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(detailView).toBeHidden();
			await expect(launched.window.getByRole('dialog', { name: 'System Processes' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[3].id} ${fourteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await processMonitor.getByTitle('Expand all').click();
			const aiProcessRow = processMonitor
				.locator('[tabindex="0"]')
				.filter({ hasText: 'Debug Accessibility Agent - AI Agent (codex)' })
				.first();
			await aiProcessRow.focus();
			await launched.window.keyboard.press('Enter');
			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();

			await detailView.getByTitle('Back (Esc)').click();

			await expect(detailView).toBeHidden();
			await expect(launched.window.getByRole('dialog', { name: 'System Processes' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourteenthTrancheActiveScenarioMatrix[4].id} ${fourteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(processMonitor).toBeVisible();

			await processMonitor.getByTitle('Close (Esc)').click();

			await expect(processMonitor).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[0].id} ${fifteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			await expect(logViewer).toBeVisible();

			await logViewer.getByTitle('Close log viewer').click();

			await expect(logViewer).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[1].id} ${fifteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			await expect(logViewer).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(logViewer).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[2].id} ${fifteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const infoEntry = getSystemLogEntry(logViewer, 'Debug accessibility info sentinel');

			await infoEntry.getByRole('button', { name: 'Show details' }).click();

			await expect(
				infoEntry.locator('pre').filter({ hasText: 'debug-accessibility-info' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[3].id} ${fifteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const infoEntry = getSystemLogEntry(logViewer, 'Debug accessibility info sentinel');
			const structuredDetails = infoEntry
				.locator('pre')
				.filter({ hasText: 'debug-accessibility-info' });

			await infoEntry.getByRole('button', { name: 'Show details' }).click();
			await expect(structuredDetails).toBeVisible();
			await infoEntry.getByRole('button', { name: 'Hide details' }).click();

			await expect(structuredDetails).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifteenthTrancheActiveScenarioMatrix[4].id} ${fifteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
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
			await searchInput.fill('missing debug accessibility sentinel');

			await expect(logViewer.getByText('No logs match your filter')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[0].id} ${sixteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await launched.window.getByRole('button', { name: 'Cancel' }).click();

			await expect(launched.window.getByText('Kill Process?')).toBeHidden();
			expect((await getStubbedActiveProcessState(launched.electronApp))?.killCalls).toEqual([]);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[1].id} ${sixteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await launched.window
				.locator('div.fixed.inset-0')
				.last()
				.click({ position: { x: 5, y: 5 } });

			await expect(launched.window.getByText('Kill Process?')).toBeHidden();
			expect((await getStubbedActiveProcessState(launched.electronApp))?.killCalls).toEqual([]);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[2].id} ${sixteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			const confirmDialog = await openProcessKillConfirmation(launched.window, processMonitor);

			await confirmDialog.getByRole('button', { name: 'Kill Process', exact: true }).click();

			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.killCalls)
				.toEqual([aiProcess.sessionId]);
			await expect(processMonitor.getByText('No running processes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[3].id} ${sixteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const processes = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, processes);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await launched.window.getByRole('button', { name: 'Cancel' }).click();
			await processMonitor.getByTitle('Refresh (R)').click();

			expect((await getStubbedActiveProcessState(launched.electronApp))?.killCalls).toEqual([]);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixteenthTrancheActiveScenarioMatrix[4].id} ${sixteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess, terminalProcess] = createStubbedActiveProcesses(
			launched.sessions[0],
			launched.projectDir
		);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess, terminalProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			const confirmDialog = await openProcessKillConfirmation(launched.window, processMonitor);

			await confirmDialog.getByRole('button', { name: 'Kill Process', exact: true }).click();

			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.killCalls)
				.toEqual([aiProcess.sessionId]);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[0].id} ${seventeenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await launched.window.keyboard.press('Escape');

			await expect(confirmDialog).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[1].id} ${seventeenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await confirmDialog.getByRole('button', { name: 'Close modal' }).click();

			await expect(confirmDialog).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[2].id} ${seventeenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await confirmDialog.click({ position: { x: 5, y: 5 } });

			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[3].id} ${seventeenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);
			await expect(confirmDialog.getByRole('button', { name: 'Confirm' })).toBeFocused();

			await launched.window.keyboard.press('Enter');

			await expect(confirmDialog).toBeHidden();
			await expect(logViewer.getByText('No logs yet')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toHaveCount(0);
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventeenthTrancheActiveScenarioMatrix[4].id} ${seventeenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.getByRole('button', { name: 'INFO' }).click();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(confirmDialog).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeHidden();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
			await logViewer.getByRole('button', { name: 'ALL', exact: true }).click();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[0].id} ${eighteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(processMonitor).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(processMonitor).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[1].id} ${eighteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(
				processMonitor.getByText('↑↓ navigate • Enter view details • R refresh')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[2].id} ${eighteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();

			await selectFirstProcessRowWithKeyboard(launched.window, processMonitor);
			await launched.window.keyboard.press('Enter');

			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();
			await expect(detailView.getByText('Debug Accessibility Agent').first()).toBeVisible();
			await expect(detailView.getByText('Process Session ID')).toBeVisible();
			await expect(detailView.getByText(`${launched.sessions[0].id}-ai-`)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[3].id} ${eighteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await processMonitor.focus();
			await launched.window.keyboard.press('ArrowDown');
			await launched.window.keyboard.press('Space');

			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighteenthTrancheActiveScenarioMatrix[4].id} ${eighteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await processMonitor.focus();
			await launched.window.keyboard.press('ArrowDown');
			await launched.window.keyboard.press('Space');
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
			await launched.window.keyboard.press('Enter');

			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[0].id} ${nineteenthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();

			await processMonitor.focus();
			await launched.window.keyboard.press('ArrowUp');
			await launched.window.keyboard.press('Enter');

			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();
			await expect(detailView.getByText(`${launched.sessions[0].id}-terminal`)).toBeVisible();
			await expect(detailView.getByText('/bin/zsh -l')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[1].id} ${nineteenthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await processMonitor.focus();
			await launched.window.keyboard.press('ArrowDown');
			await launched.window.keyboard.press('ArrowLeft');

			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[2].id} ${nineteenthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await processMonitor.focus();
			await launched.window.keyboard.press('ArrowDown');
			await launched.window.keyboard.press('ArrowLeft');
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
			await launched.window.keyboard.press('ArrowRight');

			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[3].id} ${nineteenthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await processMonitor.focus();
			await launched.window.keyboard.press('ArrowDown');
			await launched.window.keyboard.press('ArrowRight');
			await launched.window.keyboard.press('Enter');

			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
			await expect(processMonitor.getByText('Debug Accessibility Agent')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${nineteenthTrancheActiveScenarioMatrix[4].id} ${nineteenthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			await openProcessMonitorFromQuickActions(launched.window);
			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.getCalls)
				.toBeGreaterThanOrEqual(1);

			await launched.window.keyboard.press('r');

			await expect
				.poll(async () => (await getStubbedActiveProcessState(launched.electronApp))?.getCalls)
				.toBeGreaterThanOrEqual(2);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[0].id} ${twentiethTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await processMonitor.getByTitle('Expand all').click();
			const aiProcessRow = processMonitor
				.locator('[tabindex="0"]')
				.filter({ hasText: 'Debug Accessibility Agent - AI Agent (codex)' })
				.first();

			await aiProcessRow.dblclick();

			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();
			await expect(detailView.getByText('Debug Accessibility Agent')).toBeVisible();
			await expect(detailView.getByText('Tool Type')).toBeVisible();
			await expect(detailView.getByText('codex').first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[1].id} ${twentiethTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await processMonitor.getByTitle('Expand all').click();
			const aiProcessRow = processMonitor
				.locator('[tabindex="0"]')
				.filter({ hasText: 'Debug Accessibility Agent - AI Agent (codex)' })
				.first();
			await aiProcessRow.dblclick();
			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();

			await detailView.getByTitle('Close').click();

			await expect(detailView).toBeHidden();
			await expect(launched.window.getByRole('dialog', { name: 'System Processes' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[2].id} ${twentiethTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();

			await launched.window.keyboard.press('ArrowUp');
			await launched.window.keyboard.press('Enter');

			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();
			await expect(detailView.getByText('Tool Type')).toBeVisible();
			await expect(detailView.getByText('Process Type')).toBeVisible();
			await expect(detailView.getByText('terminal').first()).toBeVisible();
			await expect(detailView.getByText('PID')).toBeVisible();
			await expect(detailView.getByText('4343')).toBeVisible();
			await expect(detailView.getByText('Working Directory')).toBeVisible();
			await expect(detailView.getByText(launched.projectDir)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[3].id} ${twentiethTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await processMonitor.getByTitle('Expand all').click();

			await processMonitor.getByTitle('Click to navigate to this session').click();

			await expect(processMonitor).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentiethTrancheActiveScenarioMatrix[4].id} ${twentiethTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(processMonitor.getByText('2 active')).toBeVisible();
			await expect(processMonitor.getByText('1 session • 0 groups')).toBeVisible();
			await expect(processMonitor.getByText('Running').first()).toBeVisible();
			await expect(
				processMonitor.getByText('↑↓ navigate • Enter view details • R refresh')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[0].id} ${twentyFirstTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await processMonitor.focus();
			await launched.window.keyboard.press('ArrowDown');
			await launched.window.keyboard.press('Enter');

			await expect(processMonitor.getByText('UNGROUPED AGENTS')).toBeVisible();
			await expect(processMonitor.getByText('Debug Accessibility Agent')).toBeHidden();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[1].id} ${twentyFirstTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await selectFirstProcessRowWithKeyboard(launched.window, processMonitor);
			await launched.window.keyboard.press('ArrowLeft');
			await launched.window.keyboard.press('Enter');

			await expect(processMonitor.getByText('Debug Accessibility Agent')).toBeVisible();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[2].id} ${twentyFirstTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - AI Agent (codex)')
			).toBeVisible();

			await selectFirstProcessRowWithKeyboard(launched.window, processMonitor);
			await launched.window.keyboard.press('Space');

			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();
			await expect(detailView.getByText('Process Session ID')).toBeVisible();
			await expect(detailView.getByText('codex').first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[3].id} ${twentyFirstTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();

			await processMonitor.getByTitle('Collapse all').click();
			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeHidden();
			await processMonitor.getByTitle('Expand all').click();

			await expect(
				processMonitor.getByText('Debug Accessibility Agent - Terminal Shell')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFirstTrancheActiveScenarioMatrix[4].id} ${twentyFirstTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await processMonitor.getByTitle('Expand all').click();
			const aiProcessRow = processMonitor
				.locator('[tabindex="0"]')
				.filter({ hasText: 'Debug Accessibility Agent - AI Agent (codex)' })
				.first();

			await aiProcessRow.click();
			await launched.window.keyboard.press('Enter');

			const detailView = launched.window.getByRole('dialog', { name: 'Process Details' });
			await expect(detailView).toBeVisible();
			await expect(detailView.getByText('Process Session ID')).toBeVisible();
			await expect(detailView.getByText(`${launched.sessions[0].id}-ai-`)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[0].id} ${twentySecondTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await confirmDialog.getByRole('button', { name: 'Confirm' }).click();
			await expect(confirmDialog).toBeHidden();
			await expect(logViewer.getByText('No logs yet')).toBeVisible();
			await expect(logViewer.getByText('0 entries')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[1].id} ${twentySecondTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.evaluate((element) => {
				element.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
				);
			});
			await logViewer.getByPlaceholder('Search logs...').fill('E2EDebug');
			await expect(logViewer.getByText('2 entries')).toBeVisible();
			await expect(logViewer.getByText('E2EDebug').first()).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility info sentinel')).toBeVisible();
			await expect(logViewer.getByText('Debug accessibility error sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[2].id} ${twentySecondTrancheActiveScenarioMatrix[2].title}`, async () => {
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
			await expect(searchInput).toBeFocused();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[3].id} ${twentySecondTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			await expect(logViewer.getByText('to search')).toBeVisible();

			await logViewer.evaluate((element) => {
				element.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
				);
			});

			await expect(logViewer.getByPlaceholder('Search logs...')).toBeVisible();
			await expect(logViewer.getByText('to search')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySecondTrancheActiveScenarioMatrix[4].id} ${twentySecondTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const expandAll = logViewer.getByTitle('Expand all');
			const collapseAll = logViewer.getByTitle('Collapse all');

			await expect(expandAll).toBeEnabled();
			await expect(collapseAll).toBeDisabled();
			await expandAll.click();

			await expect(expandAll).toBeDisabled();
			await expect(collapseAll).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[0].id} ${twentyThirdTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expect(debugPackageDialog.getByText('Privacy:')).toBeVisible();
			await expect(
				debugPackageDialog.getByText(/does NOT include your conversations/i)
			).toBeVisible();
			await expect(debugPackageDialog.getByText(/API keys/i)).toBeVisible();
			await expect(debugPackageDialog.getByText(/file contents/i)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[1].id} ${twentyThirdTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expect(debugPackageDialog.getByText('5 of 5 selected')).toBeVisible();
			await expect(debugPackageDialog.getByRole('checkbox', { name: /System Logs/ })).toBeChecked();
			await expect(
				debugPackageDialog.getByRole('checkbox', { name: /Error States/ })
			).toBeChecked();
			await expect(
				debugPackageDialog.getByRole('checkbox', { name: /Session Metadata/ })
			).toBeChecked();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[2].id} ${twentyThirdTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);
			const systemLogsCheckbox = debugPackageDialog.getByRole('checkbox', { name: /System Logs/ });

			await toggleDebugPackageCategory(debugPackageDialog, 'System Logs');

			await expect(systemLogsCheckbox).not.toBeChecked();
			await expect(debugPackageDialog.getByText('4 of 5 selected')).toBeVisible();
			await expect(
				debugPackageDialog.getByRole('button', { name: 'Generate Package' })
			).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[3].id} ${twentyThirdTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);
			const systemLogsCheckbox = debugPackageDialog.getByRole('checkbox', { name: /System Logs/ });

			await toggleDebugPackageCategory(debugPackageDialog, 'System Logs');
			await expect(debugPackageDialog.getByText('4 of 5 selected')).toBeVisible();
			await toggleDebugPackageCategory(debugPackageDialog, 'System Logs');

			await expect(systemLogsCheckbox).toBeChecked();
			await expect(debugPackageDialog.getByText('5 of 5 selected')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyThirdTrancheActiveScenarioMatrix[4].id} ${twentyThirdTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expect(debugPackageDialog.getByText('To submit:')).toBeVisible();
			await expect(debugPackageDialog.getByText(/Open a GitHub issue/)).toBeVisible();
			await expect(debugPackageDialog.getByText(/Attach the generated zip file/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[0].id} ${twentyFourthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText('Update Available!')).toBeVisible();
			await expect(
				updateDialog.getByText('You are 1 version behind the latest release.')
			).toBeVisible();
			await expect(updateDialog.getByText('Current: v0.15.3 → Latest: v0.16.0')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[1].id} ${twentyFourthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText('Release Notes', { exact: true })).toBeVisible();
			await expect(updateDialog.getByText(/v0\.16\.0.*Debug Accessibility Fallback/)).toBeVisible();
			await expect(updateDialog.getByText('Adds update fallback coverage.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[2].id} ${twentyFourthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(
				updateDialog.getByRole('button', { name: 'Download and Install Update' })
			).toBeVisible();
			await expect(
				updateDialog.getByRole('button', { name: /Or download manually from GitHub/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[3].id} ${twentyFourthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'current' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);
			const preReleaseCheckbox = updateDialog.getByRole('checkbox', {
				name: /Include pre-release updates/,
			});

			await expect(preReleaseCheckbox).not.toBeChecked();
			await preReleaseCheckbox.click();

			await expect(preReleaseCheckbox).toBeChecked();
			await expect
				.poll(async () => (await getStubbedUpdateState(launched.electronApp))?.checkCalls)
				.toEqual([false, true]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFourthTrancheActiveScenarioMatrix[4].id} ${twentyFourthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'current' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(updateDialog.getByText("You're up to date!")).toBeVisible();
			await expect(updateDialog.getByText('Maestro v0.16.0')).toBeVisible();
			await expect(updateDialog.getByRole('button', { name: 'View all releases' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[0].id} ${twentyFifthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await emitStubbedUpdateStatus(launched.electronApp, {
				status: 'downloading',
				progress: {
					percent: 64,
					bytesPerSecond: 2048,
					total: 4096,
					transferred: 2048,
				},
			});

			await expect(updateDialog.getByText('Downloading update...')).toBeVisible();
			await expect(updateDialog.getByText('64%')).toBeVisible();
			await expect(updateDialog.getByText('2 KB / 4 KB')).toBeVisible();
			await expect(updateDialog.getByText('2 KB/s')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[1].id} ${twentyFifthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await emitStubbedUpdateStatus(launched.electronApp, {
				status: 'downloading',
				progress: {
					percent: 12,
					bytesPerSecond: 1024,
					total: 4096,
					transferred: 512,
				},
			});

			await expect(updateDialog.getByRole('button', { name: 'Downloading...' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[2].id} ${twentyFifthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await emitStubbedUpdateStatus(launched.electronApp, {
				status: 'downloaded',
				info: { version: '0.16.0' },
			});

			await expect(updateDialog.getByRole('button', { name: 'Restart to Update' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[3].id} ${twentyFifthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await emitStubbedUpdateStatus(launched.electronApp, {
				status: 'downloaded',
				info: { version: '0.16.0' },
			});
			await updateDialog.getByRole('button', { name: 'Restart to Update' }).click();

			await expect
				.poll(async () => (await getStubbedUpdateState(launched.electronApp))?.installCalls)
				.toBe(1);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyFifthTrancheActiveScenarioMatrix[4].id} ${twentyFifthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { downloadMode: 'error' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await updateDialog.getByRole('button', { name: 'Download and Install Update' }).click();
			await expect(updateDialog.getByText('Download failed')).toBeVisible();
			await updateDialog.getByTitle('Refresh').click();

			await expect(updateDialog.getByText('Download failed')).toBeHidden();
			await expect
				.poll(async () => (await getStubbedUpdateState(launched.electronApp))?.checkCalls.length)
				.toBe(2);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[0].id} ${twentySixthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('no matching debug accessibility command');

			await expect(quickActionsDialog.getByText('No actions found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[1].id} ${twentySixthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Move to Group');
			await quickActionsDialog.getByRole('button', { name: /Move to Group/ }).click();
			await expect(
				quickActionsDialog.getByPlaceholder('Move Debug Accessibility Agent to...')
			).toBeVisible();

			await quickActionsDialog.getByRole('button', { name: /Back to main menu/ }).click();

			await expect(quickActionsDialog).toBeVisible();
			await expect(
				quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[2].id} ${twentySixthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Move to Group');
			await quickActionsDialog.getByRole('button', { name: /Move to Group/ }).click();

			await expect(quickActionsDialog.getByRole('button', { name: /No Group/ })).toBeVisible();
			await expect(
				quickActionsDialog.getByRole('button', { name: /Create New Group/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[3].id} ${twentySixthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const shortcutsDialog = await openShortcutsFromQuickActions(launched.window);
			await shortcutsDialog.getByPlaceholder('Search shortcuts...').fill('no shortcut sentinel');

			await expect(shortcutsDialog.getByText('No shortcuts found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySixthTrancheActiveScenarioMatrix[4].id} ${twentySixthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench({
			settings: {
				keyboardMasteryStats: {
					usedShortcuts: ['help'],
					currentLevel: 0,
					lastLevelUpTimestamp: 0,
					lastAcknowledgedLevel: 0,
				},
			},
		});
		try {
			const shortcutsDialog = await openShortcutsFromQuickActions(launched.window);

			await expect(shortcutsDialog.getByText(/[1-9]\d* \/ \d+ mastered \(\d+%\)/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[0].id} ${twentySeventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);

			await expect(
				quickActionsDialog.getByRole('button', { name: /Debug: Reset Busy State/ })
			).toBeHidden();
			await expect(
				quickActionsDialog.getByRole('button', { name: /Debug: Log Session State/ })
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[1].id} ${twentySeventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('debug');

			await expect(
				quickActionsDialog.getByRole('button', { name: /Debug: Reset Busy State/ })
			).toBeVisible();
			await expect(
				quickActionsDialog.getByRole('button', { name: /Debug: Copy Install GUID to Clipboard/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[2].id} ${twentySeventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('View System Logs');

			await launched.window.keyboard.press('Enter');

			await expect(quickActionsDialog).toBeHidden();
			await expect(
				launched.window.getByRole('dialog', { name: 'System Log Viewer' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[3].id} ${twentySeventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('About Maestro');

			await launched.window.keyboard.press('Meta+1');

			await expect(quickActionsDialog).toBeHidden();
			await expect(launched.window.getByRole('dialog', { name: 'About Maestro' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentySeventhTrancheActiveScenarioMatrix[4].id} ${twentySeventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Maestro Website');
			await quickActionsDialog.getByRole('button', { name: /Maestro Website/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://runmaestro.ai/',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[0].id} ${twentyEighthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Settings');
			await quickActionsDialog.getByRole('button', { name: /Settings/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			const settingsDialog = launched.window.getByRole('dialog', { name: 'Settings' });
			await expect(settingsDialog).toBeVisible();
			await expect(settingsDialog.getByText('General')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[1].id} ${twentyEighthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Change Theme');
			await quickActionsDialog.getByRole('button', { name: /Change Theme/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			const settingsDialog = launched.window.getByRole('dialog', { name: 'Settings' });
			await expect(settingsDialog).toBeVisible();
			await expect(settingsDialog.getByLabel('Theme picker')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[2].id} ${twentyEighthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Configure Global Environment Variables');
			await quickActionsDialog
				.getByRole('button', { name: /Configure Global Environment Variables/ })
				.click();

			await expect(quickActionsDialog).toBeHidden();
			const settingsDialog = launched.window.getByRole('dialog', { name: 'Settings' });
			await expect(settingsDialog).toBeVisible();
			await expect(settingsDialog.getByText('Global Environment Variables')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[3].id} ${twentyEighthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Documentation');
			await quickActionsDialog
				.getByRole('button', { name: /Documentation and User Guide/ })
				.click();

			await expect(quickActionsDialog).toBeHidden();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://docs.runmaestro.ai/',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyEighthTrancheActiveScenarioMatrix[4].id} ${twentyEighthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubShellOpenExternal(launched.electronApp);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Join Discord');
			await quickActionsDialog.getByRole('button', { name: /Join Discord/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			expect((await getStubbedShellOpenExternalState(launched.electronApp))?.urls).toEqual([
				'https://runmaestro.ai/discord',
			]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[0].id} ${twentyNinthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);

			await expectDialogSemantics(quickActionsDialog, 'Quick Actions');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[1].id} ${twentyNinthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);

			await expect(
				quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
			).toBeFocused();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[2].id} ${twentyNinthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);

			await expect(quickActionsDialog.getByText('ESC')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[3].id} ${twentyNinthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('View');

			await launched.window.keyboard.press('ArrowDown');

			await expect(
				quickActionsDialog.getByRole('button', { name: /View System Logs/ })
			).toBeVisible();
			await expect(
				quickActionsDialog.getByRole('button', { name: /View System Processes/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${twentyNinthTrancheActiveScenarioMatrix[4].id} ${twentyNinthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);

			await launched.window.keyboard.press('Escape');

			await expect(quickActionsDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[0].id} ${thirtiethTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const shortcutsDialog = await openShortcutsFromQuickActions(launched.window);

			await expectDialogSemantics(shortcutsDialog, 'Keyboard Shortcuts');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[1].id} ${thirtiethTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const shortcutsDialog = await openShortcutsFromQuickActions(launched.window);

			await expect(shortcutsDialog.getByPlaceholder('Search shortcuts...')).toBeVisible();
			await shortcutsDialog.getByPlaceholder('Search shortcuts...').fill('help');
			await expect(shortcutsDialog.getByText(/\d+ \/ \d+ mastered/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[2].id} ${thirtiethTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const shortcutsDialog = await openShortcutsFromQuickActions(launched.window);

			await expect(shortcutsDialog.getByRole('button', { name: 'Close modal' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[3].id} ${thirtiethTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const shortcutsDialog = await openShortcutsFromQuickActions(launched.window);

			await expect(shortcutsDialog.locator('kbd').first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtiethTrancheActiveScenarioMatrix[4].id} ${thirtiethTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const shortcutsDialog = await openShortcutsFromQuickActions(launched.window);

			await launched.window.keyboard.press('Escape');

			await expect(shortcutsDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[0].id} ${thirtyFirstTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const logViewer = await openSystemLogViewer(launched.window);

			await expectDialogSemantics(logViewer, 'System Log Viewer');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[1].id} ${thirtyFirstTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const logViewer = await openSystemLogViewer(launched.window);

			await expect(logViewer.getByTitle('Export logs')).toBeVisible();
			await expect(logViewer.getByTitle('Clear logs')).toBeVisible();
			await expect(logViewer.getByTitle('Close log viewer')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[2].id} ${thirtyFirstTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);

			await expect(logViewer.getByRole('button', { name: 'INFO' })).toBeVisible();
			await expect(logViewer.getByRole('button', { name: 'ERROR' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[3].id} ${thirtyFirstTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const logViewer = await openSystemLogViewer(launched.window);

			await logViewer.evaluate((element) => {
				element.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
				);
			});

			await expect(logViewer.getByPlaceholder('Search logs...')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFirstTrancheActiveScenarioMatrix[4].id} ${thirtyFirstTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const logViewer = await openSystemLogViewer(launched.window);
			await logViewer.evaluate((element) => {
				element.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
				);
			});
			await logViewer.getByPlaceholder('Search logs...').fill('__no_matching_log_entry__');

			await expect(logViewer.getByText('No logs match your filter')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySecondTrancheActiveScenarioMatrix[0].id} ${thirtySecondTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await expectDialogSemantics(confirmDialog, 'Confirm');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySecondTrancheActiveScenarioMatrix[1].id} ${thirtySecondTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await expect(confirmDialog.getByRole('button', { name: 'Confirm' })).toBeFocused();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySecondTrancheActiveScenarioMatrix[2].id} ${thirtySecondTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await expect(confirmDialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySecondTrancheActiveScenarioMatrix[3].id} ${thirtySecondTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await expect(confirmDialog.getByRole('button', { name: 'Confirm' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySecondTrancheActiveScenarioMatrix[4].id} ${thirtySecondTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await seedSystemLogs(launched.window);
			const logViewer = await openSystemLogViewer(launched.window);
			const confirmDialog = await openSystemLogClearConfirmation(launched.window, logViewer);

			await expect(confirmDialog).toBeVisible();
			await expect(logViewer).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyThirdTrancheActiveScenarioMatrix[0].id} ${thirtyThirdTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(launched.electronApp, []);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expectDialogSemantics(processMonitor, 'System Processes');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyThirdTrancheActiveScenarioMatrix[1].id} ${thirtyThirdTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(processMonitor.getByTitle('Refresh (R)')).toBeVisible();
			await expect(processMonitor.getByTitle('Expand all')).toBeVisible();
			await expect(processMonitor.getByTitle('Collapse all')).toBeVisible();
			await expect(processMonitor.getByTitle('Close (Esc)')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyThirdTrancheActiveScenarioMatrix[2].id} ${thirtyThirdTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(processMonitor.getByText(/Enter view details.*R refresh/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyThirdTrancheActiveScenarioMatrix[3].id} ${thirtyThirdTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(
				launched.electronApp,
				createStubbedActiveProcesses(launched.sessions[0], launched.projectDir)
			);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(processMonitor.getByText('2 active')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyThirdTrancheActiveScenarioMatrix[4].id} ${thirtyThirdTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubActiveProcesses(launched.electronApp, []);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);

			await expect(processMonitor.getByText('No running processes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFourthTrancheActiveScenarioMatrix[0].id} ${thirtyFourthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await expect(launched.window.getByText('Kill Process?')).toBeVisible();
			await expect(launched.window.getByText(/Any unsaved work may be lost/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFourthTrancheActiveScenarioMatrix[1].id} ${thirtyFourthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await expect(
				launched.window.getByRole('button', { name: 'Kill Process', exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFourthTrancheActiveScenarioMatrix[2].id} ${thirtyFourthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await expect(launched.window.getByRole('button', { name: 'Cancel' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFourthTrancheActiveScenarioMatrix[3].id} ${thirtyFourthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await expect(
				launched.window.getByRole('button', { name: 'Kill Process', exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFourthTrancheActiveScenarioMatrix[4].id} ${thirtyFourthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		const [aiProcess] = createStubbedActiveProcesses(launched.sessions[0], launched.projectDir);
		try {
			await stubActiveProcesses(launched.electronApp, [aiProcess]);
			const processMonitor = await openProcessMonitorFromQuickActions(launched.window);
			await openProcessKillConfirmation(launched.window, processMonitor);

			await expect(launched.window.getByText('Kill Process?')).toBeVisible();
			await expect(processMonitor).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFifthTrancheActiveScenarioMatrix[0].id} ${thirtyFifthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expectDialogSemantics(debugPackageDialog, 'Create Debug Package');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFifthTrancheActiveScenarioMatrix[1].id} ${thirtyFifthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			for (const category of debugPackagePreviewCategories) {
				await expect(
					debugPackageDialog.getByRole('checkbox', { name: new RegExp(category.name) })
				).toBeVisible();
			}
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFifthTrancheActiveScenarioMatrix[2].id} ${thirtyFifthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			for (const category of debugPackagePreviewCategories) {
				await toggleDebugPackageCategory(debugPackageDialog, category.name);
			}

			await expect(
				debugPackageDialog.getByRole('button', { name: 'Generate Package' })
			).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFifthTrancheActiveScenarioMatrix[3].id} ${thirtyFifthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expect(debugPackageDialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyFifthTrancheActiveScenarioMatrix[4].id} ${thirtyFifthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubDebugPackageHandlers(launched.electronApp);
			const debugPackageDialog = await openDebugPackageFromQuickActions(launched.window);

			await expect(
				debugPackageDialog.getByText(/does NOT include your conversations/i)
			).toBeVisible();
			await expect(debugPackageDialog.getByText(/API keys/i)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySixthTrancheActiveScenarioMatrix[0].id} ${thirtySixthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expectDialogSemantics(updateDialog, 'Check for Updates');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySixthTrancheActiveScenarioMatrix[1].id} ${thirtySixthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp, { checkMode: 'current' });
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(
				updateDialog.getByRole('checkbox', { name: /Include pre-release updates/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySixthTrancheActiveScenarioMatrix[2].id} ${thirtySixthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(
				updateDialog.getByRole('button', { name: 'Download and Install Update' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySixthTrancheActiveScenarioMatrix[3].id} ${thirtySixthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await expect(
				updateDialog.getByRole('button', { name: /Or download manually from GitHub/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySixthTrancheActiveScenarioMatrix[4].id} ${thirtySixthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			await stubUpdateWorkflowHandlers(launched.electronApp);
			const updateDialog = await openUpdateCheckFromQuickActions(launched.window);

			await updateDialog.getByRole('button', { name: 'Close modal' }).click();

			await expect(updateDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySeventhTrancheActiveScenarioMatrix[0].id} ${thirtySeventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await expectDialogSemantics(aboutDialog, 'About Maestro');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySeventhTrancheActiveScenarioMatrix[1].id} ${thirtySeventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await expect(aboutDialog.getByTitle('Documentation')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySeventhTrancheActiveScenarioMatrix[2].id} ${thirtySeventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await expect(aboutDialog.getByTitle('Visit runmaestro.ai')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySeventhTrancheActiveScenarioMatrix[3].id} ${thirtySeventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await expect(aboutDialog.getByRole('button', { name: 'Close modal' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtySeventhTrancheActiveScenarioMatrix[4].id} ${thirtySeventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const aboutDialog = await openAboutFromQuickActions(launched.window);

			await launched.window.keyboard.press('Escape');

			await expect(aboutDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyEighthTrancheActiveScenarioMatrix[0].id} ${thirtyEighthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Settings');

			await expect(quickActionsDialog.getByRole('button', { name: /Settings/ })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyEighthTrancheActiveScenarioMatrix[1].id} ${thirtyEighthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('View System Logs');

			await expect(
				quickActionsDialog.getByRole('button', { name: /View System Logs/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyEighthTrancheActiveScenarioMatrix[2].id} ${thirtyEighthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('View System Processes');

			await expect(
				quickActionsDialog.getByRole('button', { name: /View System Processes/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyEighthTrancheActiveScenarioMatrix[3].id} ${thirtyEighthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('About Maestro');

			await expect(quickActionsDialog.getByRole('button', { name: /About Maestro/ })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyEighthTrancheActiveScenarioMatrix[4].id} ${thirtyEighthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Debug Package');

			await expect(
				quickActionsDialog.getByRole('button', { name: /Create Debug Package/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirtyNinthTrancheActiveScenarioMatrix[0].id} ${thirtyNinthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchDebugAccessibilityWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('zzzz no final debug accessibility command');

			await expect(quickActionsDialog.getByText('No actions found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});
});
