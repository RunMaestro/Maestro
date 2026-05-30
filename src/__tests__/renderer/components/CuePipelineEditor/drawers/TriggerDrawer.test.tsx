/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TriggerDrawer } from '../../../../../renderer/components/CuePipelineEditor/drawers/TriggerDrawer';

import { mockTheme } from '../../../../helpers/mockTheme';
describe('TriggerDrawer', () => {
	it('should render all trigger types when open', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		expect(screen.getByText('Heartbeat')).toBeInTheDocument();
		expect(screen.getByText('Scheduled')).toBeInTheDocument();
		expect(screen.getByText('File Change')).toBeInTheDocument();
		expect(screen.queryByText('Agent Done')).not.toBeInTheDocument();
		expect(screen.getByText('Pull Request')).toBeInTheDocument();
		expect(screen.getByText('Issue')).toBeInTheDocument();
		expect(screen.getByText('Pending Task')).toBeInTheDocument();
	});

	it('should render descriptions for each trigger', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		expect(screen.getByText('Run every N minutes')).toBeInTheDocument();
		expect(screen.getByText('Run at specific times & days')).toBeInTheDocument();
		expect(screen.getByText('Watch for file modifications')).toBeInTheDocument();
		expect(screen.queryByText('After an agent finishes')).not.toBeInTheDocument();
	});

	it('should filter triggers by label', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'file' } });

		expect(screen.getByText('File Change')).toBeInTheDocument();
		expect(screen.queryByText('Heartbeat')).not.toBeInTheDocument();
		expect(screen.queryByText('Pull Request')).not.toBeInTheDocument();
	});

	it('should filter triggers by event type', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'github' } });

		expect(screen.getByText('Pull Request')).toBeInTheDocument();
		expect(screen.getByText('Issue')).toBeInTheDocument();
		expect(screen.queryByText('Heartbeat')).not.toBeInTheDocument();
	});

	it('should filter triggers by description', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'minutes' } });

		expect(screen.getByText('Heartbeat')).toBeInTheDocument();
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

	it('should render exactly 8 trigger types (no agent.completed)', () => {
		const { container } = render(
			<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />
		);

		// Each trigger item is a draggable div; count them
		const draggableItems = container.querySelectorAll('[draggable="true"]');
		expect(draggableItems.length).toBe(8);
	});

	it('should not show agent.completed when filtering by "agent"', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const input = screen.getByPlaceholderText('Filter triggers...');
		fireEvent.change(input, { target: { value: 'agent' } });

		// No trigger items should match since agent.completed was removed
		expect(screen.getByText('No triggers match')).toBeInTheDocument();
	});

	it('should make trigger items draggable', () => {
		render(<TriggerDrawer isOpen={true} onClose={() => {}} theme={mockTheme} />);

		const heartbeat = screen.getByText('Heartbeat').closest('[draggable]');
		expect(heartbeat).toHaveAttribute('draggable', 'true');
	});
});
