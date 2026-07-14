import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { THEMES } from '../../constants/themes';
import { SessionInspector, type AgentRuntimeFeatureState } from './SessionInspector';

const runtimeFeatures: AgentRuntimeFeatureState = {
	controls: [],
	tree: [
		{
			id: 'root-entry',
			label: 'Initial request',
			children: [{ id: 'child-entry', label: 'Implement native inspector' }],
		},
	],
	todos: [
		{
			name: 'Implementation',
			items: [
				{ content: 'Build inspector', state: 'in_progress' },
				{ content: 'Verify behavior', state: 'done' },
			],
		},
	],
	subagents: [
		{ id: 'subagent-1', label: 'Runtime adapter', status: 'running', detail: 'Streaming events' },
		{ id: 'subagent-2', label: 'Storage adapter', status: 'complete' },
	],
	stats: { Tokens: 1248, Duration: '2m 15s', Tools: 7 },
};

describe('SessionInspector', () => {
	it('renders tree, todos, running subagents, and session stats', () => {
		render(
			<SessionInspector
				sessionId="session-1"
				runtimeFeatures={runtimeFeatures}
				theme={THEMES.dracula}
				onBranchSession={vi.fn()}
			/>
		);

		expect(screen.getByRole('region', { name: 'Session inspector' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Conversation tree' })).toBeInTheDocument();
		expect(screen.getByText('Initial request')).toBeInTheDocument();
		expect(screen.getByText('Implement native inspector')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Implement native inspector' }));
		expect(screen.getByRole('button', { name: 'Implement native inspector' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(screen.getByRole('heading', { name: 'Todos' })).toBeInTheDocument();
		expect(screen.getByText('Build inspector')).toBeInTheDocument();
		expect(screen.getByText('in progress')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Subagents' })).toBeInTheDocument();
		expect(screen.getByText('Runtime adapter')).toBeInTheDocument();
		expect(screen.getByText('Streaming events')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Session stats' })).toBeInTheDocument();
		expect(screen.getByText('1,248')).toBeInTheDocument();
		expect(screen.getByText('2m 15s')).toBeInTheDocument();
	});

	it('branches the selected conversation entry with the active session id', () => {
		const onBranchSession = vi.fn();
		render(
			<SessionInspector
				sessionId="session-1"
				runtimeFeatures={runtimeFeatures}
				theme={THEMES.dracula}
				onBranchSession={onBranchSession}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Branch from Implement native inspector' }));
		expect(onBranchSession).toHaveBeenCalledWith('session-1', 'child-entry');
	});

	it('renders nothing when runtime features are unavailable', () => {
		const { container } = render(
			<SessionInspector
				sessionId="session-1"
				runtimeFeatures={null}
				theme={THEMES.dracula}
				onBranchSession={vi.fn()}
			/>
		);

		expect(container).toBeEmptyDOMElement();
	});
});
