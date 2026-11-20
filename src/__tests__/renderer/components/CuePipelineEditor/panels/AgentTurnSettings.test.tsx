import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentTurnSettings } from '../../../../../renderer/components/CuePipelineEditor/panels/AgentTurnSettings';
import type { AgentNodeData } from '../../../../../shared/cue-pipeline-types';
import type { Theme } from '../../../../../renderer/types';

const theme = {
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#222',
		bgActivity: '#333',
		border: '#444',
		textMain: '#fff',
		textDim: '#999',
		accent: '#06b6d4',
	},
} as Theme;

function data(overrides: Partial<AgentNodeData> = {}): AgentNodeData {
	return { sessionId: 's-1', sessionName: 'Alpha', toolType: 'claude-code', ...overrides };
}

function openSelect(label: RegExp | string): void {
	fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('AgentTurnSettings', () => {
	it('labels each tier with the model it resolves to for this provider', () => {
		render(<AgentTurnSettings data={data()} theme={theme} onChange={vi.fn()} />);
		openSelect(/model/i);
		expect(screen.getByText('High tier (opus)')).toBeInTheDocument();
		expect(screen.getByText('Low tier (haiku)')).toBeInTheDocument();
	});

	it('writes a tier and clears any exact model when a tier is picked', () => {
		const onChange = vi.fn();
		render(<AgentTurnSettings data={data()} theme={theme} onChange={onChange} />);
		openSelect(/model/i);
		fireEvent.click(screen.getByText('High tier (opus)'));
		expect(onChange).toHaveBeenCalledWith({ tier: 'high', model: undefined });
	});

	it('offers no tiers for a provider without a tier table, only an exact model', () => {
		render(
			<AgentTurnSettings
				data={data({ toolType: 'copilot-cli' })}
				theme={theme}
				onChange={vi.fn()}
			/>
		);
		openSelect(/model/i);
		expect(screen.queryByText(/tier \(/)).not.toBeInTheDocument();
		expect(screen.getByText('Exact model...')).toBeInTheDocument();
	});

	it('shows the model id field for an exact model and writes it trimmed', () => {
		const onChange = vi.fn();
		render(
			<AgentTurnSettings
				data={data({ toolType: 'codex', model: 'gpt-5' })}
				theme={theme}
				onChange={onChange}
			/>
		);
		const input = screen.getByPlaceholderText('e.g. gpt-5.5-codex');
		fireEvent.change(input, { target: { value: ' gpt-5.5-codex ' } });
		expect(onChange).toHaveBeenCalledWith({ model: 'gpt-5.5-codex' });
	});

	it('hides effort for a provider with no effort setting', () => {
		render(
			<AgentTurnSettings data={data({ toolType: 'opencode' })} theme={theme} onChange={vi.fn()} />
		);
		expect(screen.queryByText('Effort')).not.toBeInTheDocument();
	});

	it('labels effort with the provider ladder value and writes the level', () => {
		const onChange = vi.fn();
		render(<AgentTurnSettings data={data()} theme={theme} onChange={onChange} />);
		openSelect(/effort/i);
		fireEvent.click(screen.getByText('High (max)'));
		expect(onChange).toHaveBeenCalledWith({ effort: 'high' });
	});
});
