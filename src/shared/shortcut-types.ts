/**
 * Shared keyboard shortcut type used by renderer, main (web server), and web client.
 */

export interface Shortcut {
	id: string;
	label: string;
	keys: string[];
}
