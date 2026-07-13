#!/usr/bin/env node
// Maestro CLI
// Command-line interface for Maestro

import { Command } from 'commander';
import { listGroups } from './commands/list-groups';
import { listAgents } from './commands/list-agents';
import { listPlaybooks } from './commands/list-playbooks';
import { showPlaybook } from './commands/show-playbook';
import { showAgent } from './commands/show-agent';
import { cleanPlaybooks } from './commands/clean-playbooks';
import { send } from './commands/send';
import { dispatch } from './commands/dispatch';
import { sessionList, sessionShow } from './commands/session';
import { listSessions } from './commands/list-sessions';
import { openFile } from './commands/open-file';
import { openBrowser } from './commands/open-browser';
import { openTerminal } from './commands/open-terminal';
import { refreshFiles } from './commands/refresh-files';
import { refreshAutoRun } from './commands/refresh-auto-run';
import { status } from './commands/status';
import { version } from './commands/version';
import { doctor } from './commands/doctor';
import { completions } from './commands/completions';
import { reference } from './commands/reference';
import { autoRun } from './commands/auto-run';
import { cueTrigger } from './commands/cue-trigger';
import { cueList } from './commands/cue-list';
import { cueSchedule } from './commands/cue-schedule';
import {
	cuePipelineAdd,
	cuePipelineExport,
	cuePipelineGet,
	cuePipelineList,
	cuePipelineRemove,
	cuePipelineReplace,
} from './commands/cue-pipeline';
import { createAgent } from './commands/create-agent';
import { createGroup } from './commands/create-group';
import { removeGroup } from './commands/remove-group';
import { createWorktree } from './commands/create-worktree';
import { removeAgent } from './commands/remove-agent';
import { updateAgent } from './commands/update-agent';
import { listSshRemotes } from './commands/list-ssh-remotes';
import { createSshRemote } from './commands/create-ssh-remote';
import { removeSshRemote } from './commands/remove-ssh-remote';
import { directorNotesHistory } from './commands/director-notes-history';
import { directorNotesSynopsis } from './commands/director-notes-synopsis';
import { settingsList } from './commands/settings-list';
import { settingsGet } from './commands/settings-get';
import { settingsSet } from './commands/settings-set';
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
import { profilingStart, profilingStop, profilingStatus } from './commands/profiling';
import { cadenzaOpen, cadenzaUpdate, cadenzaClose } from './commands/cadenza';
import {
	movementAdd,
	movementUpdate,
	movementMove,
	movementRemove,
	movementClear,
	movementState,
} from './commands/movement';
import { stats, statsQuery } from './commands/stats';
import { renameAgent } from './commands/rename-agent';
import { renameGroup } from './commands/rename-group';
import {
	stopAutoRun,
	resumeAutoRun,
	skipAutoRun,
	abortAutoRun,
	resetAutoRunTasks,
} from './commands/auto-run-control';
import { removePlaybook } from './commands/remove-playbook';
import { focusAgent, switchMode } from './commands/agent-control';
import { tabNew, tabClose, tabRename, tabStar } from './commands/tab';
import { setTheme } from './commands/set-theme';
import { themeShow, themeExport, themeImport, themeSet } from './commands/theme';
import { encoreList, encoreSet } from './commands/encore';
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
import { pluginInit, pluginValidate, pluginSign, pluginPack } from './commands/plugin';
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

// Injected at build time by scripts/build-cli.mjs via esbuild `define`.
// The typeof guard keeps non-esbuild execution paths (ts-node, plain tsc output) from
// throwing a ReferenceError; in those paths the constant is never substituted.
declare const __MAESTRO_CLI_VERSION__: string;
const cliVersion: string =
	typeof __MAESTRO_CLI_VERSION__ !== 'undefined' ? __MAESTRO_CLI_VERSION__ : '0.0.0-dev';

const program = new Command();

program.name('maestro-cli').description('Command-line interface for Maestro').version(cliVersion);

