import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../../../constants/themes';
import type { LogEntry } from '../../../types';
import { OmpTurnFabric } from './OmpTurnFabric';

const logs: LogEntry[] = [
	{ id: 'prompt', timestamp: 1_000, source: 'user', text: 'Inspect the adapter' },
	{
		id: 'tool',
		timestamp: 3_000,
		source: 'tool',
		text: 'read',
		metadata: { toolState: { status: 'completed' } },
	},
	{
		id: 'steer',
		timestamp: 4_000,
		source: 'user',
		text: 'Also verify ownership',
		deliveryIntent: 'steer',
	},
	{
		id: 'replace',
		timestamp: 5_000,
		source: 'user',
		text: 'Replace this request',
		deliveryIntent: 'abort_and_prompt',
		deliveryState: 'consumed',
	},
];

describe('OmpTurnFabric', () => {
	it('keeps tool activity, steer injection, interruption seam, lanes, and only observed receipt metrics in flow', () => {
		render(
			<OmpTurnFabric
				logs={logs}
				theme={THEMES.dracula}
				isLive={false}
				subagents={[
					{ id: 'sub-1', label: 'reviewer', status: 'complete', detail: 'checked adapter' },
				]}
				renderLog={(log) => <span>{log.text}</span>}
			/>
		);
		expect(screen.getByTestId('omp-turn-fabric')).toHaveTextContent('Inspect the adapter');
		expect(screen.getByText('Steered')).toBeInTheDocument();
		expect(screen.getByText('Superseded')).toBeInTheDocument();
		expect(screen.getByText(/1 tool/)).toBeInTheDocument();
		expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();
	});

	it('starts a new turn from a consumed follow-up without preserving queued chrome', () => {
		render(
			<OmpTurnFabric
				logs={[
					{ id: 'first', timestamp: 1_000, source: 'user', text: 'First request' },
					{ id: 'a', timestamp: 2_000, source: 'ai', text: 'Output A' },
					{ id: 'b', timestamp: 3_000, source: 'ai', text: 'Output B' },
					{
						id: 'follow-up',
						timestamp: 4_000,
						source: 'user',
						text: 'Follow-up request',
						deliveryIntent: 'follow_up',
						deliveryState: 'consumed',
					},
					{ id: 'c', timestamp: 5_000, source: 'ai', text: 'Output C' },
				]}
				theme={THEMES.dracula}
				isLive={false}
				renderLog={(log) => <span>{log.text}</span>}
			/>
		);

		const turns = screen.getAllByLabelText('Completed OMP turn');
		expect(turns).toHaveLength(2);
		expect(turns[0]).toHaveTextContent('Output A');
		expect(turns[0]).toHaveTextContent('Output B');
		expect(turns[0]).not.toHaveTextContent('Follow-up request');
		expect(turns[1]).toHaveTextContent('Follow-up request');
		expect(turns[1]).toHaveTextContent('Output C');
		expect(screen.queryByText(/Queued follow-up/)).not.toBeInTheDocument();
	});

	it('places the superseded seam between aborted output and a consumed replacement turn', () => {
		render(
			<OmpTurnFabric
				logs={[
					{ id: 'first', timestamp: 1_000, source: 'user', text: 'Aborted request' },
					{ id: 'aborted-output', timestamp: 2_000, source: 'ai', text: 'Aborted output' },
					{
						id: 'replacement',
						timestamp: 3_000,
						source: 'user',
						text: 'Replacement request',
						deliveryIntent: 'abort_and_prompt',
						deliveryState: 'consumed',
					},
					{ id: 'replacement-output', timestamp: 4_000, source: 'ai', text: 'Replacement output' },
				]}
				theme={THEMES.dracula}
				isLive={false}
				renderLog={(log) => <span>{log.text}</span>}
			/>
		);

		const abortedOutput = screen.getByText('Aborted output');
		const seam = screen.getByText('Superseded');
		const replacement = screen.getByText('Replacement request');
		const replacementOutput = screen.getByText('Replacement output');
		expect(
			abortedOutput.compareDocumentPosition(seam) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(
			seam.compareDocumentPosition(replacement) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(
			replacement.compareDocumentPosition(replacementOutput) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});
});
