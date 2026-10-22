#!/usr/bin/env node
// Maestro CLI
// Command-line interface for Maestro

import { Command, InvalidArgumentError, Option } from 'commander';
import { asThinkingMode, type ThinkingMode } from '../shared/types';
import { parseCliBool, parseCliPort, parseCliSeconds, isInheritValue } from './utils/parse';
import { listGroups } from './commands/list-groups';
import { listAgents } from './commands/list-agents';
import { listPlaybooks } from './commands/list-playbooks';
import { showPlaybook } from './commands/show-playbook';
import { showAgent } from './commands/show-agent';
import { cleanPlaybooks } from './commands/clean-playbooks';
import { send } from './commands/send';
import { dispatch } from './commands/dispatch';
import { ask } from './commands/ask';
import {
	queueHold,
	queueList,
	queueMerge,
	queueRemove,
	queueResume,
	queueSteer,
} from './commands/queue';
import {
	snoozeDismiss,
	snoozeHistory,
	snoozeList,
	snoozeReschedule,
	snoozeTabCommand,
	snoozeWake,
} from './commands/snooze';
import { windowList, windowMoveAgent, windowMoveGroup } from './commands/window';
import {
	throughputGaugeFlagChoices,
	throughputGaugeHide,
	throughputGaugeResetPeak,
	throughputGaugeSet,
	throughputGaugeShow,
	throughputGaugeStatus,
	throughputGaugeToggle,
} from './commands/throughput-gauge';
import { sessionList, sessionShow } from './commands/session';
import { listSessions } from './commands/list-sessions';
import { openFile } from './commands/open-file';
import { imageList, imageSave } from './commands/image';
import { openGraph } from './commands/open-graph';
import { openBrowser, closeBrowser } from './commands/open-browser';
import { openModal } from './commands/open-modal';
import { openTerminal } from './commands/open-terminal';
import { refreshFiles } from './commands/refresh-files';
import { refreshAutoRun } from './commands/refresh-auto-run';
import { status } from './commands/status';
import { version } from './commands/version';
import {
	groupChatList,
	groupChatSend,
	groupChatStart,
	groupChatSteer,
	groupChatStatus,
	groupChatStop,
	groupChatArchive,
} from './commands/group-chat';
import { doctor } from './commands/doctor';
import { completions } from './commands/completions';
import { reference } from './commands/reference';
import { applyCommandExamples } from './command-examples';
import { autoRun } from './commands/auto-run';
import { cueTrigger } from './commands/cue-trigger';
import { cueList } from './commands/cue-list';
import { cueEnable, cueDisable, cueGate, cueScreen, cueActivity } from './commands/cue-control';
import { marketplaceList, marketplaceShow, marketplaceImport } from './commands/marketplace';
import { cueSchedule } from './commands/cue-schedule';
import { cueModel } from './commands/cue-model';
import {
	cuePipelineAdd,
	cuePipelineExport,
	cuePipelineGet,
	cuePipelineList,
	cuePipelineRemove,
	cuePipelineReplace,
} from './commands/cue-pipeline';
import {
	cueEngineStart,
	cueEngineCheck,
	cueEngineStop,
	cueEngineStatus,
	cueEngineInspect,
} from './commands/cue-engine';
import { bundleExport, bundleImport, bundleInspect, bundleValidate } from './commands/bundle';
import { hostStart, hostStatus, hostStop } from './commands/host';
import { createAgent } from './commands/create-agent';
import { createGroup } from './commands/create-group';
import { removeGroup } from './commands/remove-group';
import { createWorktree } from './commands/create-worktree';
import { removeAgent } from './commands/remove-agent';
import { updateAgent } from './commands/update-agent';
import { collectRepeatable } from './services/peer-flags';
import { PICKABLE_AGENT_IDS } from '../shared/agentMetadata';
import { listSshRemotes } from './commands/list-ssh-remotes';
import { listTerminals } from './commands/list-terminals';
import { sendTerminal } from './commands/send-terminal';
import { readTerminal, DEFAULT_TAIL_LINES } from './commands/read-terminal';
import { createSshRemote } from './commands/create-ssh-remote';
import { removeSshRemote } from './commands/remove-ssh-remote';
import { testSshRemote } from './commands/test-ssh-remote';
import { updateSshRemote } from './commands/update-ssh-remote';
import { directorNotesHistory } from './commands/director-notes-history';
import { directorNotesSynopsis } from './commands/director-notes-synopsis';
import { settingsList } from './commands/settings-list';
import { settingsGet, settingsMediaStatus } from './commands/settings-get';
import { settingsSet } from './commands/settings-set';
import {
	displayFont,
	displayFontList,
	displayFontSize,
	displayFontsCatalog,
	displayPreset,
	displayZoom,
} from './commands/display-font';
import { settingsReset } from './commands/settings-reset';
import {
	settingsAgentList,
	settingsAgentGet,
	settingsAgentSet,
	settingsAgentReset,
} from './commands/settings-agent';
import { promptsGet, promptsList } from './commands/prompts-get';
import { gistCreate } from './commands/gist';
import { notifyToast } from './commands/notify-toast';
import { notifyFlash } from './commands/notify-flash';
import { notifySpeak } from './commands/notify-speak';
import { notificationInbox } from './commands/notification-inbox';
import { profilingStart, profilingStop, profilingStatus } from './commands/profiling';
import {
	modelsEndpointsAdd,
	modelsEndpointsDetect,
	modelsEndpointsList,
	modelsEndpointsModels,
	modelsEndpointsRemove,
	modelsEndpointsTest,
	modelsEndpointsUpdate,
} from './commands/models-endpoints';
import { modelsConfigSet, modelsConfigShow } from './commands/models-config';
import { modelsAssign, modelsTasks } from './commands/models-assign';
import { loadUserLocalModels } from './services/storage';
import {
	modelsAddHf,
	modelsCancel,
	modelsInstall,
	modelsList,
	modelsRemoveHf,
	modelsPause,
	modelsRemove,
	modelsVerify,
} from './commands/models-manage';
import { modelsRun } from './commands/models-run';
import { modelsRuntimesInstall, modelsRuntimesList } from './commands/models-runtimes';
import { modelsIndex } from './commands/models-index';
import { modelsProxyBlock, modelsProxyStatus } from './commands/models-proxy';
import {
	modelsTiersList,
	modelsTiersOptions,
	modelsTiersReset,
	modelsTiersSet,
	modelsTiersSuggest,
} from './commands/models-tiers';
import {
	modelsServerKey,
	modelsServerSet,
	modelsServerStart,
	modelsServerStatus,
	modelsServerStop,
} from './commands/models-server';
import {
	systemOneKeyClear,
	systemOneKeySet,
	systemOneLedger,
	systemOneSetAgents,
	systemOneSetBudget,
	systemOneSetEngine,
	systemOneSetFailPolicy,
	systemOneSetKeepInputs,
	systemOneSetTimeout,
	systemOneStatus,
	systemOneTest,
} from './commands/system-one';
import { registerSystemOneAgentCommands } from './commands/system-one-ask';
import { systemOneRoute } from './commands/system-one-route';
import { modelsStatus } from './commands/models-status';
import {
	voiceWakeAdd,
	voiceWakeClearBackground,
	voiceWakeList,
	voiceWakeRecord,
	voiceWakeRemove,
	voiceWakeStatus,
	voiceWakeStop,
	voiceWakeTrain,
	voiceWakeUndo,
} from './commands/voice-wake';
import {
	voiceInputList,
	voiceInputSet,
	voiceLatency,
	voiceListen,
	voiceMute,
	voiceScope,
	voiceSelfTest,
	voiceSend,
	voiceSetup,
	voiceStart,
	voiceStatus,
	voiceStop,
	voiceStopReply,
	voiceUnmute,
	voiceVolume,
	voiceWait,
	voiceWakeTest,
} from './commands/voice';
import {
	voiceCredentialsClear,
	voiceCredentialsList,
	voiceCredentialsSet,
	voiceCredentialsTest,
	voiceProvidersList,
	voiceProvidersSet,
	voiceVoicesList,
	voiceVoicesPreview,
	voiceVoicesSet,
	voiceWakePhraseClear,
	voiceWakePhraseList,
	voiceWakePhraseSet,
} from './commands/voice-providers';
import {
	voiceDevicesDisconnect,
	voiceDevicesDiscovery,
	voiceDevicesForget,
	voiceDevicesList,
	voiceDevicesRename,
	voiceDevicesRevoke,
	voiceDevicesRevokeAll,
	voiceDevicesTestConnection,
} from './commands/voice-devices';
import { search } from './commands/search';
import { tabSuggestCleanup } from './commands/tab-suggest-cleanup';
import { quickChat } from './commands/quick-chat';
import { maestroRun } from './commands/maestro-run';
import {
	dataviewEval,
	dataviewIndexRebuild,
	dataviewTrust,
	dataviewTrusted,
	dataviewUntrust,
	dataviewIndexStatus,
	dataviewQuery,
} from './commands/dataview';
import { cadenzaOpen, cadenzaUpdate, cadenzaClose } from './commands/cadenza';
import {
	movementBegin,
	movementAdd,
	movementUpdate,
	movementMove,
	movementRemove,
	movementClear,
	movementProgress,
	movementState,
	movementInspect,
	movementInteract,
} from './commands/movement';
import { supportPackage } from './commands/support-package';
import {
	feedbackAccounts,
	feedbackAuth,
	feedbackDiagnose,
	feedbackLogin,
	feedbackSearch,
	feedbackSubmit,
	feedbackSubscribe,
} from './commands/feedback';
import { stats, statsIndexing, statsModels, statsQuery, statsTokens } from './commands/stats';
import { renameAgent } from './commands/rename-agent';
import { renameGroup } from './commands/rename-group';
import { updateGroup } from './commands/update-group';
import { groupSettings } from './commands/group-settings';
import { updateGroupSettings } from './commands/update-group-settings';
import { delegationGraph } from './commands/delegation-graph';
import {
	stopAutoRun,
	resumeAutoRun,
	skipAutoRun,
	abortAutoRun,
	resetAutoRunTasks,
	autoRunStatus,
	autoRunFolder,
} from './commands/auto-run-control';
import { steerAutoRunCancel, steerAutoRunList, steerAutoRunSend } from './commands/steer-auto-run';
import { removePlaybook } from './commands/remove-playbook';
import { focusAgent, switchMode } from './commands/agent-control';
import { agentTestRunOn } from './commands/agent-test-run-on';
import {
	tabNew,
	tabClose,
	tabRename,
	tabStar,
	tabMove,
	tabUnread,
	tabSaveToHistory,
	tabThinking,
	tabReadOnly,
	tabModel,
	tabEffort,
	tabEnterToSend,
	tabShow,
} from './commands/tab';
import { setBookmark } from './commands/bookmark';
import { setTheme } from './commands/set-theme';
import { gloss } from './commands/gloss';
import { themeShow, themeExport, themeImport, themeSet } from './commands/theme';
import { encoreList, encoreSet } from './commands/encore';
import {
	computerHistoryApps,
	computerHistoryClear,
	computerHistoryConfig,
	computerHistoryDigests,
	computerHistoryEnableAccessibility,
	computerHistoryList,
	computerHistoryPause,
	computerHistoryQuery,
	computerHistoryResume,
	computerHistoryRulesAdd,
	computerHistoryRulesList,
	computerHistoryRulesMode,
	computerHistoryRulesRemove,
	computerHistoryStatus,
} from './commands/computer-history';
import { setVerbosity } from './output/verbosity';
import { pianolaWatch, pianolaRules, pianolaAddRule, pianolaLog } from './commands/pianola';
import { pianolaLearn } from './commands/pianola-learn';
import { pianolaProfile, pianolaSetProfile } from './commands/pianola-profile';
import {
	pianolaPlanSet,
	pianolaPlanList,
	pianolaPlanShow,
	pianolaOrchestrate,
} from './commands/pianola-orchestrate';
import {
	pianolaSuperviseWatch,
	pianolaSuperviseOrchestrate,
	pianolaSuperviseList,
	pianolaSuperviseRemove,
	pianolaSuperviseSetEnabled,
} from './commands/pianola-supervise';
import {
	pluginInit,
	pluginValidate,
	pluginSign,
	pluginPack,
	pluginRuntime,
} from './commands/plugin';
import {
	agentRunAppendEvent,
	agentRunList,
	agentRunRecord,
	agentRunShow,
	campaignList,
	campaignRecord,
	campaignShow,
} from './commands/agent-run';
import { mcpServe } from './commands/mcp';
import {
	allowWhileEncoreOff,
	encoreCommand,
	readEncoreFlagsForHelp,
	requireEncoreForOptions,
} from './utils/encore-gate';
import { logger } from '../main/utils/logger';
import { ExitCode, exitWith } from './exit-codes';

import { registerLiteCommands } from './commands/lite';
// Injected at build time by scripts/build-cli.mjs via esbuild `define`.
// The typeof guard keeps non-esbuild execution paths (ts-node, plain tsc output) from
// throwing a ReferenceError; in those paths the constant is never substituted.
declare const __MAESTRO_CLI_VERSION__: string;
const cliVersion: string =
	typeof __MAESTRO_CLI_VERSION__ !== 'undefined' ? __MAESTRO_CLI_VERSION__ : '0.0.0-dev';

// stdout carries command output (often JSON that scripts parse), so the
// main-process logger shared with modules like the WakaTime manager must keep
// its diagnostics on stderr. See #1698.
logger.routeConsoleToStderr();

const program = new Command();

// A switched-off Encore Feature's verbs are registered hidden (absent from
// --help, `reference` and `completions`) and refuse to run; see encoreCommand.
const encoreFlags = readEncoreFlagsForHelp();

program.name('maestro-cli').description('Command-line interface for Maestro').version(cliVersion);

// Global verbosity flags. `--verbose` has no short alias on purpose: several
// subcommands already use `-v` for their own verbose option, and a global `-v`
// would shadow them. The preAction hook below copies the parsed values into the
// shared verbosity module before any command action runs.
program
	.option('-q, --quiet', 'Suppress incidental success output (errors still print)')
	.option('--verbose', 'Print extra detail where available');

registerLiteCommands(program);

program.hook('preAction', (thisCommand) => {
	const opts = thisCommand.opts();
	setVerbosity({ quiet: Boolean(opts.quiet), verbose: Boolean(opts.verbose) });
});
// AgentRun and campaign commands - neutral ledger/read-model spine for external
// agent work. Pianola remains the authoritative orchestrator; these commands
// record and inspect runs/campaigns without replacing `pianola plan`.
const agentRun = program.command('agent-run').description('Record and inspect agent runs');

agentRun
	.command('record')
	.description('Record or update an agent run from a JSON file')
	.requiredOption('--file <json>', 'Agent run JSON file')
	.option('--json', 'Output as JSON (for scripting)')
	.action(agentRunRecord);

agentRun
	.command('append-event <run-id>')
	.description('Append an event to an agent run')
	.requiredOption('--type <type>', 'Event type')
	.option('--status <status>', 'Update the run status with this event')
	.option('--message <text>', 'Human-readable event message')
	.option('--json', 'Output as JSON (for scripting)')
	.action((runId, options) => agentRunAppendEvent(runId, options));

agentRun
	.command('list')
	.description('List recent agent runs')
	.option('--status <status>', 'Filter by run status')
	.option('--campaign <id>', 'Filter by campaign id')
	.option('--limit <n>', 'Maximum number of runs to show')
	.option('--json', 'Output as JSON (for scripting)')
	.action(agentRunList);

agentRun
	.command('show <run-id>')
	.description('Show an agent run and its events')
	.option('--json', 'Output as JSON (for scripting)')
	.action((runId, options) => agentRunShow(runId, options));

const campaign = program.command('campaign').description('Record and inspect agent campaigns');

campaign
	.command('record')
	.description('Record or update a campaign from a JSON file')
	.requiredOption('--file <json>', 'Campaign JSON file')
	.option('--json', 'Output as JSON (for scripting)')
	.action(campaignRecord);

campaign
	.command('list')
	.description('List campaigns')
	.option('--status <status>', 'Filter by campaign status')
	.option('--limit <n>', 'Maximum number of campaigns to show')
	.option('--json', 'Output as JSON (for scripting)')
	.action(campaignList);

campaign
	.command('show <id>')
	.description('Show a campaign')
	.option('--json', 'Output as JSON (for scripting)')
	.action((campaignId, options) => campaignShow(campaignId, options));

// List commands
const list = program.command('list').description('List resources');

list
	.command('groups')
	.description('List all session groups')
	.option('--json', 'Output as JSON lines (for scripting)')
	.action(listGroups);

list
	.command('agents')
	.description('List all agents')
	.option('-g, --group <id>', 'Filter by group ID')
	.option('--json', 'Output as JSON lines (for scripting)')
	.action(listAgents);

list
	.command('playbooks')
	.description('List playbooks (optionally filter by agent)')
	.option('-a, --agent <id>', 'Agent ID (shows all if not specified)')
	.option('--json', 'Output as JSON lines (for scripting)')
	.action(listPlaybooks);

list
	.command('sessions <agent-id>')
	.description('List agent sessions (most recent first)')
	.option('-l, --limit <count>', 'Maximum number of sessions to show (default: 25)')
	.option('-k, --skip <count>', 'Number of sessions to skip for pagination (default: 0)')
	.option('-s, --search <keyword>', 'Filter sessions by keyword in name or first message')
	.option('--json', 'Output as JSON (for scripting)')
	.action(listSessions);

list
	.command('ssh-remotes')
	.description('List all configured SSH remotes')
	.option('--json', 'Output as JSON lines (for scripting)')
	.action(listSshRemotes);

list
	.command('terminals')
	.description('List open terminal tabs in the desktop app (all agents unless --agent is given)')
	.option('-a, --agent <id>', 'Only list terminals belonging to this agent')
	.option('--json', 'Output as JSON (for scripting)')
	.action(listTerminals);

// Show command
const show = program.command('show').description('Show details of a resource');

show
	.command('agent <id>')
	.description(
		'Show agent details: settings, the environment it is spawned with, peers, history and usage stats'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.option('--show-secrets', 'Print secret environment values in full instead of masked')
	.action(showAgent);

show
	.command('playbook <id>')
	.description('Show detailed information about a playbook')
	.option('--json', 'Output as JSON (for scripting)')
	.action(showPlaybook);

// Playbook command (lazy-loaded to keep CLI startup lean)
program
	.command('playbook <playbook-id>')
	.description('Run a playbook')
	.option('--dry-run', 'Show what would be executed without running')
	.option('--no-history', 'Do not write history entries')
	.option('--json', 'Output as JSON lines (for scripting)')
	.option('--debug', 'Show detailed debug output for troubleshooting')
	.option('--verbose', 'Show full prompt sent to agent on each iteration')
	.option('--no-synopsis', 'Skip synopsis generation after each task (reduces overhead)')
	.option('--wait', 'Wait for agent to become available if busy')
	.option(
		'--model <model>',
		"Model to use for this run only, overriding the agent's configured default"
	)
	.option(
		'--effort <effort>',
		"Reasoning effort for this run only, overriding the agent's configured default"
	)
	.option(
		'--ignore-model-hints',
		'Ignore MAESTRO:MODEL markers in the documents and run every task at --model/--effort (or the agent default)'
	)
	.action(async (playbookId: string, options: Record<string, unknown>) => {
		const { runPlaybook } = await import('./commands/run-playbook');
		return runPlaybook(playbookId, options);
	});

// Goal-Driven Auto Run command (lazy-loaded)
program
	.command('goal-run <agent-id> <goal>')
	.description('Launch a Goal-Driven Auto Run: pursue a free-text goal until done')
	.option('--exit-criteria <text>', 'What "done" looks like and when to declare a deadlock')
	.option('--max-iterations <n>', 'Cap iterations (default: infinite)')
	.option('--no-history', 'Do not write history entries')
	.option('--json', 'Output as JSON lines (for scripting)')
	.option('--verbose', 'Show full prompt sent to agent on each iteration')
	.option(
		'--visible',
		'Run inside the Maestro desktop app (visible Auto Run) instead of headlessly'
	)
	.option('--wait', 'With --visible, wait for the agent to become available if busy')
	.option(
		'--model <model>',
		"Model to use for this run only, overriding the agent's configured default"
	)
	.option(
		'--effort <effort>',
		"Reasoning effort for this run only, overriding the agent's configured default"
	)
	.action(async (agentId: string, goal: string, options: Record<string, unknown>) => {
		const { goalRun } = await import('./commands/goal-run');
		return goalRun(agentId, goal, options);
	});

// Run-doc command - run raw Auto Run documents headlessly without saving a
// playbook first. Self-contained (spawns the agent itself); unlike
// `auto-run --launch` it does not route through the desktop renderer, so it
// works whether or not the Maestro window is open.
program
	.command('run-doc <docs...>')
	.description('Run one or more Auto Run documents headlessly (no saved playbook required)')
	.requiredOption(
		'-a, --agent <id>',
		'Target agent by ID or name (use "maestro-cli list agents" to find agents)'
	)
	.option('-p, --prompt <text>', 'Custom prompt for the run (defaults to the Auto Run prompt)')
	.option('--loop', 'Enable looping')
	.option('--max-loops <n>', 'Maximum loop count (implies --loop)')
	.option('--reset-on-completion', 'Enable reset-on-completion for all documents')
	.option('--dry-run', 'Show what would be executed without running')
	.option('--no-history', 'Do not write history entries')
	.option('--json', 'Output as JSON lines (for scripting)')
	.option('--debug', 'Show detailed debug output for troubleshooting')
	.option('--verbose', 'Show full prompt sent to agent on each iteration')
	.option('--no-synopsis', 'Skip synopsis generation after each task (reduces overhead)')
	.option('--wait', 'Wait for agent to become available if busy')
	.option(
		'--model <model>',
		"Model to use for this run only, overriding the agent's configured default"
	)
	.option(
		'--effort <effort>',
		"Reasoning effort for this run only, overriding the agent's configured default"
	)
	.option(
		'--ignore-model-hints',
		'Ignore MAESTRO:MODEL markers in the documents and run every task at --model/--effort (or the agent default)'
	)
	.action(async (docs: string[], options: Record<string, unknown>) => {
		const { runDoc } = await import('./commands/run-doc');
		return runDoc(docs, options as never);
	});

// Clean command
const clean = program.command('clean').description('Clean up orphaned resources');

clean
	.command('playbooks')
	.description('Remove playbooks for deleted sessions')
	.option('--dry-run', 'Show what would be removed without actually removing')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cleanPlaybooks);

