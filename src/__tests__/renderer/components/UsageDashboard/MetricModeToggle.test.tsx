/**
 * Tests for MetricModeToggle's average mode and the helpers beside it.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import {
	MetricModeToggle,
	OVERVIEW_METRIC_LABELS,
	formatMetricValue,
	metricModeNoun,
} from '../../../../renderer/components/UsageDashboard/MetricModeToggle';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

describe('MetricModeToggle', () => {
	it('offers an average mode and reports it back', () => {
		const onChange = vi.fn();
		render(
			<MetricModeToggle
				mode="count"
				onChange={onChange}
				theme={theme}
				modes={['count', 'duration', 'average']}
				labels={OVERVIEW_METRIC_LABELS}
			/>
		);
		expect(screen.getByText('Queries')).toBeInTheDocument();
		expect(screen.getByText('Time')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Show average time per query' }));
		expect(onChange).toHaveBeenCalledWith('average');
	});

	it('keeps the default labels when none are passed', () => {
		render(<MetricModeToggle mode="count" onChange={() => {}} theme={theme} />);
		expect(screen.getByText('Count')).toBeInTheDocument();
		expect(screen.getByText('Duration')).toBeInTheDocument();
		expect(screen.getByText('Tokens')).toBeInTheDocument();
	});
});

describe('metric helpers', () => {
	it('formats an average as a duration', () => {
		expect(formatMetricValue('average', 125_000)).toBe('2m 5s');
	});

	it('names the average mode for accessible labels', () => {
		expect(metricModeNoun('average')).toBe('average time per query');
		expect(metricModeNoun('count')).toBe('queries');
	});
});