// Global verbosity flags. `--verbose` has no short alias on purpose: several
// subcommands already use `-v` for their own verbose option, and a global `-v`
// would shadow them. The preAction hook below copies the parsed values into the
// shared verbosity module before any command action runs.
program
	.option('-q, --quiet', 'Suppress incidental success output (errors still print)')
	.option('--verbose', 'Print extra detail where available');

program.hook('preAction', (thisCommand) => {
	const opts = thisCommand.opts();
	setVerbosity({ quiet: Boolean(opts.quiet), verbose: Boolean(opts.verbose) });
});
// AgentRun and campaign commands — neutral ledger/read-model spine for external
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

// Show command
const show = program.command('show').description('Show details of a resource');

show
	.command('agent <id>')
	.description('Show agent details including history and usage stats')
	.option('--json', 'Output as JSON (for scripting)')
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
		'--no-system-prompt',
		'Skip the Maestro system prompt (agent identity, git branch, history path, conductor profile). Default is to include it for parity with the desktop app.'
	)
	.action(send);

// Dispatch command - hand a prompt to the desktop and return tab/session ID.
// Splits the desktop-handoff half of `send --live` into a dedicated verb so
// callers can address the same tab again without owning a persistent channel.
program
	.command('dispatch <agent-id> <message>')
	.description(
		'Dispatch a prompt to an agent in the Maestro desktop app and return its tab/session ID'
	)
	.option('--new-tab', 'Create a fresh AI tab and dispatch the prompt into it')
	.option(
		'-t, --tab <id>',
		'Target an existing tab by its tab id (mutually exclusive with --new-tab)'
	)
	.option(
		'-f, --force',
		'Bypass the busy-state guard when writing to a busy tab; requires allowConcurrentSend (cannot be combined with --new-tab — a fresh tab is never busy)'
	)
	.action(dispatch);

// Session inspection commands - read-only access to desktop conversation state.
// Lets external pollers (Maestro-Discord, Cue follow-ups) pick up where Maestro
// left off without owning a persistent channel — pair with `dispatch` to write
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

// Open file command - open a file in the Maestro desktop app
program
	.command('open-file <file-path>')
	.description('Open a file as a preview tab in the Maestro desktop app')
	.option('-a, --agent <id>', "Target agent (defaults to auto-detect by file path's owning agent)")
	.option('--no-switch', "Don't switch the Maestro UI to the target agent/tab")
	.option('--json', 'Output as JSON (for scripting)')
	.action(openFile);

// Open browser command - open a URL in a browser tab in the Maestro desktop app
program
	.command('open-browser <url>')
	.description('Open a URL as a browser tab in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(openBrowser);

// Open terminal command - open a new terminal tab in the Maestro desktop app
program
	.command('open-terminal')
	.description('Open a new terminal tab in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option('--cwd <path>', "Working directory for the terminal (must be within the agent's cwd)")
	.option('--shell <shell>', 'Shell binary to use (default: zsh)')
	.option('--name <name>', 'Display name for the tab')
	.option('--json', 'Output as JSON (for scripting)')
	.action(openTerminal);

// Refresh files command - refresh the file tree in the Maestro desktop app
program
	.command('refresh-files')
	.description('Refresh the file tree in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(refreshFiles);

// Refresh auto-run command - refresh Auto Run documents in the Maestro desktop app
program
	.command('refresh-auto-run')
	.description('Refresh Auto Run documents in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
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

// Remove playbook command - delete a saved playbook from an agent
program
	.command('remove-playbook <agent-id> <playbook-id>')
	.description('Remove a saved playbook from an agent (find IDs via "list playbooks -a <agent>")')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, playbookId, options) => removePlaybook(agentId, playbookId, options));

// Cue commands - interact with Maestro Cue automation
const cue = program.command('cue').description('Interact with Maestro Cue automation');

cue
	.command('trigger <subscription-name>')
	.description('Manually trigger a Cue subscription by name')
	.option('-p, --prompt <text>', 'Override the subscription prompt with custom text')
	.option('--json', 'Output as JSON (for scripting)')
	.option('--source-agent-id <id>', 'Agent ID to pass as source context for write-back')
	.action(cueTrigger);

cue
	.command('list')
	.description('List all Cue subscriptions across agents')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueList);