// Send command - run an agent locally and return its response synchronously.
// For desktop-handoff workflows, use `maestro-cli dispatch` instead.
program
	.command('send <agent-id> <message>')
	.description('Send a message to an agent and get a JSON response')
	.option('-s, --session <id>', 'Resume an existing agent session (for multi-turn conversations)')
	.option('-r, --read-only', 'Run in read-only/plan mode (agent cannot modify files)')
	.option('-t, --tab', 'Open/focus the session tab in Maestro desktop')
	.option(
		'--model <model>',
		'Run this one turn on a model other than the agent\'s own. "auto" asks the model router for the tier and effort this message needs (see: s1 route)'
	)
	.option('--require-plugin-tools', 'Fail if a desktop-backed run with plugin tools is unavailable')
	.option(
		'--require-tool-receipt <tool-id>',
		'Require a host-observed delivery receipt from this plugin tool ID'
	)
	.option(
		'--no-system-prompt',
		'Skip the Maestro system prompt (agent identity, git branch, history path, conductor profile). Default is to include it for parity with the desktop app.'
	)
	.option(
		'--no-history',
		'Do not write a History entry for this turn (written by default, desktop app running or not)'
	)
	.option('--no-synopsis', 'Skip the synopsis turn; the History entry carries the response instead')
	.option('--json', 'Output as JSON (this verb always does; accepted so every verb takes --json)')
	.action(send);

// Dispatch command - hand a prompt to the desktop and return tab/session ID.
// Splits the desktop-handoff half of `send --live` into a dedicated verb so
// callers can address the same tab again without owning a persistent channel.
program
	.command('dispatch <agent-id> <message>')
	.description(
		'Dispatch a prompt to an agent in the Maestro desktop app and return its tab/session ID'
	)
	.option(
		'--new-tab',
		'Create a fresh AI tab and deliver the prompt into it. The tab is hidden by default: it is named from the prompt but draws no chip until the user opens it from the completion toast or the delegation pill. A working agent cannot start a second turn, so the prompt is queued for the new tab and runs when the current turn ends (the response reports queued: true).'
	)
	.option(
		'--visible',
		'With --new-tab: give the new tab a chip in the tab strip instead of creating it hidden (it still opens in the background unless --focus)'
	)
	.option(
		'--background',
		'Leave the view where it is (default with --new-tab; suppresses the agent switch otherwise)'
	)
	.option(
		'-t, --tab <id>',
		'Target an existing tab by its tab id (mutually exclusive with --new-tab)'
	)
	.option(
		'-f, --force',
		'Bypass the busy-state guard when writing to a busy tab; requires allowConcurrentSend (cannot be combined with --new-tab, which queues instead)'
	)
	.option(
		'--focus',
		'Switch to and focus the target agent/tab when dispatching (by default dispatch runs in the background without stealing focus)'
	)
	.option(
		'--queue',
		'If the target tab is busy, queue the prompt into the execution queue (FIFO) instead of rejecting it; an idle target dispatches immediately. Cannot be combined with --new-tab (which already queues when the agent is busy) or --force. Returns the queue position.'
	)
	.option('--wait', 'Alias for --queue')
	.option(
		'--held',
		"Queue the prompt PAUSED, even when the agent is idle, like the Send menu's Queue Held. It keeps its place until `queue resume <item-id>`. Implies --queue; returns the item id."
	)
	.option(
		'--notify-on-complete <agent-id>',
		'Wake this agent with a real turn in its live tab when THIS dispatch finishes. Correlated to the dispatched tab, fires exactly once, and waits for a multi-task Auto Run to finish rather than firing per task. Requires --new-tab or --tab.'
	)
	.option(
		'--callback-tab <id>',
		'Specific tab of the --notify-on-complete agent to wake (default: its active AI tab)'
	)
	.option(
		'--callback-prompt <text>',
		'Override the callback prompt body. {{DISPATCH_STATUS}}, {{DISPATCH_TAB_ID}}, {{DISPATCH_TARGET_ID}}, {{DISPATCH_OUTPUT}}, {{DISPATCH_DURATION}}, {{DISPATCH_TASKS_COMPLETED}}, {{DISPATCH_TASKS_TOTAL}}, {{DISPATCH_PROMPT}} and {{DISPATCH_CALLBACK_ID}} are substituted.'
	)
	.option(
		'--callback-timeout <seconds>',
		'Give up and fire a timeout callback after this long (default 3600, max 86400)'
	)
	.option('--json', 'Output as JSON (this verb always does; accepted so every verb takes --json)')
	.action(dispatch);

// Ask command - the agent-to-agent question. `dispatch` hands WORK to an agent
// and lands in a real tab; `ask` asks a QUESTION and rides the cross-agent
// consult path (hidden tab on the target, fresh context, no focus, no unread),
// returning the answer here instead of interrupting whatever conversation the
// human has open with that agent.
program
	.command('ask <agent-id> <question>')
	.description(
		"Ask another agent a question and print its answer (background consult - never touches the target's open conversation)"
	)
	.option(
		'--from <agent-id>',
		'Your own agent id. Names the consult on the target, keeps continuity across repeat asks, forwards your working directory so it can read your project, and lets Stop cancel the consult. Defaults to the agent this runs under inside Maestro'
	)
	.option(
		'--with-context',
		'Forward your current transcript as context. Off by default: ask sends a self-contained question in a fresh context'
	)
	.option('--timeout <seconds>', 'How long to wait for the answer (default 600, min 10, max 3600)')
	.option('--json', 'Output the answer as JSON')
	.action(ask);

// Queue commands - inspect and manage the desktop execution queue populated by
// `dispatch --queue`. Read-only `list`, a `remove` verb for scriptable
// cleanup/debugging, `hold` / `resume` (the card's Hold / Resume), `merge` (the
// card's Merge button), and `steer` (the Steer button). The queue lives
// authoritatively in the desktop renderer.
const queue = program
	.command('queue')
	.description('Inspect and manage the desktop execution queue (from dispatch --queue)');

queue
	.command('list')
	.description('List queued execution items as JSON (all agents, or one with --agent)')
	.option(
		'-a, --agent <id>',
		'Only list items for this agent (default: every agent with queued items)'
	)
	.option('--json', 'Output as JSON (this verb always does; accepted so every verb takes --json)')
	.action(queueList);

queue
	.command('remove <item-id>')
	.description('Remove a queued item by its id (from dispatch --queue output or queue list)')
	.option('-a, --agent <id>', 'Agent whose queue the item belongs to (required)')
	.option('--json', 'Output as JSON (this verb always does; accepted so every verb takes --json)')
	.action(queueRemove);

queue
	.command('hold <item-id>')
	.description(
		'Hold a queued item, like the Hold button on its queued card: it keeps its place but does not run until resumed'
	)
	.option('-a, --agent <id>', 'Agent whose queue the item belongs to (required)')
	.action(queueHold);

queue
	.command('resume <item-id>')
	.description(
		'Resume a held queued item, like the Resume button on its queued card: it runs when its turn comes'
	)
	.option('-a, --agent <id>', 'Agent whose queue the item belongs to (required)')
	.action(queueResume);

queue
	.command('merge <item-id>')
	.description(
		"Merge a queued message into the message above it on the same tab, like the Merge button on its queued card: the two are sent as one message, in the upper one's place"
	)
	.option('-a, --agent <id>', 'Agent whose queue the item belongs to (required)')
	.action(queueMerge);

queue
	.command('steer <item-id>')
	.description(
		'Steer a queued message into the turn already running on its tab, like the Steer button on the queued card (Claude agents on the interactive token source, or Codex agents on the app-server transport). The item leaves the queue once the agent has it and returns if the agent never takes it.'
	)
	.option('-a, --agent <id>', 'Agent whose queue the item belongs to (required)')
	.option('--json', 'Output as JSON (this verb always does; accepted so every verb takes --json)')
	.action(queueSteer);

// Window commands - the CLI half of the Left Bar's "Move to Window" menus (on an
// agent and on a group) and the matching Cmd+K commands. Answered by the primary
// window through the same code path as a click.
const windowCmd = program
	.command('window')
	.description('List Maestro windows, and move agents or whole groups between them');

windowCmd
	.command('list')
	.description('List open windows and the agents each one holds')
	.option('--json', 'Output as JSON')
	.action(windowList);

windowCmd
	.command('move-agent <agent-id>')
	.description('Move an agent (with its worktrees) to another window')
	.option('--to <window>', '"new", "main", a window number, a window id, or a window name')
	.option('--json', 'Output as JSON')
	.action(windowMoveAgent);

windowCmd
	.command('move-group <group-id>')
	.description('Move every agent in a group (with subgroups when nesting is on) to another window')
	.option('--to <window>', '"new", "main", a window number, a window id, or a window name')
	.option('--json', 'Output as JSON')
	.action(windowMoveGroup);

// Snooze commands - the CLI half of the Snooze dialog (Opt+Cmd+S), the Snoozed
// Tabs list, and its history log. `<when>` takes the same expressions the dialog
// does ("2h", "tomorrow", "next fri 3pm", "aug 5"), parsed locally so a typo
// fails before a round trip.
const snooze = program
	.command('snooze')
	.description('Park a tab until later, and manage what is parked');

snooze
	.command('tab <tab-id> <when>')
	.description('Snooze a tab or tiled group until <when> (e.g. 2h, tomorrow, "next fri 3pm")')
	.option(
		'-a, --agent <id>',
		'Agent that owns the tab. Required for a file, terminal, browser, or group tab, which are not in the AI tab list'
	)
	.option('-n, --note <text>', 'Note-to-self surfaced in the wake notification')
	.option(
		'-p, --wake-prompt <text>',
		'Prompt sent to the agent the moment the tab comes back (AI tabs and groups only)'
	)
	.option('--background', 'Park it without flashing the "Snoozed until ..." confirmation')
	.option('--focus', 'Show the confirmation flash (the default)')
	.option('--json', 'Output the stored snooze as JSON')
	.action(snoozeTabCommand);

snooze
	.command('list')
	.description('List snoozed tabs across every agent, soonest wake first')
	.option('-a, --agent <id>', 'Only list snoozes held by this agent')
	.option('--json', 'Output as JSON')
	.action(snoozeList);

snooze
	.command('wake <snooze-id>')
	.description('Bring a snoozed tab back right now (accepts a unique id prefix)')
	.option('--background', 'Accepted and ignored: a wake restores the tab without focusing it')
	.option('--focus', 'Accepted and ignored: a wake restores the tab without focusing it')
	.option('--json', 'Output as JSON')
	.action(snoozeWake);

snooze
	.command('dismiss <snooze-id>')
	.description("Drop a snooze and its tab - it won't come back")
	.option('--background', 'Dismiss it without raising the "Snooze dismissed" toast')
	.option('--focus', 'Raise the toast (the default)')
	.option('--json', 'Output as JSON')
	.action(snoozeDismiss);

snooze
	.command('reschedule <snooze-id> <when>')
	.description('Move a snooze to a new time, optionally rewriting its note or wake prompt')
	.option('-n, --note <text>', 'Replace the note (pass an empty string to clear it)')
	.option('-p, --wake-prompt <text>', 'Replace the wake prompt (empty string clears it)')
	.option('--json', 'Output as JSON')
	.action(snoozeReschedule);

snooze
	.command('history')
	.description('Snoozes that have already resolved - woken, unsnoozed, or dismissed')
	.option('--limit <n>', 'Only show the newest <n> entries')
	.option('--json', 'Output as JSON')
	.action(snoozeHistory);

// `unsnooze` is the verb people reach for, and it is what the Snoozed Tabs list
// calls the button, so it is spelled out here rather than left as `snooze wake`.
program
	.command('unsnooze <snooze-id>')
	.description('Bring a snoozed tab back right now (alias for "snooze wake")')
	.option('--background', 'Accepted and ignored: a wake restores the tab without focusing it')
	.option('--focus', 'Accepted and ignored: a wake restores the tab without focusing it')
	.option('--json', 'Output as JSON')
	.action(snoozeWake);

// Throughput Gauge commands - the CLI half of the floating tokens/sec gauge (an
// Encore Feature): show and hide, the gear's five settings, Reset peak, and a
// status read. Every verb answers with the gauge's status after it ran.
const throughputGauge = encoreCommand(
	program,
	'throughput-gauge',
	'throughputGauge',
	encoreFlags
).description('Show, hide, configure, or read the Throughput Gauge (tokens per second)');

const gaugeFlagHelp = (label: string, field: Parameters<typeof throughputGaugeFlagChoices>[0]) =>
	`${label}: ${throughputGaugeFlagChoices(field).join(' | ')}`;

throughputGauge
	.command('show')
	.description('Put the gauge on screen (does not move focus)')
	.option('--json', 'Output the gauge status as JSON')
	.action(throughputGaugeShow);

throughputGauge
	.command('hide')
	.description('Take the gauge off screen')
	.option('--json', 'Output the gauge status as JSON')
	.action(throughputGaugeHide);

throughputGauge
	.command('toggle')
	.description(
		'Flip the gauge on or off screen, like the hotkey (scripts should prefer show / hide)'
	)
	.option('--json', 'Output the gauge status as JSON')
	.action(throughputGaugeToggle);

throughputGauge
	.command('set')
	.description('Change one or more gauge settings, like the gear on the gauge')
	.option('--scope <scope>', gaugeFlagHelp('Whose output to count', 'scope'))
	.option('--metric <metric>', gaugeFlagHelp('Which reading to show', 'metric'))
	.option('--layout <layout>', gaugeFlagHelp('One gauge or all three', 'layout'))
	.option('--style <style>', gaugeFlagHelp('How the reading is drawn', 'style'))
	.option('--window <seconds>', gaugeFlagHelp('Rolling-average window in seconds', 'windowMs'))
	.option('--json', 'Output the gauge status as JSON')
	.action(throughputGaugeSet);

throughputGauge
	.command('reset-peak')
	.description('Start the peak mark again from the current reading')
	.option('--json', 'Output the gauge status as JSON')
	.action(throughputGaugeResetPeak);

throughputGauge
	.command('status')
	.description('Read visibility, settings, live rates, and peaks')
	.option('--json', 'Output as JSON (enabled, visible, settings, rates, peak, windowMs)')
	.action(throughputGaugeStatus);

// Session inspection commands - read-only access to desktop conversation state.
// Lets external pollers (Maestro-Discord, Cue follow-ups) pick up where Maestro
// left off without owning a persistent channel - pair with `dispatch` to write
// and `session show` to follow up.
const session = program
	.command('session')
	.description('Inspect open desktop tabs and their conversation history');

session
	.command('list')
	.description('List open desktop AI tabs and their tab/session IDs')
	.option('--json', 'Output as JSON (for scripting)')
	.action(sessionList);

session
	.command('show <tab-id>')
	.description('Print conversation history for a desktop tab')
	.option(
		'--since <timestamp>',
		'Only return messages after this timestamp (ISO-8601 or epoch ms/sec)'
	)
	.option('--tail <n>', 'Only return the last N messages (applied after --since)')
	.option('--json', 'Output as JSON (for scripting); default is a formatted transcript')
	.action(sessionShow);

// Group chat commands - start and drive multi-agent group chats in the desktop app.
// `start` is how a script hands a job to a moderator (the release commands use it);
// participants join by @mention, exactly as when a user types them. Never moves the view.
const groupChat = program
	.command('group-chat')
	.description('Start, message, and inspect group chats in the desktop app');

groupChat
	.command('start <name>')
	.description('Create a group chat and send its moderator the opening message')
	.option(
		'-p, --participant <agent>',
		'Participant agent ID or name (repeatable; at least one)',
		(value: string, prev: string[]) => [...prev, value],
		[] as string[]
	)
	.option(
		'--moderator <agent-type>',
		"Moderator agent type (e.g. claude-code); defaults to the first participant's type"
	)
	.option('-m, --message <text>', 'Opening message for the moderator (defaults to the name)')
	.option('--message-file <path>', 'Read the opening message from a file')
	.option('--json', 'Output as JSON (for scripting)')
	.action(groupChatStart);

groupChat
	.command('send <chat> [message]')
	.description('Send a message to a group chat (ID, ID prefix, or name); refused while busy')
	.option('--message-file <path>', 'Read the message from a file')
	.option('--json', 'Output as JSON (for scripting)')
	.action(groupChatSend);

groupChat
	.command('steer <chat> [message]')
	.description(
		'Type a message into the round running in a group chat instead of waiting for it to end'
	)
	.option('--message-file <path>', 'Read the message from a file')
	.option('--item <queued-id>', 'Steer a message already in the chat queue (ids are in status)')
	.option('--read-only', 'Only steer new text when the running round is read-only')
	.option('--json', 'Output as JSON (for scripting)')
	.action(groupChatSteer);

