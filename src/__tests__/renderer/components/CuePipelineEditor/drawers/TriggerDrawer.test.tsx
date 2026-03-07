import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TriggerDrawer } from '../../../../../renderer/components/CuePipelineEditor/drawers/TriggerDrawer';
import type { Theme } from '../../../../../renderer/types';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f940',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

describe('TriggerDrawer', () => {
	it('should render all trigger types when open', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		expect(screen.getByText('Scheduled')).toBeInTheDocument();
		expect(screen.getByText('File Change')).toBeInTheDocument();
		expect(screen.getByText('Agent Done')).toBeInTheDocument();
		expect(screen.getByText('Pull Request')).toBeInTheDocument();
		expect(screen.getByText('Issue')).toBeInTheDocument();
		expect(screen.getByText('Pending Task')).toBeInTheDocument();
	});

	it('should render descriptions for each trigger', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		expect(screen.getByText('Run on a timer')).toBeInTheDocument();
		expect(screen.getByText('Watch for file modifications')).toBeInTheDocument();
		expect(screen.getByText('After an agent finishes')).toBeInTheDocument();
	});

	it('should filter triggers by label', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'file' } });

		expect(screen.getByText('File Change')).toBeInTheDocument();
		expect(screen.queryByText('Scheduled')).not.toBeInTheDocument();
		expect(screen.queryByText('Pull Request')).not.toBeInTheDocument();
	});

	it('should filter triggers by event type', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'github' } });

		expect(screen.getByText('Pull Request')).toBeInTheDocument();
		expect(screen.getByText('Issue')).toBeInTheDocument();
		expect(screen.queryByText('Scheduled')).not.toBeInTheDocument();
	});

	it('should filter triggers by description', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'timer' } });

		expect(screen.getByText('Scheduled')).toBeInTheDocument();
		expect(screen.queryByText('File Change')).not.toBeInTheDocument();
	});

	it('should show empty state when no triggers match', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'zzzznothing' } });

		expect(screen.getByText('No triggers match')).toBeInTheDocument();
	});

	it('should use theme colors for styling', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const header = screen.getByText('Triggers');
		expect(header).toHaveStyle({ color: mockTheme.colors.textMain });
	});

	it('should be hidden when not open', () => {
		const { container } = render(
			<TriggerDrawer isOpen={false} onClose={() => {}} theme={mockTheme} />
		);

		const drawer = container.firstChild as HTMLElement;
		expect(drawer.style.transform).toBe('translateX(-100%)');
	});

	it('should be visible when open', () => {
		const { container } = render(
			<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />
		);

		const drawer = container.firstChild as HTMLElement;
		expect(drawer.style.transform).toBe('translateX(0)');
	});

	it('should make trigger items draggable', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const scheduled = screen.getByText('Scheduled').closest('[draggable]');
		expect(scheduled).toHaveAttribute('draggable', 'true');
	});
});
