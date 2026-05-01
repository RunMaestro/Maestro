import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CueModalHeader } from '../../../../renderer/components/CueModal/CueModalHeader';
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
		showHelp: false,
		onOpenHelp: vi.fn(),
		onCloseHelp: vi.fn(),
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

	it('clicking Pipeline tab calls setActiveTab("pipeline")', () => {
		const props = makeProps();
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByText('Pipeline Editor'));
		expect(props.setActiveTab).toHaveBeenCalledWith('pipeline');
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

	it('showHelp=true hides tabs and toggle; shows back arrow', () => {
		const props = makeProps({ showHelp: true });
		render(<CueModalHeader {...props} />);
		expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
		expect(screen.queryByText('Pipeline Editor')).not.toBeInTheDocument();
		expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
		expect(screen.getByText('Maestro Cue Guide')).toBeInTheDocument();
		expect(screen.getByTitle('Back to dashboard')).toBeInTheDocument();
	});

	it('back arrow fires onCloseHelp', () => {
		const props = makeProps({ showHelp: true });
		render(<CueModalHeader {...props} />);
		fireEvent.click(screen.getByTitle('Back to dashboard'));
		expect(props.onCloseHelp).toHaveBeenCalled();
	});

	it('close button visible in help view too', () => {
		const props = makeProps({ showHelp: true });
		const { container } = render(<CueModalHeader {...props} />);
		const buttons = container.querySelectorAll('button');
		fireEvent.click(buttons[buttons.length - 1]);
		expect(props.onClose).toHaveBeenCalled();
	});
});