groupChat
	.command('status <chat>')
	.description("Show a group chat's state, participants, and latest messages")
	.option('--tail <n>', 'How many recent messages to print (default 5; 0 for none)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(groupChatStatus);

groupChat
	.command('list')
	.description('List group chats and whether each is busy')
	.option('--all', 'Include archived chats')
	.option('--json', 'Output as JSON (for scripting)')
	.action(groupChatList);

groupChat
	.command('stop <chat>')
	.description("Stop a group chat's moderator and participants")
	.option('--json', 'Output as JSON (for scripting)')
	.action(groupChatStop);

groupChat
	.command('archive <chat>')
	.description(
		'Archive a group chat (stops its moderator and participants); --restore brings it back'
	)
	.option('--restore', 'Unarchive the chat instead')
	.option('--json', 'Output as JSON (for scripting)')
	.action(groupChatArchive);

// Open file command - open a file in the Maestro desktop app.
//
// Also the verb that PLAYS media: the renderer's open path recognizes a
// playable local audio or video file and hands it to the floating player
// instead of making a tab, so there is no separate `play` command and nothing
// should be shelling out to the OS player.
program
	.command('open-file <file-path>')
	.description(
		'Open a file as a preview tab in the Maestro desktop app (audio and video play in the floating media player instead; an http(s) URL to an MP4 or audio file streams in the player; a folder is revealed in the Files panel)'
	)
	.option('-a, --agent <id>', "Target agent (defaults to auto-detect by file path's owning agent)")
	.option(
		'--background',
		'Open the preview tab without changing anything currently rendered, on any agent'
	)
	.option('--focus', 'Switch to the file after opening it (default)')
	.option('--no-switch', "Don't switch to the target agent, but still activate the tab there")
	.option(
		'--queue',
		'Audio/video only: add to the media player queue and show the player without starting playback'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(openFile);

// Open graph command - render a Document Graph over specific documents.
//
// Its own verb rather than a `open <surface>` entry: `open_modal` carries only
// a surface name and a tab, and a graph needs a file set.
program
	.command('open-graph [paths...]')
	.description('Open the Document Graph over specific markdown files or a directory')
	.option('-a, --agent <id>', "Target agent (defaults to auto-detect by path's owning agent)")
	.option('--focus <path>', 'Center the graph on this document (default: the most-linked one)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(openGraph);

// Open browser command - open a URL in a browser tab in the Maestro desktop app
program
	.command('open-browser <url>')
	.description('Open a URL as a browser tab in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option(
		'--background',
		'Create the tab without focusing it or switching agents (use for agent research, then close-browser when done)'
	)
	.option('--focus', 'Switch to the browser tab after opening it (default)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(openBrowser);

// Open modal command - bring up a Maestro surface (Cue, Settings, Usage
// Dashboard, ...) in the running desktop app, optionally on a given tab. Prints
// the hotkey / command-palette / click paths too, so an agent that opens a
// surface for the user can also teach them how to reach it by hand.
program
	.command('open [surface]')
	.description('Open a Maestro modal or dashboard (use --list to see every surface)')
	.option('-t, --tab <tab>', 'Deep-link to a tab within the surface')
	.option('--sub-tab <sub-tab>', 'Deep-link to a tab inside that tab (needs --tab)')
	.option(
		'-g, --group <id>',
		'Open the surface on one agent group (Delegation Graph, Group Settings)'
	)
	.option('-a, --agent <id>', "Open one agent's surface for this agent (Edit Agent)")
	.option('--list', 'List every openable surface, its tabs, and its shortcut')
	.option('--json', 'Output as JSON (for scripting)')
	.action(openModal);

// Image commands - reach the screenshots a user pasted into the chat.
//
// The agent can see a pasted image but has no path to it, so saving one used to
// be a right-click only the human could perform. `image list` names them and
// `image save` writes the bytes to disk.
const image = program
	.command('image')
	.description('List and save images pasted into a Maestro chat');

image
	.command('list')
	.description("List images pasted into an agent's conversation, newest first")
	.option('-a, --agent <id>', 'Only this agent (defaults to every agent)')
	.option('-t, --tab <tab-id>', 'Only this AI tab')
	.option('--limit <n>', 'Maximum images to show (default: 20)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(imageList);

image
	.command('save [target]')
	.description('Save a pasted image to disk (target: index, handle, or "latest")')
	.option('-a, --agent <id>', 'Only this agent (defaults to every agent)')
	.option('-t, --tab <tab-id>', 'Only this AI tab')
	.option(
		'-o, --output <path>',
		'File or directory to write (default: a generated name in the cwd)'
	)
	.option('--all', 'Save every image in scope instead of just the newest')
	.option('--force', 'Overwrite an existing file named by --output')
	.option('--json', 'Output as JSON (for scripting)')
	.action(imageSave);

// Close browser command - close a browser tab opened via open-browser
program
	.command('close-browser <tab-id>')
	.description('Close a browser tab in the Maestro desktop app (owning agent resolved by tab ID)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(closeBrowser);

// Open terminal command - open a new terminal tab in the Maestro desktop app
program
	.command('open-terminal')
	.description('Open a new terminal tab in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option('--cwd <path>', "Working directory for the terminal (must be within the agent's cwd)")
	.option('--shell <shell>', 'Shell binary to use (default: zsh)')
	.option('--name <name>', 'Display name for the tab')
	.option(
		'--command <command>',
		'Command to run in the terminal (kept as the startup command, so it re-runs if the tab restarts)'
	)
	.option('--background', 'Create the tab without moving the view (agent and tab stay put)')
	.option('--input-required', 'Notify the user that this terminal needs human input')
	.option('--focus', 'Switch to the terminal tab after opening it (default)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(openTerminal);

// Send terminal command - run something in a terminal tab that already exists
program
	.command('send-terminal [command]')
	.description('Run a command in an existing Maestro terminal tab')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option(
		'--tab <id-or-name>',
		"Terminal tab ID or display name (defaults to the agent's active terminal)"
	)
	.option('--control <letter>', 'Send a control character instead of a command (e.g. C for Ctrl-C)')
	.option('--no-enter', 'Type the command without pressing Enter')
	.option('--json', 'Output as JSON (for scripting)')
	.action(sendTerminal);

// Read-terminal command - read the scrollback of an existing Maestro terminal tab
program
	.command('read-terminal')
	.description("Read a Maestro terminal tab's output")
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option(
		'--tab <id-or-name>',
		"Terminal tab ID or display name (defaults to the agent's active terminal)"
	)
	.option('--tail <n>', `Return only the last N lines (default: ${DEFAULT_TAIL_LINES})`)
	.option('--json', 'Output as JSON (for scripting)')
	.action(readTerminal);

// Refresh files command - refresh the file tree in the Maestro desktop app
program
	.command('refresh-files')
	.description('Refresh the file tree in the Maestro desktop app (never moves the view)')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option(
		'--background',
		'Accepted and ignored: this refresh never moves the view or shows a notice'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(refreshFiles);

// Refresh auto-run command - refresh Auto Run documents in the Maestro desktop app
program
	.command('refresh-auto-run')
	.description('Refresh Auto Run documents in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option('--background', 'Refresh without switching to the target agent (default)')
	.option('--focus', 'Switch to the target agent while refreshing')
	.option('--json', 'Output as JSON (for scripting)')
	.action(refreshAutoRun);

// Auto-run command - configure and optionally launch an auto-run session
program
	.command('auto-run <docs...>')
	.description('Configure and optionally launch an auto-run with documents')
	.option('-a, --agent <id>', 'Target agent by ID (use "maestro-cli list agents" to find IDs)')
	.option('-p, --prompt <text>', 'Custom prompt for the auto-run')
	.option('--loop', 'Enable looping')
	.option('--max-loops <n>', 'Maximum loop count (implies --loop)')
	.option('--save-as <name>', "Save as a playbook with this name (don't launch)")
	.option('--launch', 'Start the auto-run immediately (default: just configure)')
	.option('--reset-on-completion', 'Enable reset-on-completion for all documents')
	.option(
		'--worktree',
		'Run the auto-run inside a git worktree (requires --launch, --branch, --worktree-path)'
	)
	.option('--branch <name>', 'Branch name for the worktree (created if it does not exist)')
	.option(
		'--base-branch <name>',
		'Ref the new branch should be based on when it does not yet exist (e.g. "rc" or "main"). Defaults to the main repo HEAD.'
	)
	.option(
		'--worktree-path <path>',
		'Filesystem path for the worktree (must be a sibling of the repo)'
	)
	.option('--create-pr', 'Open a GitHub PR when the auto-run completes successfully')
	.option(
		'--pr-target-branch <branch>',
		'Target branch for the PR (defaults to the repo default branch)'
	)
	.option(
		'--model <model>',
		"Model to use for this run only, overriding the agent's configured default"
	)
	.option(
		'--effort <effort>',
		"Reasoning effort for this run only, overriding the agent's configured default"
	)
	.option(
		'--ignore-model-hints',
		'Ignore MAESTRO:MODEL markers in the documents and run every task at --model/--effort (or the agent default)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(autoRun);

// Auto Run control commands - stop a run and recover from an error pause. These
// complement `auto-run` (which launches) for full lifecycle control.
program
	.command('stop-auto-run')
	.description('Stop the active Auto Run for an agent')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => stopAutoRun(options.agent, options));

program
	.command('resume-auto-run')
	.description('Resume an Auto Run that paused on an error')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => resumeAutoRun(options.agent, options));

program
	.command('skip-auto-run')
	.description('Skip the current document of an error-paused Auto Run and continue')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => skipAutoRun(options.agent, options));

program
	.command('abort-auto-run')
	.description('Abort an error-paused Auto Run')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => abortAutoRun(options.agent, options));

program
	.command('reset-auto-run-tasks <filename>')
	.description('Reset all completed [x] tasks back to [ ] in an Auto Run document')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((filename, options) => resetAutoRunTasks(options.agent, filename, options));

program
	.command('auto-run-status')
	.description('Show whether an Auto Run is active and its document/task progress')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => autoRunStatus(options.agent, options));

program
	.command('auto-run-folder <path>')
	.description(
		"Point an agent at a different Auto Run folder (relative paths resolve against this shell's cwd)"
	)
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((folder, options) => autoRunFolder(options.agent, folder, options));

// Steering commands - the CLI half of the Thought Stream's Steer Auto Run bar.
// A note parks until the run dispatches its next task, then opens that task's
// prompt. Named for Auto Run because "steering" also means typing into a live
// chat turn, which is a different mechanism with no CLI verb here.
const steerAutoRun = program
	.command('steer-auto-run')
	.description('Course-correct a running Auto Run without stopping it');

steerAutoRun
	.command('send <note>')
	.description('Send a steering note; it is delivered at the start of the next task')
	.requiredOption('-a, --agent <id>', 'Agent whose Auto Run to steer')
	.option('--background', 'Queue it without flashing the "Steering note queued" confirmation')
	.option('--focus', 'Show the confirmation flash (the default)')
	.option('--json', 'Output the stored note as JSON')
	.action(steerAutoRunSend);

steerAutoRun
	.command('list')
	.description('Show the notes still waiting, and each delivered note with its task reply')
	.requiredOption('-a, --agent <id>', 'Agent whose steering notes to read')
	.option('--background', 'Accepted and ignored: reading the notes changes nothing on screen')
	.option('--focus', 'Accepted and ignored: reading the notes changes nothing on screen')
	.option('--json', 'Output as JSON, including each full reply')
	.action(steerAutoRunList);

steerAutoRun
	.command('cancel <note-id>')
	.description('Take back a note no task has read yet (accepts a unique id prefix)')
	.requiredOption('-a, --agent <id>', 'Agent that holds the note')
	.option('--background', 'Accepted and ignored: cancelling a note raises no notice')
	.option('--focus', 'Accepted and ignored: cancelling a note raises no notice')
	.option('--json', 'Output the cancelled note as JSON')
	.action(steerAutoRunCancel);

// Playbook Exchange - browse and install community playbooks
const marketplace = program
	.command('marketplace')
	.description('Browse and import Playbook Exchange playbooks (the modal: `open marketplace`)');

marketplace
	.command('list')
	.description('List playbooks in the official + local catalog')
	.option('-c, --category <name>', 'Only this category')
	.option('-s, --search <text>', 'Match id, title, description, or tags')
	.option('--refresh', 'Bypass the catalog cache')
	.option('--json', 'Output as JSON (for scripting)')
	.action(marketplaceList);

marketplace
	.command('show <playbook-id>')
	.description("Show a playbook's details, documents, and README")
	.option('--json', 'Output as JSON (for scripting)')
	.action(marketplaceShow);

marketplace
	.command('import <playbook-id>')
	.description("Install a playbook into an agent's Auto Run folder")
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('-f, --folder <name>', 'Folder name under the Auto Run folder (default: from the title)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(marketplaceImport);

// Remove playbook command - delete a saved playbook from an agent
program
	.command('remove-playbook <agent-id> <playbook-id>')
	.description('Remove a saved playbook from an agent (find IDs via "list playbooks -a <agent>")')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, playbookId, options) => removePlaybook(agentId, playbookId, options));

// Cue commands - interact with Maestro Cue automation
const cue = encoreCommand(program, 'cue', 'maestroCue', encoreFlags).description(
	'Interact with Maestro Cue automation'
);

cue
	.command('trigger <subscription-name>')
	.description(
		'Manually trigger a Cue subscription by name (pipeline siblings with identical trigger settings fire too)'
	)
	.option('-p, --prompt <text>', 'Override the subscription prompt with custom text')
	.option('--json', 'Output as JSON (for scripting)')
	.option('--source-agent-id <id>', 'Agent ID to pass as source context for write-back')
	.option(
		'--data-dir <path>',
		'Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)'
	)
	.action(cueTrigger);

cue
	.command('list')
	.description('List all Cue subscriptions across agents')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueList);

// Read or change the model one subscription runs on. No setting flag = read.
// Works with the desktop app closed; the engine's YAML watcher picks it up.
cue
	.command('model <subscription-name>')
	.description(
		'Show or set the model tier, exact model, and effort a Cue subscription runs at (no setting flag = show)'
	)
	.option('-a, --agent <id-or-name>', 'Scope to one agent (required when the name exists on two)')
	.option('--tier <level>', 'Model tier: low, medium, high (mapped per provider)')
	.option('--model <id>', 'Exact model id (instead of --tier)')
	.option('--effort <level>', 'Effort: low, medium, high (mapped per provider)')
	.option('--clear-model', "Remove the tier / model and use the agent's own model")
	.option('--clear-effort', "Remove the effort and use the agent's own effort")
	.option('--json', 'Output as JSON (for scripting)')
	.option(
		'--data-dir <path>',
		'Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)'
	)
	.action(cueModel);

cue
	.command('enable <subscription>')
	.description('Turn a Cue subscription on (name, or the full id from `cue list --json`)')
	.option('-a, --agent <id>', 'Disambiguate a name several agents share')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueEnable);

cue
	.command('disable <subscription>')
	.description('Turn a Cue subscription off without deleting it')
	.option('-a, --agent <id>', 'Disambiguate a name several agents share')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueDisable);

// Cue gate - the pipeline editor's Gate field: a plain-language condition the
// Local Models `cue-gate` task checks before an event starts a run. With no
// flag it prints the gate, so a write can be read back.
cue
	.command('gate <subscription>')
	.description(
		"Show, set, or remove a subscription's gate (a condition a local model checks before a run starts)"
	)
	.option('--set <condition>', 'Set the gate: a condition the event must meet, in plain language')
	.option(
		'--on-unavailable <policy>',
		'When no model can answer: run (start the run and warn; default) or skip'
	)
	.option('--clear', 'Remove the gate')
	.option('-a, --agent <id>', 'Disambiguate a name several agents share')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueGate);

// Cue screen - the pipeline editor's injection screen field: whether the
// Local Models `injection-screen` task scores the untrusted text a
// subscription substitutes before a run starts. With no flag it prints the
// screen, so a write can be read back.
cue
	.command('screen <subscription>')
	.description(
		"Show or set a subscription's prompt-injection screen (a local classifier scores untrusted text before a run starts)"
	)
	.option(
		'--mode <mode>',
		'on (always screen), off (never), or auto (screen commands that use untrusted text; default)'
	)
	.option(
		'--threshold <score>',
		'Block at or above this score, above 0 and at most 1 (default 0.8)'
	)
	.option('-a, --agent <id>', 'Disambiguate a name several agents share')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueScreen);

cue
	.command('activity')
	.description('Show recent Cue runs, newest first')
	.option('-a, --agent <id>', 'Only runs for this agent')
	.option('-n, --limit <n>', 'How many runs to show (default 20)')
	.option('--json', 'Output as JSON (for scripting)')
	.option(
		'--data-dir <path>',
		'Data directory to read cue.db from when the app is not running (default: MAESTRO_USER_DATA or the platform default)'
	)
	.action(cueActivity);

// Cue schedule - author / inspect / edit / cancel Scheduled Tasks (the
// clock-driven subscriptions: time.once, time.scheduled, time.heartbeat).
// Primary agent surface for "in 20 minutes do X", "remind me at 4pm…", and
// "every weekday at 9am…" - writes directly to the agent's `.maestro/cue.yaml`
// so it works without the desktop app running. The same tasks are listed and
// editable in the app under Maestro Cue → Scheduled Tasks. See
// `cue-schedule.ts` for the full flag matrix.
cue
	.command('schedule')
	.description('Create a scheduled task (or --list / --cancel / --reschedule / --pause)')
	.option('--in <duration>', 'One-shot: fire after a relative delay (e.g. 30s, 20m, 2h, 1d)')
	.option('--at <timestamp>', 'One-shot: fire at ISO-8601 timestamp or "YYYY-MM-DD HH:MM" (local)')
	.option('--daily-at <times>', 'Repeating: comma-separated HH:MM times (e.g. 09:00,17:30)')
	.option('--days <days>', 'Limit --daily-at to these days (e.g. mon,tue,wed,thu,fri)')
	.option('--every <duration>', 'Repeating: fire on an interval (e.g. 30m, 2h, 1d)')
	.option('--list', 'List scheduled tasks across agents')
	.option('--kind <kind>', 'Filter --list by kind: once, daily, interval, all (default: all)')
	.option('--cancel <name>', 'Cancel a scheduled task by name')
	.option('--reschedule <name>', 'Change when an existing task fires (pass the timing flag too)')
	.option('--pause <name>', 'Disable a task without deleting it')
	.option('--resume <name>', 'Re-enable a paused task')
	.option('-a, --agent <id-or-name>', 'Target agent (required when creating; scopes other modes)')
	.option(
		'-p, --prompt <text>',
		'Prompt to send when the task fires. With --auto-run: extra instructions for the run'
	)
	.option(
		'--auto-run <documents...>',
		"Launch an Auto Run of these .md documents (inside the agent's Auto Run folder) instead of sending a prompt. Kept on a failed launch"
	)
	.option('--reset-on-completion', 'With --auto-run: uncheck every task when the run finishes')
	.option('--loop', 'With --auto-run: re-run the documents once every task is checked off')
	.option('--max-loops <n>', 'With --auto-run: loop ceiling (implies --loop)')
	.option('--per-document', 'With --auto-run: one agent turn per document instead of one per task')
	.option('--ignore-model-hints', "With --auto-run: ignore the documents' MAESTRO:MODEL hints")
	.option('--no-auto-resume', 'With --auto-run: stay paused after an agent error')
	.option('--auto-resume-after <minutes>', 'With --auto-run: minutes between auto-resume attempts')
	.option('--max-auto-resumes <n>', 'With --auto-run: auto-resume attempt ceiling')
	.option(
		'--worktree-branch <name>',
		'With --auto-run: create a worktree on this branch when the run fires, and run there'
	)
	.option(
		'--worktree-agent <id-or-name>',
		'With --auto-run: run in this already-open worktree agent'
	)
	.option(
		'--worktree-path <path>',
		'With --auto-run: run in the worktree already on disk at this path'
	)
	.option(
		'--base-branch <ref>',
		'With a worktree flag: ref a new branch is cut from, and the pull request target'
	)
	.option('--create-pr', 'With a worktree flag: open a pull request when the run finishes')
	.option('--notify', 'Show a toast notification when the task fires')
	.option('--sticky', 'Make the notify toast sticky (requires --notify)')
	.option('-m, --message <text>', 'Body for the notify toast (defaults to label/prompt)')
	.option('-n, --name <name>', 'Custom subscription name (auto-generated when omitted)')
	.option('-l, --label <text>', 'Human-readable label (defaults to truncated prompt)')
	.option('--pipeline <name>', 'Pipeline name (default: Tasks)')
	.option('--grace-minutes <n>', 'Override the default 360-minute grace window')
	.option(
		'--tier <level>',
		'Model tier for the prompt run: low, medium, high (mapped per provider)'
	)
	.option(
		'--model <id>',
		'Exact model id for the prompt run (instead of --tier). With --auto-run: model for this run only'
	)
	.option(
		'--effort <level>',
		'Effort for the prompt run: low, medium, high (mapped per provider). With --auto-run: reasoning effort for this run only'
	)
	.option(
		'--keep-on-failure',
		'Keep the subscription on a failed/timed-out run (default: self-destructs on both success and failure)'
	)
	.option(
		'--gate <condition>',
		'Only run when a local model says the fire meets this condition (edit later with `cue gate`)'
	)
	.option(
		'--gate-on-unavailable <policy>',
		'With --gate, when no model can answer: run (default) or skip'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueSchedule);

// Cue pipeline subcommands - manage entries in cue-pipeline-layout.json.
// Designed for batch scaffolding (e.g. PowerShell scripts that bootstrap
// a fleet of project agents with a templated pipeline). All mutations go
// through the daemon so they don't race with the desktop app's own writes.
const cuePipeline = cue
	.command('pipeline')
	.description('Manage Cue pipeline layout entries (cue-pipeline-layout.json)');

cuePipeline
	.command('list')
	.description('List all pipelines in the layout file')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cuePipelineList);

cuePipeline
	.command('get <name>')
	.description('Print one pipeline entry as JSON to stdout')
	.option('--json', 'Output as JSON (default; flag kept for parity)')
	.action(cuePipelineGet);

cuePipeline
	.command('export <name>')
	.description('Alias for `get`: print one pipeline entry as JSON to stdout')
	.option('--json', 'Output as JSON (default; flag kept for parity)')
	.action(cuePipelineExport);

cuePipeline
	.command('add <name>')
	.description('Add a new pipeline entry from a JSON file')
	.requiredOption('--from <file>', 'JSON file with one pipeline entry (matches `get` output)')
	.option('--force', 'Replace any existing pipeline with the same name/id')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cuePipelineAdd);

cuePipeline
	.command('replace <name>')
	.description('Replace an existing pipeline entry from a JSON file')
	.requiredOption('--from <file>', 'JSON file with one pipeline entry (matches `get` output)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cuePipelineReplace);

cuePipeline
	.command('remove <name>')
	.description('Remove a pipeline entry by name or id')
	.option('--force', 'Suppress the no-op error when the pipeline is already absent')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cuePipelineRemove);

// Cue engine subcommands - run Maestro Cue unattended, without the desktop
// app, and inspect/control that runner. See `cue-engine.ts` for what the
// standalone engine can and cannot do relative to the desktop app's own
// instance, and `cue-engine-lock.ts` for the cross-process guard that keeps
// this from double-firing triggers alongside a desktop app left open.
const cueEngine = cue
	.command('engine')
	.description('Run Maestro Cue unattended (no desktop app) and control that runner');

cueEngine
	.command('start')
	.description(
		'Start the Cue engine in this process and block until Ctrl+C / stopped. Agents inherit the whole environment unless MAESTRO_SERVER_MODE=1 (set by the server unit and image), which passes only the server allowlist plus MAESTRO_SERVER_ENV_ALLOW and declared secrets'
	)
	.option('--json', 'Print machine-readable start/failure status')
	.option(
		'--data-dir <path>',
		'Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)'
	)
	.addOption(
		new Option(
			'--log-format <format>',
			'Log line format: text, or one JSON object per line on stderr'
		)
			.choices(['text', 'json'])
			.default('text')
	)
	.option(
		'--require-ready',
		'Refuse to start (exit 1, nothing armed) when the readiness check finds any gap; see "cue engine check"'
	)
	.option(
		'--status-port <port>',
		'Serve /healthz, /readyz and /status on 127.0.0.1 at this port (documented port: 7433). Off unless given',
		(value) => {
			try {
				return parseCliPort(value, '--status-port');
			} catch (err) {
				throw new InvalidArgumentError((err as Error).message);
			}
		}
	)
	.option(
		'--drain-timeout <seconds>',
		'On SIGTERM/SIGINT, let runs in flight finish for this long before stopping them; a second signal stops at once',
		(value) => {
			try {
				return parseCliSeconds(value, '--drain-timeout');
			} catch (err) {
				throw new InvalidArgumentError((err as Error).message);
			}
		},
		90
	)
	.option(
		'--notify-webhook <url>',
		'POST a JSON notice for every notify action and every expired agent login to this http(s) URL'
	)
	.action((opts) => cueEngineStart({ ...opts, version: cliVersion }));

cueEngine
	.command('check')
	.description(
		'Check that every agent, secret, workspace, cue.yaml and tool the engine needs is present, and that there is something to run; list every gap (exit 1 when not ready)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.option(
		'--data-dir <path>',
		'Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)'
	)
	.action(cueEngineCheck);

// Stopping takes a footprint away, so it still runs with Cue switched off: an
// engine started before the switch must not be left running unstoppable.
allowWhileEncoreOff(
	cueEngine
		.command('stop')
		.description('Stop a running standalone engine (refuses to signal a desktop-owned one)')
		.option('--json', 'Output as JSON (for scripting)')
		.option(
			'--data-dir <path>',
			'Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)'
		)
		.option('--wait-ms <ms>', 'How long to wait for the lock to clear after signaling', (v) =>
			parseInt(v, 10)
		)
		.action((opts) => cueEngineStop(opts))
);

cueEngine
	.command('status')
	.description('Report whether an engine is running and its last known heartbeat')
	.option('--json', 'Output as JSON (for scripting)')
	.option(
		'--data-dir <path>',
		'Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)'
	)
	.action(cueEngineStatus);

cueEngine
	.command('inspect')
	.description('List every agent with a readable .maestro/cue.yaml and its subscription counts')
	.option('--json', 'Output as JSON (for scripting)')
	.option(
		'--data-dir <path>',
		'Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)'
	)
	.action(cueEngineInspect);

// Bundle commands - pack a Cue pipeline or one agent into a portable zip, and
// import one. With the app running (and no --data-dir), export and import go
// through it, the same as the Cue modal's Bundles tab; otherwise they read and
// write the data directory directly.
const bundle = program
	.command('bundle')
	.description('Export, validate, inspect, and import portable Cue pipeline and agent bundles');

