/**
 * tabFocusFields - compatibility entry for the four session patches that
 * decide which tab the user sees.
 *
 * The implementations live in tabHelpers/focusFields.ts (tabHelpers is now a
 * folder, so they cannot stay in tabHelpers.ts). This file re-exports them so
 * terminalTabHelpers and other callers that import from here keep working
 * without closing an import cycle through tabHelpers/index.ts.
 *
 * Prefer `tabHelpers` (or `tabHelpers/focusFields`) for new call sites.
 * Background placement (omit the spread so the view does not move) is
 * documented in shared/focusPlacement.ts.
 */

export {
	aiTabFocusFields,
	fileTabFocusFields,
	browserTabFocusFields,
	terminalTabFocusFields,
} from './tabHelpers/focusFields';