// Cue schedule — author / inspect / cancel one-shot `time.once` subscriptions.
// Primary agent surface for "in 20 minutes do X" or "remind me at 4pm…" — writes
// directly to the agent's `.maestro/cue.yaml` so it works without the desktop
// app running. See `cue-schedule.ts` for the full flag matrix.
cue
	.command('schedule')
	.description('Schedule a one-shot Cue task (or --list / --cancel pending tasks)')
	.option('--in <duration>', 'Fire after a relative delay (e.g. 30s, 20m, 2h, 1d)')
	.option('--at <timestamp>', 'Fire at ISO-8601 timestamp or "YYYY-MM-DD HH:MM" (local time)')
	.option('--list', 'List all pending one-shot tasks across agents')
	.option('--cancel <name>', 'Cancel a pending one-shot task by name')
	.option('-a, --agent <id-or-name>', 'Target agent (required when creating)')
	.option('-p, --prompt <text>', 'Prompt to send when the task fires')
	.option('--notify', 'Show a toast notification when the task fires')
	.option('--sticky', 'Make the notify toast sticky (requires --notify)')
	.option('-m, --message <text>', 'Body for the notify toast (defaults to label/prompt)')
	.option('-n, --name <name>', 'Custom subscription name (auto-generated when omitted)')
	.option('-l, --label <text>', 'Human-readable label (defaults to truncated prompt)')
	.option('--pipeline <name>', 'Pipeline name (default: Tasks)')
	.option('--grace-minutes <n>', 'Override the default 360-minute grace window')
	.option(
		'--keep-on-failure',
		'Keep the subscription on a failed/timed-out run (default: self-destructs on both success and failure)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(cueSchedule);

// Cue pipeline subcommands — manage entries in cue-pipeline-layout.json.
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

// Director's Notes commands
const directorNotes = program
	.command('director-notes')
	.description("Director's Notes: unified history and AI synopsis");

directorNotes
	.command('history')
	.description('Show unified history across all agents')
	.option('-d, --days <n>', 'Lookback period in days (default: from app settings)')
	.option('-f, --format <type>', 'Output format: json, markdown, text (default: text)')
	.option('--filter <type>', 'Filter by entry type: auto, user, cue')
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
	.action((options) => reference(program, options));

// Create agent command - create a new agent in the Maestro desktop app
program
	.command('create-agent <name>')
	.description('Create a new agent in the Maestro desktop app')
	.requiredOption('-d, --cwd <path>', 'Working directory for the agent')
	.option(
		'-t, --type <type>',
		'Agent type (claude-code, codex, opencode, factory-droid, copilot-cli, gemini-cli, qwen3-coder)',
		'claude-code'
	)
	.option('-g, --group <id>', 'Group ID to assign the agent to')
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
	.option('--model <model>', 'Model override (e.g., sonnet, opus)')
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
	.option('--json', 'Output as JSON (for scripting)')
	.action(createAgent);

// Create group command - create a new group in the Maestro desktop app
program
	.command('create-group <name>')
	.description('Create a new group in the Maestro desktop app')
	.option('-e, --emoji <emoji>', 'Emoji icon for the group')
	.option('--parent <group-id>', 'Create inside this root group')
	.option('--json', 'Output as JSON (for scripting)')
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
	.option('--model <model>', 'Model override (e.g. sonnet, opus; empty string clears)')
	.option('--effort <level>', 'Effort/reasoning level override (empty string clears)')
	.option('--context-window <size>', 'Context window size in tokens (0 or "none" clears)')
	.option(
		'--token-source <mode>',
		'Claude token source: api | tui | dynamic (Claude Code agents only)'
	)
	.option('--maestro-p-path <path>', 'Override the maestro-p binary path (empty string clears)')
	.option(
		'--provider <type>',
		'Switch the agent provider (resets tabs + clears provider config; requires --force)'
	)
	.option('--force', 'Confirm a destructive change (required for --provider)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(updateAgent);

// Rename agent command - change an agent's display name in the desktop app
program
	.command('rename-agent <agent-id> <new-name>')
	.description('Rename an agent in the Maestro desktop app')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, newName, options) => renameAgent(agentId, newName, options));

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
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, mode, options) => switchMode(agentId, mode, options));