bundle
	.command('export')
	.description(
		'Export one Cue pipeline or one agent to a deterministic bundle zip. Refuses, writing nothing, when an exported cue.yaml would fail bundle validate'
	)
	.option('-a, --agent <id-or-name>', 'Export this agent (exclusive with --pipeline)')
	.option('-p, --pipeline <name>', 'Export this Cue pipeline (exclusive with --agent)')
	.option('-o, --output <path>', 'Zip to write (default: ./<name>.maestro-bundle.zip)')
	.option('--allow-inline-secrets', 'Export subscriptions that hold a literal webhook.secret')
	.option('--data-dir <path>', "Read Maestro's data from this directory instead of the default")
	.option('--created-at <iso>', 'Record this ISO-8601 time as the bundle creation time')
	.option('--no-claude-skills', 'Leave out Claude Code skills (.claude/skills)')
	.option('--no-claude-mcp', 'Leave out .mcp.json (exported with secrets as ${VAR} references)')
	.option(
		'--no-claude-memory',
		'Leave out CLAUDE.md and Claude auto memory (exported with secret-looking tokens redacted)'
	)
	.option('--no-cue', "Leave out the agent's Cue subscriptions (--agent only)")
	.option(
		'--exact',
		'Exact copy: also carry secret values, binary paths, SSH and other providers settings, and local folders, so an import on this machine restores the agent as it was. Do not share the file'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => bundleExport(cliVersion, options));

bundle
	.command('validate <bundle>')
	.description(
		'Check a bundle zip: file hashes both ways, cue.yaml, references, secrets, and engine version'
	)
	.option(
		'--check-env',
		'Also check that this machine supplies each required secret (systemd credential, /run/secrets file, or environment variable); missing or unusable ones are warnings'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((bundlePath, options) => bundleValidate(cliVersion, bundlePath, options));

bundle
	.command('inspect <bundle>')
	.description('Describe a bundle from its manifest and README without unpacking the rest')
	.option('--json', 'Output as JSON (for scripting)')
	.action(bundleInspect);

bundle
	.command('import <bundle>')
	.description(
		'Import a bundle into the running app, or with it closed into a data directory, plus local workspace folders. Prints the plan, shell commands included, before the first write'
	)
	.option(
		'-w, --workspace <key=path>',
		'Map a bundle workspace to its own local folder (repeatable, one per workspace)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option(
		'--agent-path <tool=path>',
		'Set the binary a provider runs, e.g. claude-code=/usr/local/bin/claude (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option('--data-dir <path>', 'Import into this Maestro data directory instead of the default')
	.option('--dry-run', 'Report everything the import would do, including conflicts; write nothing')
	.option('--force', 'Overwrite conflicting agents, subscriptions, playbooks, files, and paths')
	.option('-g, --group <id>', 'Put the agents the import creates in this Left Bar group')
	.option(
		'--no-local',
		"Ignore an exact copy's machine data (secret values, binary paths, SSH, folders)"
	)
	.option(
		'--reject-shell-commands',
		'Refuse the import, before anything is written, if any subscription runs a shell command'
	)
	.option('--json', 'Output as JSON (for scripting): one document, after the import')
	.action((bundlePath, options) => bundleImport(cliVersion, bundlePath, options));

// Director's Notes commands
const directorNotes = encoreCommand(
	program,
	'director-notes',
	'directorNotes',
	encoreFlags
).description("Director's Notes: unified history and AI synopsis");

directorNotes
	.command('history')
	.description('Show unified history across all agents')
	.option('-d, --days <n>', 'Lookback period in days (default: from app settings)')
	.option('-f, --format <type>', 'Output format: json, markdown, text (default: text)')
	.option('--filter <type>', 'Filter by entry type: auto, user, cue, agent')
	.option('-l, --limit <n>', 'Maximum entries to show (default: 100)')
	.option('--json', 'Output as JSON (shorthand for --format json)')
	.action(directorNotesHistory);

directorNotes
	.command('synopsis')
	.description('Generate AI synopsis of recent activity (requires running Maestro app)')
	.option('-d, --days <n>', 'Lookback period in days (default: from app settings)')
	.option('-f, --format <type>', 'Output format: json, markdown, text (default: text)')
	.option('--json', 'Output as JSON (shorthand for --format json)')
	.action(directorNotesSynopsis);

// Status command - check if Maestro desktop app is running and reachable
program
	.command('status')
	.description('Check if the Maestro desktop app is running and reachable')
	.option('--json', 'Output as JSON (for scripting)')
	.action(status);

// Version command - report the running app's version + build commit hash (the
// hash shown in the About modal), plus the CLI's own version.
program
	.command('version')
	.description("Show the running Maestro app's version and build commit hash")
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => version(cliVersion, options));

// Doctor command - diagnose connection, version skew, handler support, SSH config
program
	.command('doctor')
	.description('Diagnose CLI connectivity, version skew, and configuration')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => doctor(cliVersion, options));

// Host commands - run Maestro's runtime detached (no desktop) and control that process
const host = program
	.command('host')
	.description('Run the Maestro runtime detached, with no desktop app, and control it');

host
	.command('start')
	.description('Start a detached host that serves this data directory over the bridge')
	.option('--data-dir <path>', 'Maestro data directory (default: resolved like the desktop app)')
	.option('--dev', 'Use the development data directory')
	.option('--port <port>', 'Port to listen on (default: any free port)')
	.option(
		'--foreground',
		'Serve in this process instead of detaching (what the detached child runs)'
	)
	.option(
		'--stop-grace <seconds>',
		'On SIGTERM/SIGINT, wait this long for work in flight before stopping (default 30; 0 stops at once)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => hostStart(options, cliVersion));

host
	.command('status')
	.description('Report the host: pid, uptime, lock holder, Cue state, and work in flight')
	.option('--data-dir <path>', 'Maestro data directory (default: resolved like the desktop app)')
	.option('--dev', 'Use the development data directory')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => hostStatus(options));

host
	.command('stop')
	.description(
		'Stop the host (refuses while a turn, Auto Run or Cue run is in flight, unless --wait or --force)'
	)
	.option('--data-dir <path>', 'Maestro data directory (default: resolved like the desktop app)')
	.option('--dev', 'Use the development data directory')
	.option(
		'--wait [seconds]',
		'Wait for work in flight to finish (default 300s), then stop; never forces'
	)
	.option('--force', 'Stop even with work in flight; a run records how it ended first')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => hostStop(options));

// Completions command - emit a shell completion script (introspects the program)
program
	.command('completions <shell>')
	.description('Print a shell completion script (bash, zsh, or fish)')
	.action((shell: string) => completions(program, shell));

// Reference command - emit the full command reference (introspects the program)
program
	.command('reference')
	.description('Print the full command reference (Markdown, or --format json)')
	.option('--format <format>', 'Output format: md (default) or json')
	.option('--all', 'Include the commands of Encore Features that are switched off')
	.action((options) => reference(program, options));

// Create agent command - create a new agent in the Maestro desktop app
program
	.command('create-agent <name>')
	.description(
		"Create a new agent in the Maestro desktop app. With --group, the agent starts from that group's defaults (see group-settings); flags you pass take precedence"
	)
	.option(
		'-d, --cwd <path>',
		'Working directory for the agent (required, unless --group names a group whose defaults set one)'
	)
	.option('-t, --type <type>', `Agent type (${PICKABLE_AGENT_IDS.join(', ')})`, 'claude-code')
	.option(
		'-g, --group <id>',
		"Group to assign the agent to. The agent starts from the group's defaults (provider, model, environment variables, peers, ...), and every flag below overrides one"
	)
	.option(
		'--no-group-defaults',
		"Create a bare agent in --group, ignoring the group's defaults (no effect without --group)"
	)
	.option('--nudge <message>', 'Nudge message appended to every user message')
	.option('--new-session-message <message>', 'Message prefixed to first message in new sessions')
	.option('--custom-path <path>', 'Custom binary path for the agent')
	.option('--custom-args <args>', 'Custom CLI arguments for the agent')
	.option(
		'--env <KEY=VALUE>',
		'Environment variable (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option(
		'--model <model>',
		'Model override (e.g., sonnet, opus; "auto" lets the model router pick the tier and effort of each turn)'
	)
	.option('--effort <level>', 'Effort/reasoning level override')
	.option('--context-window <size>', 'Context window size in tokens')
	.option('--provider-path <path>', 'Custom provider path')
	.option('--ssh-remote <id>', 'SSH remote ID for remote execution')
	.option('--ssh-cwd <path>', 'Working directory override on SSH remote')
	.option(
		'--sync-history-to-remote <bool>',
		'Sync history entries to .maestro/history/ on the remote host (true/false; requires --ssh-remote)'
	)
	.option(
		'--auto-run-folder <path>',
		'Path to the agent Auto Run / playbooks folder (overrides the default <cwd>/.maestro/playbooks)'
	)
	.option(
		'--gateway-url <url|none>',
		"Local Models gateway: an HTTP proxy this agent's provider traffic goes through, set as its base-URL variable at launch. Set the Maestro token proxy mode afterwards with update-agent --proxy-mode"
	)
	.option(
		'--run-on <target>',
		"Where this agent's model runs: provider (the default), or <source id>:<model> for a model on a Local Models source (maestro-server for the Maestro model server; ids from models endpoints list). The agent keeps its provider's CLI"
	)
	.option(
		'--run-on-context <tokens>',
		"Context size the harness is told a --run-on source has (at least 40960; default: the model's catalog context on the Maestro model server, 40960 elsewhere)"
	)
	// The Peers tab of the New Agent dialog, spelled as on update-agent.
	.option(
		'--peer <agent:access>',
		'Set one explicit peer row (repeatable): <agent>:r (consult), :w (delegate), :rw, or :none (exclude the peer from a group or worktree grant)',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--peer-note <agent:text>',
		'Set the note on a peer row, the hint the agent reads for when to reach it (repeatable; needs a row)',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--group-peers <r|w|rw|off>',
		'Grant access to every other agent in the same group, resolved live'
	)
	.option(
		'--worktree-peers <r|w|rw|off>',
		"Grant access to the agent's worktree family, resolved live"
	)
	.option('--background', 'Create the agent without selecting it (Left Bar selection stays put)')
	.option('--focus', 'Select the new agent after creating it (default)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((name, options, command) =>
		createAgent(name, {
			...options,
			// `--type` carries a default, so only its source says whether it was typed.
			typeExplicit: command.getOptionValueSource('type') !== 'default',
		})
	);

// Folders, standard icons and label colors belong to Groups+: their options are
// left out of --help while it is off, and passing one then is refused.
const GROUPS_PLUS_OPTION_KEYS = [
	'icon',
	'color',
	'parent',
	'clearIcon',
	'clearColor',
	'clearParent',
] as const;
const groupsPlusOption = (flags: string, description: string): Option =>
	new Option(flags, description).hideHelp(!encoreFlags.groupsPlus);

// Create group command - create a new group in the Maestro desktop app
program
	.command('create-group <name>')
	.description('Create a new group in the Maestro desktop app')
	.option('-e, --emoji <emoji>', 'Emoji icon for the group')
	.addOption(
		groupsPlusOption(
			'--icon <icon-id>',
			'Built-in icon ID (folder, briefcase, rocket, ...) or a plugin icon ID. Mutually exclusive with --emoji'
		)
	)
	.addOption(groupsPlusOption('--color <color>', 'Label color as #RRGGBB, or a plugin color ID'))
	.addOption(groupsPlusOption('--parent <group-id>', 'Create inside this root group'))
	.option('--json', 'Output as JSON (for scripting)')
	.hook('preAction', (_command, action) =>
		requireEncoreForOptions('groupsPlus', action.opts(), GROUPS_PLUS_OPTION_KEYS)
	)
	.action(createGroup);

// Remove group command - delete a group from the Maestro desktop app. Agents
// inside are ungrouped, not deleted. Refuses a non-empty group without --force.
program
	.command('remove-group <group-id>')
	.description(
		'Remove a group from the Maestro desktop app (agents inside are ungrouped, not deleted)'
	)
	.option('-f, --force', 'Delete even if the group still has agents (ungroups them)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(removeGroup);

// Rename group command - change a group's name in the desktop app
program
	.command('rename-group <group-id> <new-name>')
	.description('Rename a group in the Maestro desktop app')
	.option('--json', 'Output as JSON (for scripting)')
	.action((groupId, newName, options) => renameGroup(groupId, newName, options));

// Update group command - change a group's name, appearance, or parent. Covers
// everything the Left Bar's group editor does; rename-group stays for
// backward compatibility.
program
	.command('update-group <group-id>')
	.description(
		"Update a group's name, icon, color, parent, or Left Bar visibility in the Maestro desktop app"
	)
	.option('-n, --name <name>', 'New group name')
	.option('-e, --emoji <emoji>', 'Emoji icon for the group. Mutually exclusive with --icon')
	.addOption(
		groupsPlusOption(
			'--icon <icon-id>',
			'Built-in icon ID (folder, briefcase, rocket, ...) or a plugin icon ID. Mutually exclusive with --emoji'
		)
	)
	.addOption(groupsPlusOption('--color <color>', 'Label color as #RRGGBB, or a plugin color ID'))
	.addOption(groupsPlusOption('--parent <group-id>', 'Move the group inside this root group'))
	.option('--clear-emoji', 'Reset the emoji to the default folder')
	.addOption(groupsPlusOption('--clear-icon', 'Remove the icon'))
	.addOption(groupsPlusOption('--clear-color', 'Remove the label color'))
	.addOption(groupsPlusOption('--clear-parent', 'Promote the group to the top level'))
	.option(
		'--hide',
		'Park the group out of the Left Bar. Its agents stay reachable through search and the switcher'
	)
	.option('--show', 'Bring a hidden group back into the Left Bar')
	.option('--json', 'Output as JSON (for scripting)')
	.hook('preAction', (_command, action) =>
		requireEncoreForOptions('groupsPlus', action.opts(), GROUPS_PLUS_OPTION_KEYS)
	)
	.action((groupId, options) => updateGroup(groupId, options));

// Delegation commands - the fleet's peer relationships read as one graph, the
// model the Delegation Graph draws. Read only: an edge is written with
// `update-agent --peer` / `--remove-peer`, and `open delegation-graph` shows
// the canvas.
const delegation = program
	.command('delegation')
	.description('Read which agents may consult or delegate to which (the Delegation Graph)');

delegation
	.command('graph')
	.description(
		'Print the Delegation Graph: every agent, whom it may consult or delegate to, and who reaches it'
	)
	.option(
		'-g, --group <id>',
		'Only one agent group, and the agents outside it that an edge joins to it'
	)
	.option('--json', 'Output the graph model (nodes and edges) as JSON')
	.action(delegationGraph);

// Group settings commands - the Group Settings dialog: the defaults a new agent
// created in a group starts with (copy-at-create; never a runtime layer), and
// the group's pill label. `group-settings` reads, `update-group-settings` writes.
program
	.command('group-settings <group-id>')
	.description(
		"Show a group's defaults (what a new agent in it starts with) and its Left Bar pill label"
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((groupId, options) => groupSettings(groupId, options));

program
	.command('update-group-settings <group-id>')
	.description(
		"Set a group's defaults for new agents and its pill label (requires the desktop app). Existing agents change only with --publish"
	)
	.option(
		'--provider <type>',
		'Default provider for new agents (use "none" for no default; switching resets the profile\'s provider-bound values)'
	)
	.option('-d, --cwd <path>', 'Default working directory (empty string clears)')
	.option('--nudge <message>', 'Nudge message appended to every message (empty string clears)')
	.option(
		'--new-session-message <message>',
		'Message prefixed to the first message of new sessions (empty string clears)'
	)
	.option('--custom-path <path>', 'Override the agent binary path (empty string clears)')
	.option('--custom-args <args>', 'Custom CLI arguments for the agent (empty string clears)')
	.option(
		'--env <KEY=VALUE>',
		'Set an environment variable (repeatable; replaces the env map)',
		(value: string, prev: string[]) => [...(prev ?? []), value],
		[] as string[]
	)
	.option('--clear-env', 'Clear all environment variable defaults')
	.option(
		'--gateway-url <url|none>',
		'Local Models gateway URL ("none" clears). Not combinable with --proxy-mode'
	)
	.option(
		'--run-on <target>',
		'Where new agents run their model: provider, or <source id>:<model> on a Local Models source'
	)
	.option(
		'--run-on-context <tokens>',
		'Context size the harness is told the Run on source has (at least 40960)'
	)
	.option(
		'--proxy-mode <mode>',
		'Maestro token proxy for new agents: off | passthrough | compress | compress-early'
	)
	.option(
		'--tier <tier=target>',
		'Where a low, medium or high task launches (repeatable): low=<source id>:<model>, high=provider:<model>, medium=provider, or low=default',
		(value: string, prev: string[]) => [...(prev ?? []), value],
		[] as string[]
	)
	.option(
		'--background-requests <target>',
		'Where the token proxy sends side requests: <source id>:<model>, or none'
	)
	.option(
		'--system-one <on|off>',
		'Whether new agents may ask System One: off switches it off for them'
	)
	.option(
		'--peer <agent:access>',
		'Set one explicit peer row (repeatable): <agent>:r, :w, :rw, or :none',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--peer-note <agent:text>',
		'Set the note on a peer row (repeatable; needs a row, empty text clears)',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--remove-peer <agent>',
		'Delete a peer row (repeatable). Not the same as :none',
		collectRepeatable,
		[] as string[]
	)
	.option('--group-peers <r|w|rw|off>', 'Grant access to every other agent in the same group')
	.option('--worktree-peers <r|w|rw|off>', "Grant access to the agent's worktree family")
	.option(
		'--model <model>',
		'Default model ("auto" lets the model router pick; empty string clears)'
	)
	.option('--effort <level>', 'Default effort/reasoning level (empty string clears)')
	.option('--context-window <size>', 'Default context window in tokens (0 or "none" clears)')
	.option(
		'--token-source <mode>',
		'Claude token source: api | tui | dynamic (needs the Claude Code provider)'
	)
	.option('--maestro-p-path <path>', 'Override the maestro-p binary path (empty string clears)')
	.option(
		'--codex-transport <transport>',
		'Codex transport: exec | app-server (needs the Codex provider)'
	)
	.option(
		'--ssh-remote <id>',
		'Default SSH remote for new agents, by id or name (use "none" for local execution)'
	)
	.option('--ssh-cwd <path>', 'Working directory override on the SSH remote')
	.option(
		'--sync-history-to-remote <bool>',
		'Sync history entries to .maestro/history/ on the remote host (true/false)'
	)
	.option(
		'--short-label <text>',
		"Text for the pill drawn beside the group's bookmarked agents, at most 12 characters (empty string returns to the automatic abbreviation). Display only: never copied or published"
	)
	.option(
		'--clear',
		'Remove the defaults entirely. Does not touch --short-label, which is group display state and not an agent default. Cannot be combined with other defaults or --publish'
	)
	.option(
		'--publish',
		"Also write this call's changes into the agents already in the group (provider, working directory and SSH remote are never written; env vars merge by key, lists replace). Needs --yes unless you answer a prompt"
	)
	.option('--yes', 'Confirm a --publish without asking')
	.option('--json', 'Output as JSON (for scripting)')
	.action((groupId, options) => updateGroupSettings(groupId, options));

// Create-worktree command - create a new agent in a git worktree off a parent
// agent, without an Auto Run playbook. The parent agent must already exist in
// the running desktop app.
program
	.command('create-worktree')
	.description('Create a new agent in a git worktree branched off an existing parent agent')
	.requiredOption(
		'-a, --agent <id>',
		'Parent agent ID the worktree branches from (use "maestro-cli list agents" to find IDs)'
	)
	.requiredOption(
		'-b, --branch <name>',
		'Branch name for the worktree (created if it does not exist)'
	)
	.option(
		'--base-branch <name>',
		'Ref the new branch is based on when it does not yet exist (e.g. "rc" or "main"). Defaults to the parent repo HEAD.'
	)
	.option(
		'-m, --message <text>',
		'Optional initial prompt to dispatch to the new agent after creation'
	)
	.option('--background', 'Create the agent without selecting it (Left Bar selection stays put)')
	.option('--focus', 'Select the new worktree agent after creating it (default)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(createWorktree);

// Remove agent command - remove an agent from the Maestro desktop app
program
	.command('remove-agent <agent-id>')
	.description('Remove an agent from the Maestro desktop app')
	.option('--json', 'Output as JSON (for scripting)')
	.action(removeAgent);

// Update agent command - mutate an existing agent's group and/or working
// directory in place. Pass `--group none` to ungroup. Cwd updates are
// refused while the agent process is alive (PTY cwd is fixed at spawn time).
program
	.command('update-agent <agent-id>')
	.description("Update an existing agent's group, working directory, and per-agent settings")
	.option(
		'-g, --group <id>',
		'Move the agent to this group (use "none" to ungroup; supports partial IDs)'
	)
	.option(
		'-d, --cwd <path>',
		"Change the agent's working directory (resolved to absolute; agent must be stopped)"
	)
	.option(
		'--ssh-remote <id>',
		'Set the SSH remote for remote execution (use "none" to revert to local; agent must be stopped)'
	)
	.option('--ssh-cwd <path>', 'Working directory override on the SSH remote')
	.option(
		'--sync-history-to-remote <bool>',
		'Sync history entries to .maestro/history/ on the remote host (true/false)'
	)
	// Editable per-agent settings (the Edit Agent modal). Pass an empty string to
	// clear a text field (e.g. --nudge "").
	.option('--nudge <message>', 'Nudge message appended to every message (empty string clears)')
	.option(
		'--new-session-message <message>',
		'Message prefixed to the first message of new sessions (empty string clears)'
	)
	.option('--custom-path <path>', 'Override the agent binary path (empty string clears)')
	.option('--custom-args <args>', 'Custom CLI arguments for the agent (empty string clears)')
	.option(
		'--env <KEY=VALUE>',
		'Set an environment variable (repeatable; replaces the env map)',
		(value: string, prev: string[]) => [...(prev ?? []), value],
		[] as string[]
	)
	.option('--clear-env', 'Clear all per-agent environment variables')
	.option(
		'--gateway-url <url|none>',
		'Local Models gateway: an HTTP proxy this agent\'s provider traffic goes through, set as its base-URL variable at launch ("none" clears)'
	)
	.option(
		'--run-on <target>',
		"Where this agent's model runs: provider (its provider's own model; clears a target), or <source id>:<model> for a model on a Local Models source (maestro-server for the Maestro model server; ids from models endpoints list). Check it with agent test-run-on"
	)
	.option(
		'--run-on-context <tokens>',
		"Context size the harness is told the Run on source has (at least 40960). Alone, it changes the context of the agent's current target"
	)
	.option(
		'--proxy-mode <mode>',
		'Maestro token proxy for this agent: off | passthrough | compress | compress-early. Any mode but off points the gateway at the proxy; off clears it. compress shortens a tool result after the model has read it once; compress-early shortens it before, which is cheaper and means the model works from the shortened output (requires the desktop app)'
	)
	.option(
		'--tier <tier=target>',
		"Where a low, medium or high task of this agent launches (repeatable): low=<source id>:<model>, high=provider:<model>, medium=provider (the provider, on the agent's own model), or low=default to follow the harness default again. Read them with show agent",
		(value: string, prev: string[]) => [...(prev ?? []), value],
		[] as string[]
	)
	.option(
		'--background-requests <target>',
		"Where the Maestro token proxy sends this agent's side requests (titles, summaries): <source id>:<model> for a model on a source that serves the Anthropic Messages route, or none. Claude Code agents on the token proxy only"
	)
	.option(
		'--system-one <on|off>',
		'Whether this agent may ask System One with maestro-cli s1: off switches it off for this agent only, on follows "Let agents use System One" (default on)'
	)
	// The Peers tab. An agent is named by id, unique id prefix, or display name.
	.option(
		'--peer <agent:access>',
		'Set one explicit peer row (repeatable): <agent>:r (consult), :w (delegate), :rw, or :none (exclude the peer from a group or worktree grant)',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--peer-note <agent:text>',
		'Set the note on a peer row, the hint the agent reads for when to reach it (repeatable; needs a row, empty text clears)',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--remove-peer <agent>',
		'Delete a peer row (repeatable). Not the same as :none: a deleted row lets the group and worktree grants apply again',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--group-peers <r|w|rw|off>',
		'Grant access to every other agent in the same group, resolved live (off clears)'
	)
	.option(
		'--worktree-peers <r|w|rw|off>',
		"Grant access to the agent's worktree family: parent, sibling and child worktrees, resolved live (off clears)"
	)
	.option(
		'--model <model>',
		'Model override (e.g. sonnet, opus; "auto" lets the model router pick per turn; empty string clears)'
	)
	.option('--effort <level>', 'Effort/reasoning level override (empty string clears)')
	.option('--context-window <size>', 'Context window size in tokens (0 or "none" clears)')
	.option(
		'--token-source <mode>',
		'Claude token source: api | tui | dynamic (Claude Code agents only)'
	)
	.option('--maestro-p-path <path>', 'Override the maestro-p binary path (empty string clears)')
	.option(
		'--codex-transport <transport>',
		'Codex transport: exec | app-server (experimental, enables steering; Codex only)'
	)
	.option('--bookmark <bool>', 'Bookmark the agent in the Left Bar (true/false)')
	// Agent Resilience and the rest of the Edit Agent dialog.
	.option(
		'--retry-on-availability <bool>',
		'Agent Resilience: resend a turn the provider refused as overloaded (true/false; "default" drops the choice, which is on)'
	)
	.option(
		'--retry-on-token-exhaustion <bool>',
		'Agent Resilience: resend a turn refused for a spent quota once it resets (true/false; "default" drops the choice, which is on)'
	)
	.option(
		'--codex-auto-reset <bool>',
		'Spend a Codex rate-limit reset credit when the quota is exhausted (true/false; "default" drops the choice; Codex only)'
	)
	.option(
		'--additional-dir <path[:access]>',
		'A directory outside the working directory the agent may use (repeatable; replaces the list): <path> is read-only, <path>:rw adds write',
		collectRepeatable,
		[] as string[]
	)
	.option('--clear-additional-dirs', 'Remove every additional directory')
	.option(
		'--env-park <KEY>',
		'Switch an environment variable off without deleting it (repeatable): kept and editable, never spawned with',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--env-unpark <KEY>',
		'Switch a parked environment variable back on (repeatable)',
		collectRepeatable,
		[] as string[]
	)
	.option(
		'--share-history-to-project-dir <bool>',
		"Mirror History entries into the local project's .maestro/history/ (true/false; for an agent another Maestro controls; agent must be stopped)"
	)
	.option(
		'--provider <type>',
		'Switch to another provider; tabs keep their transcripts and start fresh conversations there'
	)
	.option(
		'--convert',
		'With --provider: also convert owned conversations and selected project knowledge (opt-in; implied by the translation options below)'
	)
	.option(
		'--project-resources',
		'Install native project resources and add local git exclude entries'
	)
	.option('--force', 'Alias for --accept-translation-limitations')
	.option('--dry-run', 'Plan provider migration without native writes (requires --provider)')
	.option(
		'--accept-translation-limitations',
		'Accept the reported unverified or partial conversion limitations'
	)
	.option('--migration <action>', 'Migration operation: plan | apply | status | recover | rollback')
	.option(
		'--migration-plan <id>',
		'Use the reviewed plan or inspect/recover a specific operation ID'
	)
	.option(
		'--translation-resource <path>',
		'Select one user-level resource (repeatable; no account-global import)',
		(value: string, previous: string[]) => [...previous, value],
		[]
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(updateAgent);

// Agent verbs that act on one agent and are not a setting of it.
const agentCmd = program.command('agent').description('Act on one agent');

agentCmd
	.command('test-run-on <agent-id>')
	.description(
		"Send one short read-only turn through the agent's harness on its Run on target and report the reply (requires the desktop app)"
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, options) => agentTestRunOn(agentId, options));

// Rename agent command - change an agent's display name in the desktop app
program
	.command('rename-agent <agent-id> <new-name>')
	.description('Rename an agent in the Maestro desktop app')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, newName, options) => renameAgent(agentId, newName, options));

// Bookmark commands - pin/unpin an agent in the Left Bar's Bookmarks section.
// Mirrors the "Add Bookmark" context-menu item and Cmd+Shift+B. These are
// explicit set operations, not a toggle, so re-running is idempotent.
program
	.command('bookmark <agent-id>')
	.description("Bookmark an agent (pins it to the Left Bar's Bookmarks section)")
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, options) => setBookmark(agentId, true, options));

