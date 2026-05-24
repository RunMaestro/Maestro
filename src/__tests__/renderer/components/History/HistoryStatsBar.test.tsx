import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HistoryStatsBar } from '../../../../renderer/components/History/HistoryStatsBar';
import type { Theme } from '../../../../renderer/types';

const theme = {
	colors: {
		accent: '#7c3aed',
		border: '#2f3340',
		textDim: '#9ca3af',
		textMain: '#f9fafb',
		warning: '#f59e0b',
	},
} as Theme;

describe('HistoryStatsBar', () => {
	it('renders each history stat label with formatted counts', () => {
		render(
			<HistoryStatsBar
				theme={theme}
				stats={{
					agentCount: 12,
					sessionCount: 345,
					userCount: 6789,
					autoCount: 10,
					totalCount: 7156,
				}}
			/>
		);

		expect(screen.getByText('Agents')).toBeInTheDocument();
		expect(screen.getByText('Sessions')).toBeInTheDocument();
		expect(screen.getByText('User')).toBeInTheDocument();
		expect(screen.getByText('Auto')).toBeInTheDocument();
		expect(screen.getByText('Total')).toBeInTheDocument();

		expect(screen.getByText('12')).toBeInTheDocument();
		expect(screen.getByText('345')).toBeInTheDocument();
		expect(screen.getByText('6,789')).toBeInTheDocument();
		expect(screen.getByText('10')).toBeInTheDocument();
		expect(screen.getByText('7,156')).toBeInTheDocument();
	});
});
