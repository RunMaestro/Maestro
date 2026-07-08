import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CommandNode {
	spec: string;
	children: CommandNode[];
	optionCalls: unknown[][];
	requiredOptionCalls: unknown[][];
	actionHandler?: (...args: unknown[]) => unknown;
	name: ReturnType<typeof vi.fn>;
	description: ReturnType<typeof vi.fn>;
	version: ReturnType<typeof vi.fn>;
	command: ReturnType<typeof vi.fn>;
	option: ReturnType<typeof vi.fn>;
	requiredOption: ReturnType<typeof vi.fn>;
	action: ReturnType<typeof vi.fn>;
	parse: ReturnType<typeof vi.fn>;
	hook: ReturnType<typeof vi.fn>;
}

const actionMocks = {
	abortAutoRun: vi.fn(),
	autoRun: vi.fn(),
	cleanPlaybooks: vi.fn(),
	createAgent: vi.fn(),
	createGroup: vi.fn(),
	createSshRemote: vi.fn(),
	createWorktree: vi.fn(),
	cueList: vi.fn(),
	cuePipelineAdd: vi.fn(),
	cuePipelineExport: vi.fn(),
	cuePipelineGet: vi.fn(),
	cuePipelineList: vi.fn(),
	cuePipelineRemove: vi.fn(),
	cuePipelineReplace: vi.fn(),
	cueSchedule: vi.fn(),
	cueTrigger: vi.fn(),
	directorNotesHistory: vi.fn(),
	directorNotesSynopsis: vi.fn(),
	dispatch: vi.fn(),
	encoreList: vi.fn(),
	encoreSet: vi.fn(),
	focusAgent: vi.fn(),
	gistCreate: vi.fn(),
	listAgents: vi.fn(),
	listGroups: vi.fn(),
	listPlaybooks: vi.fn(),
	listSessions: vi.fn(),
	listSshRemotes: vi.fn(),
	notifyFlash: vi.fn(),
	notifyToast: vi.fn(),
	openBrowser: vi.fn(),
	openFile: vi.fn(),
	openTerminal: vi.fn(),
	promptsGet: vi.fn(),
	promptsList: vi.fn(),
	refreshAutoRun: vi.fn(),
	refreshFiles: vi.fn(),
	removeAgent: vi.fn(),
	removeGroup: vi.fn(),
	removePlaybook: vi.fn(),
	removeSshRemote: vi.fn(),
	renameAgent: vi.fn(),
	renameGroup: vi.fn(),
	resetAutoRunTasks: vi.fn(),
	resumeAutoRun: vi.fn(),
	runPlaybook: vi.fn(),
	send: vi.fn(),
	sessionList: vi.fn(),
	sessionShow: vi.fn(),
	setTheme: vi.fn(),
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
	skipAutoRun: vi.fn(),
	stats: vi.fn(),
	statsQuery: vi.fn(),
	status: vi.fn(),
	stopAutoRun: vi.fn(),
	switchMode: vi.fn(),
	tabClose: vi.fn(),
	tabNew: vi.fn(),
	tabRename: vi.fn(),
	tabStar: vi.fn(),
	updateAgent: vi.fn(),
};

interface ImportOptions {
	importId: string;
	version?: string;
}

