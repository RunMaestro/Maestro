/**
 * Syntax highlighting theme selection based on app theme mode.
 *
 * Light themes need a light syntax style (vs), dark/vibe themes use vscDarkPlus.
 * This matches the pattern already used in the mobile code.
 */

import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ThemeMode } from '../../shared/theme-types';

/**
 * Returns the appropriate syntax highlighter style for the given theme mode.
 */
export function getSyntaxStyle(mode: ThemeMode) {
	return mode === 'light' ? vs : vscDarkPlus;
}