program
	.command('unbookmark <agent-id>')
	.description("Remove an agent's bookmark")
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, options) => setBookmark(agentId, false, options));

// Focus agent command - select/focus an agent (and optionally a tab) in the UI
program
	.command('focus-agent <agent-id>')
	.description('Focus (select) an agent in the Maestro desktop UI')
	.option('--tab <tab-id>', 'Also focus this tab within the agent')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, options) => focusAgent(agentId, options));

// Switch mode command - toggle an agent between AI and terminal mode
program
	.command('switch-mode <agent-id> <mode>')
	.description('Switch an agent between "ai" and "terminal" mode')
	.option(
		'--background',
		'Refuse the switch if the agent is the one on screen, rather than changing what the user is looking at'
	)
	.option('--focus', 'Switch even when the agent is the one on screen (default)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, mode, options) => switchMode(agentId, mode, options));

// Tab commands - manage an agent's AI tabs in the desktop app. Every verb that
// takes <tab-id> also accepts the literal "active" (with -a to say whose).
const tab = program
	.command('tab')
	.alias('tabs')
	.description("Manage an agent's tabs in the desktop app");

/**
 * Options every tab-targeted verb shares: --agent disambiguates the "active"
 * tab id, --json switches to machine output. Registered once so a new verb
 * can't quietly ship without them.
 */
const tabTargetOptions = (cmd: Command): Command =>
	cmd
		.option('-a, --agent <id>', 'Whose active tab, when <tab-id> is "active"')
		.option('--json', 'Output as JSON (for scripting)');

tab
	.command('new')
	.description('Open a new tab for an agent (optionally seeded with a prompt)')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('-p, --prompt <text>', 'Seed the new AI tab with this prompt')
	.option('--background', 'Create the tab without moving the view (agent and tab stay put)')
	.option('--focus', 'Switch to the new tab after creating it (default)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => tabNew(options));

tabTargetOptions(tab.command('close <tab-id>'))
	.description('Close a tab (owning agent is resolved automatically)')
	.action((tabId, options) => tabClose(tabId, options));

tabTargetOptions(tab.command('rename <tab-id> <new-name>'))
	.description('Rename a tab')
	.action((tabId, newName, options) => tabRename(tabId, newName, options));

tabTargetOptions(tab.command('star <tab-id>'))
	.description('Star a tab')
	.action((tabId, options) => tabStar(tabId, true, options));

tabTargetOptions(tab.command('unstar <tab-id>'))
	.description('Unstar a tab')
	.action((tabId, options) => tabStar(tabId, false, options));

tabTargetOptions(tab.command('unread <tab-id>'))
	.description('Mark a tab unread (flags it for the human in the tab bar)')
	.action((tabId, options) => tabUnread(tabId, true, options));

tabTargetOptions(tab.command('read <tab-id>'))
	.description("Clear a tab's unread marker")
	.action((tabId, options) => tabUnread(tabId, false, options));

/**
 * Read a boolean tab argument, or exit with the same message every verb uses.
 * `parseCliBool` throws; the tab verbs are the only place that wants that
 * turned into a plain exit before the desktop is ever contacted.
 */
function tabBoolArg(value: string, label: string): boolean {
	try {
		return parseCliBool(value, label);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return exitWith(ExitCode.GeneralError);
	}
}

tabTargetOptions(tab.command('save-to-history <tab-id> <bool>'))
	.description("Enable/disable synopsizing this tab's completions into History (true/false)")
	.action((tabId, bool, options) =>
		tabSaveToHistory(tabId, tabBoolArg(bool, 'save-to-history'), options)
	);

tabTargetOptions(tab.command('show <tab-id>'))
	.description("Show one tab's settings (model, effort, thinking, access, history)")
	.action((tabId, options) => tabShow(tabId, options));

tabTargetOptions(tab.command('thinking <tab-id> <mode>'))
	.description('Set the thinking display: off, on, sticky, or cycle')
	.action((tabId, mode, options) => {
		const v = String(mode).trim().toLowerCase();
		if (v !== 'cycle' && asThinkingMode(v) === undefined) {
			console.error(`Invalid mode "${mode}". Use off, on, sticky, or cycle.`);
			exitWith(ExitCode.GeneralError);
		}
		return tabThinking(tabId, v as ThinkingMode | 'cycle', options);
	});

tabTargetOptions(tab.command('read-only <tab-id> <bool>'))
	.description('Put the tab in read-only/plan mode so the agent cannot modify files')
	.action((tabId, bool, options) => tabReadOnly(tabId, tabBoolArg(bool, 'read-only'), options));

tabTargetOptions(tab.command('model <tab-id> <model>'))
	.description(
		'Override the model for this tab ("inherit" clears the override; "auto" lets the model router pick the tier and effort of each turn)'
	)
	.action((tabId, model, options) =>
		tabModel(tabId, isInheritValue(model) ? null : model, options)
	);

tabTargetOptions(tab.command('effort <tab-id> <level>'))
	.description('Override the effort/reasoning level for this tab ("inherit" clears it)')
	.action((tabId, level, options) =>
		tabEffort(tabId, isInheritValue(level) ? null : level, options)
	);

tabTargetOptions(tab.command('enter-to-send <tab-id> <bool>'))
	.description('Per-tab send key: true = Enter, false = Cmd+Enter, "inherit" = global setting')
	.action((tabId, bool, options) =>
		tabEnterToSend(tabId, isInheritValue(bool) ? null : tabBoolArg(bool, 'enter-to-send'), options)
	);

tabTargetOptions(tab.command('move <tab-id> <position>'))
	.description('Move a tab to a position in its agent\'s tab bar (0-based, or "first"/"last")')
	.action((tabId, position, options) => tabMove(tabId, position, options));

// Read-only: the CLI half of the Tab Cleanup Suggestions modal. It prints what
// the Tab cleanup assignment suggests and the verb that applies each one.
tab
	.command('suggest-cleanup')
	.description(
		'Suggest tabs to close, snooze, or wake across every agent (read-only; uses the Tab cleanup Local Models assignment)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(tabSuggestCleanup);

// Create SSH remote command - add a new SSH remote configuration
program
	.command('create-ssh-remote <name>')
	.description('Create a new SSH remote configuration')
	.requiredOption(
		'-H, --host <host>',
		'SSH hostname or IP (or SSH config Host pattern with --ssh-config)'
	)
	.option('-p, --port <port>', 'SSH port (default: 22)')
	.option('-u, --username <user>', 'SSH username')
	.option('-k, --key <path>', 'Path to private key file')
	.option(
		'--env <KEY=VALUE>',
		'Remote environment variable (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option(
		'--ssh-option <KEY=VALUE>',
		'Extra ssh -o option, e.g. ProxyCommand=... or ConnectTimeout=45 (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option('--ssh-config', 'Use ~/.ssh/config for connection settings (host becomes Host pattern)')
	.option('--disabled', 'Create in disabled state')
	.option('--set-default', 'Set as the global default SSH remote')
	.option('--json', 'Output as JSON (for scripting)')
	.action(createSshRemote);

// Update SSH remote command - edit an existing SSH remote configuration
program
	.command('update-ssh-remote <remote-id>')
	.description('Update an existing SSH remote configuration')
	.option('-n, --name <name>', 'Display name')
	.option('-H, --host <host>', 'SSH hostname, IP, or SSH config Host pattern')
	.option('-p, --port <port>', 'SSH port')
	.option('-u, --username <user>', 'SSH username (empty string clears it)')
	.option('-k, --key <path>', 'Path to private key file (empty string clears it)')
	.option(
		'--env <KEY=VALUE>',
		'Remote environment variable, merged with existing (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option('--clear-env', 'Remove all remote environment variables before applying --env')
	.option(
		'--disable-env <KEY>',
		'Switch an env var off, keeping its value (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option(
		'--enable-env <KEY>',
		'Switch a previously disabled env var back on (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option(
		'--ssh-option <KEY=VALUE>',
		'Extra ssh -o option, merged with existing (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option('--clear-ssh-options', 'Remove all extra ssh -o options before applying --ssh-option')
	.option(
		'--disable-ssh-option <KEY>',
		'Switch an ssh -o option off, keeping its value (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option(
		'--enable-ssh-option <KEY>',
		'Switch a previously disabled ssh -o option back on (repeatable)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[]
	)
	.option('--ssh-config <bool>', 'Use ~/.ssh/config for connection settings (true/false)')
	.option('--enabled <bool>', 'Enable or disable this remote (true/false)')
	.option('--set-default', 'Set as the global default SSH remote')
	.option('--json', 'Output as JSON (for scripting)')
	.action(updateSshRemote);

// Remove SSH remote command - delete an SSH remote configuration
program
	.command('remove-ssh-remote <remote-id>')
	.description('Remove an SSH remote configuration')
	.option('--json', 'Output as JSON (for scripting)')
	.action(removeSshRemote);

// Test SSH remote command - dial a configured remote and report the result
program
	.command('test-ssh-remote <remote-id>')
	.description('Test an SSH remote connection and report what the remote answered')
	.option('-a, --agent <command>', 'Also check whether this binary is on the remote PATH')
	.option('--timeout <seconds>', 'Give up after this many seconds', Number, 60)
	.option('--json', 'Output as JSON (for scripting)')
	.action(testSshRemote);

// Display / typography commands
//
// Addressed by SURFACE rather than by settings key: `settings set` can already
// write these ten keys, but only if you know their names and the
// Display / typography commands
//
// Addressed by SURFACE rather than by settings key: `settings set` can already
// write these twelve keys, but only if you know their names and the
// empty-string-means-inherit convention. These validate against the shared
// registry, so a scripted setup can put the app in a known typographic state.
const display = program
	.command('display')
	.description('View and manage typography (fonts, sizes, zoom)');

display
	.command('font [surface] [value]')
	.description(
		'Get or set a surface font. Surfaces: interface, terminal, chat, filePreview, documentGraph, fileEditor. Pass "inherit" (or "inherit:terminal") to follow a root surface. Omit the surface to list all.'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((surface: string | undefined, value: string | undefined, options: { json?: boolean }) => {
		if (!surface) displayFontList(options);
		else displayFont(surface, value, options);
	});

display
	.command('size <surface> [value]')
	.description('Get or set a surface font size in px. Pass "inherit" to follow the interface size.')
	.option('--json', 'Output as JSON (for scripting)')
	.action(displayFontSize);

display
	.command('zoom [level]')
	.description('Get or set the global zoom applied to every surface (e.g. 125% or 1.25)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(displayZoom);

display
	.command('preset [name]')
	.description(
		'Get the active typography preset, or reset every font and size to one (default | hacker)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(displayPreset);

display
	.command('fonts')
	.description('List the fonts bundled with Maestro (guaranteed available on any machine)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(displayFontsCatalog);

// Settings commands
const settings = program.command('settings').description('View and manage Maestro configuration');

settings
	.command('list')
	.description('List all settings with current values')
	.option('--json', 'Output as JSON lines (for scripting)')
	.option('-v, --verbose', 'Show descriptions for each setting (useful for LLM context)')
	.option('--keys-only', 'Show only setting key names')
	.option('--defaults', 'Show default values alongside current values')
	.option('-c, --category <name>', 'Filter by category (e.g., appearance, shell, editor)')
	.option('--show-secrets', 'Show sensitive values like API keys (masked by default)')
	.action(settingsList);

settings
	.command('get <key>')
	.description(
		'Get the value of a setting (supports dot-notation, e.g., encoreFeatures.directorNotes)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.option('-v, --verbose', 'Show full details including description, type, and default')
	.action(settingsGet);

settings
	.command('set <key> <value>')
	.description('Set a setting value (auto-detects type: bool, number, JSON, string)')
	.option('--json', 'Output as JSON (for scripting)')
	.option('--raw <json>', 'Pass an explicit JSON value (bypasses auto type coercion)')
	.action(settingsSet);

settings
	.command('reset <key>')
	.description('Reset a setting to its default value')
	.option('--json', 'Output as JSON (for scripting)')
	.action(settingsReset);

settings
	.command('media-status')
	.description('Report media tools available to this CLI process and allowed models as JSON')
	.option('--json', 'Output as JSON (this verb always does; accepted so every verb takes --json)')
	.action(settingsMediaStatus);

// Agent-specific config subcommands
const agent = settings.command('agent').description('View and manage per-agent configuration');

agent
	.command('list [agent-id]')
	.description(
		'List provider configurations (all, or one provider type), or the settings of one agent when given an agent ID'
	)
	.option('--json', 'Output as JSON lines (for scripting)')
	.option('-v, --verbose', 'Show descriptions for each config key')
	.action(settingsAgentList);

agent
	.command('get <agent-id> <key>')
	.description(
		'Get a provider config value, or one setting of an agent when given an agent ID (e.g. codexTransport)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.option('-v, --verbose', 'Show full details including description')
	.action(settingsAgentGet);

agent
	.command('set <agent-id> <key> <value>')
	.description('Set an agent config value (auto-detects type)')
	.option('--json', 'Output as JSON (for scripting)')
	.option('--raw <json>', 'Pass an explicit JSON value (bypasses auto type coercion)')
	.action(settingsAgentSet);

agent
	.command('reset <agent-id> <key>')
	.description('Remove an agent config key')
	.option('--json', 'Output as JSON (for scripting)')
	.action(settingsAgentReset);

// Set theme command - switch the active theme live (ergonomic wrapper over the
// activeThemeId setting with validation + discovery).
program
	.command('set-theme [name-or-id]')
	.description('Switch the active Maestro theme (applies live). Use --list to see options.')
	.option('-l, --list', 'List available themes')
	.option('--json', 'Output as JSON (for scripting)')
	.action((nameOrId, options) => setTheme(nameOrId, options));

// Gloss command - how much light the app chrome catches (the themeGloss
// setting). Mirrors Settings -> Themes -> Surface Gloss. Prints the current
// level when called with no argument.
program
	.command('gloss [level]')
	.description(
		'Set the surface gloss level: off, sheen, strong or max (applies live). Omit the level to see the current one.'
	)
	.option('-l, --list', 'List the gloss levels and what each one does')
	.option('--json', 'Output as JSON (for scripting)')
	.action((level, options) => gloss(level, options));

// Theme commands - manage the user-configurable "Custom" theme palette
// (the customThemeColors / customThemeBaseId settings). Mirrors the in-app
// Custom Theme Builder; export files round-trip with the UI. Activate the
// result with "set-theme custom" (or the --activate flag on import/set).
const theme = program.command('theme').description('Manage the custom theme palette');

theme
	.command('show')
	.description('Print the current custom theme palette and base (reads from disk)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => themeShow(options));

theme
	.command('export')
	.description('Export the custom theme as portable JSON (stdout, or --file <path>)')
	.option('-f, --file <path>', 'Write the theme JSON to this file instead of stdout')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => themeExport(options));

theme
	.command('import <file>')
	.description('Import a theme JSON file, apply it live, and activate it')
	.option('--no-activate', 'Save the palette without switching to the Custom theme')
	.option('--json', 'Output as JSON (for scripting)')
	.action((file, options) => themeImport(file, options));

theme
	.command('set [assignments...]')
	.description('Set custom theme colors (key=value, e.g. accent=#ff0000) and/or re-base')
	.option('-b, --base <id>', 'Initialize from a built-in theme before applying overrides')
	.option('-a, --activate', 'Switch to the Custom theme after applying')
	.option('--json', 'Output as JSON (for scripting)')
	.action((assignments, options) => themeSet(assignments, options));

// Encore commands - list and toggle the optional features on Settings > Plugins
// (applies live). Always visible: it is how a hidden feature is turned on.
const encore = program
	.command('encore')
	.description('List and toggle the optional features on Settings > Plugins');

encore
	.command('list')
	.description('List the optional features and whether each is on')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => encoreList(options));

encore
	.command('enable <feature>')
	.description('Turn a feature on (any id from `encore list`, e.g. computerHistory or groups-plus)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((feature, options) => encoreSet(feature, true, options));

encore
	.command('disable <feature>')
	.description('Turn a feature off')
	.option('--json', 'Output as JSON (for scripting)')
	.action((feature, options) => encoreSet(feature, false, options));

// Computer History - local record of what the user saw and typed (Encore-gated,
// off by default). Reads come from disk and work with the app closed; writes go
// to the running app's ComputerHistoryService. Captured content is untrusted.
const computerHistory = encoreCommand(
	program,
	'computer-history',
	'computerHistory',
	encoreFlags
).description(
	'Computer History: query what the user saw and typed across apps (local, untrusted content)'
);

computerHistory
	.command('status')
	.description('Show whether recording is on, permission state, and store size')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryStatus(options));

computerHistory
	.command('list')
	.description('List recorded 15-minute segments in a time range')
	.option('--since <time>', 'Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default 2h)')
	.option('--until <time>', 'End (default now)')
	.option('--app <id>', 'Only segments that include this app id')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryList(options));

computerHistory
	.command('query')
	.description('Search recorded events (text, selections, snapshots, app and window changes)')
	.option('--since <time>', 'Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default 1h)')
	.option('--until <time>', 'End (default now)')
	.option(
		'--app <id>',
		'App id or name (comma list or repeat)',
		(val: string, prev: string[]) => [...prev, val],
		[]
	)
	.option(
		'--kind <kind>',
		'text | selection | snapshot | app | window (comma list or repeat)',
		(val: string, prev: string[]) => [...prev, val],
		[]
	)
	.option('--grep <regex>', 'Case-insensitive regex over text, titles, URLs, and labels')
	.option('--limit <n>', 'Most recent N matches (default 200)')
	.option('--drafts', 'Keep text commits a later commit in the same field supersedes')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryQuery(options));

computerHistory
	.command('apps')
	.description('Apps used in a time range, by foreground time and event count')
	.option('--since <time>', 'Start (default 1d)')
	.option('--until <time>', 'End (default now)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryApps(options));

computerHistory
	.command('digests')
	.description('List 15-minute digests and 6-hour roll-ups (model-written, untrusted content)')
	.option('--since <time>', 'Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default 1d)')
	.option('--until <time>', 'End (default now)')
	.option('--kind <kind>', '15m | 6h (default both)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryDigests(options));

computerHistory
	.command('pause')
	.description('Pause recording (until resumed, or for a duration)')
	.option('--for <duration>', 'Pause for 30m, 2h, 1d, 1w (default: until resumed)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryPause(options));

computerHistory
	.command('resume')
	.description('Resume recording')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryResume(options));

const computerHistoryRules = computerHistory
	.command('rules')
	.description('Which apps are recorded (exclude or include mode) and domains never recorded');

computerHistoryRules
	.command('list')
	.description('Show the app mode and user rules (built-in exclusions always apply)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryRulesList(options));

computerHistoryRules
	.command('mode [mode]')
	.description(
		'Show or set the app mode: exclude (record every app except ignored ones) or include (record only the record-only list)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((mode, options) => computerHistoryRulesMode(mode, options));

computerHistoryRules
	.command('add')
	.description(
		'Never record an app or a domain (and its subdomains); with --include, add an app to the record-only list'
	)
	.option('--app <id>', 'App id or exact name: macOS bundle id, Windows exe name, Linux desktop id')
	.option('--domain <domain>', 'Domain, e.g. bank.example.com')
	.option('--include', 'Add the app to the record-only list used in include mode')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryRulesAdd(options));

computerHistoryRules
	.command('remove <id>')
	.description('Remove a rule by id (or by its app id / domain)')
	.option('--include', 'When removing by value, remove it from the record-only list')
	.option('--json', 'Output as JSON (for scripting)')
	.action((id, options) => computerHistoryRulesRemove(id, options));

// Deleting a recording takes a footprint away, so it still runs with the
// feature switched off: what was recorded must always be removable.
allowWhileEncoreOff(
	computerHistory
		.command('clear')
		.description('Delete recorded history: everything since a time, or all of it')
		.option('--since <time>', 'Delete what was recorded since: 30m, 2h, 1d, 1w, ISO-8601')
		.option('--all', 'Delete all recorded history (settings and rules stay)')
		.option('--json', 'Output as JSON (for scripting)')
		.action((options) => computerHistoryClear(options))
);

computerHistory
	.command('enable-accessibility')
	.description(
		'macOS: show the Accessibility prompt. Linux: turn on the desktop accessibility bus. Windows: not needed'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryEnableAccessibility(options));

computerHistory
	.command('config')
	.description('Show settings, or change them with the flags below')
	.option('--retention-days <n>', 'Keep this many days (default 90)')
	.option('--max-gb <n>', 'Keep at most this many GB (default 25)')
	.option('--snapshots <on|off>', 'Record visible window text snapshots')
	.option(
		'--skip-private-windows <on|off>',
		'Never record private / incognito browser windows (default on)'
	)
	.option('--digests <on|off>', 'Write 15-minute digests (off by default)')
	.option(
		'--digest-source <local|agent>',
		'Who writes digests: the model assigned to the history-digests task (models assign), or the digest agent'
	)
	.option(
		'--digest-agent <id>',
		'Agent that writes digests; also sets the source to agent (empty string clears it)'
	)
	.option(
		'--digest-rollup <on|off>',
		'Also write 6-hour roll-ups from the 15-minute digests (default on)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => computerHistoryConfig(options));

// Pianola - the autonomous manager agent (Encore-gated, off by default).
const pianola = encoreCommand(program, 'pianola', 'pianola', encoreFlags).description(
	'Pianola manager agent: watch tabs, auto-answer or escalate per your rules'
);

pianola
	.command('watch <tab-id>')
	.description('Watch a desktop tab and act on awaiting-input prompts per your rules')
	.option('--agent <agent-id>', 'Agent id to dispatch answers to (defaults to the tab owner)')
	.option('--interval <seconds>', 'Polling interval in seconds (default 5)')
	.option(
		'--idle-hours <hours>',
		'Stop watching after this many hours with no tab activity (default 6, 0 = never)'
	)
	.option('--dry-run', 'Classify and record decisions but never send a message')
	.option('--once', 'Run a single iteration instead of looping')
	.option('--json', 'Reserved for scripting; affects the disabled-feature error only')
	.action((tabId, options) => pianolaWatch(tabId, options));

pianola
	.command('rules')
	.description('List the configured Pianola rules')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaRules(options));

pianola
	.command('add-rule')
	.description(
		'Add a Pianola rule (how the manager agent turns a conversation into a durable rule)'
	)
	.option('--scope <scope>', 'global | project | tab (default global)')
	.option('--scope-id <id>', 'Project path (scope project) or tab id (scope tab)')
	.option('--action <action>', 'auto_answer | escalate | ignore (required)')
	.option('--answer <text>', 'Reply text (required for auto_answer)')
	.option('--max-risk <risk>', 'Only fire when risk is at most: low | medium | high')
	.option('--kinds <list>', 'Comma list of signal kinds: question,blocked,none')
	.option('--topic-includes <list>', 'Comma list of case-insensitive topic substrings')
	.option('--priority <n>', 'Lower runs first (default 100)')
	.option('--description <text>', 'Human-readable description')
	.option('--disabled', 'Create the rule disabled')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaAddRule(options));

pianola
	.command('learn')
	.description(
		'Crawl installed CLI transcripts into a labeled decision corpus (Claude Code + Codex)'
	)
	.option('--agent <list>', 'Comma list of agents to crawl: claude-code,codex (default both)')
	.option('--limit <n>', 'Max sessions per agent, newest first (default 300)')
	.option('--since <date>', 'Only crawl transcripts modified on/after this date (e.g. 2026-06-01)')
	.option(
		'--project <substr>',
		'Only keep decisions from sessions whose path contains this substring'
	)
	.option('--exclude <substr>', 'Drop decisions from sessions whose path contains this substring')
	.option(
		'--max-pairs <n>',
		'Max decision pairs to print inline when --out is not used (default 200)'
	)
	.option('--out <file>', 'Write the full corpus JSON to a file instead of stdout')
	.option('--json', 'Compact JSON output (for scripting)')
	.action((options) => pianolaLearn(options));

pianola
	.command('profile')
	.description('Read a learned decision profile (per-project with --project, else global)')
	.option('--project <path>', 'Project path to read the profile for (falls back to global)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaProfile(options));

pianola
	.command('set-profile')
	.description('Save a learned decision profile from --file or stdin (per-project or global)')
	.option('--project <path>', 'Project path this profile is for (omit for the global profile)')
	.option('--file <path>', 'Read the profile markdown from this file (else reads stdin)')
	.option('--pair-count <n>', 'How many decision pairs this profile was synthesized from')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaSetProfile(options));

pianola
	.command('log')
	.description('Show recent Pianola decisions from the audit log')
	.option('--limit <n>', 'Maximum number of records to show (default 20)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaLog(options));

// Pianola plan - author and inspect task DAGs the orchestrator runs.
const pianolaPlan = pianola
	.command('plan')
	.description('Author and inspect Pianola task plans (DAGs)');

pianolaPlan
	.command('set')
	.description('Save a plan from --file or piped stdin (validated before write)')
	.option('--file <path>', 'Read the plan JSON from this file (else reads stdin)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaPlanSet(options));

pianolaPlan
	.command('list')
	.description('List saved plans with a progress summary')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaPlanList(options));

pianolaPlan
	.command('show <planId>')
	.description('Show one plan: its tasks, statuses, and dependencies')
	.option('--json', 'Output as JSON (for scripting)')
	.action((planId, options) => pianolaPlanShow(planId, options));

pianola
	.command('orchestrate <planId>')
	.description('Run a saved plan to completion, dispatching tasks as their dependencies finish')
	.option('--interval <seconds>', 'Polling interval in seconds (default 5)')
	.option('--concurrency <n>', 'Max tasks running at once (default 3)')
	.option('--once', 'Run a single iteration instead of looping')
	.option('--json', 'Output as JSON (for scripting)')
	.action((planId, options) => pianolaOrchestrate(planId, options));

// Pianola supervise - register background targets the desktop keeps alive
// (restart on crash, relaunch on app start, visible health). These write the
// shared supervisor store; the running app reconciles within ~1s.
const pianolaSupervise = pianola
	.command('supervise')
	.description(
		'Register desktop-supervised watchers and orchestrations (survive crashes/restarts)'
	);

pianolaSupervise
	.command('watch <tabId>')
	.description('Register a supervised tab watcher the desktop keeps alive')
	.option('--agent <agent-id>', 'Agent id to dispatch answers to (required)')
	.option('--interval <seconds>', 'Polling interval in seconds (default 5)')
	.option(
		'--idle-hours <hours>',
		'Retire the watcher after this many hours with no tab activity (default 6, 0 = never)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((tabId, options) => pianolaSuperviseWatch(tabId, options));

pianolaSupervise
	.command('orchestrate <planId>')
	.description('Register a supervised plan orchestration the desktop keeps alive')
	.option('--concurrency <n>', 'Max tasks running at once (default 3)')
	.option('--interval <seconds>', 'Polling interval in seconds (default 5)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((planId, options) => pianolaSuperviseOrchestrate(planId, options));

pianolaSupervise
	.command('list')
	.description('List registered supervised targets')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => pianolaSuperviseList(options));

pianolaSupervise
	.command('remove <id>')
	.description('Unregister a supervised target by id (the desktop stops its child)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((id, options) => pianolaSuperviseRemove(id, options));

pianolaSupervise
	.command('enable <id>')
	.description('Enable a supervised target by id')
	.option('--json', 'Output as JSON (for scripting)')
	.action((id, options) => pianolaSuperviseSetEnabled(id, true, options));

pianolaSupervise
	.command('disable <id>')
	.description('Disable a supervised target by id (the desktop stops its child)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((id, options) => pianolaSuperviseSetEnabled(id, false, options));

// Prompts command - read Maestro's bundled or user-customized system prompts.
// Designed for agent self-fetch: parent prompts reference includes via `{{REF:_name}}`
// and the agent retrieves the full content on demand with `prompts get _name`.
const prompts = program.command('prompts').description('Read Maestro system prompts');

prompts
	.command('list')
	.description('List all known prompt ids with descriptions')
	.option('--json', 'Output as JSON (for scripting)')
	.action(promptsList);

prompts
	.command('get <id>')
	.description('Print a prompt by id (honors user customizations from Settings → Maestro Prompts)')
	.option('--json', 'Output as JSON object with metadata + content')
	.action(promptsGet);

// Gist commands - publish agent session transcripts to GitHub gists via the
// running Maestro desktop app. Grouped as a subcommand so we can add more gist
// operations (list, show, delete, etc.) later.
const gist = program.command('gist').description('Publish session context to GitHub gists');

gist
	.command('create <agent-id>')
	.description(
		"Publish an agent's session transcript as a GitHub gist (requires running Maestro app)"
	)
	.option('-d, --description <text>', 'Gist description')
	.option('-p, --public', 'Create a public gist (default: private)')
	.option(
		'-s, --session <id>',
		"Publish one provider session's transcript (from `send -s <id>`) instead of the agent's open desktop tabs"
	)
	.option(
		'--allow-secrets',
		'Publish even when the secret screen finds a possible credential (default: refuse and list them, masked)'
	)
	.option('--json', 'Output as JSON (this verb always does; accepted so every verb takes --json)')
	.action(gistCreate);

// Notify commands - surface notifications in the Maestro desktop app
const notify = program
	.command('notify')
	.description('Show notifications in the Maestro desktop app');

notify
	.command('toast <title> <message>')
	.description('Show a toast notification (queued, click X or icon to dismiss)')
	.option('-c, --color <color>', 'green | yellow | orange | red | theme (default: theme)')
	.option(
		'-t, --timeout <seconds>',
		'Auto-dismiss after N seconds (range: (0, 60]; omitted = app default)'
	)
	.option(
		'--dismissible',
		'Sticky toast - no auto-dismiss; user must click to close. Cannot combine with --timeout'
	)
	.option('-a, --agent <id>', 'Associate with an agent so clicking jumps to it')
	.option(
		'--source-agent <label>',
		'Label shown in the toast header identifying which agent/pipeline fired it. Store-independent, so it shows even for cron/watchdog toasts. Wins over the name resolved from --agent; pair with --agent to also get click-to-jump'
	)
	.option(
		'--tab <id>',
		'AI tab ID within the agent - clicking jumps to that tab (requires --agent)'
	)
	.option(
		'--action-url <url>',
		'Inline link rendered beneath the message body (opens in browser when clicked)'
	)
	.option('--action-label <text>', 'Label for --action-url (defaults to the URL itself)')
	.option(
		'--open-file <path>',
		'On click, switch to the agent and open this file in its File Preview pane (requires --agent; mutually exclusive with the other --open-* flags)'
	)
	.option(
		'--open-terminal [tab]',
		'On click, switch to the agent and focus a terminal tab. Optional value is a tab id or name; bare uses the active terminal tab (requires --agent)'
	)
	.option(
		'--open-browser <url>',
		'On click, open this URL in a new in-app browser tab on the agent (requires --agent)'
	)
	.option(
		'--open-browser-tab <id>',
		'On click, focus this existing in-app browser tab (the id `open-browser` printed; requires --agent)'
	)
	.option(
		'--open-url <url>',
		'On click, open this URL in the system browser (opens outside Maestro; use --open-browser for an in-app tab)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(notifyToast);

const inbox = notify
	.command('inbox')
	.description('Read and manage the desktop notification center history');
inbox
	.command('list')
	.description('List retained notifications with stable IDs')
	.option('--unread', 'Only list unread entries')
	.option('--json', 'Output as JSON')
	.action((options) => notificationInbox({ action: 'list', unread: options.unread }, options));
for (const action of ['open', 'close', 'read-all', 'clear', 'collapse'] as const) {
	inbox
		.command(action)
		.description(
			{
				open: 'Open the notification center',
				close: 'Close the notification center',
				'read-all': 'Mark every history entry read',
				clear: 'Clear retained history',
				collapse: 'Collapse expanded notification details',
			}[action]
		)
		.option('--json', 'Output as JSON')
		.action((options) => notificationInbox({ action }, options));
}
inbox
	.command('dismiss [id]')
	.description('Dismiss one notification or all visible toasts and mark their entries read')
	.option('--json', 'Output as JSON')
	.action((id, options) => notificationInbox({ action: 'dismiss', id }, options));
for (const action of ['read', 'activate', 'link', 'detail'] as const) {
	inbox
		.command(`${action} <id>`)
		.description(
			{
				read: 'Mark one notification read',
				activate: 'Run a notification body action',
				link: 'Open a notification inline link',
				detail:
					'Expand full notification details in the inbox (requires notificationCenterDetails)',
			}[action]
		)
		.option('--json', 'Output as JSON')
		.action((id, options) => notificationInbox({ action, id }, options));
}

notify
	.command('flash <message>')
	.description('Show a center-screen flash (momentary, exclusive - replaces any active flash)')
	.option('-c, --color <color>', 'green | yellow | orange | red | theme (default: theme)')
	.option('-D, --detail <text>', 'Optional second line shown beneath the message')
	.option('-t, --timeout <seconds>', 'Auto-dismiss after N seconds (range: (0, 5]; default 1.5)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(notifyFlash);

notify
	.command('speak <text>')
	.description(
		'Say one line aloud on the computer running Maestro, with a local voice. Waits until it was spoken; queued behind other notices, and refused while a voice session is live'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(notifySpeak);

// Local Models commands - the model catalog, model servers the user runs
// (Ollama, LM Studio, OpenAI-compatible), task assignments, and the task
// router. Endpoint list/add/remove and assign edit settings directly; the
// catalog verbs, test/detect, run, status, and readiness run in the desktop app.
program
	.command('search <query>')
	.description(
		"Search past work across History entries, Director's Notes, and tab transcripts: exact text by default, by meaning with --semantic (requires the desktop app)"
	)
	.option(
		'--semantic',
		'Match by meaning on the Semantic search assignment instead of by exact text'
	)
	.option(
		'--source <source>',
		'Restrict to a source: history, notes, or transcripts (repeatable, or comma-separated)',
		(value: string, previous: string[] = []) => [...previous, value]
	)
	.option('-a, --agent <id>', 'Restrict to one agent (id, id prefix, or exact name)')
	.option('-l, --limit <n>', 'Most results to return (default 20, max 100)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(search);

// Voice (A Cappella). The Voice HUD and Settings > Voice, verb for verb: the
// session and its controls, providers and voices, cloud keys, paired devices,
// and wake phrase training.
const voice = program
	.command('voice')
	.description(
		'A Cappella voice: sessions, the HUD controls, providers, voices, cloud keys, paired devices and the wake word'
	);

voice
	.command('status')
	.description(
		'Show whether voice is on, the live session, the send wait, and what blocks a session from starting (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceStatus);

voice
	.command('start')
	.description(
		'Start a voice session on the Conductor (the default), an agent, one tab, a document, or Quick Chat. Its HUD opens in the window you are looking at'
	)
	.option('-a, --agent <id>', 'Talk to this agent (id, id prefix, or exact name)')
	.option('--tab <id>', 'Talk to this tab only ("active" for the selected tab)')
	.option('--conductor', 'Talk to the Conductor, which routes each request to an agent')
	.option('--document <path>', 'Talk about this document with the agent named by --agent')
	.option(
		'--quick-chat',
		'Talk to Quick Chat: opens its window and locks the session to its chat (no "voice scope")'
	)
	.option(
		'--paused',
		'Open with the microphone shut (push-to-talk): nothing is heard until "voice listen on"'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceStart);

voice
	.command('stop')
	.description('End the voice session and close the microphone. Works with voice switched off')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceStop);

voice
	.command('listen <state>')
	.description(
		'Open (on) or shut (off) the microphone and keep the session: the HUD talk button, and both ends of push-to-talk'
	)
	.option('--send', 'With "off": send what was said, as releasing push-to-talk does')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceListen);

voice
	.command('send')
	.description('Send what was said now, without waiting out the pause: the HUD "Send now" button')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceSend);

voice
	.command('stop-reply')
	.description('Cut off the spoken reply and keep the session open')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceStopReply);

voice
	.command('scope <mode>')
	.description(
		'Re-aim the live session: conductor, agent, or tab (the HUD Tab / Agent / Conductor switch). Refused for a Quick Chat session, which is locked'
	)
	.option('-a, --agent <id>', 'The agent, for agent and tab (default: the active agent)')
	.option('--tab <id>', 'The tab, for tab (default: the selected tab)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceScope);

voice
	.command('wait [ms]')
	.description(
		'Show, or set for this conversation, how long a pause sends a request. "default" returns to the saved wait'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWait);

voice
	.command('volume <level>')
	.description(
		'Set the volume of the spoken reply (0.1 to 1): saved, and applied to what is playing'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceVolume);

voice
	.command('mute')
	.description('Silence the spoken reply for now. Not saved, like the HUD mute button')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceMute);

voice
	.command('unmute')
	.description('Return the spoken reply to the saved volume')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceUnmute);

voice
	.command('latency')
	.description('Show where the time went in the last finished voice turn, hop by hop')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceLatency);

voice
	.command('self-test')
	.description(
		'Load each native runtime voice runs on and read the microphone permission. Works with voice switched off'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceSelfTest);

voice
	.command('setup')
	.description(
		'Show the models local voice needs and which are on disk. Downloads nothing unless --download is passed'
	)
	.option('--download', 'Download what is missing, as the Voice Setup Download button does')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceSetup);

const voiceInput = voice.command('input').description('The microphone voice listens on');

voiceInput
	.command('list')
	.description('List the microphones the app has seen and the one selected')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceInputList);

voiceInput
	.command('set <device-id>')
	.description(
		'Choose the microphone, from the next capture on. "default" follows the system default'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceInputSet);

const voiceProviders = voice
	.command('providers')
	.description('What transcribes speech, speaks replies, and routes a request');

voiceProviders
	.command('list')
	.description('Show what each slot (stt, tts, brain) runs and what it could run')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceProvidersList);

voiceProviders
	.command('set <slot> <provider-id>')
	.description(
		'Pick what a slot runs (stt, tts, brain, realtime), or the pipeline (cascade, realtime), then tell the running app'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceProvidersSet);

const voiceVoices = voice.command('voices').description('The voice replies are spoken in');

voiceVoices
	.command('list')
	.description('List the voices the Text-to-Speech provider offers and the one selected')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceVoicesList);

voiceVoices
	.command('set <voice-id>')
	.description('Pick the voice replies are spoken in')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceVoicesSet);

voiceVoices
	.command('preview [voice-id]')
	.description(
		'Speak one line in a voice (the selected one by default). Refused while a session is live'
	)
	.option('--text <text>', 'The line to speak (default: the Settings Preview line)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceVoicesPreview);

const voiceCredentials = voice
	.command('credentials')
	.description(
		'The cloud keys hosted voice providers use (openai, elevenlabs, anthropic), kept in the OS keychain'
	);

voiceCredentials
	.command('list')
	.description('Show which keys are stored. Never prints a key')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceCredentialsList);

voiceCredentials
	.command('set <service>')
	.description(
		'Store a key read from standard input (never an argument, so it stays out of shell history)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceCredentialsSet);

voiceCredentials
	.command('test <service>')
	.description('Ask the service whether the stored key works')
	.option('--stdin', 'Test a key read from standard input instead, before storing it')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceCredentialsTest);

voiceCredentials
	.command('clear <service>')
	.description('Remove a stored key')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceCredentialsClear);

const voiceDevices = voice
	.command('devices')
	.description(
		'Devices paired to hold a voice session from elsewhere. Pairing itself is approved in the app'
	);

voiceDevices
	.command('list')
	.description('List every paired device, whether it is connected, and LAN discovery')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesList);

voiceDevices
	.command('rename <device> <name>')
	.description('Rename a paired device (id, id prefix, or exact name)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesRename);

voiceDevices
	.command('revoke <device>')
	.description('End a pairing now: the device is disconnected and must pair again')
	.option('-y, --yes', 'Do not ask for confirmation')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesRevoke);

voiceDevices
	.command('forget <device>')
	.description("Delete a device's record altogether")
	.option('-y, --yes', 'Do not ask for confirmation')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesForget);

voiceDevices
	.command('revoke-all')
	.description('End every pairing now')
	.option('-y, --yes', 'Do not ask for confirmation')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesRevokeAll);

voiceDevices
	.command('disconnect')
	.description('Drop every live device connection and keep the pairings')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesDisconnect);

voiceDevices
	.command('discovery <state>')
	.description('Advertise this machine on the local network (on), or stop (off)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesDiscovery);

voiceDevices
	.command('test-connection')
	.description(
		'Probe which paths a device could reach this machine on: local network, STUN, TURN relay'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceDevicesTestConnection);

const voiceWakePhrase = voice
	.command('wake-phrase')
	.description('A wake phrase of its own for one agent: saying it opens a session on that agent');

voiceWakePhrase
	.command('list')
	.description('List every agent with a wake phrase of its own')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakePhraseList);

voiceWakePhrase
	.command('set <agent> <phrase>')
	.description("Set one agent's wake phrase, leaving every other agent's as it is")
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakePhraseSet);

voiceWakePhrase
	.command('clear <agent>')
	.description("Remove one agent's wake phrase")
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakePhraseClear);

const voiceWake = voice
	.command('wake')
	.description(
		'Teach the wake word a phrase from your own recordings: record or add WAV files, then train (requires the desktop app)'
	);

voiceWake
	.command('test [phrase]')
	.description(
		'Run the wake word alone for a few seconds and count how often it fired (default: the configured phrase)'
	)
	.option('--seconds <n>', 'How long to listen, 1 to 60 (default 10)')
	.option('--sensitivity <n>', 'Try a sensitivity from 0 to 1 without saving it')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeTest);

voiceWake
	.command('list')
	.description('List every phrase with recordings, and whether each is trained')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeList);

