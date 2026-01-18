/**
 * Chart Accessibility Tests
 *
 * Tests verifying ARIA labels, roles, and accessibility features
 * across all Usage Dashboard chart components.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import { DurationTrendsChart } from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';
import { SummaryCards } from '../../../../renderer/components/UsageDashboard/SummaryCards';
import type { StatsAggregation } from '../../../../renderer/hooks/useStats';
import type { Theme } from '../../../../renderer/types';

// Mock theme for testing
const mockTheme: Theme = {
  id: 'test-dark',
  name: 'Test Dark',
  colors: {
    bgMain: '#1a1a1a',
    bgSecondary: '#2a2a2a',
    bgActivity: '#3a3a3a',
    textMain: '#ffffff',
    textDim: '#888888',
    border: '#444444',
    accent: '#3b82f6',
    green: '#10b981',
    yellow: '#f59e0b',
    red: '#ef4444',
    orange: '#f97316',
    scrollbarThumb: '#555555',
    scrollbarTrack: '#222222',
  },
};

// Mock data for testing
const mockStatsData: StatsAggregation = {
  totalQueries: 150,
  totalDuration: 7200000, // 2 hours
  avgDuration: 48000, // 48 seconds
  byAgent: {
    'claude-code': { count: 100, duration: 5000000 },
    'opencode': { count: 30, duration: 1500000 },
    'gemini-cli': { count: 20, duration: 700000 },
  },
  bySource: {
    user: 120,
    auto: 30,
  },
  byLocation: { local: 120, remote: 30 },
  byDay: [
    { date: '2025-01-20', count: 50, duration: 2400000 },
    { date: '2025-01-21', count: 45, duration: 2160000 },
    { date: '2025-01-22', count: 55, duration: 2640000 },
  ],
  byHour: [
    { hour: 9, count: 50, duration: 2400000 },
    { hour: 14, count: 100, duration: 4800000 },
  ],
  totalSessions: 25,
  sessionsByAgent: { 'claude-code': 15, 'opencode': 6, 'gemini-cli': 4 },
  sessionsByDay: [
    { date: '2025-01-20', count: 8 },
    { date: '2025-01-21', count: 9 },
    { date: '2025-01-22', count: 8 },
  ],
  avgSessionDuration: 288000,
};

describe('Chart Accessibility - AgentComparisonChart', () => {
  it('has role="figure" on the container', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure).toBeInTheDocument();
  });

  it('has descriptive aria-label on the container', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure).toHaveAttribute('aria-label');
    expect(figure.getAttribute('aria-label')).toContain('Provider comparison chart');
    expect(figure.getAttribute('aria-label')).toContain('3 providers displayed');
  });

  it('has proper aria attributes on meter elements', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const meters = screen.getAllByRole('meter');

    // Component now shows unified view with meter elements for each agent bar
    expect(meters.length).toBeGreaterThanOrEqual(1);
    meters.forEach(meter => {
      expect(meter).toHaveAttribute('aria-valuenow');
      expect(meter).toHaveAttribute('aria-valuemin', '0');
      expect(meter).toHaveAttribute('aria-valuemax', '100');
    });
  });

  it('has role="list" on the data container', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const list = screen.getByRole('list', { name: /agent usage data/i });
    expect(list).toBeInTheDocument();
  });

  it('has role="listitem" on each agent row', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const listItems = screen.getAllByRole('listitem');
    // 3 agent rows + up to 6 legend items
    expect(listItems.length).toBeGreaterThanOrEqual(3);
  });

  it('has role="meter" on progress bars', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(3);
    meters.forEach(meter => {
      expect(meter).toHaveAttribute('aria-valuenow');
      expect(meter).toHaveAttribute('aria-valuemin', '0');
      expect(meter).toHaveAttribute('aria-valuemax', '100');
    });
  });

  it('has legend with role="list"', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const legend = screen.getByRole('list', { name: /chart legend/i });
    expect(legend).toBeInTheDocument();
  });
});

describe('Chart Accessibility - SourceDistributionChart', () => {
  it('has role="figure" on the container', () => {
    render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure).toBeInTheDocument();
  });

  it('has descriptive aria-label mentioning session type', () => {
    render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure.getAttribute('aria-label')).toContain('Session type');
  });

  it('has aria-pressed on toggle buttons', () => {
    render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    const countButton = screen.getByRole('button', { name: /show query count/i });
    const durationButton = screen.getByRole('button', { name: /show total duration/i });

    expect(countButton).toHaveAttribute('aria-pressed');
    expect(durationButton).toHaveAttribute('aria-pressed');
  });

  it('has role="img" on the SVG donut chart', () => {
    render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    const svgChart = screen.getByRole('img');
    expect(svgChart).toHaveAttribute('aria-label');
    expect(svgChart.getAttribute('aria-label')).toContain('Donut chart');
  });

  it('has legend with role="list" and listitem roles', () => {
    render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    const legend = screen.getByRole('list', { name: /chart legend/i });
    expect(legend).toBeInTheDocument();

    const legendItems = within(legend).getAllByRole('listitem');
    expect(legendItems.length).toBeGreaterThanOrEqual(1);
  });

  it('legend items have descriptive aria-labels', () => {
    render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    const legend = screen.getByRole('list', { name: /chart legend/i });
    const legendItems = within(legend).getAllByRole('listitem');

    legendItems.forEach(item => {
      expect(item).toHaveAttribute('aria-label');
      const label = item.getAttribute('aria-label') || '';
      expect(label).toMatch(/\d+\.\d+%/); // Contains percentage
    });
  });
});

describe('Chart Accessibility - ActivityHeatmap', () => {
  it('has role="figure" on the container', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure).toBeInTheDocument();
  });

  it('has descriptive aria-label mentioning activity heatmap', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure.getAttribute('aria-label')).toContain('Activity heatmap');
    expect(figure.getAttribute('aria-label')).toContain('days');
  });

  it('has aria-pressed on toggle buttons', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const countButton = screen.getByRole('button', { name: /show query count/i });
    const durationButton = screen.getByRole('button', { name: /show total duration/i });

    expect(countButton).toHaveAttribute('aria-pressed');
    expect(durationButton).toHaveAttribute('aria-pressed');
  });

  it('has role="gridcell" on heatmap cells', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const cells = screen.getAllByRole('gridcell');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('heatmap cells have descriptive aria-labels', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const cells = screen.getAllByRole('gridcell');

    cells.forEach(cell => {
      expect(cell).toHaveAttribute('aria-label');
      const label = cell.getAttribute('aria-label') || '';
      expect(label).toMatch(/\d+ quer(y|ies)/); // Contains query count
    });
  });

  it('heatmap cells are keyboard focusable', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const cells = screen.getAllByRole('gridcell');

    cells.forEach(cell => {
      expect(cell).toHaveAttribute('tabIndex', '0');
    });
  });

  it('legend has role="list" with descriptive items', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const legend = screen.getByRole('list', { name: /intensity scale/i });
    expect(legend).toBeInTheDocument();

    const legendItems = within(legend).getAllByRole('listitem');
    expect(legendItems).toHaveLength(5); // 5 intensity levels
  });

  it('legend items describe intensity levels', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const legend = screen.getByRole('list', { name: /intensity scale/i });
    const legendItems = within(legend).getAllByRole('listitem');

    const labels = legendItems.map(item => item.getAttribute('aria-label') || '');
    expect(labels.some(l => l.includes('No activity'))).toBe(true);
    expect(labels.some(l => l.includes('High'))).toBe(true);
  });
});

describe('Chart Accessibility - DurationTrendsChart', () => {
  it('has role="figure" on the container', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure).toBeInTheDocument();
  });

  it('has descriptive aria-label mentioning duration trends', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const figure = screen.getByRole('figure');
    expect(figure.getAttribute('aria-label')).toContain('Duration trends chart');
  });

  it('has role="img" on the SVG chart', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const svgChart = screen.getByRole('img');
    expect(svgChart).toHaveAttribute('aria-label');
    expect(svgChart.getAttribute('aria-label')).toContain('Line chart');
  });

  it('data points have role="graphics-symbol"', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const dataPoints = screen.getAllByRole('graphics-symbol');
    expect(dataPoints).toHaveLength(3); // 3 data points in mock data
  });

  it('data points have descriptive aria-labels', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const dataPoints = screen.getAllByRole('graphics-symbol');

    dataPoints.forEach(point => {
      expect(point).toHaveAttribute('aria-label');
      const label = point.getAttribute('aria-label') || '';
      expect(label).toContain('Average duration');
      expect(label).toMatch(/\d+ quer(y|ies)/);
    });
  });

  it('data points are keyboard focusable', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const dataPoints = screen.getAllByRole('graphics-symbol');

    dataPoints.forEach(point => {
      // SVG elements use tabindex (lowercase) attribute
      expect(point.getAttribute('tabindex') || point.getAttribute('tabIndex')).toBe('0');
    });
  });

  it('smoothing toggle has aria-label', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const toggleButton = screen.getByRole('button', { name: /smoothing/i });
    expect(toggleButton).toBeInTheDocument();
  });
});

describe('Chart Accessibility - SummaryCards', () => {
  it('has role="region" on the container', () => {
    render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
    const region = screen.getByRole('region', { name: /usage summary metrics/i });
    expect(region).toBeInTheDocument();
  });

  it('each metric card has role="group"', () => {
    render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(6); // 6 metric cards
  });

  it('metric cards have descriptive aria-labels', () => {
    render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
    const groups = screen.getAllByRole('group');

    const expectedLabels = [
      /Sessions/i,
      /Total Queries/i,
      /Total Time/i,
      /Avg Duration/i,
      /Top Agent/i,
      /Interactive %/i,
    ];

    groups.forEach((group, index) => {
      expect(group).toHaveAttribute('aria-label');
      const label = group.getAttribute('aria-label') || '';
      expect(label).toMatch(expectedLabels[index]);
    });
  });

  it('metric cards include values in aria-labels', () => {
    render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
    const groups = screen.getAllByRole('group');

    groups.forEach(group => {
      const label = group.getAttribute('aria-label') || '';
      // Should contain a value (number, time, or percentage)
      expect(label).toMatch(/: .+/); // Has colon followed by value
    });
  });
});

describe('Chart Accessibility - General ARIA Patterns', () => {
  it('all charts have proper heading structure', () => {
    // Render each chart and verify h3 headings exist
    const { unmount: u1 } = render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    expect(screen.getByRole('heading', { level: 3, name: /provider comparison/i })).toBeInTheDocument();
    u1();

    const { unmount: u2 } = render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    expect(screen.getByRole('heading', { level: 3, name: /session type/i })).toBeInTheDocument();
    u2();

    const { unmount: u3 } = render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    expect(screen.getByRole('heading', { level: 3, name: /activity heatmap/i })).toBeInTheDocument();
    u3();

    const { unmount: u4 } = render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    expect(screen.getByRole('heading', { level: 3, name: /duration trends/i })).toBeInTheDocument();
    u4();
  });

  it('meter elements use proper ARIA attributes', () => {
    const { unmount: u1 } = render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    // Component now shows unified view with meter elements for each agent bar
    const meters = screen.getAllByRole('meter');
    expect(meters.length).toBeGreaterThanOrEqual(1);
    // Each meter should have aria-valuenow, aria-valuemin, aria-valuemax
    meters.forEach(meter => {
      expect(meter).toHaveAttribute('aria-valuenow');
      expect(meter).toHaveAttribute('aria-valuemin');
      expect(meter).toHaveAttribute('aria-valuemax');
    });
    u1();
  });

  it('empty states are properly announced', () => {
    const emptyData: StatsAggregation = {
      totalQueries: 0,
      totalDuration: 0,
      avgDuration: 0,
      byAgent: {},
      bySource: { user: 0, auto: 0 },
      byLocation: { local: 0, remote: 0 },
      byDay: [],
      byHour: [],
      totalSessions: 0,
      sessionsByAgent: {},
      sessionsByDay: [],
      avgSessionDuration: 0,
    };

    render(<AgentComparisonChart data={emptyData} theme={mockTheme} />);
    expect(screen.getByText(/no agent data available/i)).toBeInTheDocument();
  });

  it('interactive elements are keyboard accessible', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);

    // All toggle buttons should be focusable
    const buttons = screen.getAllByRole('button');
    buttons.forEach(button => {
      expect(button.tabIndex).not.toBe(-1);
    });

    // Grid cells should be focusable
    const cells = screen.getAllByRole('gridcell');
    cells.forEach(cell => {
      expect(cell).toHaveAttribute('tabIndex', '0');
    });
  });
});

describe('Chart Accessibility - Screen Reader Announcements', () => {
  it('AgentComparisonChart aria-label describes displayed data', () => {
    render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
    const figure = screen.getByRole('figure');

    // Should describe what the chart shows (now unified count and duration)
    const ariaLabel = figure.getAttribute('aria-label') || '';
    expect(ariaLabel).toContain('query counts');
    expect(ariaLabel).toContain('duration');
    expect(ariaLabel).toContain('providers displayed');
  });

  it('SourceDistributionChart provides percentage summary in SVG', () => {
    render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
    const svg = screen.getByRole('img');
    const label = svg.getAttribute('aria-label') || '';

    // Should contain percentages for both sources
    expect(label).toContain('%');
    expect(label).toContain('Interactive');
  });

  it('DurationTrendsChart announces data range in SVG', () => {
    render(<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const svg = screen.getByRole('img');
    const label = svg.getAttribute('aria-label') || '';

    expect(label).toContain('Range from');
    expect(label).toContain('to');
  });

  it('ActivityHeatmap cells announce date and value', () => {
    render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);
    const cells = screen.getAllByRole('gridcell');

    // Each cell should announce its date and query count
    // Format: "Dec 24 0:00: 0 queries" or "Dec 24 AM: 0 queries"
    const firstCellLabel = cells[0].getAttribute('aria-label') || '';
    expect(firstCellLabel).toMatch(/\w+ \d+/); // Month and day (e.g., "Dec 24")
    expect(firstCellLabel).toContain('quer'); // query or queries
  });
});
