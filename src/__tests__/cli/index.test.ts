import { afterEach, describe, expect, it, vi } from 'vitest';

interface RecordedOption {
	flags: string;
	description: string;
}

interface RecordedCommand {
	pattern?: string;
	nameValue?: string;
	descriptionValue?: string;
	versionValue?: string;
	options: RecordedOption[];
	commands: RecordedCommand[];
	actionHandler?: (...args: unknown[]) => unknown;
	parseCalls: number;
	command(pattern: string): RecordedCommand;
	description(value: string): RecordedCommand;
	name(value: string): RecordedCommand;
	option(flags: string, description: string): RecordedCommand;
	action(handler: (...args: unknown[]) => unknown): RecordedCommand;
	version(value: string): RecordedCommand;
	parse(): RecordedCommand;
}

const commanderState = vi.hoisted(() => ({
	root: undefined as RecordedCommand | undefined,
	instances: [] as RecordedCommand[],
}));

const fsMock = vi.hoisted(() => ({
	readFileSync: vi.fn(),
}));

const commandHandlers = vi.hoisted(() => ({
	cleanPlaybooks: vi.fn(),
	listAgents: vi.fn(),
	listGroups: vi.fn(),
	listPlaybooks: vi.fn(),
	listSessions: vi.fn(),
	runPlaybook: vi.fn(),
	send: vi.fn(),
	settingsAgentGet: vi.fn(),
	settingsAgentList: vi.fn(),
	settingsAgentReset: vi.fn(),
	settingsAgentSet: vi.fn(),
	settingsGet: vi.fn(),
	settingsList: vi.fn(),
	settingsReset: vi.fn(),
	settingsSet: vi.fn(),
	showAgent: vi.fn(),
	showPlaybook: vi.fn(),
}));

vi.mock('fs', () => fsMock);

vi.mock('commander', () => {
	class FakeCommand implements RecordedCommand {
		pattern?: string;
		nameValue?: string;
		descriptionValue?: string;
		versionValue?: string;
		options: RecordedOption[] = [];
		commands: RecordedCommand[] = [];
		actionHandler?: (...args: unknown[]) => unknown;
		parseCalls = 0;

		constructor(pattern?: string) {
			this.pattern = pattern;
			if (!pattern && !commanderState.root) {
				commanderState.root = this;
			}
			commanderState.instances.push(this);
		}

		command(pattern: string): RecordedCommand {
			const child = new FakeCommand(pattern);
			this.commands.push(child);
			return child;
		}

		description(value: string): RecordedCommand {
			this.descriptionValue = value;
			return this;
		}

		name(value: string): RecordedCommand {
			this.nameValue = value;
			return this;
		}

		option(flags: string, description: string): RecordedCommand {
			this.options.push({ flags, description });
			return this;
		}

		action(handler: (...args: unknown[]) => unknown): RecordedCommand {
			this.actionHandler = handler;
			return this;
		}

		version(value: string): RecordedCommand {
			this.versionValue = value;
			return this;
		}

		parse(): RecordedCommand {
			this.parseCalls += 1;
			return this;
		}
	}

	return { Command: FakeCommand };
});

vi.mock('../../cli/commands/clean-playbooks', () => ({
	cleanPlaybooks: commandHandlers.cleanPlaybooks,
}));
vi.mock('../../cli/commands/list-agents', () => ({ listAgents: commandHandlers.listAgents }));
vi.mock('../../cli/commands/list-groups', () => ({ listGroups: commandHandlers.listGroups }));
vi.mock('../../cli/commands/list-playbooks', () => ({
	listPlaybooks: commandHandlers.listPlaybooks,
}));
vi.mock('../../cli/commands/list-sessions', () => ({
	listSessions: commandHandlers.listSessions,
}));
vi.mock('../../cli/commands/run-playbook', () => ({ runPlaybook: commandHandlers.runPlaybook }));
vi.mock('../../cli/commands/send', () => ({ send: commandHandlers.send }));
vi.mock('../../cli/commands/settings-agent', () => ({
	settingsAgentGet: commandHandlers.settingsAgentGet,
	settingsAgentList: commandHandlers.settingsAgentList,
	settingsAgentReset: commandHandlers.settingsAgentReset,
	settingsAgentSet: commandHandlers.settingsAgentSet,
}));
vi.mock('../../cli/commands/settings-get', () => ({ settingsGet: commandHandlers.settingsGet }));
vi.mock('../../cli/commands/settings-list', () => ({ settingsList: commandHandlers.settingsList }));
vi.mock('../../cli/commands/settings-reset', () => ({
	settingsReset: commandHandlers.settingsReset,
}));
vi.mock('../../cli/commands/settings-set', () => ({ settingsSet: commandHandlers.settingsSet }));
vi.mock('../../cli/commands/show-agent', () => ({ showAgent: commandHandlers.showAgent }));
vi.mock('../../cli/commands/show-playbook', () => ({
	showPlaybook: commandHandlers.showPlaybook,
}));