export function describeCliEntrypoint(suiteName: string): void {
	describe(suiteName, () => {
		beforeEach(() => {
			vi.resetModules();
			vi.clearAllMocks();
			actionMocks.runPlaybook.mockResolvedValue('ran-playbook');
			delete (globalThis as { __MAESTRO_CLI_VERSION__?: string }).__MAESTRO_CLI_VERSION__;
		});

		it('builds the Maestro command tree and wires command actions', async () => {
			const harness = await importCliEntrypoint({
				importId: 'package-version',
				version: '9.8.7',
			});

			expect(harness.root.name).toHaveBeenCalledWith('maestro-cli');
			expect(harness.root.description).toHaveBeenCalledWith('Command-line interface for Maestro');
			expect(harness.root.version).toHaveBeenCalledWith('9.8.7');
			expect(harness.root.parse).toHaveBeenCalledWith(process.argv, { from: 'node' });

			expect(commandPaths(harness.root)).toEqual(
				expect.arrayContaining([
					'list',
					'list > groups',
					'list > agents',
					'list > playbooks',
					'list > sessions <agent-id>',
					'list > ssh-remotes',
					'show',
					'show > agent <id>',
					'show > playbook <id>',
					'playbook <playbook-id>',
					'clean > playbooks',
					'send <agent-id> <message>',
					'dispatch <agent-id> <message>',
					'session > list',
					'session > show <tab-id>',
					'auto-run <docs...>',
					'cue > pipeline > replace <name>',
					'director-notes > synopsis',
					'create-agent <name>',
					'create-worktree',
					'tab > unstar <tab-id>',
					'create-ssh-remote <name>',
					'settings > agent > reset <agent-id> <key>',
					'encore > disable <feature>',
					'prompts > get <id>',
					'notify > toast <title> <message>',
					'stats-query <sql>',
				])
			);

			expect(commandAt(harness.root, ['list', 'groups']).actionHandler).toBe(
				actionMocks.listGroups
			);
			expect(commandAt(harness.root, ['list', 'agents']).actionHandler).toBe(
				actionMocks.listAgents
			);
			expect(commandAt(harness.root, ['show', 'agent <id>']).actionHandler).toBe(
				actionMocks.showAgent
			);
			expect(commandAt(harness.root, ['send <agent-id> <message>']).actionHandler).toBe(
				actionMocks.send
			);
			expect(
				commandAt(harness.root, ['settings', 'agent', 'reset <agent-id> <key>']).actionHandler
			).toBe(actionMocks.settingsAgentReset);
		});

		it('uses the development version fallback when no build-time version is injected', async () => {
			const harness = await importCliEntrypoint({ importId: 'fallback-version' });

			expect(harness.root.version).toHaveBeenCalledWith('0.0.0-dev');
			expect(harness.root.parse).toHaveBeenCalledTimes(1);
		});

		it('runs lazy and wrapper action handlers with the expected command arguments', async () => {
			const { root } = await importCliEntrypoint({ importId: 'wrapped-actions' });

			await expect(
				commandAt(root, ['playbook <playbook-id>']).actionHandler?.('pb-1', { json: true })
			).resolves.toBe('ran-playbook');
			expect(actionMocks.runPlaybook).toHaveBeenCalledWith('pb-1', { json: true });

			const autoRunOptions = { agent: 'agent-1', json: true };
			commandAt(root, ['stop-auto-run']).actionHandler?.(autoRunOptions);
			commandAt(root, ['resume-auto-run']).actionHandler?.(autoRunOptions);
			commandAt(root, ['skip-auto-run']).actionHandler?.(autoRunOptions);
			commandAt(root, ['abort-auto-run']).actionHandler?.(autoRunOptions);
			expect(actionMocks.stopAutoRun).toHaveBeenCalledWith('agent-1', autoRunOptions);
			expect(actionMocks.resumeAutoRun).toHaveBeenCalledWith('agent-1', autoRunOptions);
			expect(actionMocks.skipAutoRun).toHaveBeenCalledWith('agent-1', autoRunOptions);
			expect(actionMocks.abortAutoRun).toHaveBeenCalledWith('agent-1', autoRunOptions);

			commandAt(root, ['reset-auto-run-tasks <filename>']).actionHandler?.(
				'plan.md',
				autoRunOptions
			);
			expect(actionMocks.resetAutoRunTasks).toHaveBeenCalledWith(
				'agent-1',
				'plan.md',
				autoRunOptions
			);

			const jsonOptions = { json: true };
			commandAt(root, ['remove-playbook <agent-id> <playbook-id>']).actionHandler?.(
				'agent-1',
				'pb-1',
				jsonOptions
			);
			commandAt(root, ['rename-group <group-id> <new-name>']).actionHandler?.(
				'group-1',
				'Renamed',
				jsonOptions
			);
			commandAt(root, ['rename-agent <agent-id> <new-name>']).actionHandler?.(
				'agent-1',
				'Renamed',
				jsonOptions
			);
			commandAt(root, ['focus-agent <agent-id>']).actionHandler?.('agent-1', jsonOptions);
			commandAt(root, ['switch-mode <agent-id> <mode>']).actionHandler?.(
				'agent-1',
				'terminal',
				jsonOptions
			);
			expect(actionMocks.removePlaybook).toHaveBeenCalledWith('agent-1', 'pb-1', jsonOptions);
			expect(actionMocks.renameGroup).toHaveBeenCalledWith('group-1', 'Renamed', jsonOptions);
			expect(actionMocks.renameAgent).toHaveBeenCalledWith('agent-1', 'Renamed', jsonOptions);
			expect(actionMocks.focusAgent).toHaveBeenCalledWith('agent-1', jsonOptions);
			expect(actionMocks.switchMode).toHaveBeenCalledWith('agent-1', 'terminal', jsonOptions);

			commandAt(root, ['tab', 'new']).actionHandler?.(autoRunOptions);
			commandAt(root, ['tab', 'close <tab-id>']).actionHandler?.('tab-1', jsonOptions);
			commandAt(root, ['tab', 'rename <tab-id> <new-name>']).actionHandler?.(
				'tab-1',
				'Renamed',
				jsonOptions
			);
			commandAt(root, ['tab', 'star <tab-id>']).actionHandler?.('tab-1', jsonOptions);
			commandAt(root, ['tab', 'unstar <tab-id>']).actionHandler?.('tab-1', jsonOptions);
			expect(actionMocks.tabNew).toHaveBeenCalledWith(autoRunOptions);
			expect(actionMocks.tabClose).toHaveBeenCalledWith('tab-1', jsonOptions);
			expect(actionMocks.tabRename).toHaveBeenCalledWith('tab-1', 'Renamed', jsonOptions);
			expect(actionMocks.tabStar).toHaveBeenCalledWith('tab-1', true, jsonOptions);
			expect(actionMocks.tabStar).toHaveBeenCalledWith('tab-1', false, jsonOptions);

			commandAt(root, ['set-theme [name-or-id]']).actionHandler?.('dark', jsonOptions);
			commandAt(root, ['encore', 'list']).actionHandler?.(jsonOptions);
			commandAt(root, ['encore', 'enable <feature>']).actionHandler?.('symphony', jsonOptions);
			commandAt(root, ['encore', 'disable <feature>']).actionHandler?.('symphony', jsonOptions);
			expect(actionMocks.setTheme).toHaveBeenCalledWith('dark', jsonOptions);
			expect(actionMocks.encoreList).toHaveBeenCalledWith(jsonOptions);
			expect(actionMocks.encoreSet).toHaveBeenCalledWith('symphony', true, jsonOptions);
			expect(actionMocks.encoreSet).toHaveBeenCalledWith('symphony', false, jsonOptions);
		});

		it('runs repeatable option parsers', async () => {
			const { root } = await importCliEntrypoint({ importId: 'option-parsers' });

			expect(
				runOptionParser(commandAt(root, ['create-agent <name>']), '--env <KEY=VALUE>')
			).toEqual(['EXISTING=1', 'NEW=2']);
			expect(
				runOptionParser(commandAt(root, ['create-ssh-remote <name>']), '--env <KEY=VALUE>')
			).toEqual(['EXISTING=1', 'NEW=2']);
			expect(
				runOptionParser(commandAt(root, ['stats-query <sql>']), '-p, --param <value>')
			).toEqual(['EXISTING=1', 'NEW=2']);
		});
	});
}

