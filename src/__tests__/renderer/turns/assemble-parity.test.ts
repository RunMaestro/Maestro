/**
 * Parity: `assembleTurn` against the desktop.
 *
 * A turn started from the TUI has to be the same agent as one started from the desktop, so
 * this drives the desktop's REAL path for each fixture and compares the result with
 * `assembleTurn` for the same agent, tab and message:
 *
 *   renderer  `useInputProcessing.processInput` builds the user prompt and the system prompt
 *             (real `prompt-manager` served through `win.maestro.prompts.get`) and hands
 *             `win.maestro.process.spawn` a config;
 *   main      `handleProcessSpawn` takes that exact config, builds the final arguments with the
 *             real `buildAgentArgs` / `applyAgentConfigOverrides`, delivers the system prompt,
 *             and hands the process manager its `args` and `prompt`.
 *
 * Both halves run in one file because jsdom can import the main-process handler; the design
 * (Plans/maestro-tui-prompt-assembly.md section 8.7) split them only to keep each in its own
 * environment, and one file chains them without a hand-written mapping in between.
 *
 * Mocked: the process manager, the agent detector, the stores, git, and the history path.
 * Real: prompts, template substitution, argument building, system prompt delivery.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
	isWindows: vi.fn(() => false),
	userData: '',
}));

vi.mock('electron', () => ({
	app: {
		isPackaged: false,
		getPath: () => mocks.userData,
	},
	BrowserWindow: class {},
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	addBreadcrumb: vi.fn(),
}));
vi.mock('../../../main/plugins/plugin-manager-singleton', () => ({
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: () => '/opt/maestro/maestro-cli.js',
}));
vi.mock('../../../main/permission-relay', () => ({ preparePermissionRelayArgs: vi.fn() }));
vi.mock('../../../main/power-manager', () => ({
	powerManager: { addBlockReason: vi.fn(), removeBlockReason: vi.fn() },
}));
vi.mock('../../../main/agents/omp-model-catalog', () => ({
	primeOmpModelCatalog: vi.fn(),
	computeOmpCatalogKey: vi.fn(),
	buildOmpPrimeEnv: vi.fn(),
}));
vi.mock('../../../shared/maestro-lib/launch/path-prober', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/maestro-lib/launch/path-prober')>()),
	checkCustomPath: vi.fn(async (customPath: string) => ({ exists: true, path: customPath })),
}));
vi.mock('../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/platformDetection')>()),
	isWindows: () => mocks.isWindows(),
}));
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ files: [], branch: 'feature/parity' }),
		isRepo: vi.fn().mockResolvedValue(true),
	},
}));
vi.mock('../../../renderer/hooks/agent/useAgentCapabilities', async () => {
	const actual = await vi.importActual('../../../renderer/hooks/agent/useAgentCapabilities');
	return {
		...actual,
		hasCapabilityCached: vi.fn(
			(_agentId: string, capability: string) => capability === 'supportsBatchMode'
		),
	};
});
vi.mock('../../../renderer/services/shellCommand', () => ({
	runShellCommand: vi.fn(),
	dispatchShellCommand: vi.fn(),
	cancelShellCommand: vi.fn(),
	resolveCommandCwd: vi.fn(),
}));
vi.mock('../../../renderer/services/aiCommand', () => ({
	requestAiCommand: vi.fn(),
	acceptAiCommand: vi.fn(),
	dismissAiCommand: vi.fn(),
}));

import { getPrompt, initializePrompts } from '../../../main/prompt-manager';
import { handleProcessSpawn } from '../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnProcessConfig } from '../../../main/ipc/handlers/process/spawn-types';
import {
	loadInputProcessingPrompts,
	useInputProcessing,
} from '../../../renderer/hooks/input/useInputProcessing';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { AITab, BatchRunState, Session } from '../../../renderer/types';
import { assembleTurn } from '../../../shared/maestro-lib/turns/assemble';
import { createPromptLoader } from '../../../shared/maestro-lib/prompts/load';
import { PROMPT_CUSTOMIZATIONS_FILE } from '../../../shared/maestro-lib/settings/snapshot';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { buildAgentLaunchPlan } from '../../../shared/maestro-lib/launch/launch-plan';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';

// The renderer test environment types `window.maestro` through the app's preload declarations,
// which this file does not import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = window as any;

const NOW = new Date(2026, 9, 4, 12, 30, 15);
const REPO_PROMPTS = path.resolve(__dirname, '..', '..', '..', 'prompts');
const HISTORY_FILE = '/data/history/agent-1.jsonl';

const batchState = {
	isRunning: false,
	isStopping: false,
	documents: [],
	lockedDocuments: [],
	currentDocumentIndex: 0,
	currentDocTasksTotal: 0,
	currentDocTasksCompleted: 0,
	totalTasksAcrossAllDocs: 0,
	completedTasksAcrossAllDocs: 0,
	loopEnabled: false,
	loopIteration: 0,
	folderPath: '',
	worktreeActive: false,
} as unknown as BatchRunState;

/** A provider as the desktop detector returns it: the real definition, with the Claude interactive variant removed so the turn runs in API mode. */
function detectedAgent(toolType: string) {
	const definition = getAgentDefinition(toolType)!;
	const agent: Record<string, unknown> = {
		...definition,
		available: true,
		path: `/usr/local/bin/${definition.binaryName}`,
		capabilities: getAgentCapabilities(toolType),
	};
	delete agent.interactiveCommand;
	delete agent.interactiveModeArgs;
	return agent;
}