voiceWake
	.command('status [phrase]')
	.description(
		'Show what is recorded for a phrase and what its trained model measured (default: the configured wake phrase)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeStatus);

voiceWake
	.command('record [phrase]')
	.description(
		'Open the microphone and keep each burst of speech as one recording of the phrase (default: the configured wake phrase), until "voice wake stop"'
	)
	.option(
		'--other-speech',
		'Record ordinary speech that is NOT the phrase instead (about 30 seconds)'
	)
	.addOption(new Option('--background').hideHelp())
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeRecord);

voiceWake
	.command('stop')
	.description('End the recording in progress and close the microphone')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeStop);

voiceWake
	.command('add <phrase> <files...>')
	.description(
		'Add recordings from 16-bit PCM WAV files instead of the microphone, one recording of the phrase per file'
	)
	.option('--other-speech', 'The files are ordinary speech that is NOT the phrase')
	.addOption(new Option('--background').hideHelp())
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeAdd);

voiceWake
	.command('undo [phrase]')
	.description('Remove the newest recording of the phrase (default: the configured wake phrase)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeUndo);

voiceWake
	.command('clear-background [phrase]')
	.description(
		'Remove the ordinary speech recorded for a phrase, so it can be recorded again (default: the configured wake phrase)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeClearBackground);

voiceWake
	.command('train [phrase]')
	.description(
		'Build the wake word model for a phrase from its recordings (default: the configured wake phrase); waits until training finishes'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeTrain);

voiceWake
	.command('remove <phrase>')
	.description('Delete the trained model and every recording of a phrase')
	.option('--json', 'Output as JSON (for scripting)')
	.action(voiceWakeRemove);

const models = program.command('models').description('Local Models: model sources Maestro can use');

// The models the user added from Hugging Face join the catalog before any
// `models` verb reads an id, so they resolve the way they do in the desktop.
models.hook('preAction', () => loadUserLocalModels());

models
	.command('list')
	.description(
		'List the local model Library grouped by what each model is for, with install status, size, what it is good at, and what uses it (requires the desktop app)'
	)
	.option(
		'-k, --kind <kind>',
		'Only one kind: text-gen | embedding | classifier | stt | tts | wake-word'
	)
	.option(
		'--fit',
		'Say whether each model runs on this computer: Fits, Tight or Too large, with the reason'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsList);

models
	.command('add-hf <repo> <file>')
	.description(
		'Add a GGUF text model from Hugging Face to the Library by repo id and file name, pinned and labeled "Not verified by Maestro"; prints its license and downloads nothing (requires the desktop app)'
	)
	.option('--dry-run', 'Describe the model and its license without adding it')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsAddHf);

models
	.command('remove-hf <model-id>')
	.description(
		'Take a model added with add-hf out of the Library and delete its files. Refuses a model a task is assigned to unless --force (requires the desktop app)'
	)
	.option('-f, --force', 'Remove it even though assigned tasks become unavailable')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsRemoveHf);