async function importCliEntrypoint(options: ImportOptions): Promise<{ root: CommandNode }> {
	let root: CommandNode | undefined;

	delete (globalThis as { __MAESTRO_CLI_VERSION__?: string }).__MAESTRO_CLI_VERSION__;
	if (options.version) {
		(globalThis as { __MAESTRO_CLI_VERSION__?: string }).__MAESTRO_CLI_VERSION__ = options.version;
	}

	mockCommander(() => {
		root = createCommandNode('root');
		return root;
	});
	mockCommandModules();

	await importCliModule(options.importId);

	if (!root) {
		throw new Error('Commander root was not created');
	}

	return { root };
}

async function importCliModule(importId: string): Promise<void> {
	switch (importId) {
		case 'package-version':
			await import('../../cli/index.ts?package-version');
			return;
		case 'fallback-version':
			await import('../../cli/index.ts?fallback-version');
			return;
		case 'wrapped-actions':
			await import('../../cli/index.ts?wrapped-actions');
			return;
		case 'option-parsers':
			await import('../../cli/index.ts?option-parsers');
			return;
		default:
			throw new Error(`Unknown CLI import id: ${importId}`);
	}
}

function mockCommander(createRoot: () => CommandNode): void {
	vi.doMock('commander', () => ({
		Command: vi.fn(function Command() {
			return createRoot();
		}),
	}));
}

