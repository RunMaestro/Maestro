/**
 * Tests for PipelineLegend — Phase 14B extraction.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PipelineLegend } from '../../../../../renderer/components/CuePipelineEditor/panels/PipelineLegend';
import type { CuePipeline } from '../../../../../shared/cue-pipeline-types';

const theme = {
	colors: {
		bgActivity: '#111',
		border: '#333',
		textMain: '#fff',
		textDim: '#aaa',
		accent: '#09f',
	},
} as any;

function p(id: string, name: string, color: string, nodes: unknown[] = []): CuePipeline {
	return { id, name, color, nodes: nodes as any, edges: [] };
}

describe('PipelineLegend', () => {
	it('renders a button per pipeline when in All-Pipelines view', () => {
		render(
			<PipelineLegend
				pipelines={[p('a', 'Alpha', '#f00'), p('b', 'Beta', '#0f0')]}
				selectedPipelineId={null}
				selectPipeline={vi.fn()}
				theme={theme}
			/>
		);
		expect(screen.getByTitle('Switch to Alpha')).toBeTruthy();
		expect(screen.getByTitle('Switch to Beta')).toBeTruthy();
	});

	it('renders nothing when selectedPipelineId is set', () => {
		const { container } = render(
			<PipelineLegend
				pipelines={[p('a', 'Alpha', '#f00')]}
				selectedPipelineId="a"
				selectPipeline={vi.fn()}
				theme={theme}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('renders nothing with zero pipelines', () => {
		const { container } = render(
			<PipelineLegend
				pipelines={[]}
				selectedPipelineId={null}
				selectPipeline={vi.fn()}
				theme={theme}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('clicking a legend button calls selectPipeline with that id', () => {
		const selectPipeline = vi.fn();
		render(
			<PipelineLegend
				pipelines={[p('a', 'Alpha', '#f00')]}
				selectedPipelineId={null}
				selectPipeline={selectPipeline}
				theme={theme}
			/>
		);
		fireEvent.click(screen.getByTitle('Switch to Alpha'));
		expect(selectPipeline).toHaveBeenCalledWith('a');
	});

	it('shows node count per pipeline', () => {
		render(
			<PipelineLegend
				pipelines={[p('a', 'Alpha', '#f00', [{}, {}, {}])]}
				selectedPipelineId={null}
				selectPipeline={vi.fn()}
				theme={theme}
			/>
		);
		expect(screen.getByText('(3)')).toBeTruthy();
	});
});
