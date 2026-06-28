import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoopControls } from '../../../../../renderer/components/DocumentsPanel/components/LoopControls';
import type { BatchDocumentEntry } from '../../../../../renderer/types';
import { mockTheme } from '../../../../helpers/mockTheme';

const docs: BatchDocumentEntry[] = [
	{ id: '1', filename: 'alpha', resetOnCompletion: false },
	{ id: '2', filename: 'beta', resetOnCompletion: false },
];

function renderControls(overrides = {}) {
	const props = {
		theme: mockTheme,
		documents: docs,
		loopEnabled: false,
		setLoopEnabled: vi.fn(),
		maxLoops: null,
		setMaxLoops: vi.fn(),
		totalTaskCount: 6,
		missingDocCount: 0,
		hasMissingDocs: false,
		loadingTaskCounts: false,
		...overrides,
	};
	render(<LoopControls {...props} />);
	return props;
}

describe('LoopControls', () => {
	it('shows a one-document hint and hides loop controls', () => {
		renderControls({ documents: [docs[0]] });

		expect(screen.getByText('You can enable loops with two or more documents')).toBeInTheDocument();
		expect(screen.queryByText('Loop')).not.toBeInTheDocument();
	});

	it('shows the loop hint for zero documents', () => {
		renderControls({ documents: [] });

		expect(screen.getByText('You can enable loops with two or more documents')).toBeInTheDocument();
		expect(screen.queryByText('Loop')).not.toBeInTheDocument();
	});

	it('toggles loop and shows summary for available documents', () => {
		const props = renderControls();

		fireEvent.click(screen.getByText('Loop'));
		expect(props.setLoopEnabled).toHaveBeenCalledWith(true);
		expect(screen.getByText(/Total: 6 tasks across 2 documents/)).toBeInTheDocument();
	});

	it('switches between infinite and max loop controls', () => {
		const props = renderControls({ loopEnabled: true, maxLoops: null });

		fireEvent.click(screen.getByText('max'));
		expect(props.setMaxLoops).toHaveBeenCalledWith(5);
		expect(screen.queryByRole('slider')).not.toBeInTheDocument();
	});

	it('updates slider value when max mode is active', () => {
		const props = renderControls({ loopEnabled: true, maxLoops: 5 });

		const slider = screen.getByRole('slider');
		expect(slider).toHaveAttribute('min', '1');
		expect(slider).toHaveAttribute('max', '25');
		fireEvent.change(slider, { target: { value: '12' } });

		expect(props.setMaxLoops).toHaveBeenCalledWith(12);
		fireEvent.click(screen.getByText('∞'));
		expect(props.setMaxLoops).toHaveBeenCalledWith(null);
	});

	it('summarizes missing documents', () => {
		renderControls({
			documents: [
				...docs,
				{ id: '3', filename: 'gone', resetOnCompletion: false, isMissing: true },
			],
			missingDocCount: 1,
			hasMissingDocs: true,
		});

		expect(
			screen.getByText(/Total: 6 tasks across 2 available documents \(1 missing\)/)
		).toBeInTheDocument();
	});
});