function mockCommandModules(): void {
	vi.doMock('../../cli/commands/list-groups', () => ({ listGroups: actionMocks.listGroups }));
	vi.doMock('../../cli/commands/list-agents', () => ({ listAgents: actionMocks.listAgents }));
	vi.doMock('../../cli/commands/list-playbooks', () => ({
		listPlaybooks: actionMocks.listPlaybooks,
	}));
	vi.doMock('../../cli/commands/show-playbook', () => ({ showPlaybook: actionMocks.showPlaybook }));
	vi.doMock('../../cli/commands/show-agent', () => ({ showAgent: actionMocks.showAgent }));
	vi.doMock('../../cli/commands/clean-playbooks', () => ({
		cleanPlaybooks: actionMocks.cleanPlaybooks,
	}));
	vi.doMock('../../cli/commands/send', () => ({ send: actionMocks.send }));
	vi.doMock('../../cli/commands/dispatch', () => ({ dispatch: actionMocks.dispatch }));
	vi.doMock('../../cli/commands/session', () => ({
		sessionList: actionMocks.sessionList,
		sessionShow: actionMocks.sessionShow,
	}));
	vi.doMock('../../cli/commands/list-sessions', () => ({ listSessions: actionMocks.listSessions }));
	vi.doMock('../../cli/commands/open-file', () => ({ openFile: actionMocks.openFile }));
	vi.doMock('../../cli/commands/open-browser', () => ({ openBrowser: actionMocks.openBrowser }));
	vi.doMock('../../cli/commands/open-terminal', () => ({ openTerminal: actionMocks.openTerminal }));
	vi.doMock('../../cli/commands/refresh-files', () => ({ refreshFiles: actionMocks.refreshFiles }));
	vi.doMock('../../cli/commands/refresh-auto-run', () => ({
		refreshAutoRun: actionMocks.refreshAutoRun,
	}));
	vi.doMock('../../cli/commands/status', () => ({ status: actionMocks.status }));
	vi.doMock('../../cli/commands/auto-run', () => ({ autoRun: actionMocks.autoRun }));
	vi.doMock('../../cli/commands/cue-trigger', () => ({ cueTrigger: actionMocks.cueTrigger }));
	vi.doMock('../../cli/commands/cue-list', () => ({ cueList: actionMocks.cueList }));
	vi.doMock('../../cli/commands/cue-schedule', () => ({ cueSchedule: actionMocks.cueSchedule }));
	vi.doMock('../../cli/commands/cue-pipeline', () => ({
		cuePipelineAdd: actionMocks.cuePipelineAdd,
		cuePipelineExport: actionMocks.cuePipelineExport,
		cuePipelineGet: actionMocks.cuePipelineGet,
		cuePipelineList: actionMocks.cuePipelineList,
		cuePipelineRemove: actionMocks.cuePipelineRemove,
		cuePipelineReplace: actionMocks.cuePipelineReplace,
	}));
	vi.doMock('../../cli/commands/create-agent', () => ({ createAgent: actionMocks.createAgent }));
	vi.doMock('../../cli/commands/create-group', () => ({ createGroup: actionMocks.createGroup }));
	vi.doMock('../../cli/commands/remove-group', () => ({ removeGroup: actionMocks.removeGroup }));
	vi.doMock('../../cli/commands/create-worktree', () => ({
		createWorktree: actionMocks.createWorktree,
	}));
	vi.doMock('../../cli/commands/remove-agent', () => ({ removeAgent: actionMocks.removeAgent }));
	vi.doMock('../../cli/commands/update-agent', () => ({ updateAgent: actionMocks.updateAgent }));
	vi.doMock('../../cli/commands/list-ssh-remotes', () => ({
		listSshRemotes: actionMocks.listSshRemotes,
	}));
	vi.doMock('../../cli/commands/create-ssh-remote', () => ({
		createSshRemote: actionMocks.createSshRemote,
	}));
	vi.doMock('../../cli/commands/remove-ssh-remote', () => ({
		removeSshRemote: actionMocks.removeSshRemote,
	}));
	vi.doMock('../../cli/commands/director-notes-history', () => ({
		directorNotesHistory: actionMocks.directorNotesHistory,
	}));
	vi.doMock('../../cli/commands/director-notes-synopsis', () => ({
		directorNotesSynopsis: actionMocks.directorNotesSynopsis,
	}));
	vi.doMock('../../cli/commands/settings-list', () => ({ settingsList: actionMocks.settingsList }));
	vi.doMock('../../cli/commands/settings-get', () => ({ settingsGet: actionMocks.settingsGet }));
	vi.doMock('../../cli/commands/settings-set', () => ({ settingsSet: actionMocks.settingsSet }));
	vi.doMock('../../cli/commands/settings-reset', () => ({
		settingsReset: actionMocks.settingsReset,
	}));
	vi.doMock('../../cli/commands/settings-agent', () => ({
		settingsAgentGet: actionMocks.settingsAgentGet,
		settingsAgentList: actionMocks.settingsAgentList,
		settingsAgentReset: actionMocks.settingsAgentReset,
		settingsAgentSet: actionMocks.settingsAgentSet,
	}));
	vi.doMock('../../cli/commands/prompts-get', () => ({
		promptsGet: actionMocks.promptsGet,
		promptsList: actionMocks.promptsList,
	}));
	vi.doMock('../../cli/commands/gist', () => ({ gistCreate: actionMocks.gistCreate }));
	vi.doMock('../../cli/commands/notify-toast', () => ({ notifyToast: actionMocks.notifyToast }));
	vi.doMock('../../cli/commands/notify-flash', () => ({ notifyFlash: actionMocks.notifyFlash }));
	vi.doMock('../../cli/commands/stats', () => ({
		stats: actionMocks.stats,
		statsQuery: actionMocks.statsQuery,
	}));
	vi.doMock('../../cli/commands/rename-agent', () => ({ renameAgent: actionMocks.renameAgent }));
	vi.doMock('../../cli/commands/rename-group', () => ({ renameGroup: actionMocks.renameGroup }));
	vi.doMock('../../cli/commands/auto-run-control', () => ({
		abortAutoRun: actionMocks.abortAutoRun,
		resetAutoRunTasks: actionMocks.resetAutoRunTasks,
		resumeAutoRun: actionMocks.resumeAutoRun,
		skipAutoRun: actionMocks.skipAutoRun,
		stopAutoRun: actionMocks.stopAutoRun,
	}));
	vi.doMock('../../cli/commands/remove-playbook', () => ({
		removePlaybook: actionMocks.removePlaybook,
	}));
	vi.doMock('../../cli/commands/agent-control', () => ({
		focusAgent: actionMocks.focusAgent,
		switchMode: actionMocks.switchMode,
	}));
	vi.doMock('../../cli/commands/tab', () => ({
		tabClose: actionMocks.tabClose,
		tabNew: actionMocks.tabNew,
		tabRename: actionMocks.tabRename,
		tabStar: actionMocks.tabStar,
	}));
	vi.doMock('../../cli/commands/set-theme', () => ({ setTheme: actionMocks.setTheme }));
	vi.doMock('../../cli/commands/encore', () => ({
		encoreList: actionMocks.encoreList,
		encoreSet: actionMocks.encoreSet,
	}));
	vi.doMock('../../cli/commands/run-playbook', () => ({
		runPlaybook: actionMocks.runPlaybook,
	}));
}

