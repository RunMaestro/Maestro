/**
 * E2E Tests: wizard, settings, prompts lane coverage.
 *
 * This file keeps the lane deterministic: seeded state only, no live providers,
 * and no network-backed flows.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

	for (const scenario of envGatedScenarioMatrix) {
		test.skip(`${scenario.id} ${scenario.title} [env-gated]`, async () => {
			void scenario.reason;
		});
	}
});
