/**
 * tileNewTab - create a brand-new tab and drop it straight into a tile beside
 * the tab that is on screen, without the user having to make the tab first and
 * then drag it over.
 *
 * This is the keyboard/command-palette twin of the drag-to-tile path in
 * PaneDropZones, and it deliberately reuses that path's two primitives so both
 * routes produce identical layouts:
 *   - a tiled group is already showing -> `tileTabIntoGroup` splits its FOCUSED
 *     pane, so the new tile lands under whichever pane the user is working in
 *     rather than under the whole grid;
 *   - nothing is tiled yet -> `createGroupFromDrop` pairs the single on-screen
 *     tab with the new one into a fresh group.
 *
 * Each new tab is minted in its NON-ACTIVATING form. Every standard "new tab"
 * path clears `activeGroupId` and takes over the panel (a standalone tab must,
 * or the group would keep winning render precedence and the new tab would never
 * appear). Here that would be exactly backwards: it would tear down the group
 * this function is in the middle of building. The tiling call at the end is what
 * sets focus, so activation is left entirely to it.
 *
 * The new tab IS inserted into `unifiedTabOrder` on creation and then removed by
 * the tiling call - that is not wasted work: `createGroupFromDrop` puts the group
 * chip where the first of its members sat, so the strip position is inherited
 * rather than appended.
 */

import type { ThinkingMode } from '../../../shared/types';
import type { Session, UnifiedTabRef } from '../../types';
import {
	createGroupFromDrop,
	findLeafById,
	firstLeafId,
	generateGroupName,
	resolveActiveTabRef,
	resolveTabRefTitle,
	tileTabIntoGroup,
	type DropZone,
} from '../../utils/panelLayout';
import { createTab } from '../../utils/tabHelpers';
import { insertAfterActiveInUnifiedTabOrder } from '../../utils/unifiedTabOrderUtils';
import {
	addTerminalTab,
	createTerminalTab as createTerminalTabHelper,
} from '../../utils/terminalTabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../utils/browserTabPersistence';
import { createBrowserTab } from './internal/browserTabHelpers';
import { createUntitledFileTab } from './internal/filePreviewTabHelpers';

/** The tab kinds a tile command can create. Mirrors the New Tab menu. */
export type TileableTabKind = 'ai' | 'file' | 'terminal' | 'browser';

/**
 * Settings the new tab inherits. Passed in rather than read from the settings
 * store so this module stays a pure session -> session transform (and so the
 * tests do not need a live store).
 */
export interface TileNewTabDefaults {
	/** AI tabs: `defaultSaveToHistory`. */
	saveToHistory: boolean;
	/** AI tabs: `defaultShowThinking`. */
	showThinking: ThinkingMode;
	/** Browser tabs: `browserHomeUrl`, falling back to the built-in home page. */
	browserHomeUrl?: string;
}

export interface TileNewTabResult {
	session: Session;
	/** The tab that was created and tiled. */
	ref: UnifiedTabRef;
}

/** Mint a tab of `kind` and add it to the session WITHOUT activating it. */
function createInactiveTab(
	session: Session,
	kind: TileableTabKind,
	defaults: TileNewTabDefaults
): TileNewTabResult | null {
	switch (kind) {
		case 'ai': {
			const result = createTab(session, {
				saveToHistory: defaults.saveToHistory,
				showThinking: defaults.showThinking,
				activate: false,
			});
			if (!result) return null;
			return { session: result.session, ref: { type: 'ai', id: result.tab.id } };
		}
		case 'file': {
			const tab = createUntitledFileTab();
			const ref: UnifiedTabRef = { type: 'file', id: tab.id };
			return {
				session: {
					...session,
					filePreviewTabs: [...(session.filePreviewTabs || []), tab],
					unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(session, ref),
				},
				ref,
			};
		}
		case 'terminal': {
			const tab = createTerminalTabHelper();
			return {
				session: addTerminalTab(session, tab, { activate: false }),
				ref: { type: 'terminal', id: tab.id },
			};
		}
		case 'browser': {
			const homeUrl = defaults.browserHomeUrl || DEFAULT_BROWSER_TAB_URL;
			const tab = createBrowserTab(session.id, homeUrl, {
				title: homeUrl === DEFAULT_BROWSER_TAB_URL ? undefined : homeUrl,
				isLoading: homeUrl !== DEFAULT_BROWSER_TAB_URL,
			});
			const ref: UnifiedTabRef = { type: 'browser', id: tab.id };
			return {
				session: {
					...session,
					browserTabs: [...(session.browserTabs || []), tab],
					unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(session, ref),
				},
				ref,
			};
		}
	}
}

/**
 * True when the session has something on screen to tile a new tab against. The
 * commands are hidden when this is false: an agent with no tabs at all has no
 * pane to split, and "tile below" against nothing would just be "new tab".
 */
export function canTileNewTab(session: Session | undefined | null): boolean {
	return !!session && resolveActiveTabRef(session) != null;
}

/**
 * Create a `kind` tab and tile it into `zone` of the pane/tab currently on
 * screen. Returns the updated session plus the new tab's ref, or null when
 * there is nothing to tile against (see {@link canTileNewTab}).
 *
 * `zone` defaults to `'bottom'`, the shape the commands ship: the new tab takes
 * the lower half and the tab that was on screen keeps the upper half.
 */
export function tileNewTab(
	session: Session,
	kind: TileableTabKind,
	defaults: TileNewTabDefaults,
	zone: DropZone = 'bottom'
): TileNewTabResult | null {
	// Resolve the target BEFORE minting anything: creating a tab shifts
	// unifiedTabOrder, and resolveActiveTabRef reads the active-tab ids that a
	// future activating creator could move out from under us.
	const targetRef = resolveActiveTabRef(session);
	if (!targetRef) return null;

	const group =
		session.activeGroupId != null
			? session.tabGroups?.find((g) => g.id === session.activeGroupId)
			: undefined;

	// Which leaf gets split. The focused pane is the honest answer; fall back to
	// the group's first leaf when focus is missing or stale so the command still
	// does something sensible instead of silently no-opping.
	const targetLeafId = group
		? ((group.focusedPaneId && findLeafById(group.layout, group.focusedPaneId)?.id) ??
			firstLeafId(group.layout))
		: null;

	const created = createInactiveTab(session, kind, defaults);
	if (!created) return null;

	if (group && targetLeafId) {
		return {
			session: tileTabIntoGroup(created.session, group.id, targetLeafId, zone, created.ref),
			ref: created.ref,
		};
	}

	return {
		session: createGroupFromDrop(
			created.session,
			targetRef,
			created.ref,
			zone,
			generateGroupName(resolveTabRefTitle(session, targetRef))
		),
		ref: created.ref,
	};
}