models
	.command('install <model-id>')
	.description(
		'Download and verify a local model and the engine it runs on, resuming a paused download; waits until it finishes (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsInstall);

const modelRuntimes = models
	.command('runtimes')
	.description('The native engines local models run on (ONNX Runtime, llama.cpp)');

modelRuntimes
	.command('list')
	.description(
		'List the engines with install state, size, and the models each runs (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsRuntimesList);

modelRuntimes
	.command('install <runtime-id>')
	.description(
		'Download, verify and install one engine (onnx | llama), or update a stale one; waits until it is usable (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsRuntimesInstall);

models
	.command('pause <model-id>')
	.description(
		'Pause a running download and keep what arrived; models install resumes it (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsPause);

models
	.command('cancel <model-id>')
	.description(
		'Cancel a download and delete its partial files; an installed model is not touched (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsCancel);

models
	.command('remove <model-id>')
	.description(
		'Delete a downloaded model. Refuses a model a task is assigned to unless --force (requires the desktop app)'
	)
	.option('-f, --force', 'Remove it even though assigned tasks become unavailable')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsRemove);

models
	.command('verify <model-id>')
	.description(
		'Re-hash a downloaded model against the catalog; never deletes or re-downloads (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsVerify);

models
	.command('assign <task-id> <assignment>')
	.description(
		'Choose what a task runs on: off | utility-agent | system-one | local:<model-id> | endpoint:<endpoint>:<model>'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsAssign);

models
	.command('tasks')
	.description(
		'List every task with its assignment, plus readiness when the desktop app is running'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsTasks);

models
	.command('run <task-id>')
	.description(
		'Run a text-generation task (or dictation, with --audio) through its assignment; prints the text, or why it did not run (requires the desktop app)'
	)
	.option('-i, --input <text>', 'The prompt to send (required, except with --cwd or --audio)')
	.option(
		'--cwd <path>',
		'git-drafts only: draft a pull request title and body for the branch checked out in this repository'
	)
	.option('--base <branch>', 'git-drafts only: the target branch (default: main, then master)')
	.option(
		'--audio <file>',
		'dictation only: transcribe this 16-bit PCM WAV file and print the transcript'
	)
	.option('-s, --system <text>', 'System prompt')
	.option('--max-tokens <n>', 'Token budget for the reply (default 512)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsRun);

models
	.command('status [task-id]')
	.description(
		'Whether each task (or one) would run on its assignment, and if not why and what to do (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsStatus);

models
	.command('index')
	.description(
		'What the semantic index is doing: its state, and how many sources are indexed (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsIndex);

const modelProxy = models
	.command('proxy')
	.description('The Maestro token proxy: what it carried, saved, and shortened');

modelProxy
	.command('status')
	.description(
		'Whether the proxy is listening, the agents on it and their mode, tokens saved and added latency for the last 30 days, and recent compressions (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsProxyStatus);

modelProxy
	.command('block <hash>')
	.description(
		'Show one compressed block from the cache: a diff of what the agent sent against what was sent in its place (requires the desktop app)'
	)
	.option('--original', 'Print only the text the agent sent')
	.option('--compressed', 'Print only the text sent in its place')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsProxyBlock);

const modelServer = models
	.command('server')
	.description(
		"The Maestro model server: llama.cpp's llama-server, serving downloaded models to agent harnesses over HTTP"
	);

modelServer
	.command('status')
	.description(
		'State, address, engine build and accelerator, models served and loaded, key storage and log path (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsServerStatus);

modelServer
	.command('start')
	.description('Start the model server and wait until it answers (requires the desktop app)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsServerStart);

modelServer
	.command('stop')
	.description('Stop the model server and wait until it exits (requires the desktop app)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsServerStop);

modelServer
	.command('set')
	.description(
		'Change who can reach it, how many models stay loaded, the key, or the engine build; a running server restarts (requires the desktop app)'
	)
	.option('--bind <mode>', 'local (127.0.0.1, this machine) | network (0.0.0.0, needs the key)')
	.option('--max-models <n>', 'Models loaded at the same time (1 to 16, default 1)')
	.option('--rotate-key', 'Replace the API key; whatever used the old key needs the new one')
	.option(
		'--build <choice>',
		'Install this engine build: default | cpu | cuda | rocm (cuda and rocm on Windows and Linux x64 only)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsServerSet);

modelServer
	.command('key')
	.description(
		'Print the API key a harness sends to the model server, made on first use (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsServerKey);

// System One: the engine that answers typed questions (yes or no, pick one,
// rate on a rubric). Every verb runs in the desktop app.
const systemOne = program
	.command('s1')
	.description(
		'System One: ask typed questions about a text (yes, pick, rate, ask, rank, batch) and get calibrated judgments back; plus the engine that answers them (Jev, OpenJev, or a local judge), its key, a test, the decision ledger and the spend'
	);

systemOne
	.command('status')
	.description(
		'The engine in force, its address, model and timeout, where each key comes from, the fail policies, and what agents may ask and spend (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneStatus);

const systemOneSet = systemOne
	.command('set')
	.description(
		'Change the System One engine, its timeout, a task fail policy, what the ledger keeps, or what agents may ask and spend'
	);

systemOneSet
	.command('engine <engine>')
	.description(
		'Choose the engine: off | jev-cloud (sends task text to TypeSafe) | openjev (your server) | local-judge (a local model, not calibrated) (requires the desktop app)'
	)
	.option('--url <url>', 'The OpenJev server (openjev only)')
	.option(
		'--model <model>',
		'jev-cloud, openjev: pin this model, or "default" to remove the pin. local-judge: the source it answers on, local:<model-id> or endpoint:<endpoint>:<model>'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneSetEngine);

systemOneSet
	.command('timeout <ms>')
	.description(
		'The request budget for Jev and OpenJev, in milliseconds (100 to 60000, default 1500) (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneSetTimeout);

systemOneSet
	.command('fail-policy <task> <policy>')
	.description(
		'What a task does when the engine gives no answer: open (the work goes ahead) | closed (it stops) | default (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneSetFailPolicy);

systemOneSet
	.command('keep-inputs <on|off>')
	.description(
		'Whether a decision record keeps the state and questions it was asked, with secrets redacted (default off) (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneSetKeepInputs);

systemOneSet
	.command('agents <on|off>')
	.description(
		"Let agents use System One: whether an agent's own s1 yes, pick, rate, ask, rank and batch are answered, and whether its system prompt says so (default on; one agent is switched off with update-agent --system-one off) (requires the desktop app)"
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneSetAgents);

systemOneSet
	.command('budget [usd]')
	.description(
		'What agents may spend on System One in a local day, in US dollars across all agents (0 to 1000, default 1; 0 refuses every agent request) (requires the desktop app)'
	)
	.option(
		'--per-agent <usd|none>',
		'The most one agent may spend in a day, or "none" for no cap of its own (default none)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneSetBudget);

const systemOneKey = systemOne
	.command('key')
	.description('The API key Maestro stores, sealed, for Jev or OpenJev. No verb prints a key');

systemOneKey
	.command('set')
	.description(
		'Store a key read from standard input, never from an argument: pbpaste | maestro-cli s1 key set (requires the desktop app)'
	)
	.option('--engine <engine>', 'jev-cloud | openjev (default: the engine in force)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneKeySet);

systemOneKey
	.command('clear')
	.description('Forget the stored key (requires the desktop app)')
	.option('--engine <engine>', 'jev-cloud | openjev (default: the engine in force)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneKeyClear);

systemOne
	.command('test')
	.description(
		'Ask the engine one fixed question and print the answer, the latency and the engine; exits non-zero with no answer (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneTest);

systemOne
	.command('ledger')
	.description(
		'The decision ledger: what each System One run decided, or what its fail policy did with no answer, newest first, kept 30 days (requires the desktop app)'
	)
	.option('--task <task>', 'Only this task (list them with: models tasks)')
	.option(
		'--outcome <outcome>',
		'ok | failed-open | failed-closed | unavailable | cancelled | timeout'
	)
	.option('--since <time>', 'Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default: 30 days)')
	.option('--limit <n>', 'At most this many decisions, 1 to 1000 (default 100)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneLedger);

systemOne
	.command('route <prompt>')
	.description(
		'A dry run of the model router: the tier and effort the model-routing task picks for a prompt, the router that decided and its latency, without sending anything. With --agent, also what a turn on the Auto model would launch on for that agent. Exits 6 when the router is off and 7 when it gave no decision (requires the desktop app)'
	)
	.option(
		'--agent <id>',
		'Resolve the decision for this agent: its tier targets, the harness defaults, and the model, effort and place a turn on Auto would launch on (supports partial IDs)'
	)
	.option(
		'--correct <tier>',
		'Record that this prompt needed low | medium | high instead of routing it. The embedding router votes with the correction from the next prompt'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(systemOneRoute);

// The verbs an agent asks System One with: yes, pick, rate, ask, rank, batch,
// and what they cost (usage, cost).
registerSystemOneAgentCommands(systemOne);

const modelTiers = models
	.command('tiers')
	.description(
		'Harness tier defaults: which model a low, medium or high task launches on, per harness'
	);

modelTiers
	.command('list')
	.description(
		'Each tier of each harness with its value and where it came from: Harness default (set by you) or Built-in'
	)
	.option('--harness <id>', 'Only this harness (e.g. claude-code, codex, opencode)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsTiersList);

modelTiers
	.command('options <harness>')
	.description(
		'What a harness can launch a tier on: its own catalogue and the Run on targets, each in the spelling "tiers set" takes (requires the desktop app)'
	)
	.option('--refresh', "Ask the harness again instead of using the app's cached list")
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsTiersOptions);

modelTiers
	.command('suggest <harness>')
	.description(
		'A suggested model per tier with the reason, from what the harness lists; a tier nothing ranks is left blank (requires the desktop app)'
	)
	.option('--apply', 'Save the suggested tiers; a tier with no suggestion keeps its value')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsTiersSuggest);

modelTiers
	.command('set <harness> <tier> <target>')
	.description(
		"Set one tier (low | medium | high) of one harness. Target: default (clear it) | provider (the agent's own model) | provider:<model> | <source id>:<model>"
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsTiersSet);

modelTiers
	.command('reset <harness>')
	.description('Put a harness back on the built-in tier table, or one tier with --tier')
	.option('--tier <tier>', 'Only this tier: low | medium | high')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsTiersReset);

const modelConfig = models
	.command('config')
	.description('Local Models configuration: where model files are downloaded from');

modelConfig
	.command('show')
	.description('Show the download base in force (works with Maestro closed)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsConfigShow);

modelConfig
	.command('set <key> <value>')
	.description(
		'Set a Local Models option. Key: download-base, the host models and Hugging Face metadata are requested from (a mirror when your network blocks Hugging Face; "default" restores https://huggingface.co). Every download is still checked against its hash'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsConfigSet);

const modelEndpoints = models
	.command('endpoints')
	.description('Model servers you run: Ollama, LM Studio, or any OpenAI-compatible base URL');

modelEndpoints
	.command('list')
	.description('List configured endpoints (flags an API key variable that is not set)')
	.option('--json', 'Output as JSON lines (for scripting)')
	.action(modelsEndpointsList);

modelEndpoints
	.command('add')
	.description('Add an endpoint. Ollama and LM Studio default to their standard local port')
	.requiredOption('--kind <kind>', 'ollama | lmstudio | openai-compatible')
	.option('--url <url>', 'Base URL (http/https, no credentials); required for openai-compatible')
	.option('--name <name>', 'Display name (default: the kind, e.g. "Ollama")')
	.option(
		'--api-key-env <name>',
		'NAME of the Settings -> Environment variable holding the API key (the key itself is never stored)'
	)
	.option('--disabled', 'Add it switched off')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsEndpointsAdd);

modelEndpoints
	.command('update <endpoint>')
	.description('Edit an endpoint, named by id, id prefix, or name; only the fields you pass change')
	.option('--name <name>', 'Display name')
	.option('--url <url>', 'Base URL (http/https, no credentials)')
	.option('--kind <kind>', 'ollama | lmstudio | openai-compatible')
	.option(
		'--api-key-env <name>',
		'NAME of the Settings -> Environment variable holding the API key (the key itself is never stored)'
	)
	.option('--clear-api-key-env', 'Stop sending an API key')
	.option('--enable', 'Switch the endpoint on')
	.option('--disable', 'Switch the endpoint off; tasks assigned to it become unavailable')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsEndpointsUpdate);

modelEndpoints
	.command('remove <endpoint>')
	.description('Remove an endpoint, named by id, id prefix, or name')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsEndpointsRemove);

modelEndpoints
	.command('models <endpoint>')
	.description(
		'List the models an endpoint serves now, for models assign endpoint:<endpoint>:<model> (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsEndpointsModels);

modelEndpoints
	.command('test <endpoint>')
	.description('Send a one-token chat and report latency (requires the desktop app)')
	.option('-m, --model <model>', 'Model to test (default: the first one the server lists)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsEndpointsTest);

modelEndpoints
	.command('detect')
	.description(
		'Probe this machine for Ollama and LM Studio not yet configured; adds nothing (requires the desktop app)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(modelsEndpointsDetect);

const profiling = program
	.command('profiling')
	.description('Start/stop a Chromium performance capture in the desktop app (for perf iteration)');

profiling
	.command('start')
	.description('Begin a performance capture (no-ops if one is already recording)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(profilingStart);

profiling
	.command('stop')
	.description('Stop the capture and write the compressed .zip bundle to --output')
	.requiredOption(
		'-o, --output <path>',
		'Destination .zip path (absolute or relative to cwd; ~ expanded). Parent dirs are created.'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(profilingStop);

profiling
	.command('status')
	.description('Report whether a capture is currently recording')
	.option('--json', 'Output as JSON (for scripting)')
	.action(profilingStatus);

// MaestroRun commands (macOS only) - install the signed launcher that holds
// Full Disk Access for scheduled scripts, and walk the grant. Each verb is the
// same action as the matching button on the MaestroRun tile in Settings.
const maestroRunCmd = encoreCommand(program, 'maestro-run', 'maestroRun', encoreFlags).description(
	'MaestroRun (macOS): install the launcher and grant it Full Disk Access for scheduled scripts'
);

maestroRunCmd
	.command('status')
	.description('Re-check the launcher: installed version, signature, and Full Disk Access')
	.option('--check-latest', 'Also ask GitHub for the newest release')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => maestroRun('status', options));

maestroRunCmd
	.command('install')
	.description(
		'Download, verify, and install the newest MaestroRun release for this Mac (or update it)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => maestroRun('install', options));

maestroRunCmd
	.command('grant')
	.description(
		'Open System Settings on the Full Disk Access list and watch for the switch (the user flips it)'
	)
	.option('--reveal', 'Also show MaestroRun.app in Finder, for dragging into the list')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => maestroRun('grant', options));

// Dataview commands - run the Dataview queries of a note the way File Preview
// renders them. Every verb reaches the running app's DataviewService, the same
// one the preview queries. Hidden and refused while the Dataview Encore Feature
// is off.
const dataviewCmd = encoreCommand(program, 'dataview', 'dataview', encoreFlags).description(
	"Dataview: run a note's Dataview queries, manage the vault index, and choose the vaults DataviewJS trusts"
);

dataviewCmd
	.command('query <file>')
	.description(
		"Run a note's dataview blocks with `this` bound to the note (DataviewJS blocks are desktop-only)"
	)
	.option(
		'--block <n>',
		'Run only the n-th dataview block (1-based; dataviewjs fences not counted)'
	)
	.option('--agent <id>', 'Agent the note belongs to (default: the agent whose folder holds it)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((file, options) => dataviewQuery(file, options));

dataviewCmd
	.command('eval <file> <dql>')
	.description(
		'Run an ad-hoc DQL query with `this` bound to the note; start with = for an inline expression'
	)
	.option('--agent <id>', 'Agent the note belongs to (default: the agent whose folder holds it)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((file, dql, options) => dataviewEval(file, dql, options));

const dataviewIndexCmd = dataviewCmd
	.command('index')
	.description('Inspect or rebuild the Dataview index of a vault');

dataviewIndexCmd
	.command('status [root]')
	.description('Show the open vault indexes, or one vault root (pages, revision, watcher, cache)')
	.option('--agent <id>', 'Agent whose SSH remote holds the root (default: a local root)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((root, options) => dataviewIndexStatus(root, options));

dataviewIndexCmd
	.command('rebuild <root>')
	.description("Drop a vault root's index cache and index it again from scratch")
	.option('--agent <id>', 'Agent whose SSH remote holds the root (default: a local root)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((root, options) => dataviewIndexRebuild(root, options));

dataviewCmd
	.command('trust <root>')
	.description('Trust a vault root: its DataviewJS blocks run in the sandbox without asking')
	.option('--json', 'Output as JSON (for scripting)')
	.action((root, options) => dataviewTrust(root, options));

dataviewCmd
	.command('untrust <root>')
	.description('Stop trusting a vault root: its DataviewJS blocks ask before they run')
	.option('--json', 'Output as JSON (for scripting)')
	.action((root, options) => dataviewUntrust(root, options));

dataviewCmd
	.command('trusted')
	.description('List the vault roots whose DataviewJS blocks run without asking')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => dataviewTrusted(options));

// Quick Chat commands - the hotkey-summoned floating chat window. Each verb is
// the same action as the matching button in the window.
const quickChatCmd = encoreCommand(program, 'quick-chat', 'quickChat', encoreFlags).description(
	'Drive the Quick Chat window: a floating chat with one agent, summoned by a hotkey'
);

quickChatCmd
	.command('show')
	.description('Open the Quick Chat window (same as the hotkey when it is closed)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('show', {}, options));

quickChatCmd
	.command('hide')
	.description('Close the Quick Chat window; the conversation is kept')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('hide', {}, options));

quickChatCmd
	.command('return')
	.description('Close the Quick Chat window and bring Maestro forward (Cmd+` in the window)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('return', {}, options));

quickChatCmd
	.command('toggle')
	.description('Open the window, focus it, or close it (exactly what the hotkey does)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('toggle', {}, options));

quickChatCmd
	.command('status')
	.description('Show the window state, the agent, the mode, and the current conversation')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('status', {}, options));

quickChatCmd
	.command('send [message...]')
	.description(
		'Send a message in the current Quick Chat (starts a chat if none is open); --image attaches images'
	)
	.option('--image <path...>', 'Image file(s) to send with the message (PNG, JPG, GIF, WebP)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((words: string[], options) => quickChat('send', { text: words.join(' ') }, options));

quickChatCmd
	.command('new')
	.description(
		'Start a new chat (the previous one finishes any reply in progress; an ephemeral one is then deleted)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('new', {}, options));

quickChatCmd
	.command('keep [state]')
	.description('Keep the current chat as a visible tab on its agent ("off" makes it ephemeral)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((state: string | undefined, options) => quickChat('keep', { state }, options));

quickChatCmd
	.command('pin [state]')
	.description('Float the window above other windows ("off" lets it fall behind them)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((state: string | undefined, options) => quickChat('pin', { state }, options));

quickChatCmd
	.command('tab [target]')
	.description(
		'Where the next message goes: a tab id (from status), new, or auto; the chat stays there (no target prints it)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((target: string | undefined, options) => quickChat('tab', { state: target }, options));

quickChatCmd
	.command('thinking [mode]')
	.description(
		"Show the agent's reasoning: off, on (until the answer arrives), sticky (kept), or cycle (no mode prints it)"
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((mode: string | undefined, options) => quickChat('thinking', { state: mode }, options));

quickChatCmd
	.command('font [size]')
	.description(
		'Text size of the conversation: in, out, reset, or a size such as 120% (no size prints it)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((size: string | undefined, options) => quickChat('font', { state: size }, options));

quickChatCmd
	.command('agent <agent-id>')
	.description('Switch Quick Chat to another agent and start a new chat there')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agent: string, options) => quickChat('agent', { agent }, options));

quickChatCmd
	.command('reveal [message-id]')
	.description(
		'Open a tab of the chat in the main Maestro window: the tab a message went to, or the latest'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((messageId: string | undefined, options) => quickChat('reveal', { messageId }, options));

quickChatCmd
	.command('new-tab [message-id]')
	.description(
		'Send a message to a new tab instead of the tab it went to: out of the queue, or stopped and sent again if it already ran (default: the latest queued one)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((messageId: string | undefined, options) => quickChat('new-tab', { messageId }, options));

quickChatCmd
	.command('steer [message-id]')
	.description(
		'Steer a queued message into the reply already running in its tab, so the agent changes course now instead of answering it afterwards (default: the latest steerable one)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((messageId: string | undefined, options) => quickChat('steer', { messageId }, options));

quickChatCmd
	.command('history')
	.description("List the recent chats, newest first (what the window's History button shows)")
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('history', {}, options));

quickChatCmd
	.command('recall <chat>')
	.description(
		'Bring back a recent chat (its agent, tab, and messages): its number in `history`, its id, or an id prefix'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((chat: string, options) => quickChat('recall', { chatId: chat }, options));

quickChatCmd
	.command('stop')
	.description('Stop the replies in progress and withdraw the messages still queued')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('stop', {}, options));

quickChatCmd
	.command('bounds')
	.description(
		'Move or resize the window, as dragging it does, and remember it (--height is the conversation height)'
	)
	.option('--x <px>', 'Left edge, in screen points (give with --y)')
	.option('--y <px>', 'Top edge, in screen points (give with --x)')
	.option('--width <px>', 'Width')
	.option('--height <px>', 'Height of the conversation shape')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => quickChat('bounds', {}, options));

// Cadenza commands - open small cadenza panels that display or track work.
const cadenza = encoreCommand(program, 'cadenza', 'concerto', encoreFlags).description(
	'Open small cadenza views to display or track work in the Maestro desktop app'
);

cadenza
	.command('open <id>')
	.description('Open (or replace by id) a cadenza view')
	.option(
		'--type <type>',
		'tracker | file | markdown | image | code | view | html | decision (default: tracker)'
	)
	.option('--title <text>', 'Header label for the panel')
	.option(
		'--body <text>',
		'Body content - tracker line, markdown/code source, JSON block spec (--type view), HTML document, or decision prompt'
	)
	.option(
		'--body-file <path>',
		'Read body content from a file (markdown, view JSON, code, or HTML)'
	)
	.option(
		'--path <path>',
		'File/image path (required for file and image; for --type code, shows that file as a snippet)'
	)
	.option(
		'--lang <lang>',
		'Language for --type code highlighting (inferred from --path if omitted)'
	)
	.option(
		'--option <label:value>',
		'A decision button (repeatable); clicking replies value to --agent. Requires --type decision',
		(val: string, prev: string[]) => prev.concat([val]),
		[] as string[]
	)
	.option('-c, --color <color>', 'green | yellow | orange | red | theme (default: theme)')
	.option(
		'-a, --agent <id>',
		'Owning agent - lets a file cadenza expand into its tab, and the reply target for --type decision'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(cadenzaOpen);

cadenza
	.command('update <id>')
	.description('Update fields of an open cadenza in place (the living view)')
	.option('--title <text>', 'New header label')
	.option('--body <text>', 'New body content (tracker line or markdown source)')
	.option('--body-file <path>', 'Read new body content from a file')
	.option('--path <path>', 'New file/image path')
	.option('-c, --color <color>', 'green | yellow | orange | red | theme')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cadenzaUpdate);

cadenza
	.command('close <id>')
	.description('Close a cadenza view by id')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cadenzaClose);

// Movement commands - compose the roomy, agent-driven "living view" in the main
// window. Each item is free-placed at (x, y) and renders a native BlockView or
// an isolated single-page HTML mockup.
const movement = encoreCommand(program, 'movement', 'concerto', encoreFlags).description(
	'Compose the agent-driven movement (free-placed data views) in the Maestro main window'
);

movement
	.command('begin <id>')
	.description('Reserve a host-rendered Concerto shell without opening the stage')
	.requiredOption('--title <text>', 'Concerto title shown in its frame')
	.option('--x <px>', 'X position (px from the Concerto stage left)')
	.option('--y <px>', 'Y position (px from the Concerto stage top)')
	.option('--width <px>', 'Shell width in px (default: 880)')
	.option('--height <px>', 'Shell height in px (default: 560)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementBegin);

movement
	.command('add <id>')
	.description('Add or replace a native data view or HTML mockup without opening the stage')
	.option('--type <type>', 'view | html (default: view)')
	.option('--x <px>', 'X position (px from movement left)')
	.option('--y <px>', 'Y position (px from movement top)')
	.option('--width <px>', 'Item width in px (default: 500 view, 880 html)')
	.option('--height <px>', 'Optional fixed item height in px (default: fit content)')
	.option('--title <text>', 'Item header title')
	.option(
		'--body <content>',
		'Block spec JSON for --type view, or a complete document for --type html'
	)
	.option('--body-file <path>', 'Read the view JSON or HTML document from a file')
	.option('--html-file <path>', 'Read an HTML document from a file (implies --type html)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementAdd);

movement
	.command('update <id>')
	.description('Update fields of an existing movement item in place')
	.option('--type <type>', 'Switch or confirm the item type: view | html')
	.option('--x <px>', 'New X position')
	.option('--y <px>', 'New Y position')
	.option('--width <px>', 'New width')
	.option('--height <px>', 'New fixed height')
	.option('--title <text>', 'New title')
	.option('--body <content>', 'New block spec JSON or HTML document')
	.option('--body-file <path>', 'Read the new view JSON or HTML document from a file')
	.option('--html-file <path>', 'Read a new HTML document from a file (implies --type html)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementUpdate);

movement
	.command('move <id>')
	.description('Reposition a movement item')
	.requiredOption('--x <px>', 'New X position')
	.requiredOption('--y <px>', 'New Y position')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementMove);

movement
	.command('remove <id>')
	.description('Remove a movement item by id')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementRemove);

movement
	.command('clear')
	.description('Remove all movement items')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementClear);

movement
	.command('progress <id>')
	.description("Report one Concerto track's current design phase and subdivision")
	.requiredOption('--title <text>', 'Concerto title shown in the pipeline')
	.requiredOption('--phase <phase>', 'composing | refining | arranging | reviewing | testing')
	.option('--step <n>', 'Active one-based substep (default: 1)')
	.option('--steps <n>', 'Planned substeps in this phase, 1 through 8 (default: 1)')
	.option(
		'--notes <pattern>',
		'Comma-separated quarter/eighth/sixteenth notes with optional +dotted, +triad, or +tie'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementProgress);

movement
	.command('state')
	.description('Read the current movement layout (items + size) to compose around it')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementState);

movement
	.command('inspect <id>')
	.description('Capture a visible HTML Movement preview (requires an open stage) and diagnostics')
	.requiredOption('--output <png>', 'Write the live mockup screenshot to this PNG path')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementInspect);

movement
	.command('interact <id>')
	.description('Interact with a live HTML Movement by CSS selector')
	.option('--click <selector>', 'Click the matching element')
	.option('--type <selector>', 'Enter text into the matching input or editable element')
	.option('--value <text>', 'Text used with --type')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementInteract);
program
	.command('support-package')
	.description(
		'Write a sanitized support (debug) package zip, as Create Debug Package does, without a save dialog'
	)
	.requiredOption(
		'-o, --output <dir>',
		'Directory to write maestro-debug-<timestamp>.zip into (created if missing; ~ expanded)'
	)
	.option('--no-logs', 'Leave out application logs')
	.option('--no-errors', 'Leave out recent errors')
	.option('--no-sessions', 'Leave out agent/session metadata')
	.option('--no-group-chats', 'Leave out group chat metadata')
	.option('--no-batch-state', 'Leave out Auto Run state')
	.option(
		'--allow-secrets',
		'Write the package even when the secret screen finds a possible credential (default: refuse and list them, masked)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(supportPackage);

const feedback = program
	.command('feedback')
	.description(
		'Send Feedback from the CLI: check gh, find duplicates, +1 an issue, or file a new one (open the modal with `open feedback`)'
	);

feedback
	.command('auth')
	.description(
		'Check that the GitHub CLI (gh) is installed, logged in, and allowed to file on the feedback repo (required to file); names the gh account, and prints the login command when signing in can fix it'
	)
	.option('--fresh', 'Skip the cached verdict (after logging in elsewhere)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(feedbackAuth);

feedback
	.command('login')
	.description(
		'Sign the GitHub CLI in for feedback (gh auth login, device code + browser), as the modal\'s "Log in to GitHub" does'
	)
	.option('--json', 'Output the result as JSON (for scripting)')
	.action(feedbackLogin);

feedback
	.command('accounts')
	.description(
		'List the provider accounts the Feedback chat can run as, in the order it tries them (first usable one wins)'
	)
	.option(
		'--use <key>',
		'Make this account (a key from the list) the one the next chat tries first'
	)
	.option('--clear', 'Forget the remembered account and pick automatically again')
	.option('--json', 'Output as JSON (for scripting)')
	.action(feedbackAccounts);

feedback
	.command('diagnose')
	.description(
		'Read the live app state the Feedback chat starts from: agents that are busy, errored, limit-paused, retrying, or running Auto Run, plus recent warnings and errors (redacted, read-only)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(feedbackDiagnose);

feedback
	.command('search <query>')
	.description('Search RunMaestro/Maestro for issues matching a description')
	.option('--json', 'Output as JSON (for scripting)')
	.action(feedbackSearch);

feedback
	.command('submit')
	.description(
		'File a GitHub issue exactly as the Feedback modal does. Stops on likely duplicates unless --force'
	)
	.requiredOption('-c, --category <category>', 'bug | feature | improvement | general')
	.requiredOption('-s, --summary <text>', 'One-line summary (max 120 chars; becomes the title)')
	.requiredOption(
		'-e, --expected <text>',
		'Expected behavior (bug) or desired outcome (other categories)'
	)
	.requiredOption('-a, --actual <text>', 'Actual behavior (bug) or details (other categories)')
	.option('--steps <text>', 'Steps to reproduce')
	.option('--context <text>', 'Additional context')
	.option(
		'--attach <image...>',
		'Screenshots to attach: PNG, JPG, GIF, or WebP, up to 5 files, 10 MB each'
	)
	.option(
		'--support-package',
		'Generate a sanitized support package and link it from the issue (the modal checkbox)'
	)
	.option('--force', 'File even when possible duplicates exist')
	.option(
		'--allow-secrets',
		'File even when the secret screen finds a possible credential (default: refuse and list them, masked)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(feedbackSubmit);

feedback
	.command('subscribe <issue>')
	.description('Add a +1 to an existing issue instead of filing a duplicate')
	.option('--comment <text>', 'Also post this comment on the issue')
	.option(
		'--allow-secrets',
		'Post the comment even when the secret screen finds a possible credential in it'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(feedbackSubscribe);

// Stats commands - introspect the Usage Dashboard's SQLite store (requires the
// running Maestro desktop app, which owns the open database).
const statsCommand = encoreCommand(program, 'stats', 'usageStats', encoreFlags)
	.description('Show aggregated Usage Dashboard metrics for a time range')
	.option('-r, --range <range>', 'Time range: day, week, month, quarter, year, all (default: week)')
	.option('--json', 'Output the full aggregation object as JSON')
	.action(stats);

// `stats` owns `--range` and `--json` too, and Commander hands a flag to the
// first command that knows it, so the flags written after `models` land on the
// parent. `optsWithGlobals()` reads them from wherever they landed.
statsCommand
	.command('models')
	.description(
		"Show what every model other than a provider's own did: sources, tasks, Run on agents, System One and the token proxy (the Usage Dashboard's Models tab)"
	)
	.option('-r, --range <range>', 'Time range: day, week, month, quarter, year, all (default: week)')
	.option('--json', 'Output the full model usage record as JSON')
	.action((_options: unknown, command: Command) => statsModels(command.optsWithGlobals()));

encoreCommand(program, 'stats-tokens', 'usageStats', encoreFlags)
	.description(
		'Show token usage, cost, and tokens per second (average and peak) per provider and model'
	)
	.option('-r, --range <range>', 'Time range: day, week, month, quarter, year, all (default: week)')
	.option('--refresh', "Re-read changed transcripts instead of the app's cached result")
	.option('--json', 'Output the full token usage object as JSON')
	.action(statsTokens);

program
	.command('stats-indexing')
	.description(
		'Show progress of a usage-data scan (a one-time re-read after an upgrade, or a first index)'
	)
	.option('--wait', 'Block until no scan is running, printing progress each second')
	.option('--timeout <seconds>', 'With --wait, give up after this many seconds (exit code 1)')
	.option('--json', 'Output as JSON')
	.action(statsIndexing);

encoreCommand(program, 'stats-query <sql>', 'usageStats', encoreFlags)
	.description('Run a read-only SQL query against the stats database (SELECT / read PRAGMA only)')
	.option(
		'-p, --param <value>',
		'Bind a value to a positional ? placeholder (repeatable, in order)',
		(value: string, prev: string[]) => [...prev, value],
		[] as string[]
	)
	.option('--json', 'Output rows as JSON instead of a tab-separated table')
	.action(statsQuery);

// Plugin authoring commands - scaffold, validate, sign, and package a Maestro
// plugin from the command line. The manifest/signature contracts are the shared
// pure modules the host loads against, so what validates and signs here is what
// the desktop app verifies at install time.
const plugin = program
	.command('plugin')
	.description('Author, validate, sign, and package Maestro plugins');

plugin
	.command('list')
	.description('Read installed plugin versions, load status, and enable state from the desktop')
	.option('--json', 'Output as JSON')
	.action((options) => pluginRuntime('list', undefined, options));

plugin
	.command('update <dir>')
	.description('Update an installed plugin from a local package directory, preserving data')
	.option('--json', 'Output the resulting plugin registry as JSON')
	.action((dir, options) => pluginRuntime('update', dir, options));

plugin
	.command('init [dir]')
	.description('Scaffold a new plugin in <dir> (defaults to the current directory)')
	.option('--tier <0|1|2>', 'Plugin trust/capability tier (default 1)')
	.option('--id <id>', 'Plugin id (defaults to a slug of the directory name)')
	.option('--name <name>', 'Human-readable plugin name (defaults to the id)')
	.option('--force', 'Scaffold into a non-empty directory')
	.option('--json', 'Output as JSON (for scripting)')
	.action((dir, options) => pluginInit(dir, options));

plugin
	.command('validate [dir]')
	.description('Validate <dir>/plugin.json and, when present, its signature.json')
	.option(
		'--trusted-key <keys>',
		'Comma-separated base64 public keys to treat as trusted when resolving signature status'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((dir, options) => pluginValidate(dir, options));

plugin
	.command('sign <dir>')
	.description('Sign <dir> with ed25519 and write signature.json')
	.option('--key <path>', 'Private key to sign with (PEM, or base64-encoded PKCS8 DER)')
	.option('--gen-key', 'Generate a fresh ed25519 keypair (requires --key-out)')
	.option('--key-out <path>', 'Where to write the generated private key (with --gen-key)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((dir, options) => pluginSign(dir, options));

plugin
	.command('pack <dir>')
	.description('Package <dir> into a distributable archive (excludes node_modules/.git/keys)')
	.option('--out <file>', 'Output archive path (default <id>-<version>.tgz)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((dir, options) => pluginPack(dir, options));

// MCP bridge command - an MCP stdio server that exposes the running app's
// registered plugin tools to an agent's model. Agents spawn this via their
// per-invocation MCP config (see src/shared/plugins/mcp-agent-config.ts); it
// bridges tools/list + tools/call to the desktop over the CLI WebSocket, each
// call risk-gated before the broker invokes the plugin handler.
const mcp = program
	.command('mcp')
	.description('Model Context Protocol bridge for Maestro plugin tools');

mcp
	.command('serve')
	.description(
		'Run an MCP stdio server exposing registered plugin tools (spawned by an agent via its MCP config)'
	)
	.option('--tab <id>', 'Originating desktop tab id (diagnostics only)')
	.action((options) => mcpServe(options));

// Every command shows its examples in `--help` and in `reference`.
applyCommandExamples(program);

// The tree walk in src/__tests__/cli/command-tree.test.ts imports this module for
// `program`; it must not parse the test runner's argv.
export { program };

// Commander auto-switches to from: 'electron' when process.versions.electron is
// set, which is still true under ELECTRON_RUN_AS_NODE=1. In that mode Commander
// only strips argv[0] and treats the script path as the first user command.
// Force node-style argv parsing so the shim that spawns us via Electron-as-Node
// (see MaestroCliManager.writeUnixShim / writeWindowsShim) works correctly.
if (!process.env.VITEST) {
	program.parse(process.argv, { from: 'node' });
}