async function loadCli(versionReadResult: string | Error = JSON.stringify({ version: '9.8.7' })) {
	vi.resetModules();
	commanderState.root = undefined;
	commanderState.instances.length = 0;
	fsMock.readFileSync.mockReset();
	if (versionReadResult instanceof Error) {
		fsMock.readFileSync.mockImplementation(() => {
			throw versionReadResult;
		});
	} else {
		fsMock.readFileSync.mockReturnValue(versionReadResult);
	}

	await import('../../cli/index');

	const root = commanderState.root;
	expect(root).toBeDefined();
	return root!;
}

function findCommand(parent: RecordedCommand, pattern: string): RecordedCommand {
	const command = parent.commands.find((child) => child.pattern === pattern);
	expect(command, `Expected command ${pattern}`).toBeDefined();
	return command!;
}

function expectAction(
	parent: RecordedCommand,
	pattern: string,
	handler: (...args: unknown[]) => unknown
) {
	expect(findCommand(parent, pattern).actionHandler).toBe(handler);
}

describe('CLI entrypoint', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('configures the root command with package version and parses argv', async () => {
		const root = await loadCli();

		expect(root.nameValue).toBe('maestro-cli');
		expect(root.descriptionValue).toBe('Command-line interface for Maestro');
		expect(root.versionValue).toBe('9.8.7');
		expect(root.parseCalls).toBe(1);
		expect(fsMock.readFileSync).toHaveBeenCalledWith(
			expect.stringContaining('package.json'),
			'utf-8'
		);
	});

	it('falls back to 0.0.0 when package version cannot be read', async () => {
		const root = await loadCli(new Error('missing package'));

		expect(root.versionValue).toBe('0.0.0');
	});

	it('registers list, show, clean, and send command handlers with expected options', async () => {
		const root = await loadCli();

		const list = findCommand(root, 'list');
		expect(list.descriptionValue).toBe('List resources');
		expectAction(list, 'groups', commandHandlers.listGroups);
		expectAction(list, 'agents', commandHandlers.listAgents);
		expect(findCommand(list, 'agents').options).toEqual(
			expect.arrayContaining([
				{ flags: '-g, --group <id>', description: 'Filter by group ID' },
				{ flags: '--json', description: 'Output as JSON lines (for scripting)' },
			])
		);
		expectAction(list, 'playbooks', commandHandlers.listPlaybooks);
		expectAction(list, 'sessions <agent-id>', commandHandlers.listSessions);

		const show = findCommand(root, 'show');
		expectAction(show, 'agent <id>', commandHandlers.showAgent);
		expectAction(show, 'playbook <id>', commandHandlers.showPlaybook);

		expectAction(findCommand(root, 'clean'), 'playbooks', commandHandlers.cleanPlaybooks);
		expectAction(root, 'send <agent-id> <message>', commandHandlers.send);
		expect(findCommand(root, 'send <agent-id> <message>').options).toEqual([
			{
				flags: '-s, --session <id>',
				description: 'Resume an existing agent session (for multi-turn conversations)',
			},
		]);
	});

	it('registers settings and per-agent settings command handlers', async () => {
		const root = await loadCli();
		const settings = findCommand(root, 'settings');

		expect(settings.descriptionValue).toBe('View and manage Maestro configuration');
		expectAction(settings, 'list', commandHandlers.settingsList);
		expect(findCommand(settings, 'list').options.map((option) => option.flags)).toEqual([
			'--json',
			'-v, --verbose',
			'--keys-only',
			'--defaults',
			'-c, --category <name>',
			'--show-secrets',
		]);
		expectAction(settings, 'get <key>', commandHandlers.settingsGet);
		expectAction(settings, 'set <key> <value>', commandHandlers.settingsSet);
		expectAction(settings, 'reset <key>', commandHandlers.settingsReset);

		const agent = findCommand(settings, 'agent');
		expect(agent.descriptionValue).toBe('View and manage per-agent configuration');
		expectAction(agent, 'list [agent-id]', commandHandlers.settingsAgentList);
		expectAction(agent, 'get <agent-id> <key>', commandHandlers.settingsAgentGet);
		expectAction(agent, 'set <agent-id> <key> <value>', commandHandlers.settingsAgentSet);
		expectAction(agent, 'reset <agent-id> <key>', commandHandlers.settingsAgentReset);
	});

	it('lazy-loads the playbook runner when the playbook command action runs', async () => {
		const root = await loadCli();
		const playbook = findCommand(root, 'playbook <playbook-id>');

		expect(playbook.options.map((option) => option.flags)).toEqual([
			'--dry-run',
			'--no-history',
			'--json',
			'--debug',
			'--verbose',
			'--no-synopsis',
			'--wait',
		]);

		await playbook.actionHandler?.('playbook-1', { dryRun: true });

		expect(commandHandlers.runPlaybook).toHaveBeenCalledWith('playbook-1', { dryRun: true });
	});
});
