import { describe, it, expect, vi } from 'vitest';
import {
	openSearch,
	closeSearch,
} from '../../../../../renderer/components/FilePreview/giantPreview/searchBridge';
import type { EditorView } from '@codemirror/view';

vi.mock('@codemirror/search', () => ({
	openSearchPanel: vi.fn(),
	closeSearchPanel: vi.fn(),
	setSearchQuery: { of: vi.fn((q) => ({ effect: 'setSearchQuery', q })) },
	SearchQuery: class {
		search: string;
		constructor(opts: { search: string }) {
			this.search = opts.search;
		}
	},
}));

// We import after the mock so the bridge picks up the mocked module.
import { openSearchPanel, closeSearchPanel, setSearchQuery } from '@codemirror/search';

function makeView(): EditorView {
	return {
		dispatch: vi.fn(),
	} as unknown as EditorView;
}

describe('searchBridge', () => {
	it('openSearch calls openSearchPanel with the view', () => {
		const view = makeView();
		openSearch(view);
		expect(openSearchPanel).toHaveBeenCalledWith(view);
	});

	it('openSearch with an initialQuery dispatches setSearchQuery effect', () => {
		const view = makeView();
		openSearch(view, 'needle');
		expect(view.dispatch).toHaveBeenCalled();
		const dispatchedArg = (view.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(dispatchedArg.effects).toBeTruthy();
		expect(setSearchQuery.of).toHaveBeenCalled();
	});

	it('openSearch with no initialQuery does not dispatch a query effect', () => {
		const view = makeView();
		openSearch(view);
		expect(view.dispatch).not.toHaveBeenCalled();
	});

	it('openSearch with an empty initialQuery does not dispatch (falsy guard)', () => {
		const view = makeView();
		openSearch(view, '');
		expect(view.dispatch).not.toHaveBeenCalled();
	});

	it('closeSearch calls closeSearchPanel with the view', () => {
		const view = makeView();
		closeSearch(view);
		expect(closeSearchPanel).toHaveBeenCalledWith(view);
	});
});
