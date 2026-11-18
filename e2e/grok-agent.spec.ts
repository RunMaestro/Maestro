/**
 * Grok agent smoke.
 *
 * Seeds one `toolType: 'grok'` agent into the fixture's isolated data dir and
 * asserts what a user sees before any turn: the Left Bar row names the Grok
 * provider, the composer offers only the controls Grok's capabilities admit
 * (no Standard permission mode, which only Claude Code's permission relay
 * backs), and nothing spawned a provider process. No message is sent, and the
 * launch PATH drops every directory holding a `grok` executable, so no Grok
 * binary can be launched by name. Production data is never read: every store
 * resolves under the fixture's temp dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from './fixtures/electron-app';

const AGENT_ID = 'grok-e2e-agent';
const TAB_ID = 'grok-e2e-ai-tab';
const AGENT_NAME = 'Grok E2E';

/** The launch PATH without any directory that holds a `grok` executable. */
function pathWithoutGrok(): string {
	return (process.env.PATH ?? '')
		.split(path.delimiter)
		.filter((dir) => dir && !fs.existsSync(path.join(dir, 'grok')))
		.join(path.delimiter);
}

function seedGrokAgent(testDataDir: string): void {
	const workspace = path.join(testDataDir, 'workspace');
	fs.mkdirSync(workspace, { recursive: true });
	const session = {
		id: AGENT_ID,
		name: AGENT_NAME,
		toolType: 'grok',
		state: 'idle',
		cwd: workspace,
		fullPath: workspace,
		projectRoot: workspace,
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
				id: TAB_ID,
				agentSessionId: null,
				name: 'Grok Tab',
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle',
				permissionMode: 'full',
			},
		],
		activeTabId: TAB_ID,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: TAB_ID }],
		unifiedClosedTabHistory: [],
	};
	fs.writeFileSync(
		path.join(testDataDir, 'maestro-sessions.json'),
		JSON.stringify({ sessions: [session], activeSessionId: AGENT_ID })
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

const test = base.extend({
	electronLaunchEnv: async ({ testDataDir }, use) => {
		seedGrokAgent(testDataDir);
		await use({
			MAESTRO_USER_DATA: testDataDir,
			MAESTRO_DISABLE_GROUP_CHAT_PROVIDERS: '1',
			PATH: pathWithoutGrok(),
		});
	},
});

test('shows a seeded Grok agent with Grok-only composer controls and no provider process', async ({
	electronApp,
	window,
	testDataDir,
}) => {
	const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'));
	expect(path.resolve(userDataPath)).toBe(path.resolve(testDataDir));

	const stored = await window.evaluate(() => window.maestro.sessions.getAll());
	expect(stored.map((s) => [s.id, s.toolType])).toEqual([[AGENT_ID, 'grok']]);

	// Left Bar: the row carries the agent name and the Grok provider label.
	const row = window.locator('[data-nav-key]', { hasText: AGENT_NAME }).first();
	await expect(row).toBeVisible({ timeout: 30_000 });
	await expect(row.locator('.row-provider')).toHaveText('Grok CLI');

	// Composer: Grok supports thinking display and read-only, not Standard.
	const toggles = window.locator('[data-tour="toolbar-toggles"]');
	await expect(toggles).toBeVisible();
	await expect(toggles.getByRole('button', { name: /Thinking/ })).toBeVisible();
	const permissionPill = toggles.locator('button', {
		hasText: /^(Full Access|Standard|Read-Only|Plan-Mode)$/,
	});
	await expect(permissionPill).toHaveText('Full Access');

	await permissionPill.click();
	// Claude Code steps Full Access -> Standard; Grok has no Standard relay.
	await expect(permissionPill).toHaveText('Read-Only');
	await expect(permissionPill).toHaveAttribute('title', /Grok plan mode/);

	await permissionPill.click();
	await expect(permissionPill).toHaveText('Full Access');
	await expect(toggles.getByText('Standard', { exact: true })).toHaveCount(0);
	await expect(toggles.getByText('Plan-Mode', { exact: true })).toHaveCount(0);

	// No provider process was started for the seeded agent (or anything else).
	await window.waitForTimeout(300);
	const processes = await window.evaluate(() =>
		window.maestro.process.getActiveProcesses({ includeChildProcesses: true })
	);
	expect(processes).toEqual([]);
});
