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
});
