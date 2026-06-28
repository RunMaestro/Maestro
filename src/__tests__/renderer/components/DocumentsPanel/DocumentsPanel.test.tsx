import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentsPanel } from '../../../../renderer/components/DocumentsPanel';
import type { BatchDocumentEntry } from '../../../../renderer/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';

function TestHost({
	initialDocuments = [{ id: '1', filename: 'alpha', resetOnCompletion: false }],
}: {
	initialDocuments?: BatchDocumentEntry[];
}) {
	const [documents, setDocuments] = React.useState<BatchDocumentEntry[]>(initialDocuments);
	const [loopEnabled, setLoopEnabled] = React.useState(false);
	const [maxLoops, setMaxLoops] = React.useState<number | null>(null);

	return (
		<LayerStackProvider>
			<DocumentsPanel
				theme={mockTheme}
				documents={documents}
				setDocuments={setDocuments}
				taskCounts={{ alpha: 2, beta: 3 }}
				loadingTaskCounts={false}
				loopEnabled={loopEnabled}
				setLoopEnabled={setLoopEnabled}
				maxLoops={maxLoops}
				setMaxLoops={setMaxLoops}
				allDocuments={['alpha', 'beta']}
				onRefreshDocuments={vi.fn().mockResolvedValue(undefined)}
			/>
		</LayerStackProvider>
	);
}

describe('DocumentsPanel', () => {
	it('exports and renders the public component', () => {
		expect(DocumentsPanel).toBeDefined();
		render(<TestHost />);

		expect(screen.getByText('Documents to Run')).toBeInTheDocument();
		expect(screen.getByText('alpha.md')).toBeInTheDocument();
	});

	it('opens selector and adds newly selected documents', async () => {
		render(<TestHost />);

		fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
		expect(screen.getByText('Select Documents')).toBeInTheDocument();

		fireEvent.click(screen.getByText('beta.md'));
		fireEvent.click(screen.getByRole('button', { name: /Add 2 files/ }));

		await waitFor(() => expect(screen.queryByText('Select Documents')).not.toBeInTheDocument());
		expect(screen.getByText('alpha.md')).toBeInTheDocument();
		expect(screen.getByText('beta.md')).toBeInTheDocument();
	});

	it('wires row actions and loop controls', () => {
		render(
			<TestHost
				initialDocuments={[
					{ id: '1', filename: 'alpha', resetOnCompletion: false },
					{ id: '2', filename: 'beta', resetOnCompletion: false },
				]}
			/>
		);

		fireEvent.click(screen.getAllByTitle(/Enable reset/)[0]);
		expect(screen.getByTitle(/Reset enabled/)).toBeInTheDocument();

		fireEvent.click(screen.getByText('Loop'));
		expect(screen.getByText('∞')).toBeInTheDocument();
		fireEvent.click(screen.getByText('max'));
		expect(screen.getByRole('slider')).toBeInTheDocument();
	});
});
