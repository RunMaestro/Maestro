import { describe, it, expect, vi } from 'vitest';
import { createPluginCommandRegistry } from '../pluginCommandRegistry';
import { buildRegistryCommands } from '../../components/QuickActionsModal/commands/registryCommands';

describe('pluginCommandRegistry', () => {
	it('lists registered commands in registration order', () => {
		const registry = createPluginCommandRegistry();
		registry.registerCommand({ id: 'a', title: 'A', run: () => {} });
		registry.registerCommand({ id: 'b', title: 'B', run: () => {} });
		expect(registry.listCommands().map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('runs a registered command (awaiting async handlers) and forwards args', async () => {
		const registry = createPluginCommandRegistry();
		const run = vi.fn(async () => {});
		registry.registerCommand({ id: 'cmd', title: 'Cmd', run });

		await expect(registry.runCommandById('cmd', { x: 1 })).resolves.toBe(true);
		expect(run).toHaveBeenCalledWith({ x: 1 });
	});

	it('resolves false for an unknown command id without throwing', async () => {
		const registry = createPluginCommandRegistry();
		await expect(registry.runCommandById('nope')).resolves.toBe(false);
	});

	it('propagates a throwing handler so callers can surface the failure', async () => {
		const registry = createPluginCommandRegistry();
		registry.registerCommand({
			id: 'boom',
			title: 'Boom',
			run: () => {
				throw new Error('kaboom');
			},
		});
		await expect(registry.runCommandById('boom')).rejects.toThrow('kaboom');
	});

	it('re-registering an id replaces the prior handler', async () => {
		const registry = createPluginCommandRegistry();
		const first = vi.fn();
		const second = vi.fn();
		registry.registerCommand({ id: 'dup', title: 'First', run: first });
		registry.registerCommand({ id: 'dup', title: 'Second', run: second });

		expect(registry.listCommands()).toHaveLength(1);
		expect(registry.listCommands()[0]?.title).toBe('Second');
		await registry.runCommandById('dup');
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('unregister removes the command; a stale unregister after re-register is a no-op', async () => {
		const registry = createPluginCommandRegistry();
		const unregisterFirst = registry.registerCommand({ id: 'x', title: 'X1', run: () => {} });
		registry.registerCommand({ id: 'x', title: 'X2', run: () => {} });

		// The stale unregister must NOT drop the live re-registration.
		unregisterFirst();
		expect(registry.listCommands().map((c) => c.id)).toEqual(['x']);
		expect(registry.listCommands()[0]?.title).toBe('X2');
	});
});

describe('buildRegistryCommands', () => {
	it('maps registry entries to palette actions that invoke the same registry', () => {
		const registry = createPluginCommandRegistry();
		const run = vi.fn();
		registry.registerCommand({
			id: 'maestro.commandPalette.open',
			title: 'Open Command Palette',
			run,
		});

		const actions = buildRegistryCommands(registry);
		expect(actions.map((a) => ({ id: a.id, label: a.label }))).toEqual([
			{ id: 'maestro.commandPalette.open', label: 'Open Command Palette' },
		]);

		// Selecting the palette entry routes through the SAME registry the plugin
		// host uses - not a divergent allowlist.
		actions[0]?.action();
		expect(run).toHaveBeenCalledTimes(1);
	});
});