// Tab commands - manage an agent's AI tabs in the desktop app
const tab = program.command('tab').description("Manage an agent's tabs in the desktop app");

tab
	.command('new')
	.description('Open a new tab for an agent (optionally seeded with a prompt)')
	.requiredOption('-a, --agent <id>', 'Target agent ID')
	.option('-p, --prompt <text>', 'Seed the new AI tab with this prompt')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => tabNew(options));

tab
	.command('close <tab-id>')
	.description('Close a tab (owning agent is resolved automatically)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((tabId, options) => tabClose(tabId, options));

tab
	.command('rename <tab-id> <new-name>')
	.description('Rename a tab')
	.option('--json', 'Output as JSON (for scripting)')
	.action((tabId, newName, options) => tabRename(tabId, newName, options));

tab
	.command('star <tab-id>')
	.description('Star a tab')
	.option('--json', 'Output as JSON (for scripting)')
	.action((tabId, options) => tabStar(tabId, true, options));

tab
	.command('unstar <tab-id>')
	.description('Unstar a tab')
	.option('--json', 'Output as JSON (for scripting)')
	.action((tabId, options) => tabStar(tabId, false, options));

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
	.option('--ssh-config', 'Use ~/.ssh/config for connection settings (host becomes Host pattern)')
	.option('--disabled', 'Create in disabled state')
	.option('--set-default', 'Set as the global default SSH remote')
	.option('--json', 'Output as JSON (for scripting)')
	.action(createSshRemote);

// Remove SSH remote command - delete an SSH remote configuration
program
	.command('remove-ssh-remote <remote-id>')
	.description('Remove an SSH remote configuration')
	.option('--json', 'Output as JSON (for scripting)')
	.action(removeSshRemote);

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

// Agent-specific config subcommands
const agent = settings.command('agent').description('View and manage per-agent configuration');

agent
	.command('list [agent-id]')
	.description('List agent configurations (all agents or a specific one)')
	.option('--json', 'Output as JSON lines (for scripting)')
	.option('-v, --verbose', 'Show descriptions for each config key')
	.action(settingsAgentList);

agent
	.command('get <agent-id> <key>')
	.description('Get a single agent config value')
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

// Encore commands - list and toggle experimental Encore features (applies live)
const encore = program
	.command('encore')
	.description('List and toggle experimental Encore features');

encore
	.command('list')
	.description('List Encore features and whether each is enabled')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => encoreList(options));

