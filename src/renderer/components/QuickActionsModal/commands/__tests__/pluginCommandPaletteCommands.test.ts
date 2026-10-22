import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildPluginCommandPaletteCommands } from '../pluginCommandPaletteCommands';
import { mergePluginContributions } from '../../../../utils/pluginContributionMerge';
import type { QuickAction } from '../../types';
import {
	collectContributions,
	type CommandContribution,
	type CommandMacroContribution,
	type UiItemContribution,
} from '../../../../../shared/plugins/contributions';
import { validatePluginManifest } from '../../../../../shared/plugins/plugin-manifest';

function command(over: Partial<CommandContribution> = {}): CommandContribution {
	return {
		id: 'acme.tools/hello',
		localId: 'hello',
		pluginId: 'acme.tools',
		title: 'Say Hello',
		...over,
	};
}

function macro(over: Partial<CommandMacroContribution> = {}): CommandMacroContribution {
	return {
		id: 'acme.tools/greet',
		localId: 'greet',
		pluginId: 'acme.tools',
		title: 'Greet',
		prompt: 'say hi',
		...over,
	};
}

function uiItem(over: Partial<UiItemContribution> = {}): UiItemContribution {
	return {
		id: 'acme.tools/go',
		localId: 'go',
		pluginId: 'acme.tools',
		surface: 'menu',
		label: 'Go',
		command: 'run',
		...over,
	};
}

describe('buildPluginCommandPaletteCommands', () => {
	it('surfaces a tier-1 command and invokes it over the invokeCommand RPC', async () => {
		const invokeCommand = vi.fn().mockResolvedValue({ dispatched: true });
		const onCommandResult = vi.fn();
		const setQuickActionOpen = vi.fn();

		const actions = buildPluginCommandPaletteCommands({
			commands: [command()],
			macros: [],
			invokeCommand,
			onCommandResult,
			setQuickActionOpen,
		});

		expect(actions).toHaveLength(1);
		expect(actions[0].label).toBe('Say Hello');
		// Non-suppressible provenance rides in the subtext.
		expect(actions[0].subtext).toContain('from acme.tools');

		await actions[0].action();
		expect(invokeCommand).toHaveBeenCalledWith('acme.tools/hello');
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		// let the invoke promise settle
		await Promise.resolve();
		expect(onCommandResult).toHaveBeenCalledWith({ dispatched: true, title: 'Say Hello' });
	});

	it('surfaces a tier-0 macro and dispatches its templated prompt', () => {
		const onRunPromptMacro = vi.fn();
		const setQuickActionOpen = vi.fn();
		const actions = buildPluginCommandPaletteCommands({
			commands: [],
			macros: [macro()],
			onRunPromptMacro,
			setQuickActionOpen,
		});
		expect(actions[0].label).toBe('Macro: Greet');
		actions[0].action();
		expect(onRunPromptMacro).toHaveBeenCalledWith('say hi');
	});

	it('omits commands/macros when their dispatch callback is absent', () => {
		const actions = buildPluginCommandPaletteCommands({
			commands: [command()],
			macros: [macro()],
			setQuickActionOpen: vi.fn(),
		});
		expect(actions).toEqual([]);
	});

	it('lets a built-in palette entry win a colliding id', () => {
		const builtinRan = vi.fn();
		const invokeCommand = vi.fn().mockResolvedValue({ dispatched: true });
		const builtins: QuickAction[] = [
			{ id: 'acme.tools/hello', label: 'Built-in Hello', action: builtinRan },
		];
		const pluginActions = buildPluginCommandPaletteCommands({
			commands: [command()], // id collides with the built-in above
			macros: [],
			invokeCommand,
			setQuickActionOpen: vi.fn(),
		});

		const merged = mergePluginContributions(builtins, pluginActions);
		const survivor = merged.items.find((r) => r.item.id === 'acme.tools/hello');
		expect(survivor?.item.label).toBe('Built-in Hello');
		expect(merged.errors[0]).toContain('collides with a built-in');

		// Running the surviving action runs the built-in, never the plugin invoke.
		survivor?.item.action();
		expect(builtinRan).toHaveBeenCalledTimes(1);
		expect(invokeCommand).not.toHaveBeenCalled();
	});
});

