import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunningAgentSubtext } from '../../../../../renderer/components/QuickActionsModal/components/RunningAgentSubtext';
import { mockTheme } from '../../../../helpers/mockTheme';

describe('RunningAgentSubtext', () => {
	it('renders elapsed time, busy tab name, and queue count', () => {
		render(
			<RunningAgentSubtext
				info={{
					state: 'busy',
					thinkingStartTime: 0,
					busyTabName: 'Planner',
					queueCount: 3,
				}}
				now={3000}
				theme={mockTheme}
				isSelected={false}
			/>
		);

		expect(screen.getByText(/3s/)).toBeInTheDocument();
		expect(screen.getByText(/Planner/)).toBeInTheDocument();
		expect(screen.getByText(/3 queued/)).toBeInTheDocument();
	});
});
