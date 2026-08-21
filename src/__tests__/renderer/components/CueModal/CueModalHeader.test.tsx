import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CueModalHeader } from '../../../../renderer/components/CueModal/CueModalHeader';
import { CUE_MODAL_TABS } from '../../../../shared/uiSurfaces';
import type { Theme } from '../../../../renderer/types';

const theme = {
	colors: {
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		bgActivity: '#111',
		bgMain: '#222',
		accent: '#06b6d4',
		error: '#ff0000',
	},
} as unknown as Theme;

function makeProps(overrides: Partial<React.ComponentProps<typeof CueModalHeader>> = {}) {
	return {
		theme,
		activeTab: 'dashboard' as const,
		setActiveTab: vi.fn(),
		isEnabled: false,
		toggling: false,
		handleToggle: vi.fn(),
		onOpenHelp: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
}

describe('CueModalHeader', () => {
	it('clicking Dashboard tab calls setActiveTab("dashboard")', () => {
		const props = makeProps({ activeTab: 'pipeline' });
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByText('Dashboard'));
		expect(props.setActiveTab).toHaveBeenCalledWith('dashboard');
	});

	// The graph tab kept its 'pipeline' id when its label became "Pipeline
	// Graph", so existing deep links (`maestro-cli open cue --tab pipeline`,
	// the YAML editor's nav button) still land on the canvas.
	it('clicking Pipeline Graph tab calls setActiveTab("pipeline")', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByText('Pipeline Graph'));
		expect(props.setActiveTab).toHaveBeenCalledWith('pipeline');
	});

	it('clicking Pipeline List tab calls setActiveTab("pipeline-list")', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByText('Pipeline List'));
		expect(props.setActiveTab).toHaveBeenCalledWith('pipeline-list');
	});

	it('clicking Scheduled Tasks tab calls setActiveTab("scheduled")', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByText('Scheduled Tasks'));
		expect(props.setActiveTab).toHaveBeenCalledWith('scheduled');
	});

	// `maestro-cli open cue --tab <id>` validates against the shared registry,
	// so a tab added here without a registry entry would be un-deep-linkable
	// (and a stale registry entry would resolve to a tab that no longer exists).
	it('renders exactly the tabs listed in the shared surface registry, in order', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		for (const tab of CUE_MODAL_TABS) {
			expect(screen.getByText(tab.label)).toBeInTheDocument();
		}
		const rendered = screen
			.getAllByRole('button')
			.map((button) => button.textContent)
			.filter((text): text is string => text !== null);
		const tabOrder = CUE_MODAL_TABS.map((tab) => tab.label);
		const renderedTabOrder = rendered.filter((text) => tabOrder.includes(text));
		expect(renderedTabOrder).toEqual(tabOrder);
	});

	it('clicking Backup tab calls setActiveTab("backup")', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByText('Backup'));
		expect(props.setActiveTab).toHaveBeenCalledWith('backup');
	});

	it('master toggle click fires handleToggle', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByText('Disabled'));
		expect(props.handleToggle).toHaveBeenCalled();
	});

	it('toggle is disabled while toggling=true', () => {
		const props = makeProps({ toggling: true });
		render(<CueModalHeader {...props} />);
		const btn = screen.getByText('Disabled').closest('button')!;
		expect(btn).toBeDisabled();
	});

	it('isEnabled=true shows "Enabled" label', () => {
		const props = makeProps({ isEnabled: true });
		render(<CueModalHeader {...props} />);
		expect(screen.getByText('Enabled')).toBeInTheDocument();
	});

	it('help button fires onOpenHelp', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		const help = screen.getByTitle('About Maestro Cue');
		fireEvent.click(help);
		expect(props.onOpenHelp).toHaveBeenCalled();
	});

	it('close button fires onClose', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByTitle('Close'));
		expect(props.onClose).toHaveBeenCalled();
	});
});