encore
	.command('enable <feature>')
	.description(
		'Enable an Encore feature (directorNotes, usageStats, symphony, maestroCue, pianola)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action((feature, options) => encoreSet(feature, true, options));

encore
	.command('disable <feature>')
	.description('Disable an Encore feature')
	.option('--json', 'Output as JSON (for scripting)')
	.action((feature, options) => encoreSet(feature, false, options));

// Pianola - the autonomous manager agent (Encore-gated, off by default).
const pianola = program
	.command('pianola')
	.description('Pianola manager agent: watch tabs, auto-answer or escalate per your rules');

pianola
	.command('watch <tab-id>')
	.description('Watch a desktop tab and act on awaiting-input prompts per your rules')
	.option('--agent <agent-id>', 'Agent id to dispatch answers to (defaults to the tab owner)')
	.option('--interval <seconds>', 'Polling interval in seconds (default 5)')
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

// Prompts command — read Maestro's bundled or user-customized system prompts.
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

// Gist commands — publish agent session transcripts to GitHub gists via the
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
	.action(gistCreate);

// Notify commands — surface notifications in the Maestro desktop app
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
		'Sticky toast — no auto-dismiss; user must click to close. Cannot combine with --timeout'
	)
	.option('-a, --agent <id>', 'Associate with an agent so clicking jumps to it')
	.option(
		'--source-agent <label>',
		'Label shown in the toast header identifying which agent/pipeline fired it. Store-independent, so it shows even for cron/watchdog toasts. Wins over the name resolved from --agent; pair with --agent to also get click-to-jump'
	)
	.option(
		'--tab <id>',
		'AI tab ID within the agent — clicking jumps to that tab (requires --agent)'
	)
	.option(
		'--action-url <url>',
		'Inline link rendered beneath the message body (opens in browser when clicked)'
	)
	.option('--action-label <text>', 'Label for --action-url (defaults to the URL itself)')
	.option(
		'--open-file <path>',
		'On click, switch to the agent and open this file in its File Preview pane (requires --agent; mutually exclusive with --open-url)'
	)
	.option(
		'--open-url <url>',
		'On click, open this URL in the system browser (mutually exclusive with --open-file)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(notifyToast);

notify
	.command('flash <message>')
	.description('Show a center-screen flash (momentary, exclusive — replaces any active flash)')
	.option('-c, --color <color>', 'green | yellow | orange | red | theme (default: theme)')
	.option('-D, --detail <text>', 'Optional second line shown beneath the message')
	.option('-t, --timeout <seconds>', 'Auto-dismiss after N seconds (range: (0, 5]; default 1.5)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(notifyFlash);

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

// Cadenza commands - open small cadenza panels that display or track work.
const cadenza = program
	.command('cadenza')
	.description('Open small cadenza views to display or track work in the Maestro desktop app');

cadenza
	.command('open <id>')
	.description('Open (or replace by id) a cadenza view')
	.option(
		'--type <type>',
		'tracker | file | markdown | image | code | view | decision (default: tracker)'
	)
	.option('--title <text>', 'Header label for the panel')
	.option(
		'--body <text>',
		'Body content - tracker line, markdown/code source, JSON block spec (--type view), or the prompt (--type decision)'
	)
	.option(
		'--body-file <path>',
		'Read body content from a file (large markdown or a view JSON spec)'
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
// window. Each item is free-placed at (x, y) and renders a BlockView JSON spec.
const movement = program
	.command('movement')
	.description(
		'Compose the agent-driven movement (free-placed data views) in the Maestro main window'
	);

movement
	.command('add <id>')
	.description('Add (or replace by id) a movement item rendering a JSON block spec')
	.option('--x <px>', 'X position (px from movement left)')
	.option('--y <px>', 'Y position (px from movement top)')
	.option('--width <px>', 'Item width in px (default 320)')
	.option('--height <px>', 'Optional fixed item height in px (default: fit content)')
	.option('--title <text>', 'Item header title')
	.option(
		'--body <json>',
		'Block spec JSON, e.g. {"blocks":[{"kind":"stat","label":"Tests","value":8}]}'
	)
	.option('--body-file <path>', 'Read the block spec JSON from a file')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementAdd);

movement
	.command('update <id>')
	.description('Update fields of an existing movement item in place')
	.option('--x <px>', 'New X position')
	.option('--y <px>', 'New Y position')
	.option('--width <px>', 'New width')
	.option('--height <px>', 'New fixed height')
	.option('--title <text>', 'New title')
	.option('--body <json>', 'New block spec JSON')
	.option('--body-file <path>', 'Read the new block spec JSON from a file')
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
	.command('state')
	.description('Read the current movement layout (items + size) to compose around it')
	.option('--json', 'Output as JSON (for scripting)')
	.action(movementState);

// Stats commands - introspect the Usage Dashboard's SQLite store (requires the
// running Maestro desktop app, which owns the open database).
program
	.command('stats')
	.description('Show aggregated Usage Dashboard metrics for a time range')
	.option('-r, --range <range>', 'Time range: day, week, month, quarter, year, all (default: week)')
	.option('--json', 'Output the full aggregation object as JSON')
	.action(stats);

program
	.command('stats-query <sql>')
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

// Commander auto-switches to from: 'electron' when process.versions.electron is
// set, which is still true under ELECTRON_RUN_AS_NODE=1. In that mode Commander
// only strips argv[0] and treats the script path as the first user command.
// Force node-style argv parsing so the shim that spawns us via Electron-as-Node
// (see MaestroCliManager.writeUnixShim / writeWindowsShim) works correctly.
program.parse(process.argv, { from: 'node' });
