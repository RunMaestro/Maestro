/**
 * Whether the Computer History viewer can be offered on this client.
 *
 * Two conditions, and every entry point (hotkey, command palette, hamburger
 * menu, the modal host) asks this one function so they cannot drift: the
 * `computerHistory` Encore flag is on, AND this is the desktop app. The
 * web-desktop bridge refuses every `computerHistory:*` channel by design
 * (screen history never leaves the machine through the browser), so an entry
 * offered there would open a viewer that can read nothing.
 */

import { isWebDesktop } from './runtimeContext';

export function canOpenComputerHistory(
	encoreFeatures: { computerHistory?: boolean } | null | undefined
): boolean {
	return encoreFeatures?.computerHistory === true && !isWebDesktop();
}