describe('buildPluginCommandPaletteCommands - uiItems (menu surface)', () => {
	it('surfaces a menu uiItem and invokes its namespaced command', async () => {
		const invokeCommand = vi.fn().mockResolvedValue({ dispatched: true });
		const setQuickActionOpen = vi.fn();
		const actions = buildPluginCommandPaletteCommands({
			commands: [],
			macros: [],
			uiItems: [uiItem()],
			invokeCommand,
			setQuickActionOpen,
		});
		expect(actions).toHaveLength(1);
		expect(actions[0].label).toBe('Go');
		await actions[0].action();
		expect(invokeCommand).toHaveBeenCalledWith('acme.tools/run'); // namespaced
	});

	it('does not surface non-menu surfaces in the palette', () => {
		const actions = buildPluginCommandPaletteCommands({
			commands: [],
			macros: [],
			uiItems: [uiItem({ surface: 'status-bar' }), uiItem({ surface: 'toolbar' })],
			invokeCommand: vi.fn(),
			setQuickActionOpen: vi.fn(),
		});
		expect(actions).toHaveLength(0);
	});

	it('omits uiItems when no invokeCommand is provided', () => {
		const actions = buildPluginCommandPaletteCommands({
			commands: [],
			macros: [],
			uiItems: [uiItem()],
			setQuickActionOpen: vi.fn(),
		});
		expect(actions).toHaveLength(0);
	});
});

describe('buildPluginCommandPaletteCommands - the shipped Kanban board', () => {
	/** The REAL `examples/plugins/maestro-kanban/plugin.json`, through the host's
	 * own manifest and contribution validators. Reading the shipped manifest
	 * rather than a fixture is the point: the palette is one of the board's three
	 * ways in, and a fixture would keep passing while the plugin a user installs
	 * had lost its entry. */
	function kanbanContributions() {
		const require = createRequire(import.meta.url);
		const path = require.resolve('../../../../../../examples/plugins/maestro-kanban/plugin.json');
		const { manifest, errors } = validatePluginManifest(JSON.parse(readFileSync(path, 'utf8')));
		expect(errors).toEqual([]);
		if (!manifest) throw new Error('maestro-kanban plugin.json did not validate');
		const collected = collectContributions(manifest);
		expect(collected.errors).toEqual([]);
		return collected;
	}

	it("turns the board's open command into a palette entry that opens the board", async () => {
		const { commands, uiItems } = kanbanContributions();
		const invokeCommand = vi.fn().mockResolvedValue({ dispatched: true });
		const onCommandResult = vi.fn();
		const setQuickActionOpen = vi.fn();

		const actions = buildPluginCommandPaletteCommands({
			commands,
			macros: [],
			uiItems,
			invokeCommand,
			onCommandResult,
			setQuickActionOpen,
		});

		const open = actions.find((a) => a.id === 'maestro-kanban/open');
		expect(open).toBeDefined();
		expect(open?.label).toBe('Kanban: Open Board');
		expect(open?.subtext).toContain('from maestro-kanban');

		await open?.action();
		expect(invokeCommand).toHaveBeenCalledWith('maestro-kanban/open');
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		await Promise.resolve();
		expect(onCommandResult).toHaveBeenCalledWith({
			dispatched: true,
			title: 'Kanban: Open Board',
		});
	});

	it("leaves the board's Left Bar launcher to its own surface", () => {
		const { uiItems } = kanbanContributions();
		// The launcher mounts on `sidebar`, so it renders in the Left Bar action
		// row and must NOT also appear in the palette - that would be the same way
		// in listed twice, next to the `open` command entry above.
		expect(uiItems.map((i) => i.surface)).toContain('sidebar');
		const actions = buildPluginCommandPaletteCommands({
			commands: [],
			macros: [],
			uiItems,
			invokeCommand: vi.fn(),
			setQuickActionOpen: vi.fn(),
		});
		expect(actions).toEqual([]);
	});
});
