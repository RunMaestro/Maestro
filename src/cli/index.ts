#!/usr/bin/env node
// Maestro CLI
// Command-line interface for Maestro

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { listGroups } from './commands/list-groups';
import { listAgents } from './commands/list-agents';
import { listPlaybooks } from './commands/list-playbooks';
import { showPlaybook } from './commands/show-playbook';
import { showAgent } from './commands/show-agent';
import { cleanPlaybooks } from './commands/clean-playbooks';
import { send } from './commands/send';
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

// Read version from package.json at runtime
function getVersion(): string {
	try {
		// When bundled, __dirname points to dist/cli, so go up to project root
		const packagePath = path.resolve(__dirname, '../../package.json');
		const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
		return packageJson.version;
	} catch {
		return '0.0.0';
	}
}

const program = new Command();

program.name('maestro-cli').description('Command-line interface for Maestro').version(getVersion());

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

// Send command - send a message to an agent and get a JSON response
program
	.command('send <agent-id> <message>')
	.description('Send a message to an agent and get a JSON response')
	.option('-s, --session <id>', 'Resume an existing agent session (for multi-turn conversations)')
	.option('-r, --read-only', 'Run in read-only/plan mode (agent cannot modify files)')
	.option('-t, --tab', 'Open/focus the session tab in Maestro desktop')
	.option('-l, --live', 'Send message through Maestro desktop (appears in tab)')
	.option('--new-tab', 'Create a new AI tab instead of writing to the active one (requires --live)')
	.action(send);

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
		'Agent type (claude-code, codex, opencode, factory-droid, gemini-cli, qwen3-coder, aider)',
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

program.parse();
