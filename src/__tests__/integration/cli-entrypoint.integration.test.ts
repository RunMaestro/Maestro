import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CommandNode {
	spec: string;
	children: CommandNode[];
	options: string[];
	actionHandler?: (...args: unknown[]) => unknown;
	name: ReturnType<typeof vi.fn>;
	description: ReturnType<typeof vi.fn>;
	version: ReturnType<typeof vi.fn>;
	command: ReturnType<typeof vi.fn>;
	option: ReturnType<typeof vi.fn>;
	action: ReturnType<typeof vi.fn>;
	parse: ReturnType<typeof vi.fn>;
}

const actionMocks = {
	listGroups: vi.fn(),
	listAgents: vi.fn(),
	listPlaybooks: vi.fn(),
	showPlaybook: vi.fn(),
	showAgent: vi.fn(),
	cleanPlaybooks: vi.fn(),
	send: vi.fn(),
	listSessions: vi.fn(),
	settingsList: vi.fn(),
	settingsGet: vi.fn(),
	settingsSet: vi.fn(),
	settingsReset: vi.fn(),
	settingsAgentList: vi.fn(),
	settingsAgentGet: vi.fn(),
	settingsAgentSet: vi.fn(),
	settingsAgentReset: vi.fn(),
	runPlaybook: vi.fn(),
};

const fsMockState = vi.hoisted(() => {
	const state = {
		readThrows: false,
		packageJson: { version: '1.0.0' } as Record<string, unknown>,
		readFileSync: undefined as unknown as ReturnType<typeof vi.fn>,
	};
	state.readFileSync = vi.fn(() => {
		if (state.readThrows) {
			throw new Error('package missing');
		}
		return JSON.stringify(state.packageJson);
	});
	return state;
});

describe('CLI entrypoint integration', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		fsMockState.readThrows = false;
		fsMockState.packageJson = { version: '1.0.0' };
	});

	it('builds the Maestro command tree and wires command actions', async () => {
		const harness = await importCliEntrypoint({ packageJson: { version: '9.8.7' } });

		expect(harness.root.name).toHaveBeenCalledWith('maestro-cli');
		expect(harness.root.description).toHaveBeenCalledWith('Command-line interface for Maestro');
		expect(harness.root.version).toHaveBeenCalledWith('9.8.7');
		expect(harness.root.parse).toHaveBeenCalledTimes(1);

		const commands = flattenCommands(harness.root).map((node) => node.spec);
		expect(commands).toEqual(
			expect.arrayContaining([
				'list',
				'groups',
				'agents',
				'playbooks',
				'sessions <agent-id>',
				'show',
				'agent <id>',
				'playbook <id>',
				'playbook <playbook-id>',
				'clean',
				'send <agent-id> <message>',
				'settings',
				'get <key>',
				'set <key> <value>',
				'reset <key>',
				'agent',
				'reset <agent-id> <key>',
			])
		);

		expect(findCommand(harness.root, 'groups')?.actionHandler).toBe(actionMocks.listGroups);
		expect(findCommand(harness.root, 'agents')?.actionHandler).toBe(actionMocks.listAgents);
		expect(findCommand(harness.root, 'send <agent-id> <message>')?.actionHandler).toBe(
			actionMocks.send
		);
		expect(findCommand(harness.root, 'reset <agent-id> <key>')?.actionHandler).toBe(
			actionMocks.settingsAgentReset
		);

		const playbookRunner = findCommand(harness.root, 'playbook <playbook-id>')?.actionHandler;
		await expect(playbookRunner?.('pb-1', { json: true })).resolves.toBe('ran-playbook');
		expect(actionMocks.runPlaybook).toHaveBeenCalledWith('pb-1', { json: true });
	});

	it('falls back to a zero version when package metadata cannot be read', async () => {
		const harness = await importCliEntrypoint({ readThrows: true });

		expect(harness.root.version).toHaveBeenCalledWith('0.0.0');
		expect(harness.root.parse).toHaveBeenCalledTimes(1);
	});
});

