/**
 * E2E Tests: wizard, settings, prompts lane coverage.
 *
 * This file keeps the lane deterministic: seeded state only, no live providers,
 * and no network-backed flows.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface DirectorNotesSettings {
	provider?: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	defaultLookbackDays?: number;
}

interface WizardE2ETab {
	id: string;
	saveToHistory?: boolean;
	readOnlyMode?: boolean;
	showThinking?: 'off' | 'on' | 'sticky';
}

interface WizardE2ESession {
	id: string;
	aiTabs?: WizardE2ETab[];
}

declare global {
	interface Window {
		maestro: {
			settings: {
				get: {
					(key: 'encoreFeatures'): Promise<{ directorNotes?: boolean } | undefined>;
					(key: 'directorNotesSettings'): Promise<DirectorNotesSettings>;
					(key: string): Promise<unknown>;
				};
			};
			agents: {
				getConfig: (agentId: string) => Promise<Record<string, unknown>>;
			};
			sessions: {
				getAll: () => Promise<WizardE2ESession[]>;
			};
		};
	}
}

const activeScenarioMatrix = [
	{ id: 'WSP-001', title: 'opens and closes the New Agent Wizard' },
	{ id: 'WSP-002', title: 'renders seeded inline wizard controls' },
	{ id: 'WSP-003', title: 'persists a custom AI command from Settings' },
	{ id: 'WSP-004', title: "opens Director's Notes from Quick Actions when enabled" },
	{ id: 'WSP-005', title: 'inserts a seeded Prompt Composer mention without sending' },
	{ id: 'WSP-006', title: 'preserves inline wizard draft text through Prompt Composer' },
	{ id: 'WSP-007', title: 'cancels inline wizard exit confirmation' },
	{ id: 'WSP-008', title: 'exits inline wizard after explicit confirmation' },
	{ id: 'WSP-009', title: 'closes the New Agent Wizard from the header button' },
	{ id: 'WSP-010', title: 'renders seeded custom AI command settings' },
	{ id: 'WSP-011', title: 'dismisses Prompt Composer mention suggestions before closing' },
	{ id: 'WSP-012', title: 'keeps Prompt Composer send disabled for blank drafts' },
	{ id: 'WSP-013', title: 'shows seeded inline wizard confidence state' },
	{ id: 'WSP-014', title: 'updates Prompt Composer character count for a draft' },
	{ id: 'WSP-015', title: 'persists a Prompt Composer draft from the close button' },
	{ id: 'WSP-016', title: 'filters Settings shortcuts to Prompt Composer commands' },
	{ id: 'WSP-017', title: "hides Director's Notes quick action when disabled" },
	{ id: 'WSP-018', title: "enables Director's Notes settings from Encore features" },
	{ id: 'WSP-019', title: 'marks unavailable New Agent Wizard providers as coming soon' },
	{ id: 'WSP-020', title: 'persists the Settings theme picker selection' },
	{ id: 'WSP-021', title: 'persists the Settings Display font size selection' },
	{ id: 'WSP-022', title: 'toggles Prompt Composer History state from the toolbar' },
	{ id: 'WSP-023', title: 'toggles Prompt Composer Read-Only state from the toolbar' },
	{ id: 'WSP-024', title: "keeps Director's Notes AI Overview disabled until synopsis is ready" },
	{ id: 'WSP-025', title: 'persists the Settings default History toggle' },
	{ id: 'WSP-026', title: 'persists the Settings automatic tab naming toggle' },
	{ id: 'WSP-027', title: 'persists the Display file icon theme selection' },
	{ id: 'WSP-028', title: 'persists the Display auto-hide menu bar toggle' },
	{ id: 'WSP-029', title: 'toggles Prompt Composer enter-to-send mode' },
	{ id: 'WSP-030', title: 'persists the Settings conductor profile draft' },
	{ id: 'WSP-031', title: 'persists the Settings system log level selection' },
	{ id: 'WSP-032', title: 'persists the Settings GitHub CLI custom path' },
	{ id: 'WSP-033', title: 'persists the Display terminal width selection' },
	{ id: 'WSP-034', title: 'toggles Display Document Graph external links default' },
	{ id: 'WSP-035', title: 'persists the Settings custom shell path' },
	{ id: 'WSP-036', title: 'toggles Settings stats collection' },
	{ id: 'WSP-037', title: 'persists the default Usage Dashboard range' },
	{ id: 'WSP-038', title: 'persists Display Bionify mode and intensity' },
	{ id: 'WSP-039', title: 'validates and persists the Display Bionify algorithm' },
	{ id: 'WSP-040', title: 'persists the Settings default thinking mode' },
	{ id: 'WSP-041', title: 'toggles Settings AI output auto-scroll' },
	{ id: 'WSP-042', title: 'toggles Settings spell check' },
	{ id: 'WSP-043', title: 'toggles Settings sleep prevention' },
	{ id: 'WSP-044', title: 'toggles Settings GPU acceleration' },
	{ id: 'WSP-045', title: 'persists the Settings shell arguments field' },
	{ id: 'WSP-046', title: 'toggles Settings terminal Enter-to-send mode' },
	{ id: 'WSP-047', title: 'toggles Settings OS notifications' },
	{ id: 'WSP-048', title: 'persists Settings custom notification command state' },
	{ id: 'WSP-049', title: 'persists Settings toast notification duration' },
	{ id: 'WSP-050', title: 'adds a Settings local file indexing ignore pattern' },
	{ id: 'WSP-051', title: 'removes a Settings local file indexing ignore pattern' },
	{ id: 'WSP-052', title: 'toggles Settings local file indexing gitignore honor' },
	{ id: 'WSP-053', title: 'toggles Settings context window warnings' },
	{ id: 'WSP-054', title: 'adjusts Settings context warning thresholds' },
	{ id: 'WSP-055', title: 'persists Settings max output lines selection' },
	{ id: 'WSP-056', title: 'persists Settings user message alignment' },
	{ id: 'WSP-057', title: 'toggles Settings native title bar preference' },
	{ id: 'WSP-058', title: 'toggles Settings confetti animation preference' },
	{ id: 'WSP-059', title: 'toggles Settings update checks on startup' },
	{ id: 'WSP-060', title: 'cancels a new custom AI command draft in Settings' },
	{ id: 'WSP-061', title: 'edits a seeded custom AI command in Settings' },
	{ id: 'WSP-062', title: 'persists Settings global environment variables' },
	{ id: 'WSP-063', title: 'persists Settings Group Chat standing instructions' },
	{ id: 'WSP-064', title: 'trims pasted Prompt Composer text' },
	{ id: 'WSP-065', title: 'keeps literal Prompt Composer at-text without selecting a mention' },
	{ id: 'WSP-066', title: 'blocks duplicate custom AI command creation in Settings' },
	{ id: 'WSP-067', title: 'deletes a seeded custom AI command in Settings' },
	{ id: 'WSP-068', title: 'rejects invalid Settings global environment variable names' },
	{ id: 'WSP-069', title: 'removes a Settings global environment variable' },
	{ id: 'WSP-070', title: "adjusts Director's Notes default lookback period" },
	{ id: 'WSP-071', title: 'opens Prompt Composer from the keyboard shortcut' },
	{ id: 'WSP-072', title: 'prefixes custom AI commands created without a slash' },
	{ id: 'WSP-073', title: 'adds a Settings SSH remote ignore pattern' },
	{ id: 'WSP-074', title: 'removes a Settings SSH remote ignore pattern' },
	{ id: 'WSP-075', title: 'toggles Settings SSH remote gitignore honor' },
	{ id: 'WSP-076', title: 'uploads a Prompt Composer image and opens the lightbox' },
	{ id: 'WSP-077', title: 'removes a Prompt Composer staged image before sending' },
	{ id: 'WSP-078', title: 'cancels a seeded custom AI command edit in Settings' },
	{ id: 'WSP-079', title: 'shows duplicate Settings SSH remote ignore pattern feedback' },
	{ id: 'WSP-080', title: 'resets Settings SSH remote ignore patterns to defaults' },
	{ id: 'WSP-081', title: 'inserts a tab character in Prompt Composer' },
	{ id: 'WSP-082', title: 'toggles Prompt Composer History with the keyboard shortcut' },
	{ id: 'WSP-083', title: 'toggles Prompt Composer Read-Only with the keyboard shortcut' },
	{ id: 'WSP-084', title: 'inserts a newline with Shift+Enter in Prompt Composer' },
	{ id: 'WSP-085', title: 'opens a staged Prompt Composer image with the keyboard shortcut' },
	{ id: 'WSP-086', title: 'closes the image lightbox without closing Prompt Composer' },
	{ id: 'WSP-087', title: 'cycles Prompt Composer Thinking mode from the toolbar' },
	{ id: 'WSP-088', title: 'persists the Display maximum log buffer selection' },
	{ id: 'WSP-089', title: 'toggles Settings beta update channel' },
	{ id: 'WSP-090', title: 'toggles Settings crash reporting preference' },
	{ id: 'WSP-091', title: 'records a Settings general shortcut override' },
	{ id: 'WSP-092', title: 'cancels Settings shortcut recording with Escape' },
	{ id: 'WSP-093', title: 'records a Settings AI tab shortcut override' },
	{ id: 'WSP-094', title: 'adds a Display custom interface font' },
	{ id: 'WSP-095', title: 'removes a Display custom interface font' },
	{ id: 'WSP-096', title: 'selects a Display custom interface font' },
	{ id: 'WSP-097', title: 'prevents duplicate Display custom interface fonts' },
	{ id: 'WSP-098', title: 'selects the Settings custom theme card' },
	{ id: 'WSP-099', title: 'initializes the Settings custom theme from Solarized' },
	{ id: 'WSP-100', title: 'resets the Settings custom theme to Dracula defaults' },
	{ id: 'WSP-101', title: 'edits the Settings custom theme main background color' },
	{ id: 'WSP-102', title: 'advances the Settings theme picker with Tab' },
	{ id: 'WSP-103', title: 'wraps the Settings theme picker backward to Custom' },
	{ id: 'WSP-104', title: 'persists selecting the GitHub light theme' },
	{ id: 'WSP-105', title: "lists Codex as the Director's Notes synopsis provider" },
	{ id: 'WSP-106', title: "persists Director's Notes provider path args and env vars" },
	{ id: 'WSP-107', title: "clears Director's Notes provider custom overrides" },
	{ id: 'WSP-108', title: "persists Director's Notes Codex model override" },
	{ id: 'WSP-109', title: "persists Director's Notes Codex context window" },
	{ id: 'WSP-110', title: "shows Director's Notes available model count" },
	{ id: 'WSP-111', title: "shows Director's Notes built-in environment variables" },
	{ id: 'WSP-112', title: 'keeps New Agent Wizard Continue disabled by default' },
	{ id: 'WSP-113', title: 'preserves a typed New Agent Wizard agent name' },
	{ id: 'WSP-114', title: 'selects Codex in the New Agent Wizard provider grid' },
	{ id: 'WSP-115', title: 'enables New Agent Wizard Continue after name and provider' },
	{ id: 'WSP-116', title: 'selects Codex in the New Agent Wizard with Enter' },
	{ id: 'WSP-117', title: 'marks Gemini CLI as a disabled coming-soon provider' },
	{ id: 'WSP-118', title: 'opens Codex customization from the New Agent Wizard' },
	{ id: 'WSP-119', title: 'edits the New Agent Wizard Codex custom path' },
	{ id: 'WSP-120', title: 'resets the New Agent Wizard Codex custom path' },
	{ id: 'WSP-121', title: 'edits the New Agent Wizard Codex custom arguments' },
	{ id: 'WSP-122', title: 'clears the New Agent Wizard Codex custom arguments' },
	{ id: 'WSP-123', title: 'adds a New Agent Wizard Codex environment variable' },
	{ id: 'WSP-124', title: 'removes a New Agent Wizard Codex environment variable' },
	{ id: 'WSP-125', title: 'edits New Agent Wizard Codex model and context settings' },
	{ id: 'WSP-126', title: 'advances New Agent Wizard to directory selection' },
	{ id: 'WSP-127', title: 'returns from directory selection with wizard state preserved' },
	{ id: 'WSP-128', title: 'shows New Agent Wizard project directory controls' },
	{ id: 'WSP-129', title: 'reports a missing New Agent Wizard project directory' },
	{ id: 'WSP-130', title: 'accepts a regular New Agent Wizard project directory' },
	{ id: 'WSP-131', title: 'enables directory-step Continue for a valid project directory' },
	{ id: 'WSP-132', title: 'clears New Agent Wizard project directory validation state' },
	{ id: 'WSP-133', title: 'surfaces existing Auto Run documents in the New Agent Wizard' },
	{ id: 'WSP-134', title: 'marks continuing with existing Auto Run documents as recommended' },
	{ id: 'WSP-135', title: 'cancels existing Auto Run document reuse from the New Agent Wizard' },
	{ id: 'WSP-136', title: 'offers a delete-and-start-fresh path for existing documents' },
	{ id: 'WSP-137', title: 'opens existing Auto Run document choices from Enter on directory step' },
	{ id: 'WSP-138', title: 'dismisses existing Auto Run document choices with Escape' },
	{
		id: 'WSP-139',
		title: 'revalidates a project directory after cancelling existing document reuse',
	},
	{ id: 'WSP-140', title: 'shows Settings stats database controls' },
	{ id: 'WSP-141', title: 'clears Settings stats older than a selected period' },
	{ id: 'WSP-142', title: 'keeps WakaTime detail controls hidden while disabled' },
	{ id: 'WSP-143', title: 'keeps the WakaTime API key field hidden while disabled' },
	{ id: 'WSP-144', title: 'shows WakaTime local-storage privacy copy' },
	{ id: 'WSP-145', title: 'shows Settings storage location defaults' },
	{ id: 'WSP-146', title: 'shows Settings storage file-manager action' },
	{ id: 'WSP-147', title: 'shows Settings custom theme import controls' },
	{ id: 'WSP-148', title: 'imports valid Settings custom theme colors' },
	{ id: 'WSP-149', title: 'rejects invalid Settings custom theme color values' },
	{ id: 'WSP-150', title: 'rejects Settings custom theme files without colors' },
	{ id: 'WSP-151', title: 'rejects Settings custom theme files missing color keys' },
	{ id: 'WSP-152', title: 'rejects invalid Settings custom theme JSON' },
	{ id: 'WSP-153', title: 'imports a Settings custom theme base id' },
	{ id: 'WSP-154', title: 'chooses a custom Settings storage folder' },
	{ id: 'WSP-155', title: 'resets a custom Settings storage folder to default' },
	{ id: 'WSP-156', title: 'leaves Settings storage unchanged when folder selection is cancelled' },
	{ id: 'WSP-157', title: 'reports Settings storage migration errors' },
	{ id: 'WSP-158', title: 'reports Settings storage reset errors' },
	{ id: 'WSP-159', title: 'routes Settings storage file-manager opens through shell IPC' },
	{ id: 'WSP-160', title: 'persists Display Document Graph maximum nodes' },
	{ id: 'WSP-161', title: 'clamps Display Document Graph maximum nodes to the supported range' },
	{ id: 'WSP-162', title: 'ghosts context warning thresholds when warnings are disabled' },
	{ id: 'WSP-163', title: 'renders seeded context warning threshold percentages' },
	{ id: 'WSP-164', title: 'lowers the yellow context threshold when red crosses it' },
	{ id: 'WSP-165', title: 'toggles context warnings from the keyboard' },
	{ id: 'WSP-166', title: 'blocks duplicate local file indexing ignore patterns' },
	{ id: 'WSP-167', title: 'resets local file indexing ignore patterns to defaults' },
	{ id: 'WSP-168', title: 'keeps local ignore pattern Add disabled for blank input' },
	{ id: 'WSP-169', title: 'adds a local ignore pattern from Enter' },
	{ id: 'WSP-170', title: 'opens the Bionify algorithm reference modal' },
	{ id: 'WSP-171', title: 'closes the Bionify algorithm reference modal with Escape' },
	{ id: 'WSP-172', title: 'persists the Settings default stats time range' },
	{ id: 'WSP-173', title: 'clears the Settings GitHub CLI custom path' },
	{ id: 'WSP-174', title: 'clears Settings shell arguments' },
	{ id: 'WSP-175', title: 'reports Settings stats clearing failures' },
	{ id: 'WSP-176', title: 'renders Settings stats database metadata' },
	{ id: 'WSP-177', title: 'shows Settings global environment variable scope copy' },
	{ id: 'WSP-178', title: 'persists a Settings custom shell path' },
	{ id: 'WSP-179', title: 'clears a Settings custom shell path' },
	{ id: 'WSP-180', title: 'toggles Settings stats collection off' },
	{ id: 'WSP-181', title: 'reports successful Settings stats clearing totals' },
	{ id: 'WSP-182', title: 'adds a Settings global environment variable' },
	{ id: 'WSP-183', title: 'removes a Settings global environment variable' },
	{ id: 'WSP-184', title: 'blocks invalid Settings global environment variable names' },
	{ id: 'WSP-185', title: 'toggles Settings operating system notifications off' },
	{ id: 'WSP-186', title: 'routes Settings test notifications through notification IPC' },
	{ id: 'WSP-187', title: 'persists the Settings custom notification command' },
	{ id: 'WSP-188', title: 'shows Settings custom notification running and success states' },
	{ id: 'WSP-189', title: 'stops a running Settings custom notification command' },
	{ id: 'WSP-190', title: 'reports Settings custom notification command failures' },
	{ id: 'WSP-191', title: 'persists Settings toast notification duration' },
	{ id: 'WSP-192', title: 'renders Settings SSH remote empty state' },
	{ id: 'WSP-193', title: 'opens the Settings SSH remote add modal' },
	{ id: 'WSP-194', title: 'validates required Settings SSH remote fields' },
	{ id: 'WSP-195', title: 'saves a Settings SSH remote with environment variables' },
	{ id: 'WSP-196', title: 'imports Settings SSH remote fields from SSH config' },
	{ id: 'WSP-197', title: 'clears Settings SSH config import origin' },
	{ id: 'WSP-198', title: 'toggles the Settings SSH remote default host' },
	{ id: 'WSP-199', title: 'reports successful Settings SSH remote connection tests' },
	{ id: 'WSP-200', title: 'marks disabled Settings SSH remotes and blocks tests' },
	{ id: 'WSP-201', title: 'deletes a Settings SSH remote from the list' },
	{ id: 'WSP-202', title: 'shows New Agent Wizard remote location choices' },
	{ id: 'WSP-203', title: 'carries New Agent Wizard remote selection into directory step' },
	{ id: 'WSP-204', title: 'validates New Agent Wizard remote project directories through SSH' },
	{ id: 'WSP-205', title: 'shows existing remote Auto Run documents in the New Agent Wizard' },
	{ id: 'WSP-206', title: 'reports missing New Agent Wizard remote project directories' },
	{ id: 'WSP-207', title: 'clears New Agent Wizard remote selection when switching back local' },
	{ id: 'WSP-208', title: 'preserves New Agent Wizard remote selection when returning' },
	{ id: 'WSP-209', title: 'selects a local New Agent Wizard directory from Browse' },
	{ id: 'WSP-210', title: 'keeps New Agent Wizard directory empty when Browse is cancelled' },
	{ id: 'WSP-211', title: 'reports New Agent Wizard Browse failures' },
	{ id: 'WSP-212', title: 'routes local New Agent Wizard directory validation without SSH' },
	{
		id: 'WSP-213',
		title: 'shows plural existing Auto Run document counts in the New Agent Wizard',
	},
	{ id: 'WSP-214', title: 'reports New Agent Wizard existing document delete failures' },
	{ id: 'WSP-215', title: 'continues New Agent Wizard discovery from existing documents' },
	{ id: 'WSP-216', title: 'deletes existing New Agent Wizard documents before discovery' },
	{ id: 'WSP-217', title: "loads Director's Notes Unified History entries" },
	{ id: 'WSP-218', title: "filters Director's Notes Unified History by summary" },
	{ id: 'WSP-219', title: "filters Director's Notes Unified History by agent name" },
	{ id: 'WSP-220', title: "shows Director's Notes Unified History empty search state" },
	{ id: 'WSP-221', title: "collapses Director's Notes history search with Escape" },
	{ id: 'WSP-222', title: "closes Director's Notes Help tab with Escape" },
	{ id: 'WSP-223', title: "cycles Director's Notes tabs from the keyboard" },
	{ id: 'WSP-224', title: "filters Director's Notes Unified History by entry type" },
	{ id: 'WSP-225', title: 'returns from New Agent Wizard Codex configuration with Codex selected' },
	{ id: 'WSP-226', title: 'enables New Agent Wizard Continue after Codex configuration' },
	{ id: 'WSP-227', title: 'preserves New Agent Wizard Codex arguments after reopening config' },
	{
		id: 'WSP-228',
		title: 'preserves New Agent Wizard Codex environment variables after reopening config',
	},
	{
		id: 'WSP-229',
		title: 'auto-numbers New Agent Wizard Codex populated environment variables',
	},
	{ id: 'WSP-230', title: 'shows New Agent Wizard Codex built-in environment variable help' },
	{ id: 'WSP-231', title: 'lists New Agent Wizard Codex model options' },
	{ id: 'WSP-232', title: 'commits a New Agent Wizard Codex model dropdown selection' },
];

const envGatedScenarioMatrix = [
	{
		id: 'WSP-ENV-001',
		title: 'completes provider-account-backed wizard handoff',
		reason: 'Requires real provider account state and is outside deterministic lane coverage.',
	},
];

function createWizardSettingsPromptsWorkbench(options: { inlineWizard?: boolean } = {}) {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-wsp-'));
	const projectDir = path.join(homeDir, 'project');
	const now = Date.parse('2026-06-08T12:00:00Z');
	const primarySessionId = 'wsp-primary-agent';
	const reviewerSessionId = 'wsp-reviewer-agent';

	fs.mkdirSync(path.join(projectDir, 'Auto Run Docs'), { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'README.md'), '# Wizard Settings Prompts\n', 'utf-8');
	fs.writeFileSync(
		path.join(projectDir, 'wsp-diagram.png'),
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
			'base64'
		)
	);

	return {
		homeDir,
		projectDir,
		sessions: [
			createSeedSession({
				id: primarySessionId,
				name: options.inlineWizard ? 'Inline Wizard Agent' : 'Prompt Primary Agent',
				projectDir,
				now,
				wizardState: options.inlineWizard
					? createInlineWizardState({
							projectDir,
							sessionId: primarySessionId,
							tabId: `${primarySessionId}-tab`,
						})
					: undefined,
			}),
			createSeedSession({
				id: reviewerSessionId,
				name: 'Reviewer',
				projectDir,
				now: now + 1,
			}),
		],
	};
}

function seedExistingAutoRunDoc(projectDir: string, filename = 'phase-legacy.md') {
	const docPath = path.join(projectDir, 'Auto Run Docs', filename);
	fs.writeFileSync(
		docPath,
		'# Existing Wizard Plan\n\n- Keep planning from prior work.\n',
		'utf-8'
	);
	return docPath;
}

function createCustomThemeImportColors(overrides: Record<string, string> = {}) {
	return {
		bgMain: '#101820',
		bgSidebar: '#17212b',
		bgActivity: '#22303c',
		border: '#334455',
		textMain: '#f5f7fa',
		textDim: '#9aa6b2',
		accent: '#33aaff',
		accentDim: 'rgba(51, 170, 255, 0.24)',
		accentText: '#77ddff',
		accentForeground: '#07131f',
		success: '#44cc88',
		warning: '#ffcc66',
		error: '#ff6677',
		...overrides,
	};
}

function writeThemeImportFile(homeDir: string, filename: string, content: string) {
	const filePath = path.join(homeDir, filename);
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

type StubbedStorageSyncResult = {
	success: boolean;
	migrated?: number;
	error?: string;
	errors?: string[];
};

type StubbedStorageSyncOptions = {
	defaultPath?: string;
	initialCustomPath?: string;
	selectedFolder?: string | null;
	setCustomPathResult?: StubbedStorageSyncResult;
	resetCustomPathResult?: StubbedStorageSyncResult;
};

type StubbedStorageSyncState = {
	customPath?: string;
	setCalls: Array<string | null>;
};

async function stubStorageSyncHandlers(
	electronApp: ElectronApplication,
	options: StubbedStorageSyncOptions = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eStorageSyncState?: StubbedStorageSyncState;
			};
			state.__maestroE2eStorageSyncState = {
				customPath: payload.initialCustomPath,
				setCalls: [],
			};

			ipcMain.removeHandler('sync:getDefaultPath');
			ipcMain.handle('sync:getDefaultPath', async () => payload.defaultPath);
			ipcMain.removeHandler('sync:getSettings');
			ipcMain.handle('sync:getSettings', async () => ({
				customSyncPath: state.__maestroE2eStorageSyncState?.customPath,
			}));
			ipcMain.removeHandler('sync:getCurrentStoragePath');
			ipcMain.handle(
				'sync:getCurrentStoragePath',
				async () => state.__maestroE2eStorageSyncState?.customPath ?? payload.defaultPath
			);
			ipcMain.removeHandler('sync:selectSyncFolder');
			ipcMain.handle('sync:selectSyncFolder', async () => payload.selectedFolder);
			ipcMain.removeHandler('sync:setCustomPath');
			ipcMain.handle('sync:setCustomPath', async (_event, customPath: string | null) => {
				state.__maestroE2eStorageSyncState?.setCalls.push(customPath);
				const result =
					customPath === null ? payload.resetCustomPathResult : payload.setCustomPathResult;
				if (result.success) {
					state.__maestroE2eStorageSyncState = {
						customPath: customPath ?? undefined,
						setCalls: state.__maestroE2eStorageSyncState?.setCalls ?? [],
					};
				}
				return result;
			});
		},
		{
			defaultPath: options.defaultPath ?? '/tmp/maestro-e2e-default-storage',
			initialCustomPath: options.initialCustomPath,
			selectedFolder: options.selectedFolder ?? null,
			setCustomPathResult: options.setCustomPathResult ?? { success: true, migrated: 3 },
			resetCustomPathResult: options.resetCustomPathResult ?? { success: true, migrated: 2 },
		}
	);
}

async function getStubbedStorageSyncState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eStorageSyncState?: StubbedStorageSyncState;
		};
		return state.__maestroE2eStorageSyncState ?? { setCalls: [] };
	});
}

type StubbedShellPathCall = {
	type: 'openPath';
	itemPath: string;
};

async function stubShellPathHandlers(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eShellPathCalls?: StubbedShellPathCall[];
		};
		state.__maestroE2eShellPathCalls = [];
		ipcMain.removeHandler('shell:openPath');
		ipcMain.handle('shell:openPath', async (_event, itemPath: string) => {
			state.__maestroE2eShellPathCalls?.push({ type: 'openPath', itemPath });
			return '';
		});
	});
}

async function getStubbedShellPathCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eShellPathCalls?: StubbedShellPathCall[];
		};
		return state.__maestroE2eShellPathCalls ?? [];
	});
}

type StubbedStatsClearResult = {
	success: boolean;
	deletedQueryEvents: number;
	deletedAutoRunSessions: number;
	deletedAutoRunTasks: number;
	error?: string;
};

type StubbedStatsOptions = {
	dbSize?: number;
	earliestTimestamp?: number | null;
	clearResult?: StubbedStatsClearResult;
};

async function stubStatsDataManagement(
	electronApp: ElectronApplication,
	options: StubbedStatsOptions = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eStatsClearDays?: number[];
				__maestroE2eStatsDbSize?: number;
			};
			state.__maestroE2eStatsClearDays = [];
			state.__maestroE2eStatsDbSize = payload.dbSize;

			ipcMain.removeHandler('stats:get-database-size');
			ipcMain.handle('stats:get-database-size', async () => state.__maestroE2eStatsDbSize);
			ipcMain.removeHandler('stats:get-earliest-timestamp');
			ipcMain.handle('stats:get-earliest-timestamp', async () => payload.earliestTimestamp);
			ipcMain.removeHandler('stats:clear-old-data');
			ipcMain.handle('stats:clear-old-data', async (_event, olderThanDays: number) => {
				state.__maestroE2eStatsClearDays?.push(olderThanDays);
				return payload.clearResult;
			});
		},
		{
			dbSize: options.dbSize ?? 2 * 1024 * 1024,
			earliestTimestamp: options.earliestTimestamp ?? Date.UTC(2026, 0, 2),
			clearResult: options.clearResult ?? {
				success: true,
				deletedQueryEvents: 2,
				deletedAutoRunSessions: 1,
				deletedAutoRunTasks: 3,
			},
		}
	);
}

async function getStubbedStatsClearDays(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eStatsClearDays?: number[];
		};
		return state.__maestroE2eStatsClearDays ?? [];
	});
}

interface StubbedNotificationOptions {
	speakResult?: { success: boolean; notificationId?: number; error?: string };
}

async function stubNotificationHandlers(
	electronApp: ElectronApplication,
	options: StubbedNotificationOptions = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eNotificationShowCalls?: Array<{ title: string; body: string }>;
				__maestroE2eNotificationSpeakCalls?: Array<{ text: string; command?: string }>;
				__maestroE2eNotificationStopCalls?: number[];
			};
			state.__maestroE2eNotificationShowCalls = [];
			state.__maestroE2eNotificationSpeakCalls = [];
			state.__maestroE2eNotificationStopCalls = [];

			ipcMain.removeHandler('notification:show');
			ipcMain.handle('notification:show', async (_event, title: string, body: string) => {
				state.__maestroE2eNotificationShowCalls?.push({ title, body });
				return { success: true };
			});
			ipcMain.removeHandler('notification:speak');
			ipcMain.handle('notification:speak', async (_event, text: string, command?: string) => {
				state.__maestroE2eNotificationSpeakCalls?.push({ text, command });
				return payload.speakResult;
			});
			ipcMain.removeHandler('notification:stopSpeak');
			ipcMain.handle('notification:stopSpeak', async (_event, notificationId: number) => {
				state.__maestroE2eNotificationStopCalls?.push(notificationId);
				return { success: true };
			});
		},
		{
			speakResult: options.speakResult ?? { success: true, notificationId: 701 },
		}
	);
}

async function getStubbedNotificationState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eNotificationShowCalls?: Array<{ title: string; body: string }>;
			__maestroE2eNotificationSpeakCalls?: Array<{ text: string; command?: string }>;
			__maestroE2eNotificationStopCalls?: number[];
		};
		return {
			showCalls: state.__maestroE2eNotificationShowCalls ?? [],
			speakCalls: state.__maestroE2eNotificationSpeakCalls ?? [],
			stopCalls: state.__maestroE2eNotificationStopCalls ?? [],
		};
	});
}

async function emitStubbedNotificationCompletion(
	electronApp: ElectronApplication,
	notificationId: number
) {
	await electronApp.evaluate(({ BrowserWindow }, completedId) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send(
			'notification:commandCompleted',
			completedId
		);
	}, notificationId);
}

interface StubbedSshRemoteConfig {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
	remoteEnv?: Record<string, string>;
	enabled: boolean;
	useSshConfig?: boolean;
	sshConfigHost?: string;
}

interface StubbedSshConfigHost {
	host: string;
	hostName?: string;
	port?: number;
	user?: string;
	identityFile?: string;
	proxyJump?: string;
}

interface StubbedSshRemoteOptions {
	configs?: StubbedSshRemoteConfig[];
	defaultId?: string | null;
	sshConfigHosts?: StubbedSshConfigHost[];
	testResult?: {
		success: boolean;
		result?: { remoteInfo?: { hostname?: string } };
		error?: string;
	};
}

function createStubSshRemoteConfig(
	overrides: Partial<StubbedSshRemoteConfig> = {}
): StubbedSshRemoteConfig {
	return {
		id: overrides.id ?? 'ssh-remote-1',
		name: overrides.name ?? 'Quant VPS',
		host: overrides.host ?? 'quant.example.com',
		port: overrides.port ?? 22,
		username: overrides.username ?? 'ubuntu',
		privateKeyPath: overrides.privateKeyPath ?? '~/.ssh/quant',
		remoteEnv: overrides.remoteEnv ?? {},
		enabled: overrides.enabled ?? true,
		useSshConfig: overrides.useSshConfig,
		sshConfigHost: overrides.sshConfigHost,
	};
}

async function stubSshRemoteHandlers(
	electronApp: ElectronApplication,
	options: StubbedSshRemoteOptions = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eSshRemoteConfigs?: StubbedSshRemoteConfig[];
				__maestroE2eSshDefaultId?: string | null;
				__maestroE2eSshSaveCalls?: Array<Partial<StubbedSshRemoteConfig>>;
				__maestroE2eSshDeleteCalls?: string[];
				__maestroE2eSshDefaultCalls?: Array<string | null>;
				__maestroE2eSshTestCalls?: unknown[];
			};
			state.__maestroE2eSshRemoteConfigs = payload.configs.map((config) => ({ ...config }));
			state.__maestroE2eSshDefaultId = payload.defaultId;
			state.__maestroE2eSshSaveCalls = [];
			state.__maestroE2eSshDeleteCalls = [];
			state.__maestroE2eSshDefaultCalls = [];
			state.__maestroE2eSshTestCalls = [];

			ipcMain.removeHandler('ssh-remote:getConfigs');
			ipcMain.handle('ssh-remote:getConfigs', async () => ({
				success: true,
				configs: state.__maestroE2eSshRemoteConfigs ?? [],
			}));
			ipcMain.removeHandler('ssh-remote:getDefaultId');
			ipcMain.handle('ssh-remote:getDefaultId', async () => ({
				success: true,
				id: state.__maestroE2eSshDefaultId,
			}));
			ipcMain.removeHandler('ssh-remote:setDefaultId');
			ipcMain.handle('ssh-remote:setDefaultId', async (_event, id: string | null) => {
				state.__maestroE2eSshDefaultId = id;
				state.__maestroE2eSshDefaultCalls?.push(id);
				return { success: true };
			});
			ipcMain.removeHandler('ssh-remote:saveConfig');
			ipcMain.handle(
				'ssh-remote:saveConfig',
				async (_event, config: Partial<StubbedSshRemoteConfig>) => {
					state.__maestroE2eSshSaveCalls?.push(config);
					const existing = state.__maestroE2eSshRemoteConfigs?.find(
						(item) => item.id === config.id
					);
					const saved: StubbedSshRemoteConfig = {
						id:
							config.id ||
							existing?.id ||
							`ssh-remote-${(state.__maestroE2eSshRemoteConfigs?.length ?? 0) + 1}`,
						name: config.name ?? existing?.name ?? 'Saved Remote',
						host: config.host ?? existing?.host ?? 'localhost',
						port: config.port ?? existing?.port ?? 22,
						username: config.username ?? existing?.username ?? '',
						privateKeyPath: config.privateKeyPath ?? existing?.privateKeyPath ?? '',
						remoteEnv: config.remoteEnv ?? existing?.remoteEnv ?? {},
						enabled: config.enabled ?? existing?.enabled ?? true,
						useSshConfig: config.useSshConfig ?? existing?.useSshConfig,
						sshConfigHost: config.sshConfigHost ?? existing?.sshConfigHost,
					};
					const configs = state.__maestroE2eSshRemoteConfigs ?? [];
					const index = configs.findIndex((item) => item.id === saved.id);
					if (index >= 0) {
						configs[index] = saved;
					} else {
						configs.push(saved);
					}
					state.__maestroE2eSshRemoteConfigs = configs;
					return { success: true, config: saved };
				}
			);
			ipcMain.removeHandler('ssh-remote:deleteConfig');
			ipcMain.handle('ssh-remote:deleteConfig', async (_event, id: string) => {
				state.__maestroE2eSshDeleteCalls?.push(id);
				state.__maestroE2eSshRemoteConfigs = (state.__maestroE2eSshRemoteConfigs ?? []).filter(
					(config) => config.id !== id
				);
				if (state.__maestroE2eSshDefaultId === id) {
					state.__maestroE2eSshDefaultId = null;
				}
				return { success: true };
			});
			ipcMain.removeHandler('ssh-remote:test');
			ipcMain.handle('ssh-remote:test', async (_event, configOrId: unknown) => {
				state.__maestroE2eSshTestCalls?.push(configOrId);
				return payload.testResult;
			});
			ipcMain.removeHandler('ssh-remote:getSshConfigHosts');
			ipcMain.handle('ssh-remote:getSshConfigHosts', async () => ({
				success: true,
				hosts: payload.sshConfigHosts,
				configPath: '~/.ssh/config',
			}));
		},
		{
			configs: options.configs ?? [],
			defaultId: options.defaultId ?? null,
			sshConfigHosts: options.sshConfigHosts ?? [],
			testResult: options.testResult ?? {
				success: true,
				result: { remoteInfo: { hostname: 'quant-vps' } },
			},
		}
	);
}

async function getStubbedSshRemoteState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eSshRemoteConfigs?: StubbedSshRemoteConfig[];
			__maestroE2eSshDefaultId?: string | null;
			__maestroE2eSshSaveCalls?: Array<Partial<StubbedSshRemoteConfig>>;
			__maestroE2eSshDeleteCalls?: string[];
			__maestroE2eSshDefaultCalls?: Array<string | null>;
			__maestroE2eSshTestCalls?: unknown[];
		};
		return {
			configs: state.__maestroE2eSshRemoteConfigs ?? [],
			defaultId: state.__maestroE2eSshDefaultId ?? null,
			saveCalls: state.__maestroE2eSshSaveCalls ?? [],
			deleteCalls: state.__maestroE2eSshDeleteCalls ?? [],
			defaultCalls: state.__maestroE2eSshDefaultCalls ?? [],
			testCalls: state.__maestroE2eSshTestCalls ?? [],
		};
	});
}

interface StubbedWizardRemoteDirectoryOptions {
	readDirError?: string;
	isRepo?: boolean;
	autoRunDocs?: Array<{ name: string; path: string }>;
	selectedFolder?: string | null;
	selectFolderError?: string;
	deleteFolderResult?: { success: boolean; error?: string };
}

async function stubWizardRemoteDirectoryHandlers(
	electronApp: ElectronApplication,
	options: StubbedWizardRemoteDirectoryOptions = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eWizardReadDirCalls?: Array<{ dirPath: string; sshRemoteId?: string }>;
				__maestroE2eWizardGitCalls?: Array<{ cwd: string; sshRemoteId?: string }>;
				__maestroE2eWizardListDocsCalls?: Array<{ folderPath: string; sshRemoteId?: string }>;
				__maestroE2eWizardSelectFolderCalls?: number;
				__maestroE2eWizardDeleteFolderCalls?: string[];
			};
			state.__maestroE2eWizardReadDirCalls = [];
			state.__maestroE2eWizardGitCalls = [];
			state.__maestroE2eWizardListDocsCalls = [];
			state.__maestroE2eWizardSelectFolderCalls = 0;
			state.__maestroE2eWizardDeleteFolderCalls = [];

			ipcMain.removeHandler('fs:readDir');
			ipcMain.handle('fs:readDir', async (_event, dirPath: string, sshRemoteId?: string) => {
				state.__maestroE2eWizardReadDirCalls?.push({ dirPath, sshRemoteId });
				if (payload.readDirError) {
					throw new Error(payload.readDirError);
				}
				return [
					{ name: 'README.md', isDirectory: false, isFile: true, path: `${dirPath}/README.md` },
				];
			});
			ipcMain.removeHandler('git:isRepo');
			ipcMain.handle('git:isRepo', async (_event, cwd: string, sshRemoteId?: string) => {
				state.__maestroE2eWizardGitCalls?.push({ cwd, sshRemoteId });
				return payload.isRepo;
			});
			ipcMain.removeHandler('autorun:listDocs');
			ipcMain.handle(
				'autorun:listDocs',
				async (_event, folderPath: string, sshRemoteId?: string) => {
					state.__maestroE2eWizardListDocsCalls?.push({ folderPath, sshRemoteId });
					return { success: true, files: payload.autoRunDocs, tree: [] };
				}
			);
			ipcMain.removeHandler('dialog:selectFolder');
			ipcMain.handle('dialog:selectFolder', async () => {
				state.__maestroE2eWizardSelectFolderCalls =
					(state.__maestroE2eWizardSelectFolderCalls ?? 0) + 1;
				if (payload.selectFolderError) {
					throw new Error(payload.selectFolderError);
				}
				return payload.selectedFolder ?? null;
			});
			ipcMain.removeHandler('autorun:deleteFolder');
			ipcMain.handle('autorun:deleteFolder', async (_event, folderPath: string) => {
				state.__maestroE2eWizardDeleteFolderCalls?.push(folderPath);
				return payload.deleteFolderResult;
			});
		},
		{
			readDirError: options.readDirError,
			isRepo: options.isRepo ?? false,
			autoRunDocs: options.autoRunDocs ?? [],
			selectedFolder: options.selectedFolder ?? null,
			selectFolderError: options.selectFolderError,
			deleteFolderResult: options.deleteFolderResult ?? { success: true },
		}
	);
}

async function getStubbedWizardRemoteDirectoryState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eWizardReadDirCalls?: Array<{ dirPath: string; sshRemoteId?: string }>;
			__maestroE2eWizardGitCalls?: Array<{ cwd: string; sshRemoteId?: string }>;
			__maestroE2eWizardListDocsCalls?: Array<{ folderPath: string; sshRemoteId?: string }>;
			__maestroE2eWizardSelectFolderCalls?: number;
			__maestroE2eWizardDeleteFolderCalls?: string[];
		};
		return {
			readDirCalls: state.__maestroE2eWizardReadDirCalls ?? [],
			gitCalls: state.__maestroE2eWizardGitCalls ?? [],
			listDocsCalls: state.__maestroE2eWizardListDocsCalls ?? [],
			selectFolderCalls: state.__maestroE2eWizardSelectFolderCalls ?? 0,
			deleteFolderCalls: state.__maestroE2eWizardDeleteFolderCalls ?? [],
		};
	});
}

function createSeedSession({
	id,
	name,
	projectDir,
	now,
	wizardState,
}: {
	id: string;
	name: string;
	projectDir: string;
	now: number;
	wizardState?: Record<string, unknown>;
}) {
	const tabId = `${id}-tab`;

	return {
		id,
		name,
		toolType: 'codex',
		state: 'idle',
		cwd: projectDir,
		fullPath: projectDir,
		projectRoot: projectDir,
		createdAt: now,
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
				id: tabId,
				agentSessionId: null,
				name: 'Main',
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: now,
				state: 'idle',
				wizardState,
			},
		],
		activeTabId: tabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tabId }],
		unifiedClosedTabHistory: [],
	};
}

function createInlineWizardState({
	projectDir,
	sessionId,
	tabId,
}: {
	projectDir: string;
	sessionId: string;
	tabId: string;
}) {
	return {
		isActive: true,
		isInitializing: false,
		isWaiting: false,
		mode: 'new',
		goal: null,
		confidence: 37,
		ready: false,
		conversationHistory: [],
		isGeneratingDocs: false,
		generatedDocuments: [],
		existingDocuments: [],
		previousUIState: null,
		error: null,
		lastUserMessageContent: null,
		projectPath: projectDir,
		agentType: 'codex',
		sessionName: 'Inline Wizard Agent',
		tabId,
		sessionId,
		streamingContent: '',
		generationProgress: null,
		currentDocumentIndex: 0,
		agentSessionId: null,
		subfolderName: null,
		subfolderPath: null,
		autoRunFolderPath: path.join(projectDir, 'Auto Run Docs'),
	};
}

function createDirectorNotesEnabledSettings(overrides: Partial<DirectorNotesSettings> = {}) {
	return {
		encoreFeatures: {
			directorNotes: true,
		},
		directorNotesSettings: {
			provider: 'codex',
			defaultLookbackDays: 7,
			...overrides,
		},
	};
}

type StubbedDirectorHistoryEntry = {
	id: string;
	type: 'AUTO' | 'USER';
	timestamp: number;
	summary: string;
	projectPath: string;
	sourceSessionId: string;
	agentName?: string;
	agentSessionId?: string;
	sessionName?: string;
	success?: boolean;
	elapsedTimeMs?: number;
	validated?: boolean;
};

function createStubDirectorHistoryEntries(): StubbedDirectorHistoryEntry[] {
	return [
		{
			id: 'director-history-auto-1',
			type: 'AUTO',
			timestamp: Date.parse('2026-06-08T13:00:00Z'),
			summary: 'Refined onboarding copy for the setup wizard',
			projectPath: '/tmp/maestro-wizard',
			sourceSessionId: 'wsp-primary-agent',
			agentName: 'Planner Agent',
			agentSessionId: 'provider-session-1',
			sessionName: 'Planning thread',
			success: true,
			elapsedTimeMs: 4200,
			validated: true,
		},
		{
			id: 'director-history-user-1',
			type: 'USER',
			timestamp: Date.parse('2026-06-08T12:30:00Z'),
			summary: 'Reviewed billing prompt composer draft',
			projectPath: '/tmp/maestro-prompts',
			sourceSessionId: 'wsp-reviewer-agent',
			agentName: 'Review Agent',
			agentSessionId: 'provider-session-2',
			sessionName: 'Review thread',
			elapsedTimeMs: 1900,
		},
	];
}

async function stubDirectorNotesHistory(
	electronApp: ElectronApplication,
	entries: StubbedDirectorHistoryEntry[] = createStubDirectorHistoryEntries()
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eDirectorHistoryCalls?: Array<{
					lookbackDays: number;
					filter?: 'AUTO' | 'USER' | null;
					limit?: number;
					offset?: number;
				}>;
				__maestroE2eHistoryUpdateCalls?: Array<{
					entryId: string;
					updates: Record<string, unknown>;
					sessionId?: string;
				}>;
			};
			state.__maestroE2eDirectorHistoryCalls = [];
			state.__maestroE2eHistoryUpdateCalls = [];

			ipcMain.removeHandler('director-notes:getUnifiedHistory');
			ipcMain.handle('director-notes:getUnifiedHistory', async (_event, options) => {
				state.__maestroE2eDirectorHistoryCalls?.push(options);
				const filteredEntries = options.filter
					? payload.entries.filter((entry) => entry.type === options.filter)
					: payload.entries;
				const offset = options.offset ?? 0;
				const limit = options.limit ?? filteredEntries.length;
				const pagedEntries = filteredEntries.slice(offset, offset + limit);
				const autoCount = payload.entries.filter((entry) => entry.type === 'AUTO').length;
				const userCount = payload.entries.filter((entry) => entry.type === 'USER').length;

				return {
					entries: pagedEntries,
					total: filteredEntries.length,
					limit,
					offset,
					hasMore: offset + limit < filteredEntries.length,
					stats: {
						agentCount: new Set(payload.entries.map((entry) => entry.sourceSessionId)).size,
						sessionCount: new Set(
							payload.entries.map((entry) => entry.agentSessionId).filter(Boolean)
						).size,
						autoCount,
						userCount,
						totalCount: payload.entries.length,
					},
				};
			});
			ipcMain.removeHandler('history:update');
			ipcMain.handle(
				'history:update',
				async (_event, entryId: string, updates: Record<string, unknown>, sessionId?: string) => {
					state.__maestroE2eHistoryUpdateCalls?.push({ entryId, updates, sessionId });
					return true;
				}
			);
		},
		{ entries }
	);
}

async function getStubbedDirectorNotesHistoryState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eDirectorHistoryCalls?: Array<{
				lookbackDays: number;
				filter?: 'AUTO' | 'USER' | null;
				limit?: number;
				offset?: number;
			}>;
			__maestroE2eHistoryUpdateCalls?: Array<{
				entryId: string;
				updates: Record<string, unknown>;
				sessionId?: string;
			}>;
		};
		return {
			historyCalls: state.__maestroE2eDirectorHistoryCalls ?? [],
			updateCalls: state.__maestroE2eHistoryUpdateCalls ?? [],
		};
	});
}

async function openQuickActions(window: Page) {
	const quickActionsDialog = window.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await window.bringToFront();
		await window.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	return quickActionsDialog;
}

async function openDirectorNotesFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill("Director's Notes");
	await quickActionsDialog.getByRole('button', { name: /Director's Notes/ }).click();
	const directorNotesDialog = window.getByRole('dialog', { name: "Director's Notes" });
	await expect(directorNotesDialog).toBeVisible();
	return directorNotesDialog;
}

async function openSettingsTab(window: Page, tabTitle: string, expectedText: string) {
	await window.keyboard.press('Meta+,');
	const settingsDialog = window.getByRole('dialog', { name: 'Settings' });
	await expect(settingsDialog).toBeVisible();
	await settingsDialog.locator(`button[title="${tabTitle}"]`).click();
	await expect(settingsDialog.getByText(expectedText).first()).toBeVisible();
	return settingsDialog;
}

async function openPromptComposer(window: Page) {
	await window.getByText('Main', { exact: true }).click();
	await expect(window.getByTitle('Send message')).toBeVisible();
	await window.getByTitle(/Open Prompt Composer/).click();
	await expect(window.getByText('Prompt Composer')).toBeVisible();
	const composerInput = window.getByPlaceholder(/Write your prompt here/);
	await expect(composerInput).toBeVisible();
	return composerInput;
}

async function openNewAgentWizard(window: Page) {
	await helpers.openWizardViaShortcut(window);
	const wizardDialog = window.getByRole('dialog', { name: 'New Agent Wizard' });
	await expect(wizardDialog).toBeVisible();
	await expect(wizardDialog.getByRole('heading', { name: 'Create a Maestro Agent' })).toBeVisible();
	return wizardDialog;
}

async function openCodexWizardCustomization(window: Page) {
	const wizardDialog = await openNewAgentWizard(window);
	const codexTile = wizardDialog.getByRole('button', { name: 'Codex' });

	await codexTile.getByTitle('Customize agent settings').click();
	await expect(wizardDialog.getByText('Codex Configuration')).toBeVisible();
	return wizardDialog;
}

async function openWizardDirectoryStep(window: Page, agentName = 'Directory Codex Agent') {
	const wizardDialog = await openNewAgentWizard(window);

	await wizardDialog.getByLabel('Agent name').fill(agentName);
	await wizardDialog.getByRole('button', { name: 'Codex' }).click();
	await wizardDialog.getByRole('button', { name: 'Continue' }).click();
	await expect(wizardDialog.getByText('Where Should We Work?')).toBeVisible();
	return wizardDialog;
}

function promptComposerDialog(window: Page) {
	return window
		.getByText('Prompt Composer')
		.locator('xpath=ancestor::div[contains(@class, "z-10")][1]');
}

function settingsFieldPanel(scope: Locator, label: string) {
	return scope
		.getByText(label, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]');
}

async function stubEncoreCodexAgent(
	electronApp: ElectronApplication,
	initialConfig: Record<string, unknown> = {}
) {
	await electronApp.evaluate(({ ipcMain }, config) => {
		const configs: Record<string, Record<string, unknown>> = {
			codex: { ...config },
		};
		const codexAgent = {
			id: 'codex',
			name: 'Codex',
			binaryName: 'codex',
			command: 'codex',
			args: [],
			available: true,
			hidden: false,
			path: '/usr/local/bin/codex',
			capabilities: {
				supportsBatchMode: true,
				supportsModelSelection: true,
			},
			configOptions: [
				{
					key: 'model',
					type: 'text',
					label: 'Model',
					description: 'Model override for E2E coverage.',
					default: '',
				},
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window Size',
					description: 'Maximum context window size in tokens.',
					default: 400000,
				},
			],
		};

		ipcMain.removeHandler('agents:detect');
		ipcMain.handle('agents:detect', async () => [codexAgent]);
		ipcMain.removeHandler('agents:refresh');
		ipcMain.handle('agents:refresh', async () => codexAgent);
		ipcMain.removeHandler('agents:getConfig');
		ipcMain.handle('agents:getConfig', async (_event, agentId: string) => configs[agentId] || {});
		ipcMain.removeHandler('agents:setConfig');
		ipcMain.handle(
			'agents:setConfig',
			async (_event, agentId: string, nextConfig: Record<string, unknown>) => {
				configs[agentId] = { ...nextConfig };
				return true;
			}
		);
		ipcMain.removeHandler('agents:getModels');
		ipcMain.handle('agents:getModels', async () => ['gpt-5.3-codex', 'o3']);
	}, initialConfig);
}

test.describe(`wizard settings prompts lane (${activeScenarioMatrix.length} active, 0 skipped, ${envGatedScenarioMatrix.length} env-gated)`, () => {
	test(`${activeScenarioMatrix[0].id} ${activeScenarioMatrix[0].title}`, async ({ window }) => {
		await helpers.openWizardViaShortcut(window);
		const wizardDialog = window.getByRole('dialog', { name: 'New Agent Wizard' });
		await expect(
			wizardDialog.getByRole('heading', { name: 'Create a Maestro Agent' })
		).toBeVisible();
		await expect(wizardDialog.getByRole('button', { name: /Codex/ }).first()).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(wizardDialog).toBeHidden();
	});

	test(`${activeScenarioMatrix[1].id} ${activeScenarioMatrix[1].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench({ inlineWizard: true });
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await expect(launched.window.getByText('Project Wizard')).toBeVisible();
			await expect(launched.window.getByText('Auto Run Playbook')).toBeVisible();
			await expect(
				launched.window.getByPlaceholder('Tell the wizard about your project...')
			).toBeVisible();
			await expect(launched.window.getByTitle('Open Prompt Composer')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[2].id} ${activeScenarioMatrix[2].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);

			await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
			await settingsDialog.getByPlaceholder('/mycommand').fill('/wsp-review');
			await settingsDialog
				.getByPlaceholder('Short description for autocomplete')
				.fill('Wizard settings prompts review');
			await settingsDialog
				.getByPlaceholder(/The actual prompt sent to the AI agent/)
				.fill('Review {{CWD}} for wizard settings prompts coverage.');
			await settingsDialog.getByRole('button', { name: 'Create' }).first().click();

			await expect(settingsDialog.getByText('/wsp-review')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const commands = await window.maestro.settings.get('customAICommands');
						return Array.isArray(commands)
							? commands.find((command) => command.command === '/wsp-review')
							: undefined;
					});
				})
				.toMatchObject({
					description: 'Wizard settings prompts review',
					prompt: 'Review {{CWD}} for wizard settings prompts coverage.',
					isBuiltIn: false,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[3].id} ${activeScenarioMatrix[3].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				encoreFeatures: {
					directorNotes: true,
				},
			},
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill("Director's Notes");
			await quickActionsDialog.getByRole('button', { name: /Director's Notes/ }).click();

			const directorNotesDialog = launched.window.getByRole('dialog', {
				name: "Director's Notes",
			});
			await expect(directorNotesDialog).toBeVisible();
			await expect(directorNotesDialog.getByText("What are Director's Notes?")).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[4].id} ${activeScenarioMatrix[4].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			await composerInput.fill('Ask @Rev');
			await expect(launched.window.getByRole('button', { name: /@Reviewer/ })).toBeVisible();
			await composerInput.press('Enter');
			await expect(composerInput).toHaveValue('Ask @Reviewer ');

			await launched.window.keyboard.press('Escape');
			await expect(launched.window.getByText('Prompt Composer')).toBeHidden();
			await launched.window.getByTitle(/Open Prompt Composer/).click();
			await expect(composerInput).toHaveValue('Ask @Reviewer ');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[5].id} ${activeScenarioMatrix[5].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench({ inlineWizard: true });
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const wizardInput = launched.window.getByPlaceholder('Tell the wizard about your project...');
			await wizardInput.fill('Draft an Auto Run plan for the seeded project.');
			await launched.window.getByTitle('Open Prompt Composer').click();

			const composerInput = launched.window.getByPlaceholder(/Write your prompt here/);
			await expect(composerInput).toHaveValue('Draft an Auto Run plan for the seeded project.');
			await launched.window.getByTitle('Close (Escape)').click();
			await expect(wizardInput).toHaveValue('Draft an Auto Run plan for the seeded project.');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[6].id} ${activeScenarioMatrix[6].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench({ inlineWizard: true });
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await launched.window.getByPlaceholder('Tell the wizard about your project...').focus();
			await launched.window.keyboard.press('Escape');

			const exitDialog = launched.window.getByRole('dialog', { name: /Exit Wizard/ });
			await expect(exitDialog).toBeVisible();
			await expect(
				exitDialog.getByText('Progress will be lost. Are you sure you want to exit the wizard?')
			).toBeVisible();
			await exitDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(exitDialog).toBeHidden();
			await expect(launched.window.getByText('Project Wizard')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[7].id} ${activeScenarioMatrix[7].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench({ inlineWizard: true });
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await launched.window.getByPlaceholder('Tell the wizard about your project...').focus();
			await launched.window.keyboard.press('Escape');

			const exitDialog = launched.window.getByRole('dialog', { name: /Exit Wizard/ });
			await expect(exitDialog).toBeVisible();
			await exitDialog.getByRole('button', { name: 'Exit' }).click();

			await expect(exitDialog).toBeHidden();
			await expect(launched.window.getByText('Project Wizard')).toBeHidden();
			await expect(launched.window.getByTitle('Send message')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[8].id} ${activeScenarioMatrix[8].title}`, async ({ window }) => {
		await helpers.openWizardViaShortcut(window);
		const wizardDialog = window.getByRole('dialog', { name: 'New Agent Wizard' });
		await expect(
			wizardDialog.getByRole('heading', { name: 'Create a Maestro Agent' })
		).toBeVisible();

		await wizardDialog.getByRole('button', { name: 'Close wizard' }).click();
		await expect(wizardDialog).toBeHidden();
	});

	test(`${activeScenarioMatrix[9].id} ${activeScenarioMatrix[9].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customAICommands: [
					{
						id: 'wsp-seeded-summary',
						command: '/wsp-seeded-summary',
						description: 'Seeded wizard settings summary',
						prompt: 'Summarize {{CWD}} for wizard settings prompt coverage.',
						isBuiltIn: false,
					},
				],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);

			await expect(settingsDialog.getByText('/wsp-seeded-summary')).toBeVisible();
			await expect(settingsDialog.getByText('Seeded wizard settings summary')).toBeVisible();
			await expect(settingsDialog.getByText('Add Command')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[10].id} ${activeScenarioMatrix[10].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			await composerInput.fill('Ask @Rev');

			const reviewerMention = launched.window.getByRole('button', { name: /@Reviewer/ });
			await expect(reviewerMention).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(reviewerMention).toBeHidden();
			await expect(launched.window.getByText('Prompt Composer')).toBeVisible();
			await launched.window.keyboard.press('Escape');
			await expect(launched.window.getByText('Prompt Composer')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[11].id} ${activeScenarioMatrix[11].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			const sendButton = launched.window.getByRole('button', { name: /^Send$/ });

			await expect(sendButton).toBeDisabled();
			await composerInput.fill('   ');
			await expect(sendButton).toBeDisabled();
			await composerInput.fill('Review seeded prompt composer behavior.');
			await expect(sendButton).toBeEnabled();

			await launched.window.keyboard.press('Escape');
			await expect(launched.window.getByText('Prompt Composer')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[12].id} ${activeScenarioMatrix[12].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench({ inlineWizard: true });
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await expect(launched.window.getByText('Project Understanding Confidence')).toBeVisible();
			await expect(launched.window.getByText('37%')).toBeVisible();
			await expect(
				launched.window.getByTitle('Project Understanding Confidence: 37%')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[13].id} ${activeScenarioMatrix[13].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			await expect(launched.window.getByText('0 characters')).toBeVisible();

			await composerInput.fill('Count this seeded composer draft.');
			await expect(launched.window.getByText('33 characters')).toBeVisible();
			await expect(launched.window.getByRole('button', { name: /^Send$/ })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[14].id} ${activeScenarioMatrix[14].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			await composerInput.fill('Persist this draft through the header close control.');
			await launched.window.getByTitle('Close (Escape)').click();

			await expect(launched.window.getByText('Prompt Composer')).toBeHidden();
			await launched.window.getByTitle(/Open Prompt Composer/).click();
			await expect(composerInput).toHaveValue(
				'Persist this draft through the header close control.'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[15].id} ${activeScenarioMatrix[15].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Shortcuts',
				'Not all shortcuts can be modified'
			);

			await settingsDialog.getByPlaceholder('Filter shortcuts...').fill('Prompt Composer');
			await expect(settingsDialog.getByText('Open Prompt Composer')).toBeVisible();
			await expect(settingsDialog.getByText('New Agent Wizard')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[16].id} ${activeScenarioMatrix[16].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				encoreFeatures: {
					directorNotes: false,
				},
			},
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill("Director's Notes");
			await expect(
				quickActionsDialog.getByRole('button', { name: /Director's Notes/ })
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[17].id} ${activeScenarioMatrix[17].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				encoreFeatures: {
					directorNotes: false,
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			await settingsDialog.getByRole('button', { name: /Director's Notes/ }).click();

			await expect(settingsDialog.getByText('Synopsis Provider')).toBeVisible();
			await expect(settingsDialog.getByText(/Default Lookback Period:/)).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const features = await window.maestro.settings.get('encoreFeatures');
						return Boolean(features?.directorNotes);
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[18].id} ${activeScenarioMatrix[18].title}`, async ({ window }) => {
		await helpers.openWizardViaShortcut(window);
		const wizardDialog = window.getByRole('dialog', { name: 'New Agent Wizard' });

		await expect(
			wizardDialog.getByRole('button', { name: /Gemini CLI \(coming soon\)/ })
		).toBeDisabled();
		await expect(
			wizardDialog.getByRole('button', { name: /Qwen3 Coder \(coming soon\)/ })
		).toBeDisabled();
		await expect(wizardDialog.getByText('Soon').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[19].id} ${activeScenarioMatrix[19].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Dark Mode');
			const solarizedTheme = settingsDialog.locator('[data-theme-id="solarized-light"]');

			await expect(solarizedTheme).toContainText('Solarized');
			await solarizedTheme.click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('activeThemeId');
					});
				})
				.toBe('solarized-light');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[20].id} ${activeScenarioMatrix[20].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Font Size');

			await settingsDialog.getByRole('button', { name: /^Large$/ }).click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('fontSize');
					});
				})
				.toBe(16);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[21].id} ${activeScenarioMatrix[21].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await openPromptComposer(launched.window);
			await launched.window.getByTitle(/Save to History/).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const sessions = await window.maestro.sessions.getAll();
						const primarySession = sessions.find((session) => session.id === 'wsp-primary-agent');
						const primaryTab = primarySession?.aiTabs?.find(
							(tab) => tab.id === 'wsp-primary-agent-tab'
						);
						return Boolean(primaryTab?.saveToHistory);
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[22].id} ${activeScenarioMatrix[22].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await openPromptComposer(launched.window);
			await launched.window.getByRole('button', { name: /Read-Only/ }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const sessions = await window.maestro.sessions.getAll();
						const primarySession = sessions.find((session) => session.id === 'wsp-primary-agent');
						const primaryTab = primarySession?.aiTabs?.find(
							(tab) => tab.id === 'wsp-primary-agent-tab'
						);
						return Boolean(primaryTab?.readOnlyMode);
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[23].id} ${activeScenarioMatrix[23].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				encoreFeatures: {
					directorNotes: true,
				},
			},
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill("Director's Notes");
			await quickActionsDialog.getByRole('button', { name: /Director's Notes/ }).click();

			const directorNotesDialog = launched.window.getByRole('dialog', {
				name: "Director's Notes",
			});
			await expect(directorNotesDialog.getByRole('button', { name: 'Help' })).toBeVisible();
			await expect(
				directorNotesDialog.getByRole('button', { name: 'Unified History' })
			).toBeVisible();
			await expect(directorNotesDialog.getByRole('button', { name: 'AI Overview' })).toBeDisabled();

			await directorNotesDialog.getByRole('button', { name: 'Help' }).click();
			await expect(directorNotesDialog.getByText("What are Director's Notes?")).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[24].id} ${activeScenarioMatrix[24].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				defaultSaveToHistory: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default History Toggle'
			);

			await settingsDialog.getByText('Enable "History" by default for new tabs').click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('defaultSaveToHistory');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[25].id} ${activeScenarioMatrix[25].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				automaticTabNamingEnabled: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Automatic Tab Naming'
			);

			await settingsDialog.getByText('Automatically name tabs based on first message').click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('automaticTabNamingEnabled');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[26].id} ${activeScenarioMatrix[26].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				fileExplorerIconTheme: 'default',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Files Pane Icon Theme'
			);

			await settingsDialog.getByRole('button', { name: /^Rich$/ }).click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('fileExplorerIconTheme');
					});
				})
				.toBe('rich');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[27].id} ${activeScenarioMatrix[27].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				autoHideMenuBar: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Window Chrome');
			const autoHideRow = settingsDialog
				.getByText('Auto-hide menu bar')
				.locator('xpath=ancestor::div[contains(@class, "flex")][1]');

			await autoHideRow.getByRole('switch').click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('autoHideMenuBar');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[28].id} ${activeScenarioMatrix[28].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				enterToSendAI: true,
			},
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			const composerModal = composerInput.locator(
				'xpath=ancestor::div[contains(@class, "fixed")][1]'
			);
			await composerModal.getByTitle(/Switch to .*Enter to send/).click();

			await expect(composerModal.getByTitle('Switch to Enter to send')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('enterToSendAI');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[29].id} ${activeScenarioMatrix[29].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				conductorProfile: '',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Conductor Profile');
			await settingsDialog
				.getByPlaceholder(/I'm a senior developer working on a React\/TypeScript project/)
				.fill('Prefer concise implementation notes and focused diffs.');

			await expect(settingsDialog.getByText('54/1000')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('conductorProfile');
					});
				})
				.toBe('Prefer concise implementation notes and focused diffs.');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[30].id} ${activeScenarioMatrix[30].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				logLevel: 'info',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'System Log Level');
			await settingsDialog.getByRole('button', { name: 'Warn' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('logLevel');
					});
				})
				.toBe('warn');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[31].id} ${activeScenarioMatrix[31].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				ghPath: '',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'GitHub CLI (gh) Path'
			);
			await settingsDialog.getByPlaceholder('/opt/homebrew/bin/gh').fill('/usr/local/bin/gh');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('ghPath');
					});
				})
				.toBe('/usr/local/bin/gh');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[32].id} ${activeScenarioMatrix[32].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				terminalWidth: 80,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Terminal Width');
			await settingsDialog.getByRole('button', { name: '160' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('terminalWidth');
					});
				})
				.toBe(160);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[33].id} ${activeScenarioMatrix[33].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				documentGraphShowExternalLinks: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Document Graph');
			const externalLinksRow = settingsDialog
				.getByText('Show external links by default')
				.locator('xpath=ancestor::div[contains(@class, "flex")][1]');

			await externalLinksRow.getByRole('switch').click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('documentGraphShowExternalLinks');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[34].id} ${activeScenarioMatrix[34].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customShellPath: '',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
			await settingsDialog.getByPlaceholder('/path/to/shell').fill('/usr/local/bin/fish');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('customShellPath');
					});
				})
				.toBe('/usr/local/bin/fish');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[35].id} ${activeScenarioMatrix[35].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				statsCollectionEnabled: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');
			await settingsDialog.getByRole('switch', { name: 'Enable stats collection' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('statsCollectionEnabled');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[36].id} ${activeScenarioMatrix[36].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				defaultStatsTimeRange: 'week',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');
			await settingsDialog
				.locator('select')
				.filter({ hasText: 'Last 30 days' })
				.selectOption('month');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('defaultStatsTimeRange');
					});
				})
				.toBe('month');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[37].id} ${activeScenarioMatrix[37].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				bionifyReadingMode: false,
				bionifyIntensity: 1,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Reading Mode');
			await settingsDialog.getByRole('button', { name: /^Bionify$/ }).click();
			await settingsDialog.getByRole('button', { name: /^Strong$/ }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return {
							readingMode: await window.maestro.settings.get('bionifyReadingMode'),
							intensity: await window.maestro.settings.get('bionifyIntensity'),
						};
					});
				})
				.toEqual({
					readingMode: true,
					intensity: 1.35,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[38].id} ${activeScenarioMatrix[38].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				bionifyAlgorithm: '- 0 1 1 2 0.4',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Bionify Algorithm');
			const algorithmInput = settingsDialog.getByLabel('Bionify algorithm');
			const validationMessage = settingsDialog.getByText(
				'Enter `+|- len1 len2 len3 len4 fraction`, for example `- 0 1 1 2 0.4`.'
			);

			await algorithmInput.fill('invalid algorithm');
			await expect(validationMessage).toBeVisible();
			await algorithmInput.fill('+ 1 1 2 2 0.5');
			await algorithmInput.press('Enter');

			await expect(validationMessage).toBeHidden();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('bionifyAlgorithm');
					});
				})
				.toBe('+ 1 1 2 2 0.5');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[39].id} ${activeScenarioMatrix[39].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				defaultShowThinking: 'off',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Thinking Mode'
			);
			await settingsDialog.getByRole('button', { name: /^Sticky$/ }).click();

			await expect(
				settingsDialog.getByText('Thinking streams live and stays visible')
			).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('defaultShowThinking');
					});
				})
				.toBe('sticky');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[40].id} ${activeScenarioMatrix[40].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				autoScrollAiMode: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Auto-scroll AI Output'
			);
			await settingsDialog.getByText('Auto-scroll AI output').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('autoScrollAiMode');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[41].id} ${activeScenarioMatrix[41].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				spellCheck: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Spell Check');
			await settingsDialog.getByText('Enable spell checking').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('spellCheck');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[42].id} ${activeScenarioMatrix[42].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				preventSleepEnabled: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Power');
			await settingsDialog.getByRole('switch', { name: 'Prevent sleep while working' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('preventSleepEnabled');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[43].id} ${activeScenarioMatrix[43].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				disableGpuAcceleration: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Rendering Options');
			await settingsDialog.getByRole('switch', { name: 'Disable GPU acceleration' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('disableGpuAcceleration');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[44].id} ${activeScenarioMatrix[44].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				shellArgs: '',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
			await settingsDialog.getByPlaceholder('--flag value').fill('--login --interactive');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('shellArgs');
					});
				})
				.toBe('--login --interactive');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[45].id} ${activeScenarioMatrix[45].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				enterToSendTerminal: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Input Send Behavior'
			);
			const terminalModeRow = settingsDialog
				.getByText('Terminal Mode')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			await terminalModeRow.getByRole('button').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('enterToSendTerminal');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[46].id} ${activeScenarioMatrix[46].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				osNotificationsEnabled: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Operating System Notifications'
			);
			await settingsDialog.getByText('Enable OS Notifications').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('osNotificationsEnabled');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[47].id} ${activeScenarioMatrix[47].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				audioFeedbackEnabled: false,
				audioFeedbackCommand: 'say',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Custom Notification'
			);
			await settingsDialog.getByText('Enable Custom Notification').click();
			await settingsDialog.getByPlaceholder('say').fill('printf wsp-notify');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return {
							enabled: await window.maestro.settings.get('audioFeedbackEnabled'),
							command: await window.maestro.settings.get('audioFeedbackCommand'),
						};
					});
				})
				.toEqual({
					enabled: true,
					command: 'printf wsp-notify',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[48].id} ${activeScenarioMatrix[48].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				toastDuration: 20,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Toast Notification Duration'
			);
			await settingsDialog.getByRole('button', { name: '10s' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('toastDuration');
					});
				})
				.toBe(10);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[49].id} ${activeScenarioMatrix[49].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				localIgnorePatterns: ['.git', 'node_modules'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Local Ignore Patterns'
			);
			const localIgnorePatternsSection = settingsDialog
				.getByText('Local Ignore Patterns')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			await localIgnorePatternsSection
				.getByPlaceholder('Enter glob pattern (e.g., node_modules, *.log)')
				.fill('dist-e2e-cache');
			await localIgnorePatternsSection.getByRole('button', { name: 'Add' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('localIgnorePatterns');
					});
				})
				.toEqual(['.git', 'node_modules', 'dist-e2e-cache']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[50].id} ${activeScenarioMatrix[50].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				localIgnorePatterns: ['.git', 'node_modules', 'dist-e2e-cache'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Local Ignore Patterns'
			);
			const patternRow = settingsDialog
				.getByText('dist-e2e-cache')
				.locator('xpath=ancestor::div[contains(@class, "font-mono")][1]');
			await patternRow.getByTitle('Remove pattern').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('localIgnorePatterns');
					});
				})
				.toEqual(['.git', 'node_modules']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[51].id} ${activeScenarioMatrix[51].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				localHonorGitignore: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Local Ignore Patterns'
			);
			const gitignoreRow = settingsDialog
				.getByText('Honor .gitignore')
				.locator('xpath=ancestor::label[1]');
			await gitignoreRow.getByRole('checkbox').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('localHonorGitignore');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[52].id} ${activeScenarioMatrix[52].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				contextManagementSettings: {
					contextWarningsEnabled: false,
					contextWarningYellowThreshold: 60,
					contextWarningRedThreshold: 80,
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Context Window Warnings'
			);
			await settingsDialog
				.getByRole('button', { name: /Show context consumption warnings/ })
				.click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('contextManagementSettings');
					});
				})
				.toMatchObject({
					contextWarningsEnabled: true,
					contextWarningYellowThreshold: 60,
					contextWarningRedThreshold: 80,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[53].id} ${activeScenarioMatrix[53].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				contextManagementSettings: {
					contextWarningsEnabled: true,
					contextWarningYellowThreshold: 55,
					contextWarningRedThreshold: 70,
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Context Window Warnings'
			);
			const yellowThresholdControl = settingsDialog
				.getByText('Yellow warning threshold')
				.locator('xpath=ancestor::div[input[@type="range"]][1]');
			await yellowThresholdControl.locator('input[type="range"]').evaluate((slider) => {
				const input = slider as HTMLInputElement;
				input.value = '80';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			});

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('contextManagementSettings');
					});
				})
				.toMatchObject({
					contextWarningsEnabled: true,
					contextWarningYellowThreshold: 80,
					contextWarningRedThreshold: 90,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[54].id} ${activeScenarioMatrix[54].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				maxOutputLines: 25,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Max Output Lines per Response'
			);
			const maxOutputSection = settingsDialog
				.getByText('Max Output Lines per Response')
				.locator('xpath=ancestor::div[.//button[normalize-space(.)="100"]][1]');
			await maxOutputSection.getByRole('button', { name: '100' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('maxOutputLines');
					});
				})
				.toBe(100);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[55].id} ${activeScenarioMatrix[55].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				userMessageAlignment: 'right',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'User Message Alignment'
			);
			const alignmentSection = settingsDialog
				.getByText('User Message Alignment')
				.locator('xpath=ancestor::div[.//button[normalize-space(.)="Left"]][1]');
			await alignmentSection.getByRole('button', { name: 'Left' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('userMessageAlignment');
					});
				})
				.toBe('left');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[56].id} ${activeScenarioMatrix[56].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				useNativeTitleBar: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Window Chrome');
			const nativeTitleBarRow = settingsDialog
				.getByText('Use native title bar')
				.locator('xpath=ancestor::div[contains(@class, "flex")][1]');
			await nativeTitleBarRow.getByRole('switch').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('useNativeTitleBar');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[57].id} ${activeScenarioMatrix[57].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				disableConfetti: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Rendering Options');
			await settingsDialog.getByRole('switch', { name: 'Disable confetti animations' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('disableConfetti');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[58].id} ${activeScenarioMatrix[58].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				checkForUpdatesOnStartup: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Updates');
			await settingsDialog.getByText('Check for updates on startup').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('checkForUpdatesOnStartup');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[59].id} ${activeScenarioMatrix[59].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customAICommands: [],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);

			await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
			await settingsDialog.getByPlaceholder('/mycommand').fill('/wsp-cancel');
			await settingsDialog
				.getByPlaceholder('Short description for autocomplete')
				.fill('Canceled wizard settings command');
			await settingsDialog
				.getByPlaceholder(/The actual prompt sent to the AI agent/)
				.fill('This draft should not persist.');
			await settingsDialog.getByRole('button', { name: 'Cancel' }).first().click();

			await expect(settingsDialog.getByText('New Command')).toBeHidden();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const commands = await window.maestro.settings.get('customAICommands');
						return Array.isArray(commands)
							? commands.some((command) => command.command === '/wsp-cancel')
							: false;
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[60].id} ${activeScenarioMatrix[60].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customAICommands: [
					{
						id: 'wsp-edit-command',
						command: '/wsp-edit',
						description: 'Initial WSP edit command',
						prompt: 'Initial prompt for {{CWD}}.',
						isBuiltIn: false,
					},
				],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);
			await settingsDialog.getByRole('button', { name: /\/wsp-edit/ }).click();
			await settingsDialog.getByTitle('Edit command').click();

			const editForm = settingsDialog
				.getByText('/wsp-edit')
				.locator('xpath=ancestor::div[contains(@class, "p-3")][1]');
			await editForm.locator('input').nth(1).fill('Edited WSP command');
			await editForm.locator('textarea').fill('Edited prompt preserves {{PROJECT_DIR}} coverage.');
			await editForm.getByRole('button', { name: 'Save' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const commands = await window.maestro.settings.get('customAICommands');
						return Array.isArray(commands)
							? commands.find((command) => command.command === '/wsp-edit')
							: undefined;
					});
				})
				.toMatchObject({
					description: 'Edited WSP command',
					prompt: 'Edited prompt preserves {{PROJECT_DIR}} coverage.',
					isBuiltIn: false,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[61].id} ${activeScenarioMatrix[61].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				shellEnvVars: {},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Global Environment Variables'
			);
			const envSection = settingsDialog
				.getByText('Environment Variables (optional)')
				.locator('xpath=ancestor::div[.//button[normalize-space(.)="Add Variable"]][1]');
			await envSection.getByRole('button', { name: 'Add Variable' }).click();
			await envSection.getByPlaceholder('VARIABLE').last().fill('WSP_ENV_FLAG');
			await envSection.getByPlaceholder('value').last().fill('enabled');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('shellEnvVars');
					});
				})
				.toMatchObject({
					WSP_ENV_FLAG: 'enabled',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[62].id} ${activeScenarioMatrix[62].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				moderatorStandingInstructions: '',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Group Chat',
				'Moderator Standing Instructions'
			);
			const standingInstructions =
				'Always ask agents to keep wizard settings prompt coverage static and deterministic.';
			await settingsDialog.getByPlaceholder(/Always instruct agents/).fill(standingInstructions);

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('moderatorStandingInstructions');
					});
				})
				.toBe(standingInstructions);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[63].id} ${activeScenarioMatrix[63].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);

			await composerInput.fill('Prefix: ');
			await composerInput.evaluate((textarea) => {
				const input = textarea as HTMLTextAreaElement;
				input.setSelectionRange(input.value.length, input.value.length);
				const dataTransfer = new DataTransfer();
				dataTransfer.setData('text/plain', '  pasted wizard prompt text  \n\n');
				input.dispatchEvent(
					new ClipboardEvent('paste', {
						clipboardData: dataTransfer,
						bubbles: true,
						cancelable: true,
					})
				);
			});

			await expect(composerInput).toHaveValue('Prefix: pasted wizard prompt text');
			await launched.window.keyboard.press('Escape');
			await expect(launched.window.getByText('Prompt Composer')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[64].id} ${activeScenarioMatrix[64].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			const composerDialog = promptComposerDialog(launched.window);

			await composerInput.fill('@NoMatchingWspAgent');
			await expect(composerDialog.getByRole('button', { name: /@Reviewer/ })).toHaveCount(0);
			await expect(composerInput).toHaveValue('@NoMatchingWspAgent');

			await launched.window.keyboard.press('Escape');
			await expect(launched.window.getByText('Prompt Composer')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[65].id} ${activeScenarioMatrix[65].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customAICommands: [
					{
						id: 'wsp-duplicate-command',
						command: '/wsp-duplicate',
						description: 'Original duplicate guard command',
						prompt: 'Original duplicate guard prompt.',
						isBuiltIn: false,
					},
				],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);

			await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
			await settingsDialog.getByPlaceholder('/mycommand').fill('/wsp-duplicate');
			await settingsDialog
				.getByPlaceholder('Short description for autocomplete')
				.fill('Duplicate attempt should be ignored');
			await settingsDialog
				.getByPlaceholder(/The actual prompt sent to the AI agent/)
				.fill('Duplicate prompt should not persist.');
			await settingsDialog.getByRole('button', { name: 'Create' }).first().click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const commands = await window.maestro.settings.get('customAICommands');
						return Array.isArray(commands)
							? commands.filter((command) => command.command === '/wsp-duplicate').length
							: 0;
					});
				})
				.toBe(1);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[66].id} ${activeScenarioMatrix[66].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customAICommands: [
					{
						id: 'wsp-delete-command',
						command: '/wsp-delete',
						description: 'Delete guard command',
						prompt: 'Delete this deterministic prompt.',
						isBuiltIn: false,
					},
				],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);
			await settingsDialog.getByRole('button', { name: /\/wsp-delete/ }).click();
			const commandCard = settingsDialog
				.getByText('/wsp-delete')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByTitle('Delete command').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const commands = await window.maestro.settings.get('customAICommands');
						return Array.isArray(commands)
							? commands.some((command) => command.command === '/wsp-delete')
							: false;
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[67].id} ${activeScenarioMatrix[67].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				shellEnvVars: {
					WSP_VALID: 'kept',
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Global Environment Variables'
			);
			const envSection = settingsDialog
				.getByText('Environment Variables (optional)')
				.locator('xpath=ancestor::div[.//button[normalize-space(.)="Add Variable"]][1]');
			await envSection.getByRole('button', { name: 'Add Variable' }).click();
			await envSection.getByPlaceholder('VARIABLE').last().fill('1INVALID');
			await envSection.getByPlaceholder('value').last().fill('ignored');

			await expect(settingsDialog.getByText(/Invalid variable name/)).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('shellEnvVars');
					});
				})
				.toEqual({
					WSP_VALID: 'kept',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[68].id} ${activeScenarioMatrix[68].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				shellEnvVars: {
					WSP_REMOVE: 'temporary',
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Global Environment Variables'
			);
			const variableRow = settingsDialog
				.getByDisplayValue('WSP_REMOVE')
				.locator('xpath=ancestor::div[contains(@class, "flex")][1]');
			await variableRow.getByTitle('Remove variable').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const envVars = await window.maestro.settings.get('shellEnvVars');
						return Boolean(envVars && typeof envVars === 'object' && 'WSP_REMOVE' in envVars);
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[69].id} ${activeScenarioMatrix[69].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Default Lookback Period: 7 days'
			);
			const lookbackControl = settingsDialog
				.getByText(/Default Lookback Period:/)
				.locator('xpath=ancestor::div[input[@type="range"]][1]');
			await lookbackControl.locator('input[type="range"]').evaluate((slider) => {
				const input = slider as HTMLInputElement;
				input.value = '30';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			});

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const settings = await window.maestro.settings.get('directorNotesSettings');
						return settings && typeof settings === 'object' && 'defaultLookbackDays' in settings
							? settings.defaultLookbackDays
							: undefined;
					});
				})
				.toBe(30);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[70].id} ${activeScenarioMatrix[70].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await launched.window.getByText('Main', { exact: true }).click();
			await expect(launched.window.getByTitle('Send message')).toBeVisible();
			await launched.window.keyboard.press('Meta+Shift+P');

			const composerInput = launched.window.getByPlaceholder(/Write your prompt here/);
			await expect(composerInput).toBeVisible();
			await composerInput.fill('Keyboard-opened wizard settings prompt');
			await expect(composerInput).toHaveValue('Keyboard-opened wizard settings prompt');

			await launched.window.keyboard.press('Escape');
			await expect(launched.window.getByText('Prompt Composer')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[71].id} ${activeScenarioMatrix[71].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customAICommands: [],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);

			await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
			await settingsDialog.getByPlaceholder('/mycommand').fill('wsp-noslash');
			await settingsDialog
				.getByPlaceholder('Short description for autocomplete')
				.fill('No slash command normalization');
			await settingsDialog
				.getByPlaceholder(/The actual prompt sent to the AI agent/)
				.fill('Normalize the slash prefix for {{CWD}}.');
			await settingsDialog.getByRole('button', { name: 'Create' }).first().click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const commands = await window.maestro.settings.get('customAICommands');
						return Array.isArray(commands)
							? commands.find((command) => command.command === '/wsp-noslash')
							: undefined;
					});
				})
				.toMatchObject({
					description: 'No slash command normalization',
					prompt: 'Normalize the slash prefix for {{CWD}}.',
					isBuiltIn: false,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[72].id} ${activeScenarioMatrix[72].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				sshRemoteIgnorePatterns: ['.git', '*cache*'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'SSH Hosts',
				'Remote Ignore Patterns'
			);
			const remoteIgnoreSection = settingsDialog
				.getByText('Remote Ignore Patterns')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			await remoteIgnoreSection
				.getByPlaceholder('Enter glob pattern (e.g., node_modules, *.log)')
				.fill('remote-dist-cache');
			await remoteIgnoreSection.getByRole('button', { name: 'Add' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('sshRemoteIgnorePatterns');
					});
				})
				.toEqual(['.git', '*cache*', 'remote-dist-cache']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[73].id} ${activeScenarioMatrix[73].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				sshRemoteIgnorePatterns: ['.git', 'remote-dist-cache', '*cache*'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'SSH Hosts',
				'Remote Ignore Patterns'
			);
			const patternRow = settingsDialog
				.getByText('remote-dist-cache')
				.locator('xpath=ancestor::div[contains(@class, "font-mono")][1]');
			await patternRow.getByTitle('Remove pattern').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('sshRemoteIgnorePatterns');
					});
				})
				.toEqual(['.git', '*cache*']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[74].id} ${activeScenarioMatrix[74].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				sshRemoteHonorGitignore: true,
				sshRemoteIgnorePatterns: ['.git'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'SSH Hosts',
				'Remote Ignore Patterns'
			);
			const gitignoreRow = settingsDialog
				.getByText('Honor .gitignore')
				.locator('xpath=ancestor::label[1]');
			await gitignoreRow.getByRole('checkbox').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('sshRemoteHonorGitignore');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[75].id} ${activeScenarioMatrix[75].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await openPromptComposer(launched.window);
			const composerDialog = promptComposerDialog(launched.window);
			const imagePath = path.join(seeded.projectDir, 'wsp-diagram.png');

			await composerDialog.locator('input[type="file"]').setInputFiles(imagePath);
			const stagedImage = composerDialog.getByRole('button', {
				name: 'Prompt composer staged image 1',
			});
			await expect(stagedImage).toBeVisible();

			await stagedImage.click();
			const lightbox = launched.window.getByRole('dialog', { name: 'Image Lightbox' });
			await expect(lightbox).toBeVisible();
			await expect(lightbox.getByRole('img', { name: 'Expanded image preview' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[76].id} ${activeScenarioMatrix[76].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await openPromptComposer(launched.window);
			const composerDialog = promptComposerDialog(launched.window);
			const imagePath = path.join(seeded.projectDir, 'wsp-diagram.png');

			await composerDialog.locator('input[type="file"]').setInputFiles(imagePath);
			const stagedImage = composerDialog.getByRole('button', {
				name: 'Prompt composer staged image 1',
			});
			await expect(stagedImage).toBeVisible();

			await stagedImage
				.locator('xpath=ancestor::div[contains(@class, "relative")][1]')
				.locator('button')
				.click();
			await expect(stagedImage).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[77].id} ${activeScenarioMatrix[77].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customAICommands: [
					{
						id: 'wsp-cancel-edit-command',
						command: '/wsp-cancel-edit',
						description: 'Original edit-cancel command',
						prompt: 'Original edit-cancel prompt.',
						isBuiltIn: false,
					},
				],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'AI Commands',
				'Custom AI Commands'
			);
			await settingsDialog.getByRole('button', { name: /\/wsp-cancel-edit/ }).click();
			await settingsDialog.getByTitle('Edit command').click();

			const editForm = settingsDialog
				.getByText('/wsp-cancel-edit')
				.locator('xpath=ancestor::div[contains(@class, "p-3")][1]');
			await editForm.locator('input').nth(1).fill('Edited but canceled command');
			await editForm.locator('textarea').fill('Canceled prompt mutation.');
			await editForm.getByRole('button', { name: 'Cancel' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const commands = await window.maestro.settings.get('customAICommands');
						return Array.isArray(commands)
							? commands.find((command) => command.command === '/wsp-cancel-edit')
							: undefined;
					});
				})
				.toMatchObject({
					description: 'Original edit-cancel command',
					prompt: 'Original edit-cancel prompt.',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[78].id} ${activeScenarioMatrix[78].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				sshRemoteIgnorePatterns: ['.git', '*cache*'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'SSH Hosts',
				'Remote Ignore Patterns'
			);
			const remoteIgnoreSection = settingsDialog
				.getByText('Remote Ignore Patterns')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			await remoteIgnoreSection
				.getByPlaceholder('Enter glob pattern (e.g., node_modules, *.log)')
				.fill('.git');
			await remoteIgnoreSection.getByRole('button', { name: 'Add' }).click();

			await expect(remoteIgnoreSection.getByText('Pattern already exists')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('sshRemoteIgnorePatterns');
					});
				})
				.toEqual(['.git', '*cache*']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[79].id} ${activeScenarioMatrix[79].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				sshRemoteIgnorePatterns: ['remote-only-cache'],
				sshRemoteHonorGitignore: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'SSH Hosts',
				'Remote Ignore Patterns'
			);
			await settingsDialog.getByRole('button', { name: /Reset to defaults/ }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return {
							ignorePatterns: await window.maestro.settings.get('sshRemoteIgnorePatterns'),
							honorGitignore: await window.maestro.settings.get('sshRemoteHonorGitignore'),
						};
					});
				})
				.toEqual({
					ignorePatterns: ['.git', '*cache*'],
					honorGitignore: true,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[80].id} ${activeScenarioMatrix[80].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);

			await composerInput.fill('Draft prompt line');
			await composerInput.press('Tab');
			await expect(composerInput).toHaveValue(/Draft prompt line\t$/);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[81].id} ${activeScenarioMatrix[81].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			await composerInput.press('Meta+S');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const sessions = await window.maestro.sessions.getAll();
						const primarySession = sessions.find((session) => session.id === 'wsp-primary-agent');
						const primaryTab = primarySession?.aiTabs?.find(
							(tab) => tab.id === 'wsp-primary-agent-tab'
						);
						return Boolean(primaryTab?.saveToHistory);
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[82].id} ${activeScenarioMatrix[82].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);
			await composerInput.press('Meta+R');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const sessions = await window.maestro.sessions.getAll();
						const primarySession = sessions.find((session) => session.id === 'wsp-primary-agent');
						const primaryTab = primarySession?.aiTabs?.find(
							(tab) => tab.id === 'wsp-primary-agent-tab'
						);
						return Boolean(primaryTab?.readOnlyMode);
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[83].id} ${activeScenarioMatrix[83].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const composerInput = await openPromptComposer(launched.window);

			await composerInput.fill('First wizard prompt line');
			await composerInput.press('Shift+Enter');
			await composerInput.type('Second wizard prompt line');

			await expect(composerInput).toHaveValue(
				'First wizard prompt line\nSecond wizard prompt line'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[84].id} ${activeScenarioMatrix[84].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await openPromptComposer(launched.window);
			const composerDialog = promptComposerDialog(launched.window);
			const imagePath = path.join(seeded.projectDir, 'wsp-diagram.png');

			await composerDialog.locator('input[type="file"]').setInputFiles(imagePath);
			await expect(
				composerDialog.getByRole('button', { name: 'Prompt composer staged image 1' })
			).toBeVisible();

			await launched.window.keyboard.press('Meta+Shift+L');
			const lightbox = launched.window.getByRole('dialog', { name: 'Image Lightbox' });
			await expect(lightbox).toBeVisible();
			await expect(lightbox.getByRole('img', { name: 'Expanded image preview' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[85].id} ${activeScenarioMatrix[85].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await openPromptComposer(launched.window);
			const composerDialog = promptComposerDialog(launched.window);
			const imagePath = path.join(seeded.projectDir, 'wsp-diagram.png');

			await composerDialog.locator('input[type="file"]').setInputFiles(imagePath);
			await launched.window.keyboard.press('Meta+Shift+L');

			const lightbox = launched.window.getByRole('dialog', { name: 'Image Lightbox' });
			await expect(lightbox).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(lightbox).toBeHidden();
			await expect(launched.window.getByText('Prompt Composer')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[86].id} ${activeScenarioMatrix[86].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await openPromptComposer(launched.window);
			const composerDialog = promptComposerDialog(launched.window);
			const thinkingButton = composerDialog.getByRole('button', { name: /Thinking/ });

			await thinkingButton.click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const sessions = await window.maestro.sessions.getAll();
						const primarySession = sessions.find((session) => session.id === 'wsp-primary-agent');
						const primaryTab = primarySession?.aiTabs?.find(
							(tab) => tab.id === 'wsp-primary-agent-tab'
						);
						return primaryTab?.showThinking;
					});
				})
				.toBe('on');

			await thinkingButton.click();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const sessions = await window.maestro.sessions.getAll();
						const primarySession = sessions.find((session) => session.id === 'wsp-primary-agent');
						const primaryTab = primarySession?.aiTabs?.find(
							(tab) => tab.id === 'wsp-primary-agent-tab'
						);
						return primaryTab?.showThinking;
					});
				})
				.toBe('sticky');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[87].id} ${activeScenarioMatrix[87].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				maxLogBuffer: 1000,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Maximum Log Buffer'
			);
			const maxLogBufferSection = settingsDialog
				.getByText('Maximum Log Buffer')
				.locator('xpath=ancestor::div[.//button[normalize-space(.)="25000"]][1]');
			await maxLogBufferSection.getByRole('button', { name: '25000' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('maxLogBuffer');
					});
				})
				.toBe(25000);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[88].id} ${activeScenarioMatrix[88].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				enableBetaUpdates: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Pre-release Channel'
			);
			await settingsDialog.getByText('Include beta and release candidate updates').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('enableBetaUpdates');
					});
				})
				.toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[89].id} ${activeScenarioMatrix[89].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				crashReportingEnabled: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Privacy');
			await settingsDialog.getByText('Send anonymous crash reports').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('crashReportingEnabled');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[90].id} ${activeScenarioMatrix[90].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Shortcuts',
				'Not all shortcuts can be modified'
			);
			await settingsDialog.getByPlaceholder('Filter shortcuts...').fill('New Agent Wizard');
			const shortcutRow = settingsDialog
				.getByText('New Agent Wizard')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			const shortcutButton = shortcutRow.getByRole('button');

			await shortcutButton.click();
			await expect(shortcutButton).toHaveText('Press keys...');
			await shortcutButton.press('Control+Shift+N');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const shortcuts = await window.maestro.settings.get('shortcuts');
						return shortcuts &&
							typeof shortcuts === 'object' &&
							'openWizard' in shortcuts &&
							shortcuts.openWizard &&
							typeof shortcuts.openWizard === 'object' &&
							'keys' in shortcuts.openWizard
							? shortcuts.openWizard.keys
							: undefined;
					});
				})
				.toEqual(['Ctrl', 'Shift', 'N']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[91].id} ${activeScenarioMatrix[91].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Shortcuts',
				'Not all shortcuts can be modified'
			);
			await settingsDialog.getByPlaceholder('Filter shortcuts...').fill('Open Settings');
			const shortcutRow = settingsDialog
				.getByText('Open Settings')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			const shortcutButton = shortcutRow.getByRole('button');

			await shortcutButton.click();
			await expect(shortcutButton).toHaveText('Press keys...');
			await shortcutButton.press('Escape');

			await expect(shortcutButton).not.toHaveText('Press keys...');
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const shortcuts = await window.maestro.settings.get('shortcuts');
						return shortcuts &&
							typeof shortcuts === 'object' &&
							'settings' in shortcuts &&
							shortcuts.settings &&
							typeof shortcuts.settings === 'object' &&
							'keys' in shortcuts.settings
							? shortcuts.settings.keys
							: undefined;
					});
				})
				.toEqual(['Meta', ',']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[92].id} ${activeScenarioMatrix[92].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Shortcuts',
				'Not all shortcuts can be modified'
			);
			await settingsDialog.getByPlaceholder('Filter shortcuts...').fill('Toggle Show Thinking');
			const shortcutRow = settingsDialog
				.getByText('Toggle Show Thinking')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			const shortcutButton = shortcutRow.getByRole('button');

			await shortcutButton.click();
			await shortcutButton.press('Control+Shift+K');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const tabShortcuts = await window.maestro.settings.get('tabShortcuts');
						return tabShortcuts &&
							typeof tabShortcuts === 'object' &&
							'toggleShowThinking' in tabShortcuts &&
							tabShortcuts.toggleShowThinking &&
							typeof tabShortcuts.toggleShowThinking === 'object' &&
							'keys' in tabShortcuts.toggleShowThinking
							? tabShortcuts.toggleShowThinking.keys
							: undefined;
					});
				})
				.toEqual(['Ctrl', 'Shift', 'K']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[93].id} ${activeScenarioMatrix[93].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customFonts: [],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Interface Font');
			const fontSection = settingsDialog
				.getByText('Interface Font')
				.locator('xpath=ancestor::div[.//input[@placeholder="Add custom font name..."]][1]');
			await fontSection.getByPlaceholder('Add custom font name...').fill('WSP Mono');
			await fontSection.getByRole('button', { name: 'Add' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('customFonts');
					});
				})
				.toEqual(['WSP Mono']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[94].id} ${activeScenarioMatrix[94].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customFonts: ['WSP Mono'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Interface Font');
			const fontSection = settingsDialog
				.getByText('Interface Font')
				.locator('xpath=ancestor::div[.//input[@placeholder="Add custom font name..."]][1]');
			await fontSection.getByText('WSP Mono').locator('xpath=following-sibling::button[1]').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('customFonts');
					});
				})
				.toEqual([]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[95].id} ${activeScenarioMatrix[95].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customFonts: ['WSP Mono'],
				fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Interface Font');
			await settingsDialog.locator('select').first().selectOption('WSP Mono');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('fontFamily');
					});
				})
				.toBe('WSP Mono');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[96].id} ${activeScenarioMatrix[96].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customFonts: ['WSP Mono'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Interface Font');
			const fontSection = settingsDialog
				.getByText('Interface Font')
				.locator('xpath=ancestor::div[.//input[@placeholder="Add custom font name..."]][1]');
			await fontSection.getByPlaceholder('Add custom font name...').fill('WSP Mono');
			await fontSection.getByRole('button', { name: 'Add' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('customFonts');
					});
				})
				.toEqual(['WSP Mono']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[97].id} ${activeScenarioMatrix[97].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				activeThemeId: 'dracula',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog.locator('[data-theme-id="custom"]').getByRole('button').first().click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('activeThemeId');
					});
				})
				.toBe('custom');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[98].id} ${activeScenarioMatrix[98].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customThemeBaseId: 'dracula',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			const customThemeSection = settingsDialog.locator('[data-theme-id="custom"]');
			await customThemeSection.getByRole('button', { name: /Initialize/ }).click();
			await customThemeSection.getByRole('button', { name: /^Solarized$/ }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return {
							base: await window.maestro.settings.get('customThemeBaseId'),
							colors: await window.maestro.settings.get('customThemeColors'),
						};
					});
				})
				.toMatchObject({
					base: 'solarized-light',
					colors: {
						bgMain: '#fdf6e3',
						accent: '#207c76',
					},
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[99].id} ${activeScenarioMatrix[99].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customThemeBaseId: 'solarized-light',
				customThemeColors: {
					bgMain: '#123456',
					bgSidebar: '#eee8d5',
					bgActivity: '#e6dfc8',
					border: '#d3cbb7',
					textMain: '#5f737b',
					textDim: '#606969',
					accent: '#207c76',
					accentDim: 'rgba(32, 124, 118, 0.1)',
					accentText: '#207c76',
					accentForeground: '#fdf6e3',
					success: '#687700',
					warning: '#8d6a00',
					error: '#d3302d',
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog
				.locator('[data-theme-id="custom"]')
				.getByTitle('Reset to default')
				.click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return {
							base: await window.maestro.settings.get('customThemeBaseId'),
							colors: await window.maestro.settings.get('customThemeColors'),
						};
					});
				})
				.toMatchObject({
					base: 'dracula',
					colors: {
						bgMain: '#282a36',
						accent: '#bd93f9',
					},
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[100].id} ${activeScenarioMatrix[100].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			const customThemeSection = settingsDialog.locator('[data-theme-id="custom"]');
			const mainBackgroundRow = customThemeSection
				.getByText('Main Background')
				.locator('xpath=ancestor::div[contains(@class, "flex")][1]');
			await mainBackgroundRow.getByRole('button', { name: /#/ }).click();
			await mainBackgroundRow.locator('input[type="text"]').fill('#123456');
			await mainBackgroundRow.locator('input[type="text"]').press('Enter');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const colors = await window.maestro.settings.get('customThemeColors');
						return colors && typeof colors === 'object' && 'bgMain' in colors
							? colors.bgMain
							: undefined;
					});
				})
				.toBe('#123456');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[101].id} ${activeScenarioMatrix[101].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				activeThemeId: 'dracula',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Dark Mode');
			await settingsDialog.getByRole('group', { name: 'Theme picker' }).focus();
			await launched.window.keyboard.press('Tab');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('activeThemeId');
					});
				})
				.toBe('monokai');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[102].id} ${activeScenarioMatrix[102].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				activeThemeId: 'dracula',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Dark Mode');
			await settingsDialog.getByRole('group', { name: 'Theme picker' }).focus();
			await launched.window.keyboard.press('Shift+Tab');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('activeThemeId');
					});
				})
				.toBe('custom');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[103].id} ${activeScenarioMatrix[103].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				activeThemeId: 'dracula',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Light Mode');
			await settingsDialog.locator('[data-theme-id="github-light"]').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('activeThemeId');
					});
				})
				.toBe('github-light');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[104].id} ${activeScenarioMatrix[104].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			const providerSelect = settingsDialog.getByLabel('Select synopsis provider agent');

			await expect(providerSelect).toHaveValue('codex');
			await expect(providerSelect.locator('option[value="codex"]')).toHaveText('Codex');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[105].id} ${activeScenarioMatrix[105].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				encoreFeatures: {
					directorNotes: true,
				},
				directorNotesSettings: {
					provider: 'codex',
					defaultLookbackDays: 7,
				},
			},
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			await settingsDialog.getByTitle('Customize provider settings').click();

			await settingsDialog.getByPlaceholder('/path/to/codex').fill('/tmp/wsp-director-codex');
			await settingsDialog.getByPlaceholder('/path/to/codex').blur();
			await settingsDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--sandbox read-only --model wsp');
			await settingsDialog.getByPlaceholder('--flag value --another-flag').blur();
			await settingsDialog.getByRole('button', { name: 'Add Variable' }).click();
			await settingsDialog.getByPlaceholder('VARIABLE_NAME').fill('WSP_DIRECTOR_NOTES');
			await settingsDialog.getByPlaceholder('VARIABLE_NAME').blur();
			await settingsDialog.getByPlaceholder('value', { exact: true }).fill('enabled');
			await settingsDialog.getByPlaceholder('value', { exact: true }).blur();

			await expect(settingsDialog.getByText('Customized')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const settings = await window.maestro.settings.get('directorNotesSettings');
						return {
							customArgs: settings.customArgs,
							customEnvVars: settings.customEnvVars,
							customPath: settings.customPath,
						};
					});
				})
				.toEqual({
					customArgs: '--sandbox read-only --model wsp',
					customEnvVars: { WSP_DIRECTOR_NOTES: 'enabled' },
					customPath: '/tmp/wsp-director-codex',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[106].id} ${activeScenarioMatrix[106].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings({
				customPath: '/tmp/wsp-director-codex',
				customArgs: '--sandbox read-only',
				customEnvVars: {
					WSP_DIRECTOR_CLEAR: 'before-clear',
				},
			}),
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			await settingsDialog.getByTitle('Customize provider settings').click();

			await settingsFieldPanel(settingsDialog, 'Path')
				.getByRole('button', { name: 'Reset' })
				.click();
			await settingsFieldPanel(settingsDialog, 'Custom Arguments (optional)')
				.getByRole('button', { name: 'Clear' })
				.click();
			await settingsFieldPanel(settingsDialog, 'Environment Variables (optional)')
				.getByTitle('Remove variable')
				.click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const settings = await window.maestro.settings.get('directorNotesSettings');
						return {
							customArgs: settings.customArgs ?? null,
							customEnvVars: settings.customEnvVars ?? {},
							customPath: settings.customPath ?? null,
						};
					});
				})
				.toEqual({
					customArgs: null,
					customEnvVars: {},
					customPath: null,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[107].id} ${activeScenarioMatrix[107].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp, { model: 'gpt-5.2-codex' });
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			await settingsDialog.getByTitle('Customize provider settings').click();
			const modelInput = settingsFieldPanel(settingsDialog, 'Model')
				.locator('input[type="text"]')
				.first();

			await expect(modelInput).toHaveValue('gpt-5.2-codex');
			await modelInput.fill('gpt-5.3-codex');
			await modelInput.blur();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const config = await window.maestro.agents.getConfig('codex');
						return config.model;
					});
				})
				.toBe('gpt-5.3-codex');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[108].id} ${activeScenarioMatrix[108].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp, { contextWindow: 400000 });
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			await settingsDialog.getByTitle('Customize provider settings').click();
			const contextWindowInput = settingsFieldPanel(settingsDialog, 'Context Window Size')
				.locator('input[type="number"]')
				.first();

			await expect(contextWindowInput).toHaveValue('400000');
			await contextWindowInput.fill('128000');
			await contextWindowInput.blur();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const config = await window.maestro.agents.getConfig('codex');
						return config.contextWindow;
					});
				})
				.toBe(128000);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[109].id} ${activeScenarioMatrix[109].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp, { model: 'gpt-5.2-codex' });
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			await settingsDialog.getByTitle('Customize provider settings').click();

			await expect(settingsDialog.getByText('2 models available')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[110].id} ${activeScenarioMatrix[110].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Encore Features',
				'Optional features that extend Maestro'
			);
			await settingsDialog.getByTitle('Customize provider settings').click();
			const envPanel = settingsFieldPanel(settingsDialog, 'Environment Variables (optional)');

			await expect(envPanel.getByText('MAESTRO_SESSION_RESUMED')).toBeVisible();
			await expect(envPanel.getByText('1 (when resuming)')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[111].id} ${activeScenarioMatrix[111].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);

			await expect(wizardDialog.getByLabel('Agent name')).toHaveValue('');
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[112].id} ${activeScenarioMatrix[112].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);
			const agentNameInput = wizardDialog.getByLabel('Agent name');

			await agentNameInput.fill('Wizard Codex Agent');
			await expect(agentNameInput).toHaveValue('Wizard Codex Agent');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[113].id} ${activeScenarioMatrix[113].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);
			const codexTile = wizardDialog.getByRole('button', { name: 'Codex' });

			await codexTile.click();
			await expect(codexTile).toHaveAttribute('aria-pressed', 'true');
			await expect(
				wizardDialog.getByRole('button', { name: 'Claude Code (not installed)' })
			).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[114].id} ${activeScenarioMatrix[114].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);

			await wizardDialog.getByLabel('Agent name').fill('Ready Codex Agent');
			await wizardDialog.getByRole('button', { name: 'Codex' }).click();
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[115].id} ${activeScenarioMatrix[115].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);
			const codexTile = wizardDialog.getByRole('button', { name: 'Codex' });

			await codexTile.focus();
			await launched.window.keyboard.press('Enter');
			await expect(codexTile).toHaveAttribute('aria-pressed', 'true');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[116].id} ${activeScenarioMatrix[116].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);
			const geminiTile = wizardDialog.getByRole('button', { name: 'Gemini CLI (coming soon)' });

			await expect(geminiTile).toBeDisabled();
			await expect(geminiTile).toHaveAttribute('aria-pressed', 'false');
			await expect(geminiTile.getByText('Soon')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[117].id} ${activeScenarioMatrix[117].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);
			const codexTile = wizardDialog.getByRole('button', { name: 'Codex' });

			await codexTile.getByTitle('Customize agent settings').click();
			await expect(wizardDialog.getByText('Codex Configuration')).toBeVisible();
			await expect(wizardDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[118].id} ${activeScenarioMatrix[118].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const pathInput = wizardDialog.getByPlaceholder('/path/to/codex');

			await pathInput.fill('/opt/wsp/codex');
			await expect(pathInput).toHaveValue('/opt/wsp/codex');
			await expect(
				settingsFieldPanel(wizardDialog, 'Path').getByRole('button', { name: 'Reset' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[119].id} ${activeScenarioMatrix[119].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const pathInput = wizardDialog.getByPlaceholder('/path/to/codex');

			await pathInput.fill('/opt/wsp/codex');
			await settingsFieldPanel(wizardDialog, 'Path').getByRole('button', { name: 'Reset' }).click();
			await expect(pathInput).toHaveValue('/usr/local/bin/codex');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[120].id} ${activeScenarioMatrix[120].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const argsInput = wizardDialog.getByPlaceholder('--flag value --another-flag');

			await argsInput.fill('--sandbox read-only --model wsp-wizard');
			await expect(argsInput).toHaveValue('--sandbox read-only --model wsp-wizard');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[121].id} ${activeScenarioMatrix[121].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const argsInput = wizardDialog.getByPlaceholder('--flag value --another-flag');

			await argsInput.fill('--sandbox read-only');
			await settingsFieldPanel(wizardDialog, 'Custom Arguments (optional)')
				.getByRole('button', { name: 'Clear' })
				.click();
			await expect(argsInput).toHaveValue('');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[122].id} ${activeScenarioMatrix[122].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);

			await wizardDialog.getByRole('button', { name: 'Add Variable' }).click();
			await wizardDialog.getByPlaceholder('VARIABLE_NAME').fill('WSP_WIZARD_ENV');
			await wizardDialog.getByPlaceholder('value', { exact: true }).fill('enabled');

			await expect(wizardDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue('WSP_WIZARD_ENV');
			await expect(wizardDialog.getByPlaceholder('value', { exact: true })).toHaveValue('enabled');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[123].id} ${activeScenarioMatrix[123].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);

			await wizardDialog.getByRole('button', { name: 'Add Variable' }).click();
			await wizardDialog.getByPlaceholder('VARIABLE_NAME').fill('WSP_WIZARD_REMOVE');
			await settingsFieldPanel(wizardDialog, 'Environment Variables (optional)')
				.getByTitle('Remove variable')
				.click();

			await expect(wizardDialog.getByText('WSP_WIZARD_REMOVE')).toBeHidden();
			await expect(wizardDialog.getByPlaceholder('VARIABLE_NAME')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[124].id} ${activeScenarioMatrix[124].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp, {
				contextWindow: 400000,
				model: 'gpt-5.2-codex',
			});
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const modelInput = settingsFieldPanel(wizardDialog, 'Model')
				.locator('input[type="text"]')
				.first();
			const contextWindowInput = settingsFieldPanel(wizardDialog, 'Context Window Size')
				.locator('input[type="number"]')
				.first();

			await modelInput.fill('gpt-5.4-codex');
			await contextWindowInput.fill('196000');

			await expect(modelInput).toHaveValue('gpt-5.4-codex');
			await expect(contextWindowInput).toHaveValue('196000');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[125].id} ${activeScenarioMatrix[125].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window);

			await expect(
				wizardDialog.getByText('Choose the folder where your project lives')
			).toBeVisible();
			await expect(wizardDialog.getByText("Howdy, I'm Directory Codex Agent")).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[126].id} ${activeScenarioMatrix[126].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Return State Agent');

			await wizardDialog.getByRole('button', { name: 'Back' }).click();
			await expect(wizardDialog.getByLabel('Agent name')).toHaveValue('Return State Agent');
			await expect(wizardDialog.getByRole('button', { name: 'Codex' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[127].id} ${activeScenarioMatrix[127].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window);

			await expect(wizardDialog.getByLabel('Project Directory')).toHaveAttribute(
				'placeholder',
				'/path/to/your/project'
			);
			await expect(wizardDialog.getByRole('button', { name: 'Browse' })).toBeVisible();
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[128].id} ${activeScenarioMatrix[128].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window);
			const missingDir = path.join(seeded.homeDir, 'missing-project');

			await wizardDialog.getByLabel('Project Directory').fill(missingDir);

			await expect(
				wizardDialog.getByText('Directory not found. Please check the path exists.')
			).toBeVisible();
			await expect(wizardDialog.getByLabel('Project Directory')).toHaveAttribute(
				'aria-invalid',
				'true'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[129].id} ${activeScenarioMatrix[129].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window);

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);

			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await expect(wizardDialog.getByText('Not a Git repository')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[130].id} ${activeScenarioMatrix[130].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window);

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[131].id} ${activeScenarioMatrix[131].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window);
			const directoryInput = wizardDialog.getByLabel('Project Directory');

			await directoryInput.fill(path.join(seeded.homeDir, 'missing-project'));
			await expect(
				wizardDialog.getByText('Directory not found. Please check the path exists.')
			).toBeVisible();
			await directoryInput.fill('');

			await expect(
				wizardDialog.getByText('Directory not found. Please check the path exists.')
			).toBeHidden();
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[132].id} ${activeScenarioMatrix[132].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		seedExistingAutoRunDoc(seeded.projectDir);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window);

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			const existingDocsDialog = launched.window.getByRole('dialog', {
				name: 'Existing Auto Run Documents Found',
			});
			await expect(existingDocsDialog).toBeVisible();
			await expect(existingDocsDialog.getByText('1 Auto Run document')).toBeVisible();
			await expect(
				existingDocsDialog.getByRole('button', { name: /Continue Building on Existing Plan/ })
			).toBeFocused();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[133].id} ${activeScenarioMatrix[133].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		seedExistingAutoRunDoc(seeded.projectDir);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Existing Docs Agent');

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			const existingDocsDialog = launched.window.getByRole('dialog', {
				name: 'Existing Auto Run Documents Found',
			});
			const continueExistingPlan = existingDocsDialog.getByRole('button', {
				name: /Continue Building on Existing Plan/,
			});

			await expect(continueExistingPlan).toBeEnabled();
			await expect(existingDocsDialog.getByText('Recommended')).toBeVisible();
			await expect(existingDocsDialog.getByText('continue from where you left off.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[134].id} ${activeScenarioMatrix[134].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		seedExistingAutoRunDoc(seeded.projectDir);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Cancel Docs Agent');
			const directoryInput = wizardDialog.getByLabel('Project Directory');

			await directoryInput.fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			const existingDocsDialog = launched.window.getByRole('dialog', {
				name: 'Existing Auto Run Documents Found',
			});
			await existingDocsDialog
				.getByRole('button', { name: 'Cancel and choose a different directory' })
				.click();

			await expect(existingDocsDialog).toBeHidden();
			await expect(directoryInput).toHaveValue('');
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[135].id} ${activeScenarioMatrix[135].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		seedExistingAutoRunDoc(seeded.projectDir);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Fresh Docs Agent');

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			const existingDocsDialog = launched.window.getByRole('dialog', {
				name: 'Existing Auto Run Documents Found',
			});
			const deleteAndStartFresh = existingDocsDialog.getByRole('button', {
				name: /Delete & Start Fresh/,
			});

			await expect(deleteAndStartFresh).toBeEnabled();
			await expect(
				existingDocsDialog.getByText(
					'Remove all existing Auto Run documents and start the planning process from scratch.'
				)
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[136].id} ${activeScenarioMatrix[136].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		seedExistingAutoRunDoc(seeded.projectDir);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Keyboard Docs Agent');
			const directoryInput = wizardDialog.getByLabel('Project Directory');

			await directoryInput.fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await launched.window.keyboard.press('Enter');

			await expect(
				launched.window.getByRole('dialog', { name: 'Existing Auto Run Documents Found' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[137].id} ${activeScenarioMatrix[137].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		seedExistingAutoRunDoc(seeded.projectDir);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Escape Docs Agent');
			const directoryInput = wizardDialog.getByLabel('Project Directory');

			await directoryInput.fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			const existingDocsDialog = launched.window.getByRole('dialog', {
				name: 'Existing Auto Run Documents Found',
			});
			await expect(existingDocsDialog).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(existingDocsDialog).toBeHidden();
			await expect(directoryInput).toHaveValue('');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[138].id} ${activeScenarioMatrix[138].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		seedExistingAutoRunDoc(seeded.projectDir);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Revalidate Docs Agent');
			const directoryInput = wizardDialog.getByLabel('Project Directory');

			await directoryInput.fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			await launched.window
				.getByRole('dialog', { name: 'Existing Auto Run Documents Found' })
				.getByRole('button', { name: 'Cancel and choose a different directory' })
				.click();

			await directoryInput.fill(seeded.projectDir);

			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[139].id} ${activeScenarioMatrix[139].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');

			await expect(settingsDialog.getByText('Database size')).toBeVisible();
			await expect(settingsDialog.locator('#clear-stats-period')).toBeVisible();
			await expect(settingsDialog.getByRole('button', { name: 'Clear' })).toBeVisible();
			await expect(
				settingsDialog.getByText('Remove old query events, Auto Run sessions, and tasks')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[140].id} ${activeScenarioMatrix[140].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');

			await settingsDialog.locator('#clear-stats-period').selectOption('30');
			await settingsDialog.getByRole('button', { name: 'Clear' }).click();

			await expect(settingsDialog.getByText(/Cleared \d+ records/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[141].id} ${activeScenarioMatrix[141].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				wakatimeEnabled: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');

			await expect(
				settingsDialog.getByRole('switch', { name: 'Enable WakaTime tracking' })
			).toHaveAttribute('aria-checked', 'false');
			await expect(settingsDialog.getByText('Detailed file tracking')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[142].id} ${activeScenarioMatrix[142].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				wakatimeEnabled: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');

			await expect(settingsDialog.getByPlaceholder('waka_...')).toBeHidden();
			await expect(settingsDialog.getByTitle('Clear API key')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[143].id} ${activeScenarioMatrix[143].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				wakatimeEnabled: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');

			await expect(settingsDialog.getByText('Enable WakaTime tracking')).toBeVisible();
			await expect(
				settingsDialog.getByText('Track coding activity in Maestro sessions via WakaTime.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[144].id} ${activeScenarioMatrix[144].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');

			await expect(settingsDialog.getByText('Settings folder')).toBeVisible();
			await expect(settingsDialog.getByText('Default Location')).toBeVisible();
			await expect(settingsDialog.getByRole('button', { name: /Choose Folder/ })).toBeVisible();
			await expect(
				settingsDialog.getByText('Only run Maestro on one device at a time')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[145].id} ${activeScenarioMatrix[145].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');
			const openStorageLocation = settingsDialog.getByRole('button', {
				name: /Open in (Finder|Explorer|File Manager)/,
			});

			await expect(openStorageLocation).toBeVisible();
			await expect(openStorageLocation).toBeEnabled();
			await expect(openStorageLocation).toHaveAttribute('title', /.+/);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[146].id} ${activeScenarioMatrix[146].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			const customThemeSection = settingsDialog.locator('[data-theme-id="custom"]');

			await expect(customThemeSection.getByTitle('Export theme')).toBeVisible();
			await expect(customThemeSection.getByTitle('Import theme')).toBeVisible();
			await expect(customThemeSection.getByTitle('Reset to default')).toBeVisible();
			await expect(customThemeSection.locator('input[type="file"]')).toHaveAttribute(
				'accept',
				'.json'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[147].id} ${activeScenarioMatrix[147].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const importedColors = createCustomThemeImportColors();
		const themePath = writeThemeImportFile(
			seeded.homeDir,
			'wsp-valid-custom-theme.json',
			JSON.stringify({
				name: 'WSP Valid Theme',
				baseTheme: 'nord',
				colors: importedColors,
			})
		);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog
				.locator('[data-theme-id="custom"] input[type="file"]')
				.setInputFiles(themePath);

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const colors = await window.maestro.settings.get('customThemeColors');
						return colors && typeof colors === 'object'
							? {
									bgMain: 'bgMain' in colors ? colors.bgMain : undefined,
									accent: 'accent' in colors ? colors.accent : undefined,
									accentDim: 'accentDim' in colors ? colors.accentDim : undefined,
								}
							: undefined;
					});
				})
				.toEqual({
					bgMain: importedColors.bgMain,
					accent: importedColors.accent,
					accentDim: importedColors.accentDim,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[148].id} ${activeScenarioMatrix[148].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const originalColors = createCustomThemeImportColors({ accent: '#aa5500' });
		const invalidThemePath = writeThemeImportFile(
			seeded.homeDir,
			'wsp-invalid-color-theme.json',
			JSON.stringify({
				colors: createCustomThemeImportColors({ accent: 'not-a-color' }),
			})
		);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customThemeColors: originalColors,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog
				.locator('[data-theme-id="custom"] input[type="file"]')
				.setInputFiles(invalidThemePath);

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const colors = await window.maestro.settings.get('customThemeColors');
						return colors && typeof colors === 'object' && 'accent' in colors
							? colors.accent
							: undefined;
					});
				})
				.toBe(originalColors.accent);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[149].id} ${activeScenarioMatrix[149].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const originalColors = createCustomThemeImportColors({ bgMain: '#202020' });
		const missingColorsPath = writeThemeImportFile(
			seeded.homeDir,
			'wsp-missing-colors-theme.json',
			JSON.stringify({ name: 'Missing Colors' })
		);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customThemeColors: originalColors,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog
				.locator('[data-theme-id="custom"] input[type="file"]')
				.setInputFiles(missingColorsPath);

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const colors = await window.maestro.settings.get('customThemeColors');
						return colors && typeof colors === 'object' && 'bgMain' in colors
							? colors.bgMain
							: undefined;
					});
				})
				.toBe(originalColors.bgMain);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[150].id} ${activeScenarioMatrix[150].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const originalColors = createCustomThemeImportColors({ textMain: '#eeeeee' });
		const missingKeysPath = writeThemeImportFile(
			seeded.homeDir,
			'wsp-missing-theme-keys.json',
			JSON.stringify({ colors: { accent: '#33aaff' } })
		);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customThemeColors: originalColors,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog
				.locator('[data-theme-id="custom"] input[type="file"]')
				.setInputFiles(missingKeysPath);

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const colors = await window.maestro.settings.get('customThemeColors');
						return colors && typeof colors === 'object' && 'textMain' in colors
							? colors.textMain
							: undefined;
					});
				})
				.toBe(originalColors.textMain);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[151].id} ${activeScenarioMatrix[151].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const originalColors = createCustomThemeImportColors({ border: '#121212' });
		const invalidJsonPath = writeThemeImportFile(
			seeded.homeDir,
			'wsp-invalid-theme-json.json',
			'{ invalid json'
		);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customThemeColors: originalColors,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog
				.locator('[data-theme-id="custom"] input[type="file"]')
				.setInputFiles(invalidJsonPath);

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const colors = await window.maestro.settings.get('customThemeColors');
						return colors && typeof colors === 'object' && 'border' in colors
							? colors.border
							: undefined;
					});
				})
				.toBe(originalColors.border);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[152].id} ${activeScenarioMatrix[152].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const importedColors = createCustomThemeImportColors();
		const themePath = writeThemeImportFile(
			seeded.homeDir,
			'wsp-valid-base-theme.json',
			JSON.stringify({
				baseTheme: 'solarized-light',
				colors: importedColors,
			})
		);
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customThemeBaseId: 'dracula',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Themes', 'Custom Theme');
			await settingsDialog
				.locator('[data-theme-id="custom"] input[type="file"]')
				.setInputFiles(themePath);

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('customThemeBaseId');
					});
				})
				.toBe('solarized-light');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[153].id} ${activeScenarioMatrix[153].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const customPath = path.join(seeded.homeDir, 'synced-settings');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStorageSyncHandlers(launched.electronApp, {
				selectedFolder: customPath,
				setCustomPathResult: { success: true, migrated: 4 },
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');

			await settingsDialog.getByRole('button', { name: /Choose Folder/ }).click();

			await expect(settingsDialog.getByText('Current Location (Custom)')).toBeVisible();
			await expect(settingsDialog.getByText(customPath)).toBeVisible();
			await expect(settingsDialog.getByText('Migrated 4 settings files')).toBeVisible();
			await expect(
				settingsDialog.getByText('Restart Maestro for changes to take effect')
			).toBeVisible();
			await expect
				.poll(async () => await getStubbedStorageSyncState(launched.electronApp))
				.toEqual(expect.objectContaining({ customPath, setCalls: [customPath] }));
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[154].id} ${activeScenarioMatrix[154].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const customPath = path.join(seeded.homeDir, 'cloud-settings');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStorageSyncHandlers(launched.electronApp, {
				initialCustomPath: customPath,
				resetCustomPathResult: { success: true, migrated: 2 },
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');
			await expect(settingsDialog.getByText('Current Location (Custom)')).toBeVisible();

			await settingsDialog.getByRole('button', { name: 'Use Default' }).click();

			await expect(settingsDialog.getByText('Current Location (Custom)')).toBeHidden();
			await expect(settingsDialog.getByText('Migrated 2 settings files')).toBeVisible();
			await expect(
				settingsDialog.getByText('Restart Maestro for changes to take effect')
			).toBeVisible();
			const state = await getStubbedStorageSyncState(launched.electronApp);
			expect(state.customPath).toBeUndefined();
			expect(state.setCalls).toEqual([null]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[155].id} ${activeScenarioMatrix[155].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStorageSyncHandlers(launched.electronApp, { selectedFolder: null });
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');

			await settingsDialog.getByRole('button', { name: /Choose Folder/ }).click();

			await expect(settingsDialog.getByText('Current Location (Custom)')).toBeHidden();
			await expect(
				settingsDialog.getByText('Restart Maestro for changes to take effect')
			).toBeHidden();
			const state = await getStubbedStorageSyncState(launched.electronApp);
			expect(state.setCalls).toEqual([]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[156].id} ${activeScenarioMatrix[156].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const customPath = path.join(seeded.homeDir, 'blocked-settings');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStorageSyncHandlers(launched.electronApp, {
				selectedFolder: customPath,
				setCustomPathResult: {
					success: false,
					errors: ['Cannot migrate active settings'],
				},
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');

			await settingsDialog.getByRole('button', { name: /Choose Folder/ }).click();

			await expect(settingsDialog.getByText('Cannot migrate active settings')).toBeVisible();
			await expect(
				settingsDialog.getByText('Restart Maestro for changes to take effect')
			).toBeHidden();
			const state = await getStubbedStorageSyncState(launched.electronApp);
			expect(state.customPath).toBeUndefined();
			expect(state.setCalls).toEqual([customPath]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[157].id} ${activeScenarioMatrix[157].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const customPath = path.join(seeded.homeDir, 'existing-cloud-settings');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStorageSyncHandlers(launched.electronApp, {
				initialCustomPath: customPath,
				resetCustomPathResult: {
					success: false,
					error: 'Reset blocked by sync lock',
				},
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');

			await settingsDialog.getByRole('button', { name: 'Use Default' }).click();

			await expect(settingsDialog.getByText('Reset blocked by sync lock')).toBeVisible();
			await expect(settingsDialog.getByText('Current Location (Custom)')).toBeVisible();
			await expect(settingsDialog.getByText(customPath)).toBeVisible();
			const state = await getStubbedStorageSyncState(launched.electronApp);
			expect(state.customPath).toBe(customPath);
			expect(state.setCalls).toEqual([null]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[158].id} ${activeScenarioMatrix[158].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const customPath = path.join(seeded.homeDir, 'file-manager-settings');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStorageSyncHandlers(launched.electronApp, {
				initialCustomPath: customPath,
			});
			await stubShellPathHandlers(launched.electronApp);
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Storage Location');

			await settingsDialog.getByRole('button', { name: /Open in/ }).click();

			await expect
				.poll(async () => await getStubbedShellPathCalls(launched.electronApp))
				.toEqual([{ type: 'openPath', itemPath: customPath }]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[159].id} ${activeScenarioMatrix[159].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				documentGraphMaxNodes: 150,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Document Graph');
			const maxNodesControl = settingsDialog
				.getByText('Maximum nodes to display')
				.locator('xpath=ancestor::div[.//input[@type="range"]][1]');

			await maxNodesControl.locator('input[type="range"]').evaluate((slider) => {
				const input = slider as HTMLInputElement;
				input.value = '350';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			});

			await expect(maxNodesControl.getByText('350')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('documentGraphMaxNodes');
					});
				})
				.toBe(350);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[160].id} ${activeScenarioMatrix[160].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				documentGraphMaxNodes: 950,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Document Graph');
			const maxNodesControl = settingsDialog
				.getByText('Maximum nodes to display')
				.locator('xpath=ancestor::div[.//input[@type="range"]][1]');

			await maxNodesControl.locator('input[type="range"]').evaluate((slider) => {
				const input = slider as HTMLInputElement;
				input.value = '1200';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			});

			await expect(maxNodesControl.getByText('1000')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('documentGraphMaxNodes');
					});
				})
				.toBe(1000);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[161].id} ${activeScenarioMatrix[161].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				contextManagementSettings: {
					contextWarningsEnabled: false,
					contextWarningYellowThreshold: 65,
					contextWarningRedThreshold: 85,
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Context Window Warnings'
			);
			const thresholdPanel = settingsDialog
				.getByText('Yellow warning threshold')
				.locator('xpath=ancestor::div[contains(@class, "space-y-4")][1]');

			await expect(thresholdPanel).toHaveCSS('pointer-events', 'none');
			await expect(thresholdPanel).toHaveCSS('opacity', '0.4');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[162].id} ${activeScenarioMatrix[162].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				contextManagementSettings: {
					contextWarningsEnabled: true,
					contextWarningYellowThreshold: 65,
					contextWarningRedThreshold: 85,
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Context Window Warnings'
			);

			await expect(settingsDialog.getByText('65%')).toBeVisible();
			await expect(settingsDialog.getByText('85%')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[163].id} ${activeScenarioMatrix[163].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				contextManagementSettings: {
					contextWarningsEnabled: true,
					contextWarningYellowThreshold: 60,
					contextWarningRedThreshold: 80,
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Context Window Warnings'
			);
			const redThresholdControl = settingsDialog
				.getByText('Red warning threshold')
				.locator('xpath=ancestor::div[.//input[@type="range"]][1]');

			await redThresholdControl.locator('input[type="range"]').evaluate((slider) => {
				const input = slider as HTMLInputElement;
				input.value = '55';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			});

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('contextManagementSettings');
					});
				})
				.toMatchObject({
					contextWarningsEnabled: true,
					contextWarningYellowThreshold: 45,
					contextWarningRedThreshold: 55,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[164].id} ${activeScenarioMatrix[164].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				contextManagementSettings: {
					contextWarningsEnabled: false,
					contextWarningYellowThreshold: 70,
					contextWarningRedThreshold: 90,
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Context Window Warnings'
			);
			const contextWarningsToggle = settingsDialog.getByRole('button', {
				name: /Show context consumption warnings/,
			});

			await contextWarningsToggle.press('Enter');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('contextManagementSettings');
					});
				})
				.toMatchObject({
					contextWarningsEnabled: true,
					contextWarningYellowThreshold: 70,
					contextWarningRedThreshold: 90,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[165].id} ${activeScenarioMatrix[165].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				localIgnorePatterns: ['.git', 'node_modules'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Local Ignore Patterns'
			);
			const localIgnorePatternsSection = settingsDialog
				.getByText('Local Ignore Patterns')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');

			await localIgnorePatternsSection
				.getByPlaceholder('Enter glob pattern (e.g., node_modules, *.log)')
				.fill('.git');
			await localIgnorePatternsSection.getByRole('button', { name: 'Add' }).click();

			await expect(localIgnorePatternsSection.getByText('Pattern already exists')).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('localIgnorePatterns');
					});
				})
				.toEqual(['.git', 'node_modules']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[166].id} ${activeScenarioMatrix[166].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				localIgnorePatterns: ['custom-cache'],
				localHonorGitignore: false,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Local Ignore Patterns'
			);
			const localIgnorePatternsSection = settingsDialog
				.getByText('Local Ignore Patterns')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');

			await localIgnorePatternsSection.getByRole('button', { name: /Reset to defaults/ }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return {
							patterns: await window.maestro.settings.get('localIgnorePatterns'),
							honorGitignore: await window.maestro.settings.get('localHonorGitignore'),
						};
					});
				})
				.toEqual({
					patterns: ['.git', 'node_modules', '__pycache__'],
					honorGitignore: true,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[167].id} ${activeScenarioMatrix[167].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Local Ignore Patterns'
			);
			const localIgnorePatternsSection = settingsDialog
				.getByText('Local Ignore Patterns')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');

			await expect(localIgnorePatternsSection.getByRole('button', { name: 'Add' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[168].id} ${activeScenarioMatrix[168].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				localIgnorePatterns: ['.git'],
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Display',
				'Local Ignore Patterns'
			);
			const localIgnorePatternsSection = settingsDialog
				.getByText('Local Ignore Patterns')
				.locator('xpath=ancestor::div[contains(@class, "rounded")][1]');
			await localIgnorePatternsSection
				.getByPlaceholder('Enter glob pattern (e.g., node_modules, *.log)')
				.fill('tmp-e2e-cache');
			await localIgnorePatternsSection
				.getByPlaceholder('Enter glob pattern (e.g., node_modules, *.log)')
				.press('Enter');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('localIgnorePatterns');
					});
				})
				.toEqual(['.git', 'tmp-e2e-cache']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[169].id} ${activeScenarioMatrix[169].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Bionify Algorithm');

			await settingsDialog.getByTitle('Bionify algorithm info').click();

			const referenceDialog = launched.window.getByRole('dialog', {
				name: 'Bionify Algorithm Reference',
			});
			await expect(referenceDialog).toBeVisible();
			await expect(referenceDialog.getByText('Current default:')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[170].id} ${activeScenarioMatrix[170].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'Display', 'Bionify Algorithm');
			await settingsDialog.getByTitle('Bionify algorithm info').click();
			const referenceDialog = launched.window.getByRole('dialog', {
				name: 'Bionify Algorithm Reference',
			});
			await expect(referenceDialog).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(referenceDialog).toBeHidden();
			await expect(settingsDialog).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[171].id} ${activeScenarioMatrix[171].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				defaultStatsTimeRange: 'week',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');
			const timeRangeControl = settingsDialog
				.getByText('Default dashboard time range')
				.locator('xpath=ancestor::div[.//select][1]');

			await timeRangeControl.locator('select').selectOption('all');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('defaultStatsTimeRange');
					});
				})
				.toBe('all');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[172].id} ${activeScenarioMatrix[172].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				ghPath: '/usr/local/bin/gh',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'GitHub CLI (gh) Path'
			);
			const ghPathSection = settingsDialog
				.getByText('GitHub CLI (gh) Path')
				.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]');

			await ghPathSection.getByRole('button', { name: 'Clear' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('ghPath');
					});
				})
				.toBe('');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[173].id} ${activeScenarioMatrix[173].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				shellArgs: '--login --interactive',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
			const shellArgsSection = settingsDialog
				.getByText('Additional Arguments (optional)')
				.locator('xpath=ancestor::div[.//input[@placeholder="--flag value"]][1]');

			await shellArgsSection.getByRole('button', { name: 'Clear' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('shellArgs');
					});
				})
				.toBe('');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[174].id} ${activeScenarioMatrix[174].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStatsDataManagement(launched.electronApp, {
				clearResult: {
					success: false,
					deletedQueryEvents: 0,
					deletedAutoRunSessions: 0,
					deletedAutoRunTasks: 0,
					error: 'Stats database locked',
				},
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');
			const clearStatsSection = settingsDialog
				.getByText('Clear stats older than...')
				.locator('xpath=ancestor::div[.//select[@id="clear-stats-period"]][1]');

			await clearStatsSection.locator('select').selectOption('30');
			await clearStatsSection.getByRole('button', { name: 'Clear' }).click();

			await expect(settingsDialog.getByText('Stats database locked')).toBeVisible();
			await expect
				.poll(async () => await getStubbedStatsClearDays(launched.electronApp))
				.toEqual([30]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[175].id} ${activeScenarioMatrix[175].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStatsDataManagement(launched.electronApp, {
				dbSize: 3 * 1024 * 1024,
				earliestTimestamp: Date.UTC(2026, 4, 10),
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');

			await expect(settingsDialog.getByText('3.00 MB')).toBeVisible();
			await expect(settingsDialog.getByText(/since/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[176].id} ${activeScenarioMatrix[176].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();

			await expect(settingsDialog.getByText('Global Environment Variables')).toBeVisible();
			await expect(
				settingsDialog.getByText(/apply to all terminal sessions and\s+AI agent processes/)
			).toBeVisible();
			await expect(
				settingsDialog.getByText('Agent-specific settings can override these values.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[177].id} ${activeScenarioMatrix[177].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();

			await settingsDialog
				.locator('input[placeholder="/path/to/shell"]')
				.fill('/opt/maestro/bin/fish');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('customShellPath');
					});
				})
				.toBe('/opt/maestro/bin/fish');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[178].id} ${activeScenarioMatrix[178].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				customShellPath: '/opt/maestro/bin/fish',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
			const customShellPathSection = settingsDialog
				.locator('input[placeholder="/path/to/shell"]')
				.locator('xpath=ancestor::div[contains(@class, "flex")][1]');

			await customShellPathSection.getByRole('button', { name: 'Clear' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('customShellPath');
					});
				})
				.toBe('');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[179].id} ${activeScenarioMatrix[179].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				statsCollectionEnabled: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');

			await settingsDialog.getByRole('switch', { name: 'Enable stats collection' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('statsCollectionEnabled');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[180].id} ${activeScenarioMatrix[180].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubStatsDataManagement(launched.electronApp, {
				clearResult: {
					success: true,
					deletedQueryEvents: 4,
					deletedAutoRunSessions: 2,
					deletedAutoRunTasks: 1,
				},
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'Usage & Stats');
			const clearStatsSection = settingsDialog
				.getByText('Clear stats older than...')
				.locator('xpath=ancestor::div[.//select[@id="clear-stats-period"]][1]');

			await clearStatsSection.locator('select').selectOption('365');
			await clearStatsSection.getByRole('button', { name: 'Clear' }).click();

			await expect(
				settingsDialog.getByText('Cleared 7 records (4 queries, 2 sessions, 1 tasks)')
			).toBeVisible();
			await expect
				.poll(async () => await getStubbedStatsClearDays(launched.electronApp))
				.toEqual([365]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[181].id} ${activeScenarioMatrix[181].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
			await settingsDialog.getByRole('button', { name: 'Add Variable' }).click();
			await settingsDialog
				.locator('input[placeholder="VARIABLE"]')
				.last()
				.fill('MAESTRO_TEST_TOKEN');
			await settingsDialog.locator('input[placeholder="value"]').last().fill('redacted-value');

			await expect(settingsDialog.getByText(/Valid \(1 variables loaded\)/)).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('shellEnvVars');
					});
				})
				.toEqual({ MAESTRO_TEST_TOKEN: 'redacted-value' });
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[182].id} ${activeScenarioMatrix[182].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				shellEnvVars: {
					MAESTRO_FLAG: 'enabled',
				},
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
			await expect(settingsDialog.getByText(/Valid \(1 variables loaded\)/)).toBeVisible();

			await settingsDialog.getByTitle('Remove variable').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('shellEnvVars');
					});
				})
				.toEqual({});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[183].id} ${activeScenarioMatrix[183].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'General',
				'Default Terminal Shell'
			);
			await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
			await settingsDialog.getByRole('button', { name: 'Add Variable' }).click();
			await settingsDialog.locator('input[placeholder="VARIABLE"]').last().fill('1INVALID');
			await settingsDialog.locator('input[placeholder="value"]').last().fill('blocked-value');

			await expect(settingsDialog.getByText(/Invalid variable name/)).toBeVisible();
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('shellEnvVars');
					});
				})
				.toEqual({});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[184].id} ${activeScenarioMatrix[184].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				osNotificationsEnabled: true,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Operating System Notifications'
			);

			await settingsDialog.getByText('Enable OS Notifications').click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('osNotificationsEnabled');
					});
				})
				.toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[185].id} ${activeScenarioMatrix[185].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubNotificationHandlers(launched.electronApp);
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Operating System Notifications'
			);

			await settingsDialog.getByRole('button', { name: 'Test Notification' }).click();

			await expect
				.poll(async () => (await getStubbedNotificationState(launched.electronApp)).showCalls)
				.toEqual([
					{
						title: 'Maestro',
						body: 'Test notification - notifications are working!',
					},
				]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[186].id} ${activeScenarioMatrix[186].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				audioFeedbackCommand: 'say',
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Custom Notification'
			);

			await settingsDialog.locator('input[placeholder="say"]').fill('say -v Samantha');

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('audioFeedbackCommand');
					});
				})
				.toBe('say -v Samantha');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[187].id} ${activeScenarioMatrix[187].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				audioFeedbackCommand: 'say -v Alex',
			},
		});

		try {
			await stubNotificationHandlers(launched.electronApp, {
				speakResult: { success: true, notificationId: 902 },
			});
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Custom Notification'
			);

			await settingsDialog.getByRole('button', { name: 'Test', exact: true }).click();

			await expect(settingsDialog.getByRole('button', { name: 'Stop' })).toBeVisible();
			await expect
				.poll(async () => (await getStubbedNotificationState(launched.electronApp)).speakCalls)
				.toEqual([
					{
						text: "Howdy, I'm Maestro, here to conduct your agentic tools into a well-tuned symphony.",
						command: 'say -v Alex',
					},
				]);

			await emitStubbedNotificationCompletion(launched.electronApp, 902);

			await expect(settingsDialog.getByRole('button', { name: 'Success' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[188].id} ${activeScenarioMatrix[188].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubNotificationHandlers(launched.electronApp, {
				speakResult: { success: true, notificationId: 903 },
			});
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Custom Notification'
			);

			await settingsDialog.getByRole('button', { name: 'Test', exact: true }).click();
			await expect(settingsDialog.getByRole('button', { name: 'Stop' })).toBeVisible();
			await settingsDialog.getByRole('button', { name: 'Stop' }).click();

			await expect
				.poll(async () => (await getStubbedNotificationState(launched.electronApp)).stopCalls)
				.toEqual([903]);
			await expect(settingsDialog.getByRole('button', { name: 'Test', exact: true })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[189].id} ${activeScenarioMatrix[189].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubNotificationHandlers(launched.electronApp, {
				speakResult: { success: false, error: 'Command failed: missing binary' },
			});
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Custom Notification'
			);

			await settingsDialog.getByRole('button', { name: 'Test', exact: true }).click();

			await expect(settingsDialog.getByRole('button', { name: 'Failed' })).toBeVisible();
			await expect(settingsDialog.getByText('Command failed: missing binary')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[190].id} ${activeScenarioMatrix[190].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				toastDuration: 20,
			},
		});

		try {
			const settingsDialog = await openSettingsTab(
				launched.window,
				'Notifications',
				'Toast Notification Duration'
			);

			await settingsDialog.getByRole('button', { name: 'Never' }).click();

			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						return await window.maestro.settings.get('toastDuration');
					});
				})
				.toBe(0);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[191].id} ${activeScenarioMatrix[191].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp);
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');

			await expect(settingsDialog.getByText('No SSH remotes configured')).toBeVisible();
			await expect(
				settingsDialog.getByText('Add a remote host to run AI agents on external machines')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[192].id} ${activeScenarioMatrix[192].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp);
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');

			await settingsDialog.getByRole('button', { name: 'Add SSH Remote' }).click();

			await expect(launched.window.getByRole('dialog', { name: 'Add SSH Remote' })).toBeVisible();
			await expect(launched.window.getByLabel('Display Name')).toHaveValue('');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[193].id} ${activeScenarioMatrix[193].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp);
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');
			await settingsDialog.getByRole('button', { name: 'Add SSH Remote' }).click();
			const sshDialog = launched.window.getByRole('dialog', { name: 'Add SSH Remote' });

			await expect(sshDialog.getByRole('button', { name: 'Save' })).toBeDisabled();
			await sshDialog.getByLabel('Display Name').fill('Invalid Remote');
			await expect(sshDialog.getByRole('button', { name: 'Save' })).toBeDisabled();
			await sshDialog.getByLabel('Host').fill('invalid.example.com');
			await sshDialog.getByLabel('Port').fill('70000');
			await expect(sshDialog.getByRole('button', { name: 'Save' })).toBeDisabled();
			await sshDialog.getByLabel('Port').fill('2222');
			await expect(sshDialog.getByRole('button', { name: 'Save' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[194].id} ${activeScenarioMatrix[194].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp);
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');
			await settingsDialog.getByRole('button', { name: 'Add SSH Remote' }).click();
			const sshDialog = launched.window.getByRole('dialog', { name: 'Add SSH Remote' });

			await sshDialog.getByLabel('Display Name').fill('Quant VPS');
			await sshDialog.getByLabel('Host').fill('quant.example.com');
			await sshDialog.getByLabel('Port').fill('2222');
			await sshDialog.getByLabel('Username (optional)').fill('ubuntu');
			await sshDialog.getByLabel('Private Key Path (optional)').fill('~/.ssh/quant_vps');
			await sshDialog.getByRole('button', { name: 'Add Variable' }).click();
			await sshDialog.locator('input[placeholder="VARIABLE"]').last().fill('MAESTRO_REMOTE');
			await sshDialog.locator('input[placeholder="value"]').last().fill('enabled');
			await sshDialog.getByRole('button', { name: 'Save' }).click();

			await expect(settingsDialog.getByText('Quant VPS')).toBeVisible();
			await expect
				.poll(async () => (await getStubbedSshRemoteState(launched.electronApp)).configs)
				.toEqual([
					expect.objectContaining({
						id: 'ssh-remote-1',
						name: 'Quant VPS',
						host: 'quant.example.com',
						port: 2222,
						username: 'ubuntu',
						privateKeyPath: '~/.ssh/quant_vps',
						remoteEnv: { MAESTRO_REMOTE: 'enabled' },
						enabled: true,
					}),
				]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[195].id} ${activeScenarioMatrix[195].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp, {
				sshConfigHosts: [
					{
						host: 'quant-vps',
						hostName: '203.0.113.10',
						port: 2202,
						user: 'ubuntu',
						identityFile: '~/.ssh/quant_vps',
					},
				],
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');
			await settingsDialog.getByRole('button', { name: 'Add SSH Remote' }).click();
			const sshDialog = launched.window.getByRole('dialog', { name: 'Add SSH Remote' });

			await sshDialog.getByRole('button', { name: /Select a host to import/ }).click();
			await sshDialog.getByRole('button', { name: /quant-vps/ }).click();

			await expect(sshDialog.getByLabel('Display Name')).toHaveValue('quant-vps');
			await expect(sshDialog.getByLabel('Host', { exact: true })).toHaveValue('quant-vps');
			await expect(sshDialog.getByLabel('Port')).toHaveValue('2202');
			await expect(sshDialog.getByLabel('Username (optional)')).toHaveValue('ubuntu');
			await expect(sshDialog.getByLabel('Private Key Path (optional)')).toHaveValue(
				'~/.ssh/quant_vps'
			);
			await expect(sshDialog.getByText('Imported from:')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[196].id} ${activeScenarioMatrix[196].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp, {
				sshConfigHosts: [{ host: 'staging-vps', user: 'deploy' }],
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');
			await settingsDialog.getByRole('button', { name: 'Add SSH Remote' }).click();
			const sshDialog = launched.window.getByRole('dialog', { name: 'Add SSH Remote' });
			await sshDialog.getByRole('button', { name: /Select a host to import/ }).click();
			await sshDialog.getByRole('button', { name: /staging-vps/ }).click();

			await sshDialog.getByTitle('Stop tracking SSH config origin').click();

			await expect(sshDialog.getByText('Imported from:')).toBeHidden();
			await expect(sshDialog.getByLabel('Host', { exact: true })).toHaveValue('staging-vps');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[197].id} ${activeScenarioMatrix[197].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig();
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');

			await settingsDialog.getByTitle('Set as default').click();
			await expect(settingsDialog.getByText('Default')).toBeVisible();
			await settingsDialog.getByTitle('Remove as default').click();

			await expect
				.poll(async () => (await getStubbedSshRemoteState(launched.electronApp)).defaultCalls)
				.toEqual(['ssh-remote-1', null]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[198].id} ${activeScenarioMatrix[198].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig();
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp, {
				configs: [seededRemote],
				testResult: {
					success: true,
					result: { remoteInfo: { hostname: 'quant-vps.internal' } },
				},
			});
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');

			await settingsDialog.getByTitle('Test connection').click();

			await expect(settingsDialog.getByText('Connected to quant-vps.internal')).toBeVisible();
			await expect
				.poll(async () => (await getStubbedSshRemoteState(launched.electronApp)).testCalls)
				.toEqual([expect.objectContaining({ id: 'ssh-remote-1' })]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[199].id} ${activeScenarioMatrix[199].title}`, async () => {
		const disabledRemote = createStubSshRemoteConfig({ enabled: false });
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp, { configs: [disabledRemote] });
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');

			await expect(settingsDialog.getByText('Disabled')).toBeVisible();
			await expect(settingsDialog.getByTitle('Test connection')).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[200].id} ${activeScenarioMatrix[200].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig();
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			const settingsDialog = await openSettingsTab(launched.window, 'General', 'SSH Remote Hosts');

			await settingsDialog.getByTitle('Delete').click();

			await expect(settingsDialog.getByText('No SSH remotes configured')).toBeVisible();
			await expect
				.poll(async () => (await getStubbedSshRemoteState(launched.electronApp)).deleteCalls)
				.toEqual(['ssh-remote-1']);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[201].id} ${activeScenarioMatrix[201].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig({ name: 'Remote Build Host' });
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			const wizardDialog = await openNewAgentWizard(launched.window);
			const locationSelect = wizardDialog.getByLabel('Agent location');

			await expect(locationSelect).toBeVisible();
			await expect(locationSelect).toHaveValue('');
			await expect(locationSelect.locator('option[value=""]')).toHaveText('Local Machine');
			await expect(locationSelect.locator('option[value="ssh-remote-1"]')).toHaveText(
				'Remote Build Host'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[202].id} ${activeScenarioMatrix[202].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig({ name: 'Quant VPS' });
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			const wizardDialog = await openNewAgentWizard(launched.window);

			await wizardDialog.getByLabel('Agent location').selectOption('ssh-remote-1');
			await wizardDialog.getByLabel('Agent name').fill('Remote Directory Agent');
			await wizardDialog.getByRole('button', { name: 'Codex' }).click();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			await expect(wizardDialog.getByLabel('Project Directory')).toHaveAttribute(
				'placeholder',
				/Enter path on Quant VPS/
			);
			await expect(wizardDialog.getByRole('button', { name: 'Browse' })).toBeHidden();
			await expect(wizardDialog.getByText(/Enter the full path on/)).toBeVisible();
			await expect(wizardDialog.getByText('Quant VPS')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[203].id} ${activeScenarioMatrix[203].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig();
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, { isRepo: true });
			const wizardDialog = await openNewAgentWizard(launched.window);

			await wizardDialog.getByLabel('Agent location').selectOption('ssh-remote-1');
			await wizardDialog.getByLabel('Agent name').fill('Remote Git Agent');
			await wizardDialog.getByRole('button', { name: 'Codex' }).click();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();
			await wizardDialog.getByLabel('Project Directory').fill('/srv/maestro/project');

			await expect(wizardDialog.getByText('Git Repository Detected')).toBeVisible();
			await expect
				.poll(async () => await getStubbedWizardRemoteDirectoryState(launched.electronApp))
				.toMatchObject({
					readDirCalls: [{ dirPath: '/srv/maestro/project', sshRemoteId: 'ssh-remote-1' }],
					gitCalls: [{ cwd: '/srv/maestro/project', sshRemoteId: 'ssh-remote-1' }],
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[204].id} ${activeScenarioMatrix[204].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig({ name: 'Planning VPS' });
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				autoRunDocs: [
					{ name: 'phase-remote.md', path: '/srv/maestro/project/Auto Run Docs/phase-remote.md' },
				],
			});
			const wizardDialog = await openNewAgentWizard(launched.window);

			await wizardDialog.getByLabel('Agent location').selectOption('ssh-remote-1');
			await wizardDialog.getByLabel('Agent name').fill('Remote Existing Docs Agent');
			await wizardDialog.getByRole('button', { name: 'Codex' }).click();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();
			await wizardDialog.getByLabel('Project Directory').fill('/srv/maestro/project');
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			await expect(
				launched.window.getByRole('dialog', { name: 'Existing Auto Run Documents Found' })
			).toBeVisible();
			await expect
				.poll(
					async () =>
						(await getStubbedWizardRemoteDirectoryState(launched.electronApp)).listDocsCalls
				)
				.toContainEqual({
					folderPath: '/srv/maestro/project/Auto Run Docs',
					sshRemoteId: 'ssh-remote-1',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[205].id} ${activeScenarioMatrix[205].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig();
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				readDirError: 'Remote directory missing',
			});
			const wizardDialog = await openNewAgentWizard(launched.window);

			await wizardDialog.getByLabel('Agent location').selectOption('ssh-remote-1');
			await wizardDialog.getByLabel('Agent name').fill('Missing Remote Agent');
			await wizardDialog.getByRole('button', { name: 'Codex' }).click();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();
			await wizardDialog.getByLabel('Project Directory').fill('/srv/missing-project');

			await expect(
				wizardDialog.getByText('Directory not found. Please check the path exists.')
			).toBeVisible();
			await expect
				.poll(
					async () =>
						(await getStubbedWizardRemoteDirectoryState(launched.electronApp)).readDirCalls
				)
				.toEqual([{ dirPath: '/srv/missing-project', sshRemoteId: 'ssh-remote-1' }]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[206].id} ${activeScenarioMatrix[206].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig({ name: 'Temporary Remote' });
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			const wizardDialog = await openNewAgentWizard(launched.window);
			const locationSelect = wizardDialog.getByLabel('Agent location');

			await locationSelect.selectOption('ssh-remote-1');
			await locationSelect.selectOption('');
			await wizardDialog.getByLabel('Agent name').fill('Local Again Agent');
			await wizardDialog.getByRole('button', { name: 'Codex' }).click();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			await expect(wizardDialog.getByLabel('Project Directory')).toHaveAttribute(
				'placeholder',
				'/path/to/your/project'
			);
			await expect(wizardDialog.getByRole('button', { name: 'Browse' })).toBeVisible();
			await expect(wizardDialog.getByText(/Enter the full path on/)).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[207].id} ${activeScenarioMatrix[207].title}`, async () => {
		const seededRemote = createStubSshRemoteConfig({ name: 'Return Remote' });
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubSshRemoteHandlers(launched.electronApp, { configs: [seededRemote] });
			const wizardDialog = await openNewAgentWizard(launched.window);

			await wizardDialog.getByLabel('Agent location').selectOption('ssh-remote-1');
			await wizardDialog.getByLabel('Agent name').fill('Return Remote Agent');
			await wizardDialog.getByRole('button', { name: 'Codex' }).click();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();
			await wizardDialog.getByRole('button', { name: 'Back' }).click();

			await expect(wizardDialog.getByLabel('Agent location')).toHaveValue('ssh-remote-1');
			await expect(wizardDialog.getByLabel('Agent name')).toHaveValue('Return Remote Agent');
			await expect(wizardDialog.getByRole('button', { name: 'Codex' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[208].id} ${activeScenarioMatrix[208].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				selectedFolder: seeded.projectDir,
				isRepo: true,
			});
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Browse Local Agent');

			await wizardDialog.getByRole('button', { name: 'Browse' }).click();

			await expect(wizardDialog.getByLabel('Project Directory')).toHaveValue(seeded.projectDir);
			await expect(wizardDialog.getByText('Git Repository Detected')).toBeVisible();
			await expect
				.poll(async () => await getStubbedWizardRemoteDirectoryState(launched.electronApp))
				.toMatchObject({
					selectFolderCalls: 1,
					readDirCalls: [{ dirPath: seeded.projectDir }],
					gitCalls: [{ cwd: seeded.projectDir }],
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[209].id} ${activeScenarioMatrix[209].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, { selectedFolder: null });
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Browse Cancel Agent');

			await wizardDialog.getByRole('button', { name: 'Browse' }).click();

			await expect(wizardDialog.getByLabel('Project Directory')).toHaveValue('');
			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeHidden();
			await expect
				.poll(
					async () =>
						(await getStubbedWizardRemoteDirectoryState(launched.electronApp)).selectFolderCalls
				)
				.toBe(1);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[210].id} ${activeScenarioMatrix[210].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				selectFolderError: 'Native picker unavailable',
			});
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Browse Error Agent');

			await wizardDialog.getByRole('button', { name: 'Browse' }).click();

			await expect(wizardDialog.getByText('Failed to open folder picker')).toBeVisible();
			await expect(wizardDialog.getByLabel('Project Directory')).toHaveValue('');
			await expect
				.poll(
					async () =>
						(await getStubbedWizardRemoteDirectoryState(launched.electronApp)).selectFolderCalls
				)
				.toBe(1);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[211].id} ${activeScenarioMatrix[211].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, { isRepo: true });
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Local Git Agent');

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);

			await expect(wizardDialog.getByText('Git Repository Detected')).toBeVisible();
			await expect
				.poll(async () => {
					const state = await getStubbedWizardRemoteDirectoryState(launched.electronApp);
					const readDirCall = state.readDirCalls.at(-1);
					const gitCall = state.gitCalls.at(-1);
					return {
						readDirPath: readDirCall?.dirPath,
						readDirRemote: readDirCall?.sshRemoteId ?? null,
						gitCwd: gitCall?.cwd,
						gitRemote: gitCall?.sshRemoteId ?? null,
					};
				})
				.toEqual({
					readDirPath: seeded.projectDir,
					readDirRemote: null,
					gitCwd: seeded.projectDir,
					gitRemote: null,
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[212].id} ${activeScenarioMatrix[212].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				autoRunDocs: [
					{ name: 'phase-1.md', path: `${seeded.projectDir}/Auto Run Docs/phase-1.md` },
					{ name: 'phase-2.md', path: `${seeded.projectDir}/Auto Run Docs/phase-2.md` },
					{ name: 'summary.md', path: `${seeded.projectDir}/Auto Run Docs/summary.md` },
				],
			});
			const wizardDialog = await openWizardDirectoryStep(
				launched.window,
				'Plural Existing Docs Agent'
			);

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			const existingDocsDialog = launched.window.getByRole('dialog', {
				name: 'Existing Auto Run Documents Found',
			});
			await expect(existingDocsDialog).toBeVisible();
			await expect(existingDocsDialog.getByText('3 Auto Run documents')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[213].id} ${activeScenarioMatrix[213].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				autoRunDocs: [
					{ name: 'phase-1.md', path: `${seeded.projectDir}/Auto Run Docs/phase-1.md` },
				],
				deleteFolderResult: { success: false, error: 'Auto Run Docs are locked' },
			});
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Delete Error Agent');

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();

			const existingDocsDialog = launched.window.getByRole('dialog', {
				name: 'Existing Auto Run Documents Found',
			});
			await existingDocsDialog.getByRole('button', { name: /Delete & Start Fresh/ }).click();

			await expect(existingDocsDialog.getByText('Auto Run Docs are locked')).toBeVisible();
			await expect(
				existingDocsDialog.getByRole('button', { name: /Delete & Start Fresh/ })
			).toBeEnabled();
			await expect
				.poll(
					async () =>
						(await getStubbedWizardRemoteDirectoryState(launched.electronApp)).deleteFolderCalls
				)
				.toEqual([seeded.projectDir]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[214].id} ${activeScenarioMatrix[214].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				autoRunDocs: [
					{ name: 'phase-1.md', path: `${seeded.projectDir}/Auto Run Docs/phase-1.md` },
					{ name: 'phase-2.md', path: `${seeded.projectDir}/Auto Run Docs/phase-2.md` },
				],
			});
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Continue Docs Agent');

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();
			await launched.window
				.getByRole('dialog', { name: 'Existing Auto Run Documents Found' })
				.getByRole('button', { name: /Continue Building on Existing Plan/ })
				.click();

			await expect(wizardDialog.getByRole('heading', { name: 'Project Discovery' })).toBeVisible();
			await expect
				.poll(
					async () =>
						(await getStubbedWizardRemoteDirectoryState(launched.electronApp)).deleteFolderCalls
				)
				.toEqual([]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[215].id} ${activeScenarioMatrix[215].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			await stubWizardRemoteDirectoryHandlers(launched.electronApp, {
				autoRunDocs: [
					{ name: 'phase-1.md', path: `${seeded.projectDir}/Auto Run Docs/phase-1.md` },
				],
			});
			const wizardDialog = await openWizardDirectoryStep(launched.window, 'Fresh Delete Agent');

			await wizardDialog.getByLabel('Project Directory').fill(seeded.projectDir);
			await expect(wizardDialog.getByText('Regular Directory')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Continue' }).click();
			await launched.window
				.getByRole('dialog', { name: 'Existing Auto Run Documents Found' })
				.getByRole('button', { name: /Delete & Start Fresh/ })
				.click();

			await expect(wizardDialog.getByRole('heading', { name: 'Project Discovery' })).toBeVisible();
			await expect
				.poll(
					async () =>
						(await getStubbedWizardRemoteDirectoryState(launched.electronApp)).deleteFolderCalls
				)
				.toEqual([seeded.projectDir]);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[216].id} ${activeScenarioMatrix[216].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
			await expect(directorNotesDialog.getByText('Planner Agent')).toBeVisible();
			await expect
				.poll(async () => {
					const state = await getStubbedDirectorNotesHistoryState(launched.electronApp);
					const firstCall = state.historyCalls[0];
					return {
						lookbackDays: firstCall?.lookbackDays,
						limit: firstCall?.limit,
						offset: firstCall?.offset,
					};
				})
				.toEqual({ lookbackDays: 7, limit: 100, offset: 0 });
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[217].id} ${activeScenarioMatrix[217].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
			await directorNotesDialog.getByTitle(/Search entries/).click();
			await directorNotesDialog
				.getByPlaceholder('Filter by summary or agent name...')
				.fill('onboarding');

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
			await expect(
				directorNotesDialog.getByText('Reviewed billing prompt composer draft')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[218].id} ${activeScenarioMatrix[218].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await expect(directorNotesDialog.getByText('Review Agent')).toBeVisible();
			await directorNotesDialog.getByTitle(/Search entries/).click();
			await directorNotesDialog
				.getByPlaceholder('Filter by summary or agent name...')
				.fill('Review Agent');

			await expect(
				directorNotesDialog.getByText('Reviewed billing prompt composer draft')
			).toBeVisible();
			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[219].id} ${activeScenarioMatrix[219].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
			await directorNotesDialog.getByTitle(/Search entries/).click();
			await directorNotesDialog
				.getByPlaceholder('Filter by summary or agent name...')
				.fill('unmatched-query');

			await expect(
				directorNotesDialog.getByText('No entries matching "unmatched-query".')
			).toBeVisible();
			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[220].id} ${activeScenarioMatrix[220].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
			await directorNotesDialog.getByTitle(/Search entries/).click();
			const searchInput = directorNotesDialog.getByPlaceholder(
				'Filter by summary or agent name...'
			);
			await searchInput.fill('onboarding');
			await launched.window.keyboard.press('Escape');

			await expect(searchInput).toBeHidden();
			await expect(directorNotesDialog).toBeVisible();
			await expect(
				directorNotesDialog.getByText('Reviewed billing prompt composer draft')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[221].id} ${activeScenarioMatrix[221].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await directorNotesDialog.getByRole('button', { name: 'Help' }).click();
			await expect(directorNotesDialog.getByText("What are Director's Notes?")).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(directorNotesDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[222].id} ${activeScenarioMatrix[222].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
			await launched.window.keyboard.press('Meta+Shift+[');
			await expect(directorNotesDialog.getByText("What are Director's Notes?")).toBeVisible();
			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[223].id} ${activeScenarioMatrix[223].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: createDirectorNotesEnabledSettings(),
		});

		try {
			await stubDirectorNotesHistory(launched.electronApp);
			const directorNotesDialog = await openDirectorNotesFromQuickActions(launched.window);

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeVisible();
			await expect(
				directorNotesDialog.getByText('Reviewed billing prompt composer draft')
			).toBeVisible();
			await directorNotesDialog.getByRole('button', { name: 'AUTO' }).click();

			await expect(
				directorNotesDialog.getByText('Refined onboarding copy for the setup wizard')
			).toBeHidden();
			await expect(
				directorNotesDialog.getByText('Reviewed billing prompt composer draft')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[224].id} ${activeScenarioMatrix[224].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);

			await wizardDialog.getByRole('button', { name: 'Done' }).click();

			await expect(
				wizardDialog.getByRole('heading', { name: 'Create a Maestro Agent' })
			).toBeVisible();
			await expect(wizardDialog.getByRole('button', { name: 'Codex' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[225].id} ${activeScenarioMatrix[225].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openNewAgentWizard(launched.window);
			const codexTile = wizardDialog.getByRole('button', { name: 'Codex' });

			await wizardDialog.getByLabel('Agent name').fill('Configured Codex Agent');
			await codexTile.getByTitle('Customize agent settings').click();
			await expect(wizardDialog.getByText('Codex Configuration')).toBeVisible();
			await wizardDialog.getByRole('button', { name: 'Done' }).click();

			await expect(wizardDialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[226].id} ${activeScenarioMatrix[226].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const argsInput = wizardDialog.getByPlaceholder('--flag value --another-flag');

			await argsInput.fill('--profile wsp --reasoning high');
			await wizardDialog.getByRole('button', { name: 'Done' }).click();
			await wizardDialog
				.getByRole('button', { name: 'Codex' })
				.getByTitle('Customize agent settings')
				.click();

			await expect(wizardDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--profile wsp --reasoning high'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[227].id} ${activeScenarioMatrix[227].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);

			await wizardDialog.getByRole('button', { name: 'Add Variable' }).click();
			await wizardDialog.getByPlaceholder('VARIABLE_NAME').fill('WSP_REOPEN_ENV');
			await wizardDialog.getByPlaceholder('value', { exact: true }).fill('persisted');
			await wizardDialog.getByRole('button', { name: 'Done' }).click();
			await wizardDialog
				.getByRole('button', { name: 'Codex' })
				.getByTitle('Customize agent settings')
				.click();

			await expect(wizardDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue('WSP_REOPEN_ENV');
			await expect(wizardDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'persisted'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[228].id} ${activeScenarioMatrix[228].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const envPanel = settingsFieldPanel(wizardDialog, 'Environment Variables (optional)');

			await envPanel.getByRole('button', { name: 'Add Variable' }).click();
			await envPanel.getByPlaceholder('value', { exact: true }).fill('first');
			await envPanel.getByRole('button', { name: 'Add Variable' }).click();

			await expect(envPanel.getByPlaceholder('VARIABLE_NAME')).toHaveCount(2);
			await expect(envPanel.getByPlaceholder('VARIABLE_NAME').nth(0)).toHaveValue('NEW_VAR');
			await expect(envPanel.getByPlaceholder('VARIABLE_NAME').nth(1)).toHaveValue('NEW_VAR_1');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[229].id} ${activeScenarioMatrix[229].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const envPanel = settingsFieldPanel(wizardDialog, 'Environment Variables (optional)');

			await envPanel.getByTitle('What is this?').click();

			await expect(
				envPanel.getByText('Set to "1" when resuming an existing session.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[230].id} ${activeScenarioMatrix[230].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const modelInput = settingsFieldPanel(wizardDialog, 'Model')
				.locator('input[type="text"]')
				.first();

			await modelInput.focus();

			await expect(wizardDialog.getByRole('button', { name: 'gpt-5.3-codex' })).toBeVisible();
			await expect(wizardDialog.getByRole('button', { name: 'o3' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${activeScenarioMatrix[231].id} ${activeScenarioMatrix[231].title}`, async () => {
		const seeded = createWizardSettingsPromptsWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubEncoreCodexAgent(launched.electronApp);
			const wizardDialog = await openCodexWizardCustomization(launched.window);
			const modelInput = settingsFieldPanel(wizardDialog, 'Model')
				.locator('input[type="text"]')
				.first();

			await modelInput.focus();
			await wizardDialog.getByRole('button', { name: 'o3' }).click();

			await expect(modelInput).toHaveValue('o3');
			await expect
				.poll(async () => {
					return await launched.window.evaluate(async () => {
						const config = await window.maestro.agents.getConfig('codex');
						return config.model;
					});
				})
				.toBe('o3');
		} finally {
			await launched.cleanup();
		}
	});

	for (const scenario of envGatedScenarioMatrix) {
		test.skip(`${scenario.id} ${scenario.title} [env-gated]`, async () => {
			void scenario.reason;
		});
	}
});
