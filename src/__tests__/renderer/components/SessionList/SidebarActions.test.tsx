import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarActions } from '../../../../renderer/components/SessionList/SidebarActions';
import type { Theme } from '../../../../renderer/types';

const mockTheme: Theme = {
	name: 'test',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgInput: '#0f3460',
		textMain: '#e0e0e0',
		textDim: '#888888',
		accent: '#e94560',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ff4444',
		success: '#00cc66',
		warning: '#ffaa00',
	},
} as Theme;

const defaultShortcuts = {
	toggleSidebar: { keys: ['Cmd', 'B'], label: 'Toggle Sidebar' },
} as any;

function createProps(overrides: Partial<Parameters<typeof SidebarActions>[0]> = {}) {
	return {
		theme: mockTheme,
		leftSidebarOpen: true,
		hasNoSessions: false,
		shortcuts: defaultShortcuts,
		addNewSession: vi.fn(),
		openWizard: vi.fn(),
		setLeftSidebarOpen: vi.fn(),
		...overrides,
	};
}

describe('SidebarActions', () => {
	it('renders collapse button, New Agent, and Wizard when sidebar is open', () => {
		render(<SidebarActions {...createProps()} />);

		expect(screen.getByText('New Agent')).toBeTruthy();
		expect(screen.getByText('Wizard')).toBeTruthy();
	});

	it('hides New Agent and Wizard when sidebar is collapsed', () => {
		render(<SidebarActions {...createProps({ leftSidebarOpen: false })} />);

		expect(screen.queryByText('New Agent')).toBeNull();
		expect(screen.queryByText('Wizard')).toBeNull();
	});

	it('hides Wizard button when openWizard is undefined', () => {
		render(<SidebarActions {...createProps({ openWizard: undefined })} />);

		expect(screen.getByText('New Agent')).toBeTruthy();
		expect(screen.queryByText('Wizard')).toBeNull();
	});

	it('calls addNewSession when New Agent is clicked', () => {
		const addNewSession = vi.fn();
		render(<SidebarActions {...createProps({ addNewSession })} />);

		fireEvent.click(screen.getByText('New Agent'));
		expect(addNewSession).toHaveBeenCalledOnce();
	});

	it('calls openWizard when Wizard is clicked', () => {
		const openWizard = vi.fn();
		render(<SidebarActions {...createProps({ openWizard })} />);

		fireEvent.click(screen.getByText('Wizard'));
		expect(openWizard).toHaveBeenCalledOnce();
	});

	it('toggles sidebar open/closed on collapse button click', () => {
		const setLeftSidebarOpen = vi.fn();
		render(<SidebarActions {...createProps({ leftSidebarOpen: true, setLeftSidebarOpen })} />);

		// Click the collapse button (first button)
		const collapseBtn = screen.getByTitle(/Collapse Sidebar/);
		fireEvent.click(collapseBtn);
		expect(setLeftSidebarOpen).toHaveBeenCalledWith(false);
	});

	it('prevents collapse when no sessions and sidebar is open', () => {
		const setLeftSidebarOpen = vi.fn();
		render(
			<SidebarActions
				{...createProps({ hasNoSessions: true, leftSidebarOpen: true, setLeftSidebarOpen })}
			/>
		);

		const collapseBtn = screen.getByTitle('Add an agent first to collapse sidebar');
		fireEvent.click(collapseBtn);
		expect(setLeftSidebarOpen).not.toHaveBeenCalled();
	});

	it('allows expanding sidebar even with no sessions', () => {
		const setLeftSidebarOpen = vi.fn();
		render(
			<SidebarActions
				{...createProps({ hasNoSessions: true, leftSidebarOpen: false, setLeftSidebarOpen })}
			/>
		);

		const expandBtn = screen.getByTitle(/Expand Sidebar/);
		fireEvent.click(expandBtn);
		expect(setLeftSidebarOpen).toHaveBeenCalledWith(true);
	});
});
