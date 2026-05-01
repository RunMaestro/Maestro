#!/usr/bin/env node
// Maestro CLI
// Command-line interface for Maestro

import { Command, Option } from 'commander';
import { listGroups } from './commands/list-groups';
import { listAgents } from './commands/list-agents';
import { listPlaybooks } from './commands/list-playbooks';
import { showPlaybook } from './commands/show-playbook';
import { showAgent } from './commands/show-agent';
import { cleanPlaybooks } from './commands/clean-playbooks';
import { send } from './commands/send';
import { dispatch } from './commands/dispatch';
import { listSessions } from './commands/list-sessions';
import { openFile } from './commands/open-file';
import { openBrowser } from './commands/open-browser';
import { openTerminal } from './commands/open-terminal';
import { refreshFiles } from './commands/refresh-files';
import { refreshAutoRun } from './commands/refresh-auto-run';
import { status } from './commands/status';
import { autoRun } from './commands/auto-run';
import { cueTrigger } from './commands/cue-trigger';
import { cueList } from './commands/cue-list';
import { createAgent } from './commands/create-agent';
import { removeAgent } from './commands/remove-agent';
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
import {
	plannerDashboard,
	plannerPrdCreate,
	plannerPrdDecompose,
	plannerEpicDecompose,
	plannerSync,
} from './commands/planner';
import {
	fleetBoard,
	fleetList,
	fleetClaim,
	fleetRelease,
	fleetPause,
	fleetResume,
} from './commands/fleet';
import {
	convPrdList,
	convPrdStart,
	convPrdAsk,
	convPrdShow,
	convPrdFinalize,
	convPrdArchive,
} from './commands/conv-prd';

// Injected at build time by scripts/build-cli.mjs via esbuild `define`.
// The typeof guard keeps non-esbuild execution paths (ts-node, plain tsc output) from
// throwing a ReferenceError; in those paths the constant is never substituted.
declare const __MAESTRO_CLI_VERSION__: string;
const cliVersion: string =
	typeof __MAESTRO_CLI_VERSION__ !== 'undefined' ? __MAESTRO_CLI_VERSION__ : '0.0.0-dev';

const program = new Command();

program.name('maestro-cli').description('Command-line interface for Maestro').version(cliVersion);

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

// Playbook command (lazy-loaded to avoid eager resolution of generated/prompts)
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

// Clean command
const clean = program.command('clean').description('Clean up orphaned resources');

clean
	.command('playbooks')
	.description('Remove playbooks for deleted sessions')
	.option('--dry-run', 'Show what would be removed without actually removing')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cleanPlaybooks);

// Send command - run an agent locally and return its response synchronously.
// `--live`, `--new-tab`, and `--force` are retained as hidden aliases for
// `dispatch` during the deprecation window; new callers should use
// `maestro-cli dispatch` instead. Hiding them from `--help` keeps new users
// off the deprecated path while still parsing the flags from existing scripts.
program
	.command('send <agent-id> <message>')
	.description('Send a message to an agent and get a JSON response')
	.option('-s, --session <id>', 'Resume an existing agent session (for multi-turn conversations)')
	.option('-r, --read-only', 'Run in read-only/plan mode (agent cannot modify files)')
	.option('-t, --tab', 'Open/focus the session tab in Maestro desktop')
	.addOption(
		new Option(
			'-l, --live',
			'Send message through Maestro desktop (deprecated: use `dispatch`)'
		).hideHelp()
	)
	.addOption(
		new Option(
			'--new-tab',
			'Create a new AI tab instead of writing to the active one (deprecated: use `dispatch --new-tab`)'
		).hideHelp()
	)
	.addOption(
		new Option(
			'-f, --force',
			'Bypass the busy-state guard when writing to the active tab (deprecated: use `dispatch --force`)'
		).hideHelp()
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
		'-s, --session <id>',
		'Target an existing tab by its tab id (mutually exclusive with --new-tab)'
	)
	.option(
		'-f, --force',
		'Bypass the busy-state guard when writing to a busy tab; requires allowConcurrentSend (cannot be combined with --new-tab — a fresh tab is never busy)'
	)
	.action(dispatch);

