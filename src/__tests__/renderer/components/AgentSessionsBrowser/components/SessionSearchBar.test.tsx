/**
 * Tests for SessionSearchBar.
 *
 * On a phone the Named / Show All toggles and the mode dropdown drop to a
 * second row so the search box keeps its width; on desktop they stay inline
 * (a `contents` wrapper, so the desktop DOM is unchanged).
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionSearchBar } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionSearchBar';
import { usePhoneLayout } from '../../../../../renderer/hooks/ui/useViewportBreakpoint';
import { mockTheme } from '../../../../helpers/mockTheme';

vi.mock('../../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../../renderer/hooks/ui/useViewportBreakpoint')
	>()),
	usePhoneLayout: vi.fn(() => false),
}));
vi.mock('../../../../../renderer/components/SessionActivityGraph', () => ({
	SessionActivityGraph: () => <div data-testid="activity-graph" />,
}));
const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

function renderBar() {
	return render(
		<SessionSearchBar
			showSearchPanel={true}
			search=""
			searchMode="all"
			isSearching={false}
			namedOnly={false}
			showAllSessions={false}
			searchModeDropdownOpen={false}
			searchModeDropdownRef={React.createRef<HTMLDivElement>()}
			inputRef={React.createRef<HTMLInputElement>()}
			activityEntries={[]}
			graphLookbackHours={null}
			theme={mockTheme}
			onSearchChange={vi.fn()}
			onSearchKeyDown={vi.fn()}
			onToggleSearchPanel={vi.fn()}
			onToggleNamedOnly={vi.fn()}
			onToggleShowAll={vi.fn()}
			onSearchModeDropdownToggle={vi.fn()}
			onSearchModeSelect={vi.fn()}
			onGraphBarClick={vi.fn()}
			onLookbackChange={vi.fn()}
		/>
	);
}

afterEach(() => {
	mockedUsePhoneLayout.mockReturnValue(false);
});

describe('SessionSearchBar', () => {
	it('keeps the filters inline on desktop', () => {
		renderBar();
		expect(screen.getByTestId('session-search-filters')).toHaveClass('contents');
		expect(screen.getByPlaceholderText('Search all content...')).toHaveClass('min-w-0');
	});

	it('moves the filters to their own row on a phone', () => {
		mockedUsePhoneLayout.mockReturnValue(true);
		renderBar();
		const filters = screen.getByTestId('session-search-filters');
		expect(filters).toHaveClass('basis-full');
		expect(filters).not.toHaveClass('contents');
		expect(filters.parentElement).toHaveClass('flex-wrap');
		expect(screen.getByText('Named')).toBeInTheDocument();
		expect(screen.getByText('Show All')).toBeInTheDocument();
	});
});
