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
import { runPlaybook } from './commands/run-playbook';
import { cleanPlaybooks } from './commands/clean-playbooks';

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

// Playbook command
program
	.command('playbook <playbook-id>')
	.description('Run a playbook')
	.option('--dry-run', 'Show what would be executed without running')
	.option('--no-history', 'Do not write history entries')
	.option('--json', 'Output as JSON lines (for scripting)')
	.option('--debug', 'Show detailed debug output for troubleshooting')
	.option('--verbose', 'Show full prompt sent to agent on each iteration')
	.option('--wait', 'Wait for agent to become available if busy')
	.action(runPlaybook);

// Clean command
const clean = program.command('clean').description('Clean up orphaned resources');

clean
	.command('playbooks')
	.description('Remove playbooks for deleted sessions')
	.option('--dry-run', 'Show what would be removed without actually removing')
	.option('--json', 'Output as JSON (for scripting)')
	.action(cleanPlaybooks);

program.parse();
