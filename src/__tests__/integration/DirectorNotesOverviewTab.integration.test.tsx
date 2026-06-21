import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
	OverviewTab,
	type TabFocusHandle,
} from '../../renderer/components/DirectorNotes/OverviewTab';
import type { Shortcut, Theme } from '../../renderer/types';

const mockTheme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#151515',
		bgActivity: '#222222',
		textMain: '#ffffff',
		textDim: '#aaaaaa',
		accent: '#7c3aed',
		accentForeground: '#ffffff',
		border: '#333333',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		scrollbar: '#444444',
		scrollbarHover: '#666666',
	},
};

function renderOverview(shortcuts: Record<string, Shortcut> = {}) {
	return render(<OverviewTab theme={mockTheme} shortcuts={shortcuts} />);
}

describe('OverviewTab', () => {
	it('renders the Director Notes overview sections and guidance text', () => {
		renderOverview({
			directorNotes: {
				id: 'directorNotes',
				label: "Director's Notes",
				keys: ['F13'],
			},
		});

		expect(screen.getByText("What are Director's Notes?")).toBeInTheDocument();
		expect(screen.getByText('Unified History')).toBeInTheDocument();
		expect(screen.getByText('AI Overview')).toBeInTheDocument();
		expect(screen.getByText('Entry Types')).toBeInTheDocument();
		expect(screen.getByText('Activity Graph')).toBeInTheDocument();
		expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		expect(screen.getByText('F13')).toBeInTheDocument();
		expect(screen.getByText("Open Director's Notes")).toBeInTheDocument();
	});

	it('renders an empty shortcut key cell when no director notes shortcut is configured', () => {
		const { container } = renderOverview();

		const row = screen.getByText("Open Director's Notes").closest('div');
		const keyCell = row?.querySelector('kbd');

		expect(keyCell).toBeTruthy();
		expect(keyCell?.textContent).toBe('');
		expect(container).toHaveTextContent('Search / filter entries');
	});

	it('exposes a focus handle for modal tab switching', () => {
		const ref = React.createRef<TabFocusHandle>();
		const { container } = render(<OverviewTab ref={ref} theme={mockTheme} shortcuts={{}} />);
		const focusTarget = container.querySelector('[tabindex="0"]');

		ref.current?.focus();

		expect(document.activeElement).toBe(focusTarget);
	});
});
