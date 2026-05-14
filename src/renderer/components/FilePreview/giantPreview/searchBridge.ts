import { openSearchPanel, closeSearchPanel, setSearchQuery, SearchQuery } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';

/**
 * Thin wrapper around `@codemirror/search` so the React shell never imports
 * the CM6 search module directly. Lets us mock the bridge in tests without
 * mocking the whole library.
 */

/** Open the search panel and (optionally) seed it with a starting query. */
export function openSearch(view: EditorView, initialQuery = ''): void {
	openSearchPanel(view);
	if (initialQuery) {
		view.dispatch({
			effects: setSearchQuery.of(new SearchQuery({ search: initialQuery })),
		});
	}
}

/** Close the search panel and clear active match highlights. */
export function closeSearch(view: EditorView): void {
	closeSearchPanel(view);
}