interface Fixture {
	name: string;
	toolType: string;
	session?: Partial<Session>;
	tab?: Partial<AITab>;
	providerConfig?: Record<string, unknown>;
	message: string;
	windows?: boolean;
}

const FIXTURES: Fixture[] = [
	{
		// The inline-flag path: tab model, provider effort, quoted custom args, an extra
		// directory, a nudge and a new-session message.
		name: 'Claude Code, fresh tab, every override set',
		toolType: 'claude-code',
		session: {
			nudgeMessage: 'Keep it short.',
			newSessionMessage: 'House rules apply.',
			customArgs: '--add-dir-note "two words"',
			additionalDirectories: [{ path: '/extra/dir', read: true, write: true }],
			isGitRepo: true,
		},
		tab: { customModel: 'opus' },
		providerConfig: { effort: 'high' },
		message: 'Fix the failing test',
	},
	{
		// A resume: no new-session message, the resume args, bypass flags filtered, `-C` first.
		name: 'Codex, resumed, read-only',
		toolType: 'codex',
		session: { isGitRepo: true },
		tab: { agentSessionId: 'thread-123', readOnlyMode: true },
		message: 'Plan the refactor',
	},
	{
		// A provider with no append flag, on a resumed session: nothing embedded.
		name: 'Codex, resumed, full access',
		toolType: 'codex',
		tab: { agentSessionId: 'thread-123' },
		message: 'Continue',
	},
	{
		// The embed path plus the Copilot preamble.
		name: 'Copilot, first turn',
		toolType: 'copilot-cli',
		session: { nudgeMessage: 'Be brief.' },
		message: 'Explain the build',
	},
	{
		// A permission mode other than full and a custom model on the agent.
		name: 'Claude Code, standard permission mode, agent model',
		toolType: 'claude-code',
		session: { customModel: 'sonnet', customEffort: 'low' },
		tab: { permissionMode: 'standard', agentSessionId: 'sess-9' },
		message: 'Review this diff',
	},
	{
		// A Windows host: the system prompt travels in a temp file, never inline.
		name: 'Claude Code on a Windows host',
		toolType: 'claude-code',
		message: 'Say hello',
		windows: true,
	},
];

