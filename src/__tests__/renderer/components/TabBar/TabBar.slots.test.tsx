/**
 * @file TabBar.slots.test.tsx
 * @description Defends TabBar's optional pinned `leadingSlot`, used by Pianola's
 * manager surface. Contract: when a slot node is passed it renders inside the
 * sticky-left group; when omitted, no slot node appears (default agents are
 * unaffected). lucide-react, shortcutFormatter, matchMedia and ResizeObserver
 * are auto-mocked in `src/__tests__/setup.ts`, so a bare render mounts cleanly.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabBar } from '../../../../renderer/components/TabBar';
import type { AITab } from '../../../../renderer/types';
import { mockTheme } from '../../../helpers/mockTheme';

function baseTab(): AITab {
	return {
		id: 't1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
	};
}

function renderTabBar(extra?: { leadingSlot?: React.ReactNode }) {
	return render(
		<TabBar
			tabs={[baseTab()]}
			activeTabId="t1"
			theme={mockTheme}
			onTabSelect={vi.fn()}
			onTabClose={vi.fn()}
			onNewTab={vi.fn()}
			{...extra}
		/>
	);
}

describe('TabBar pinned slots', () => {
	it('renders the leading slot node when leadingSlot is provided', () => {
		renderTabBar({ leadingSlot: <div data-testid="probe-lead" /> });

		expect(screen.getByTestId('probe-lead')).toBeInTheDocument();
	});

	it('renders no slot node when no slot is provided', () => {
		renderTabBar();

		expect(screen.queryByTestId('probe-lead')).not.toBeInTheDocument();
	});
});
