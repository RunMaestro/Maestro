/**
 * pluginCommandRegistry - the SINGLE renderer-side command registry shared by
 * BOTH the command palette (QuickActionsModal) and the plugin host bridge
 * (the `ui.runCommand` host method). A plugin that invokes `ui:command` reaches
 * the EXACT same entry the palette lists - there is no separate private
 * allowlist. Register a command once and it is simultaneously palette-visible
 * and plugin-invokable.
 *
 * Deliberately pure and framework-free (no React, no Electron, no zustand) so
 * it can be unit-tested in isolation. The module exports a process-wide
 * singleton used by the app, plus `createPluginCommandRegistry()` for tests
 * that need a fresh, isolated instance.
 */

/** A command callable from the command palette AND from plugins. */
export interface RegisteredCommand {
	/** Stable, globally-unique command id (e.g. 'maestro.commandPalette.open').
	 *  Ids are part of the plugin-facing contract - keep them stable. */
	id: string;
	/** Human-readable label shown in the command palette. */
	title: string;
	/** Invoked when the command runs (from the palette OR a plugin). May be
	 *  async; `runCommandById` awaits it. */
	run: (args?: unknown) => void | Promise<void>;
}

export interface PluginCommandRegistry {
	/** Register a command. Re-registering an existing id replaces it. Returns an
	 *  unregister function that only removes the command if it is still the one
	 *  registered (a stale unregister after a re-register is a safe no-op). */
	registerCommand(command: RegisteredCommand): () => void;
	/** Run a registered command by id. Resolves `true` when the id was found and
	 *  its handler ran to completion; `false` when the id is unknown. A throwing
	 *  handler rejects (callers decide how to surface it). */
	runCommandById(id: string, args?: unknown): Promise<boolean>;
	/** Snapshot of all registered commands, in registration order. */
	listCommands(): RegisteredCommand[];
}

/** Build a fresh, isolated registry. Used for the singleton below and by tests. */
export function createPluginCommandRegistry(): PluginCommandRegistry {
	// Map preserves insertion order, giving listCommands() a stable order.
	const commands = new Map<string, RegisteredCommand>();

	return {
		registerCommand(command) {
			commands.set(command.id, command);
			return () => {
				if (commands.get(command.id) === command) commands.delete(command.id);
			};
		},
		async runCommandById(id, args) {
			const command = commands.get(id);
			if (!command) return false;
			await command.run(args);
			return true;
		},
		listCommands() {
			return Array.from(commands.values());
		},
	};
}

/** Process-wide singleton: the one registry the palette and plugins both use. */
export const pluginCommandRegistry = createPluginCommandRegistry();

// Convenience bindings. The factory's methods close over their own state (no
// `this`), so destructuring keeps them callable standalone.
export const { registerCommand, runCommandById, listCommands } = pluginCommandRegistry;
