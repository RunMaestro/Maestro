import { KEYMAP, formatBindingKeys, type Binding, type KeyAction } from '../keymap';

export interface AgentMenuEntry {
	action: KeyAction;
	label: string;
	keys: string;
}

/**
 * The rows of the agent menu: every binding that declares an `agentMenu` label.
 * An agent-scoped action joins the menu by setting that label in the keymap.
 */
export function agentMenuEntries(keymap: readonly Binding[] = KEYMAP): AgentMenuEntry[] {
	return keymap
		.filter((binding) => binding.agentMenu !== undefined)
		.map((binding) => ({
			action: binding.action,
			label: binding.agentMenu ?? binding.description,
			keys: formatBindingKeys(binding),
		}));
}