function createCommandNode(spec: string): CommandNode {
	const node = {
		spec,
		children: [] as CommandNode[],
		optionCalls: [] as unknown[][],
		requiredOptionCalls: [] as unknown[][],
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
	node.option = vi.fn((...args: unknown[]) => {
		node.optionCalls.push(args);
		return node;
	});
	node.requiredOption = vi.fn((...args: unknown[]) => {
		node.requiredOptionCalls.push(args);
		return node;
	});
	node.action = vi.fn((handler: (...args: unknown[]) => unknown) => {
		node.actionHandler = handler;
		return node;
	});
	node.parse = vi.fn(() => node);
	node.hook = vi.fn(() => node);

	return node;
}

function commandAt(root: CommandNode, specs: string[]): CommandNode {
	let current = root;

	for (const spec of specs) {
		const next = current.children.find((child) => child.spec === spec);
		if (!next) {
			throw new Error(`Missing command path: ${specs.join(' > ')}`);
		}
		current = next;
	}

	return current;
}

function commandPaths(root: CommandNode, parents: string[] = []): string[] {
	return root.children.flatMap((child) => {
		const path = [...parents, child.spec];
		return [path.join(' > '), ...commandPaths(child, path)];
	});
}

function runOptionParser(node: CommandNode, optionSpec: string): unknown {
	const optionCall = [...node.optionCalls, ...node.requiredOptionCalls].find(
		([spec]) => spec === optionSpec
	);
	const parser = optionCall?.[2];

	if (typeof parser !== 'function') {
		throw new Error(`Missing parser for option ${optionSpec}`);
	}

	return parser('NEW=2', ['EXISTING=1']);
}
