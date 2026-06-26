import type { CommandMacroContribution } from '../../../../shared/plugins/contributions';
import type { QuickAction } from '../types';

interface BuildPluginMacroCommandsArgs {
	/** Command macros aggregated across active plugins. */
	macros: readonly CommandMacroContribution[];
	/** Send a macro's templated prompt to the active agent. */
	onRunPromptMacro?: (prompt: string) => void;
	/** Close the command palette after dispatching. */
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Surface plugin-contributed command macros as palette actions. Selecting one
 * sends its templated prompt to the active agent (via the same input path as a
 * typed message) and closes the palette. No-op when the host did not provide a
 * dispatch callback (e.g. plugins Encore off) - in that case no macros are
 * shown rather than showing dead entries.
 */
export function buildPluginMacroCommands({
	macros,
	onRunPromptMacro,
	setQuickActionOpen,
}: BuildPluginMacroCommandsArgs): QuickAction[] {
	if (!onRunPromptMacro || macros.length === 0) return [];
	return macros.map((macro) => ({
		id: macro.id,
		label: `Macro: ${macro.title}`,
		subtext: macro.description ?? macro.pluginId,
		action: () => {
			onRunPromptMacro(macro.prompt);
			setQuickActionOpen(false);
		},
	}));
}