// Open file command - open a file in the Maestro desktop app
program
	.command('open-file <file-path>')
	.description('Open a file as a preview tab in the Maestro desktop app')
	.option('-s, --session <id>', 'Target session (defaults to active)')
	.action(openFile);

// Open browser command - open a URL in a browser tab in the Maestro desktop app
program
	.command('open-browser <url>')
	.description('Open a URL as a browser tab in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.action(openBrowser);

// Open terminal command - open a new terminal tab in the Maestro desktop app
program
	.command('open-terminal')
	.description('Open a new terminal tab in the Maestro desktop app')
	.option('-a, --agent <id>', 'Target agent by ID (defaults to active)')
	.option('--cwd <path>', "Working directory for the terminal (must be within the agent's cwd)")
	.option('--shell <shell>', 'Shell binary to use (default: zsh)')
	.option('--name <name>', 'Display name for the tab')
	.action(openTerminal);

// Refresh files command - refresh the file tree in the Maestro desktop app
program
	.command('refresh-files')
	.description('Refresh the file tree in the Maestro desktop app')
	.option('-s, --session <id>', 'Target session (defaults to active)')
	.action(refreshFiles);

// Refresh auto-run command - refresh Auto Run documents in the Maestro desktop app
program
	.command('refresh-auto-run')
	.description('Refresh Auto Run documents in the Maestro desktop app')
	.option('-s, --session <id>', 'Target session (defaults to active)')
	.action(refreshAutoRun);

// Auto-run command - configure and optionally launch an auto-run session
program
	.command('auto-run <docs...>')
	.description('Configure and optionally launch an auto-run with documents')
	.option('-s, --session <id>', '[deprecated: use --agent] Target agent by ID')
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
		'--worktree-path <path>',
		'Filesystem path for the worktree (must be a sibling of the repo)'
	)
	.option('--create-pr', 'Open a GitHub PR when the auto-run completes successfully')
	.option(
		'--pr-target-branch <branch>',
		'Target branch for the PR (defaults to the repo default branch)'
	)
	.action(autoRun);

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
		'--auto-run-folder <path>',
		'Path to the agent Auto Run / playbooks folder (overrides the default <cwd>/.maestro/playbooks)'
	)
	.option('--json', 'Output as JSON (for scripting)')
	.action(createAgent);

// Remove agent command - remove an agent from the Maestro desktop app
program
	.command('remove-agent <agent-id>')
	.description('Remove an agent from the Maestro desktop app')
	.option('--json', 'Output as JSON (for scripting)')
	.action(removeAgent);

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
	.option('--json', 'Output as JSON line (for scripting)')
	.option('-v, --verbose', 'Show full details including description, type, and default')
	.action(settingsGet);

settings
	.command('set <key> <value>')
	.description('Set a setting value (auto-detects type: bool, number, JSON, string)')
	.option('--json', 'Output as JSON line (for scripting)')
	.option('--raw <json>', 'Pass an explicit JSON value (bypasses auto type coercion)')
	.action(settingsSet);

settings
	.command('reset <key>')
	.description('Reset a setting to its default value')
	.option('--json', 'Output as JSON line (for scripting)')
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
	.option('--json', 'Output as JSON line (for scripting)')
	.option('-v, --verbose', 'Show full details including description')
	.action(settingsAgentGet);

agent
	.command('set <agent-id> <key> <value>')
	.description('Set an agent config value (auto-detects type)')
	.option('--json', 'Output as JSON line (for scripting)')
	.option('--raw <json>', 'Pass an explicit JSON value (bypasses auto type coercion)')
	.action(settingsAgentSet);

