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

interface WizardE2ETab {
	id: string;
	saveToHistory?: boolean;
	readOnlyMode?: boolean;
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
					(key: string): Promise<unknown>;
				};
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

	for (const scenario of envGatedScenarioMatrix) {
		test.skip(`${scenario.id} ${scenario.title} [env-gated]`, async () => {
			void scenario.reason;
		});
	}
});