describe('assembleTurn parity with the desktop', () => {
	let tmp: string;
	let loader: ReturnType<typeof createPromptLoader>;
	const realSetSessions = useSessionStore.getState().setSessions;
	const originalMaestro = { ...win.maestro };

	beforeAll(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-parity-'));
		mocks.userData = tmp;
		await initializePrompts();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		loader = createPromptLoader({
			bundledPromptsDir: REPO_PROMPTS,
			customizationsFile: path.join(tmp, PROMPT_CUSTOMIZATIONS_FILE),
		});
	});

	afterAll(() => {
		vi.useRealTimers();
		Object.assign(win.maestro, originalMaestro);
		useSessionStore.setState({ setSessions: realSetSessions });
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	beforeEach(() => {
		mocks.isWindows.mockReturnValue(false);
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		useSettingsStore.setState({
			automaticTabNamingEnabled: false,
			conductorProfile: 'Pedram, security researcher',
		} as never);
	});

	/** Run the desktop's renderer half and return the spawn config it produced. */
	async function runRenderer(fixture: Fixture, session: Session): Promise<SpawnProcessConfig> {
		const definition = detectedAgent(fixture.toolType);
		const spawn = vi.fn().mockResolvedValue(undefined);
		win.maestro = {
			...win.maestro,
			prompts: {
				get: vi.fn(async (id: string) => ({ success: true, content: getPrompt(id) })),
			},
			history: { getFilePath: vi.fn().mockResolvedValue(HISTORY_FILE) },
			process: {
				...win.maestro?.process,
				spawn,
				write: vi.fn().mockResolvedValue(undefined),
				runCommand: vi.fn().mockResolvedValue(undefined),
				getActiveProcesses: vi.fn().mockResolvedValue([]),
				broadcastUserInput: vi.fn().mockResolvedValue(undefined),
				onUserInput: vi.fn().mockReturnValue(() => {}),
			},
			agents: {
				...win.maestro?.agents,
				get: vi.fn().mockResolvedValue({
					id: definition.id,
					command: definition.command,
					path: definition.path,
					args: definition.args,
					yoloModeArgs: definition.yoloModeArgs,
				}),
			},
			web: { ...win.maestro?.web, broadcastUserInput: vi.fn().mockResolvedValue(undefined) },
		};
		await loadInputProcessingPrompts(true);

		const setSessions = vi.fn((updater) => realSetSessions(updater));
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
			setSessions: setSessions as typeof realSetSessions,
		});
		const deps = {
			activeSession: session,
			activeSessionId: session.id,
			setSessions,
			getInputValue: () => fixture.message,
			setInputValue: vi.fn(),
			stagedImages: [],
			setStagedImages: vi.fn(),
			inputRef: { current: null } as React.RefObject<HTMLTextAreaElement | null>,
			customAICommands: [],
			setSlashCommandOpen: vi.fn(),
			syncAiInputToSession: vi.fn(),
			syncTerminalInputToSession: vi.fn(),
			isAiMode: true,
			sessionsRef: { current: [session] },
			getBatchState: () => batchState,
			activeBatchRunState: batchState,
			processQueuedItemRef: { current: vi.fn().mockResolvedValue(undefined) },
			flushBatchedUpdates: vi.fn(),
			onHistoryCommand: vi.fn().mockResolvedValue(undefined),
		};
		const { result } = renderHook(() => useInputProcessing(deps as never));
		await act(async () => {
			await result.current.processInput();
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		return spawn.mock.calls[0][0] as SpawnProcessConfig;
	}

	/** Run the desktop's main half on that config and return what the process manager was handed. */
	async function runMain(fixture: Fixture, config: SpawnProcessConfig) {
		const processManager = {
			spawn: vi.fn((_config: unknown) => ({ success: true, pid: 4242 })),
			get: vi.fn(),
		};
		const configs = fixture.providerConfig ? { [fixture.toolType]: fixture.providerConfig } : {};
		await handleProcessSpawn(config, {
			getProcessManager: () => processManager as never,
			getAgentDetector: () => ({ getAgent: async () => detectedAgent(fixture.toolType) }) as never,
			agentConfigsStore: {
				get: (_key: string, fallback: unknown) => (_key === 'configs' ? configs : fallback),
			} as never,
			settingsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
			getMainWindow: () => null,
			sessionsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
		});
		expect(processManager.spawn).toHaveBeenCalledTimes(1);
		return processManager.spawn.mock.calls[0][0] as unknown as {
			args: string[];
			prompt?: string;
			customEnvVars?: Record<string, string>;
		};
	}

	for (const fixture of FIXTURES) {
		it(fixture.name, async () => {
			mocks.isWindows.mockReturnValue(fixture.windows === true);
			const tab = createMockAITab({
				id: 'tab-1',
				createdAt: 1700000000000,
				saveToHistory: true,
				...fixture.tab,
			});
			const session = createMockSession({
				id: 'agent-1',
				name: 'Parity Agent',
				toolType: fixture.toolType as Session['toolType'],
				aiPid: 1234,
				aiTabs: [tab],
				activeTabId: tab.id,
				...fixture.session,
			});

			const config = await runRenderer(fixture, session);
			const recorded = await runMain(fixture, config);

			const provider = {
				...(getAgentDefinition(fixture.toolType) as object),
				available: true,
				path: `/usr/local/bin/${getAgentDefinition(fixture.toolType)!.binaryName}`,
				capabilities: getAgentCapabilities(fixture.toolType),
			} as never;
			const result = assembleTurn(
				session as never,
				tab as never,
				{ text: fixture.message },
				{
					provider,
					command: (provider as { path: string }).path,
					providerConfig: fixture.providerConfig ?? {},
					conductorProfile: 'Pedram, security researcher',
					prompts: {
						maestroSystem: loader.get('maestro-system-prompt'),
						imageOnlyDefault: loader.get('image-only-default') ?? '',
						copilotPreamble: loader.get('copilot-preamble'),
					},
					gitBranch: session.isGitRepo ? 'feature/parity' : undefined,
					historyFilePath: HISTORY_FILE,
					isWindowsHost: fixture.windows === true,
					now: NOW,
				}
			);
			if (!result.ok) throw new Error(result.message);
			const turn = result.turn;

			// The system prompt text, byte for byte.
			expect(turn.systemPrompt).toBe(config.appendSystemPrompt);
			expect(turn.systemPrompt).toBeTruthy();

			// The user prompt before delivery, then the prompt the process receives.
			expect(turn.userPrompt).toBe(config.prompt);
			expect(turn.prompt).toBe(recorded.prompt);

			// The argument list. On a Windows host the file form is the caller's to add.
			if (fixture.windows) {
				const fileFlag = recorded.args.indexOf('--append-system-prompt-file');
				expect(fileFlag).toBeGreaterThan(-1);
				expect(recorded.args.slice(0, fileFlag)).toEqual(turn.launch.args);
				expect(turn.systemPromptDelivery).toEqual({ via: 'file' });
				expect(recorded.args).not.toContain('--append-system-prompt');
			} else {
				expect(turn.launch.args).toEqual(recorded.args);
			}

			// What the renderer sends as per-turn settings is what the turn is attributed to.
			expect(turn.readOnly).toBe(config.readOnlyMode);
			expect(turn.permissionMode).toBe(config.permissionMode);
			expect(turn.resumeSessionId).toBe(config.agentSessionId);
			expect(turn.settings.model).toBe(config.sessionCustomModel);
			expect(turn.settings.effort).toBe(config.sessionCustomEffort);

			// The environment the desktop hands the process, less the two vars the TUI states
			// on purpose: the tab id (F8) and the data dir (PA8). A Windows host is skipped: its
			// spawn path folds the whole host environment into `customEnvVars`, which is the
			// process manager's doing and not part of assembly.
			if (!fixture.windows) {
				const plan = buildAgentLaunchPlan({ ...turn.launch, isWindowsHost: false });
				if (!plan.ok) throw new Error(plan.error);
				const stated = { ...plan.plan.envVars };
				delete stated.MAESTRO_CALLER_TAB_ID;
				delete stated.MAESTRO_USER_DATA;
				expect(stated).toEqual(recorded.customEnvVars ?? {});
			}
		});
	}
});