async function importCliEntrypoint(options: {
	packageJson?: Record<string, unknown>;
	readThrows?: boolean;
}) {
	let root: CommandNode | undefined;

	vi.doUnmock('fs');
	vi.doUnmock('commander');
	vi.doUnmock('../../cli/commands/run-playbook');
	fsMockState.readThrows = options.readThrows ?? false;
	fsMockState.packageJson = options.packageJson ?? { version: '1.0.0' };

	vi.doMock('fs', () => ({
		readFileSync: fsMockState.readFileSync,
	}));
	vi.doMock('commander', () => ({
		Command: vi.fn(function Command() {
			root = createCommandNode('root');
			return root;
		}),
	}));
	vi.doMock('../../cli/commands/list-groups', () => ({
		listGroups: actionMocks.listGroups,
	}));
	vi.doMock('../../cli/commands/list-agents', () => ({
		listAgents: actionMocks.listAgents,
	}));
	vi.doMock('../../cli/commands/list-playbooks', () => ({
		listPlaybooks: actionMocks.listPlaybooks,
	}));
	vi.doMock('../../cli/commands/show-playbook', () => ({
		showPlaybook: actionMocks.showPlaybook,
	}));
	vi.doMock('../../cli/commands/show-agent', () => ({
		showAgent: actionMocks.showAgent,
	}));
	vi.doMock('../../cli/commands/clean-playbooks', () => ({
		cleanPlaybooks: actionMocks.cleanPlaybooks,
	}));
	vi.doMock('../../cli/commands/send', () => ({
		send: actionMocks.send,
	}));
	vi.doMock('../../cli/commands/list-sessions', () => ({
		listSessions: actionMocks.listSessions,
	}));
	vi.doMock('../../cli/commands/settings-list', () => ({
		settingsList: actionMocks.settingsList,
	}));
	vi.doMock('../../cli/commands/settings-get', () => ({
		settingsGet: actionMocks.settingsGet,
	}));
	vi.doMock('../../cli/commands/settings-set', () => ({
		settingsSet: actionMocks.settingsSet,
	}));
	vi.doMock('../../cli/commands/settings-reset', () => ({
		settingsReset: actionMocks.settingsReset,
	}));
	vi.doMock('../../cli/commands/settings-agent', () => ({
		settingsAgentList: actionMocks.settingsAgentList,
		settingsAgentGet: actionMocks.settingsAgentGet,
		settingsAgentSet: actionMocks.settingsAgentSet,
		settingsAgentReset: actionMocks.settingsAgentReset,
	}));
	vi.doMock('../../cli/commands/run-playbook', () => ({
		runPlaybook: actionMocks.runPlaybook.mockResolvedValue('ran-playbook'),
	}));

	if (options.readThrows) {
		await import('../../cli/index.ts?fallback-version');
	} else {
		await import('../../cli/index.ts?package-version');
	}

	if (!root) {
		throw new Error('Commander root was not created');
	}

	return { root };
}

function createCommandNode(spec: string): CommandNode {
	const node = {
		spec,
		children: [] as CommandNode[],
		options: [] as string[],
		actionHandler: undefined as CommandNode['actionHandler'],
	} as CommandNode;

	node.name = vi.fn(() => node);
	node.description = vi.fn(() => node);
	node.version = vi.fn(() => node);
	node.command = vi.fn((childSpec: string) => {
		const child = createCommandNode(childSpec);
		node.children.push(child);
		return child;
	});
	node.option = vi.fn((optionSpec: string) => {
		node.options.push(optionSpec);
		return node;
	});
	node.action = vi.fn((handler: (...args: unknown[]) => unknown) => {
		node.actionHandler = handler;
		return node;
	});
	node.parse = vi.fn(() => node);

	return node;
}

function flattenCommands(node: CommandNode): CommandNode[] {
	return node.children.flatMap((child) => [child, ...flattenCommands(child)]);
}

function findCommand(node: CommandNode, spec: string): CommandNode | undefined {
	return flattenCommands(node).find((child) => child.spec === spec);
}
