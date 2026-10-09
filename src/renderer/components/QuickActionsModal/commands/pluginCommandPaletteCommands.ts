import type {
	CommandContribution,
	CommandMacroContribution,
	UiItemContribution,
} from '../../../../shared/plugins/contributions';
import type { QuickAction } from '../types';

/** A palette action that also carries the plugin that authored it, so the caller
 *  can group by plugin and merge under the built-in-wins contribution contract. */
export type PluginPaletteAction = QuickAction & { pluginId: string };

interface BuildPluginCommandPaletteCommandsArgs {
	/** Tier-1 `commands` (invokeCommand-backed) aggregated across active plugins. */
	commands: readonly CommandContribution[];
	/** Tier-0 `commandMacros` (templated-prompt) aggregated across active plugins. */
	macros: readonly CommandMacroContribution[];
	/** Tier-1 `ui:contribute` items; the `menu`-surface ones surface as palette entries. */
	uiItems?: readonly UiItemContribution[];
	/** Send a macro's templated prompt to the active agent (same path as typing). */
	onRunPromptMacro?: (prompt: string) => void;
	/** Invoke a tier-1 plugin command over the EXISTING invokeCommand RPC. */
	invokeCommand?: (commandId: string) => Promise<{ dispatched: boolean }>;
	/** Report a command's dispatch result (toast). */
	onCommandResult?: (args: { dispatched: boolean; title: string }) => void;
	/** Report a command invocation failure (toast). */
	onCommandError?: (args: { title: string; error: unknown }) => void;
	/** Close the command palette after dispatching. */
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Surface plugin-contributed palette entries: tier-0 command macros (dispatch a
 * templated prompt) AND tier-1 commands (run the plugin's sandboxed handler via
 * the existing `invokeCommand` RPC - no new channel). Each entry carries
 * non-suppressible provenance ("from <plugin>") in its subtext and its owning
 * `pluginId`, so the caller can merge these against the built-in palette under
 * the shared built-in-wins contract.
 *
 * Macros are omitted when no dispatch callback is provided (e.g. plugins Encore
 * off), and commands are omitted when no invoke callback is provided, so the
 * palette never shows a dead entry it cannot run.
 */
export function buildPluginCommandPaletteCommands({
	commands,
	macros,
	uiItems,
	onRunPromptMacro,
	invokeCommand,
	onCommandResult,
	onCommandError,
	setQuickActionOpen,
}: BuildPluginCommandPaletteCommandsArgs): PluginPaletteAction[] {
	const actions: PluginPaletteAction[] = [];

	if (onRunPromptMacro) {
		for (const macro of macros) {
			actions.push({
				id: macro.id,
				pluginId: macro.pluginId,
				label: `Macro: ${macro.title}`,
				subtext: macro.description
					? `${macro.description} - from ${macro.pluginId}`
					: `from ${macro.pluginId}`,
				action: () => {
					onRunPromptMacro(macro.prompt);
					setQuickActionOpen(false);
				},
			});
		}
	}

	if (invokeCommand) {
		for (const command of commands) {
			actions.push({
				id: command.id,
				pluginId: command.pluginId,
				label: command.title,
				subtext: command.description
					? `${command.description} - from ${command.pluginId}`
					: `from ${command.pluginId}`,
				action: () => {
					void invokeCommand(command.id).then(
						(result) => onCommandResult?.({ dispatched: result.dispatched, title: command.title }),
						(error) => onCommandError?.({ title: command.title, error })
					);
					setQuickActionOpen(false);
				},
			});
		}
	}

	if (invokeCommand && uiItems) {
		for (const item of uiItems) {
			// Other surfaces (status-bar, sidebar, toolbar) render in their own
			// regions; the palette is the menu surface.
			if (item.surface !== 'menu') continue;
			actions.push({
				id: item.id,
				pluginId: item.pluginId,
				label: item.label,
				subtext: `from ${item.pluginId}`,
				action: () => {
					void invokeCommand(`${item.pluginId}/${item.command}`).then(
						(result) => onCommandResult?.({ dispatched: result.dispatched, title: item.label }),
						(error) => onCommandError?.({ title: item.label, error })
					);
					setQuickActionOpen(false);
				},
			});
		}
	}

	return actions;
}
