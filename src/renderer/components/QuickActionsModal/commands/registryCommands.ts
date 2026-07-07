import type { QuickAction } from '../types';
import {
	listCommands as listRegistryCommands,
	runCommandById as runRegistryCommandById,
	type PluginCommandRegistry,
} from '../../../stores/pluginCommandRegistry';

/** The slice of the registry the palette needs: read the list, invoke by id. */
type RegistrySource = Pick<PluginCommandRegistry, 'listCommands' | 'runCommandById'>;

/**
 * Surface the shared plugin/command-palette registry as palette QuickActions.
 *
 * Each action invokes the SAME registry entry a plugin reaches through
 * `ui.runCommand`, so the palette and plugins can never diverge onto separate
 * command sources - which is the whole point of the registry. Accepts an
 * explicit registry for testability; defaults to the process-wide singleton.
 */
export function buildRegistryCommands(
	registry: RegistrySource = {
		listCommands: listRegistryCommands,
		runCommandById: runRegistryCommandById,
	}
): QuickAction[] {
	return registry.listCommands().map((command) => ({
		id: command.id,
		label: command.title,
		// Fire-and-forget: the palette closes on select; surfacing a thrown
		// handler here would just be a toast, which the command itself owns.
		action: () => {
			void registry.runCommandById(command.id);
		},
	}));
}
