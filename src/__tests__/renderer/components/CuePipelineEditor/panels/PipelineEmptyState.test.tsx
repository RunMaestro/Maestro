/**
 * Tests for PipelineEmptyState — Phase 14B extraction.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PipelineEmptyState } from '../../../../../renderer/components/CuePipelineEditor/panels/PipelineEmptyState';

const theme = {
	colors: {
		bgMain: '#000',
		bgActivity: '#111',
		border: '#333',
		textMain: '#fff',
		textDim: '#aaa',
		accent: '#09f',
	},
} as any;

afterEach(() => vi.useRealTimers());

describe('PipelineEmptyState', () => {
	it('renders nothing when nodeCount > 0', () => {
		const { container } = render(
			<PipelineEmptyState
				nodeCount={5}
				pipelineCount={1}
				theme={theme}
				createPipeline={vi.fn()}
				setTriggerDrawerOpen={vi.fn()}
				setAgentDrawerOpen={vi.fn()}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('shows CTA when zero pipelines exist', () => {
		render(
			<PipelineEmptyState
				nodeCount={0}
				pipelineCount={0}
				theme={theme}
				createPipeline={vi.fn()}
				setTriggerDrawerOpen={vi.fn()}
				setAgentDrawerOpen={vi.fn()}
			/>
		);
		expect(screen.getByText('Create your first pipeline')).toBeTruthy();
	});

	it('CTA click invokes createPipeline and opens both drawers (after timeout)', () => {
		vi.useFakeTimers();
		const createPipeline = vi.fn();
		const setTrigger = vi.fn();
		const setAgent = vi.fn();
		render(
			<PipelineEmptyState
				nodeCount={0}
				pipelineCount={0}
				theme={theme}
				createPipeline={createPipeline}
				setTriggerDrawerOpen={setTrigger}
				setAgentDrawerOpen={setAgent}
			/>
		);
		fireEvent.click(screen.getByText('Create your first pipeline'));
		expect(createPipeline).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(50);
		expect(setTrigger).toHaveBeenCalledWith(true);
		expect(setAgent).toHaveBeenCalledWith(true);
	});

	it('shows "drag a trigger" instructional when pipelines exist but canvas is empty', () => {
		render(
			<PipelineEmptyState
				nodeCount={0}
				pipelineCount={1}
				theme={theme}
				createPipeline={vi.fn()}
				setTriggerDrawerOpen={vi.fn()}
				setAgentDrawerOpen={vi.fn()}
			/>
		);
		expect(screen.getByText(/Drag a trigger/i)).toBeTruthy();
	});
});
