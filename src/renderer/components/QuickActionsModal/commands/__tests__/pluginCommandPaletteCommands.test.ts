import { describe, it, expect, vi } from 'vitest';
import { buildPluginCommandPaletteCommands } from '../pluginCommandPaletteCommands';
import { mergePluginContributions } from '../../../../utils/pluginContributionMerge';
import type { QuickAction } from '../../types';
import type {
	CommandContribution,
	CommandMacroContribution,
	UiItemContribution,
} from '../../../../../shared/plugins/contributions';

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

describe('buildPluginCommandPaletteCommands — uiItems (menu surface)', () => {
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