agent
	.command('reset <agent-id> <key>')
	.description('Remove an agent config key')
	.option('--json', 'Output as JSON line (for scripting)')
	.action(settingsAgentReset);

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
	.option('-t, --type <type>', '[deprecated] success | info | warning | error — prefer --color')
	.option(
		'--timeout <seconds>',
		'Auto-dismiss after N seconds (range: (0, 60]; wins over --duration)'
	)
	.option(
		'-d, --duration <seconds>',
		'Auto-dismiss after N seconds (range: (0, 60]; omitted = app default)'
	)
	.option(
		'--dismissible',
		'Sticky toast — no auto-dismiss; user must click to close. Cannot combine with --timeout/--duration'
	)
	.option('-a, --agent <id>', 'Associate with an agent so clicking jumps to it')
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
	.option(
		'-v, --variant <variant>',
		'[deprecated] success | info | warning | error — prefer --color'
	)
	.option('-D, --detail <text>', 'Optional second line shown beneath the message')
	.option(
		'-t, --timeout <seconds>',
		'Auto-dismiss after N seconds (range: (0, 5]; default 1.5; wins over --duration)'
	)
	.option('-d, --duration <ms>', 'Auto-dismiss after N ms (range: (0, 5000]; default 1500)')
	.option('--json', 'Output as JSON (for scripting)')
	.action(notifyFlash);

// Planner commands — Delivery Planner (PRD → epic → tasks → GitHub sync).
// Requires the running Maestro desktop app with the Delivery Planner encore feature on.
const planner = program
	.command('planner')
	.description('Manage Delivery Planner work items (PRDs, epics, tasks)');

planner
	.command('dashboard')
	.description('Show all work items in the Delivery Planner dashboard')
	.option('-p, --project <path>', 'Project root path (defaults to current directory)')
	.option('--git-path <path>', 'Git repository root (defaults to --project)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) =>
		plannerDashboard({ project: options.project, gitPath: options.gitPath, json: options.json })
	);

const prd = planner.command('prd').description('Manage PRDs (Product Requirement Documents)');

prd
	.command('create')
	.description('Create a new PRD')
	.requiredOption('-t, --title <title>', 'PRD title')
	.option('-p, --project <path>', 'Project root path (defaults to current directory)')
	.option('--git-path <path>', 'Git repository root (defaults to --project)')
	.option('-d, --description <text>', 'Optional PRD description / problem statement')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) =>
		plannerPrdCreate({
			title: options.title,
			project: options.project,
			gitPath: options.gitPath,
			description: options.description,
			json: options.json,
		})
	);

prd
	.command('decompose <id>')
	.description('Decompose a PRD into an epic and tasks')
	.option('--json', 'Output as JSON (for scripting)')
	.action((id, options) => plannerPrdDecompose(id, { json: options.json }));

const epic = planner.command('epic').description('Manage epics');

epic
	.command('decompose <id>')
	.description('Decompose an epic into tasks')
	.option('--json', 'Output as JSON (for scripting)')
	.action((id, options) => plannerEpicDecompose(id, { json: options.json }));

planner
	.command('sync <id>')
	.description('Sync a work item to external systems')
	.option('--target <target>', 'Sync target: github | mirror | all (default: all)', 'all')
	.option('--json', 'Output as JSON (for scripting)')
	.action((id, options) =>
		plannerSync(id, {
			target: options.target as 'github' | 'mirror' | 'all',
			json: options.json,
		})
	);

// Fleet commands — Agent Dispatch: manage the fleet of agents that claim Work Graph items.
// NOTE: "fleet" = Agent Dispatch (long-lived agents claiming work items).
//       "dispatch" = Tab Dispatch (send a prompt to an agent tab). They are different.
const fleet = program
	.command('fleet')
	.description(
		'Manage the Agent Dispatch fleet (long-lived agents claiming Work Graph items).\n' +
			'  NOTE: for tab dispatch (sending prompts to a tab), use `maestro-cli dispatch`.'
	);

fleet
	.command('board')
	.description('Show work items grouped by status (kanban-style board)')
	.option('-p, --project <path>', 'Filter by project root path')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => fleetBoard({ project: options.project, json: options.json }));

fleet
	.command('list')
	.description('List all fleet entries with readiness, current load, and pickup status')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) => fleetList({ json: options.json }));

