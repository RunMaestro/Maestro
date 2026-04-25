/**
 * Tests for CueHelpContent component
 *
 * CueHelpContent displays comprehensive documentation about the Maestro Cue
 * event-driven automation feature. It renders inline within the CueModal.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CueHelpContent } from '../../../renderer/components/CueHelpModal';

import { mockTheme } from '../../helpers/mockTheme';
// Mock formatShortcutKeys to return predictable output
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
	isMacOS: () => false,
}));

// Sample theme for testing

describe('CueHelpContent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Content Sections', () => {
		beforeEach(() => {
			render(<CueHelpContent theme={mockTheme} />);
		});

		it('should render What is Maestro Cue section', () => {
			expect(screen.getByText('What is Maestro Cue?')).toBeInTheDocument();
			expect(screen.getByText(/event-driven automation system/)).toBeInTheDocument();
		});

		it('should render Getting Started section', () => {
			expect(screen.getByText('Getting Started')).toBeInTheDocument();
			expect(screen.getByText(/\.maestro\/cue\.yaml/)).toBeInTheDocument();
		});

		it('should render minimal YAML example', () => {
			expect(screen.getByText(/My First Cue/)).toBeInTheDocument();
		});

		it('should render Event Types section', () => {
			expect(screen.getByText('Event Types')).toBeInTheDocument();
		});

		it('should render all event types', () => {
			expect(screen.getAllByText('Heartbeat').length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('File Watch')).toBeInTheDocument();
			expect(screen.getByText('Agent Completed')).toBeInTheDocument();
		});

		it('should render event type codes', () => {
			expect(screen.getAllByText('time.heartbeat').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('file.changed').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('agent.completed').length).toBeGreaterThanOrEqual(1);
		});

		it('should render Template Variables section', () => {
			expect(screen.getByText('Template Variables')).toBeInTheDocument();
		});

		it('should render CUE template variables', () => {
			expect(screen.getByText('{{CUE_EVENT_TYPE}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_EVENT_TIMESTAMP}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_TRIGGER_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_RUN_ID}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_FILE_PATH}}')).toBeInTheDocument();
		});

		it('should render new file and agent completion template variables', () => {
			expect(screen.getByText('{{CUE_FILE_CHANGE_TYPE}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_SOURCE_STATUS}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_SOURCE_EXIT_CODE}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_SOURCE_DURATION}}')).toBeInTheDocument();
			expect(screen.getByText('{{CUE_SOURCE_TRIGGERED_BY}}')).toBeInTheDocument();
		});

		it('should mention standard Maestro template variables', () => {
			expect(screen.getByText('{{AGENT_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{DATE}}')).toBeInTheDocument();
		});

		it('should render Timeouts & Failure Handling section', () => {
			expect(screen.getByText('Timeouts & Failure Handling')).toBeInTheDocument();
			expect(screen.getByText(/Default timeout is 30 minutes/)).toBeInTheDocument();
		});

		it('should render Visual Pipeline Editor section', () => {
			expect(screen.getByText('Visual Pipeline Editor')).toBeInTheDocument();
		});

		it('should render Coordination Patterns section', () => {
			expect(screen.getByText('Coordination Patterns')).toBeInTheDocument();
		});

		it('should render all coordination pattern names', () => {
			expect(screen.getByText('Sequential Pipeline')).toBeInTheDocument();
			expect(screen.getByText('Fan-Out')).toBeInTheDocument();
			expect(screen.getByText('Fan-In (Gather)')).toBeInTheDocument();
			expect(screen.getByText('Swarm (Fan-Out + Fan-In)')).toBeInTheDocument();
			expect(screen.getByText('Command Action')).toBeInTheDocument();
			expect(screen.getByText('Task Queue')).toBeInTheDocument();
		});

		it('should render Event Filtering section', () => {
			expect(screen.getByText('Event Filtering')).toBeInTheDocument();
		});

		it('should mention triggeredBy filter', () => {
			const elements = screen.getAllByText(/triggeredBy/);
			expect(elements.length).toBeGreaterThan(0);
		});
	});

	describe('Shortcut Keys', () => {
		it('should render keyboard shortcut tip', () => {
			render(<CueHelpContent theme={mockTheme} />);

			const kbdElements = document.querySelectorAll('kbd');
			expect(kbdElements.length).toBeGreaterThan(0);
			expect(screen.getByText(/to open the Cue dashboard/)).toBeInTheDocument();
		});

		it('should render custom shortcut keys when provided', () => {
			render(<CueHelpContent theme={mockTheme} cueShortcutKeys={['Meta', 'Shift', 'c']} />);

			const kbdElements = document.querySelectorAll('kbd');
			const hasCustomShortcut = Array.from(kbdElements).some((kbd) => {
				const text = kbd.textContent || '';
				return text.includes('C') || text.includes('c');
			});
			expect(hasCustomShortcut).toBe(true);
		});
	});

	describe('Structure', () => {
		it('should render icons for each section', () => {
			render(<CueHelpContent theme={mockTheme} />);

			const svgElements = document.querySelectorAll('svg');
			expect(svgElements.length).toBeGreaterThan(5);
		});

		it('should render code elements for technical content', () => {
			render(<CueHelpContent theme={mockTheme} />);

			const codeElements = document.querySelectorAll('code');
			expect(codeElements.length).toBeGreaterThan(0);
		});
	});
});
