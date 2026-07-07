/**
 * Shared keyboard shortcut type used by renderer, main (web server), and web client.
 */

export interface Shortcut {
	id: string;
	label: string;
	keys: string[];
	/**
	 * Multi-window: when true, the shortcut acts only on the current window's
	 * agents (its scope is the window, not the whole app). Agent cycling and the
	 * Command-K / agent switcher are window-scoped - picking an agent that is open
	 * in another window focuses that window instead of moving the agent. Used by
	 * the shortcut-help modal to render a "Window" badge. Optional/informational:
	 * it never affects key matching, only display.
	 */
	windowScoped?: boolean;
}