fleet
	.command('claim <workItemId>')
	.description('Manually assign a work item to a fleet entry')
	.requiredOption('--to <fleetEntryId>', 'Fleet entry ID to assign the work item to')
	.option('--note <text>', 'Optional note to attach to the claim')
	.option('--json', 'Output as JSON (for scripting)')
	.action((workItemId, options) =>
		fleetClaim(workItemId, { to: options.to, note: options.note, json: options.json })
	);

fleet
	.command('release <workItemId>')
	.description('Release an active claim on a work item')
	.option('--json', 'Output as JSON (for scripting)')
	.action((workItemId, options) => fleetRelease(workItemId, { json: options.json }));

fleet
	.command('pause <agentId>')
	.description('Pause auto-pickup for an agent (resets on app restart)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, options) => fleetPause(agentId, { json: options.json }));

fleet
	.command('resume <agentId>')
	.description('Resume auto-pickup for a previously-paused agent')
	.option('--json', 'Output as JSON (for scripting)')
	.action((agentId, options) => fleetResume(agentId, { json: options.json }));

// Conv-PRD commands — Conversational PRD planner: drive a PRD draft interactively via CLI.
// Requires the running Maestro desktop app with the Conversational PRD encore feature on.
// Sessions are persisted to ~/.config/maestro/conversational-prd-sessions.json (Linux/Windows)
// or ~/Library/Application Support/maestro/conversational-prd-sessions.json (macOS).
const convPrd = program
	.command('conv-prd')
	.description(
		'Drive the Conversational PRD planner (start sessions, send messages, finalize into Delivery Planner PRDs).\n' +
			'  Requires Maestro desktop running with Conversational PRD encore feature enabled.'
	);

convPrd
	.command('list')
	.description('List all Conversational PRD sessions')
	.option('-p, --project <path>', 'Filter by project root path')
	.option('--include-archived', 'Include archived sessions in the list')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) =>
		convPrdList({
			json: options.json,
			project: options.project,
			includeArchived: options.includeArchived,
		})
	);

convPrd
	.command('start')
	.description('Start a new Conversational PRD session, returns { sessionId }')
	.option('--initial <md>', 'Initial markdown content or brief to seed the session')
	.option('-p, --project <path>', 'Project root path for the PRD')
	.option('--json', 'Output as JSON (for scripting)')
	.action((options) =>
		convPrdStart({ initial: options.initial, project: options.project, json: options.json })
	);

convPrd
	.command('ask <sessionId> <message>')
	.description('Add a user turn to an existing session and receive the assistant reply')
	.option('--json', 'Output as JSON (for scripting)')
	.action((sessionId, message, options) => convPrdAsk(sessionId, message, { json: options.json }));

convPrd
	.command('show <sessionId>')
	.description('Show the current state of a session (messages + draft)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((sessionId, options) => convPrdShow(sessionId, { json: options.json }));

convPrd
	.command('finalize <sessionId>')
	.description(
		'Finalize the PRD session — emits the final PRD.\n' +
			'  With --handoff-to-planner, creates a Delivery Planner PRD work item from the result.'
	)
	.option('--handoff-to-planner', 'Create a Delivery Planner PRD work item and return its ID')
	.option('--json', 'Output as JSON (for scripting)')
	.action((sessionId, options) =>
		convPrdFinalize(sessionId, {
			handoffToPlanner: options.handoffToPlanner,
			json: options.json,
		})
	);

convPrd
	.command('archive <sessionId>')
	.description('Archive a session (hides it from the default list)')
	.option('--json', 'Output as JSON (for scripting)')
	.action((sessionId, options) => convPrdArchive(sessionId, { json: options.json }));

// Commander auto-switches to from: 'electron' when process.versions.electron is
// set, which is still true under ELECTRON_RUN_AS_NODE=1. In that mode Commander
// only strips argv[0] and treats the script path as the first user command.
// Force node-style argv parsing so the shim that spawns us via Electron-as-Node
// (see MaestroCliManager.writeUnixShim / writeWindowsShim) works correctly.
program.parse(process.argv, { from: 'node' });
