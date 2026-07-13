import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmpWorkspace } from '../OmpWorkspace';
import type { OmpWorkspaceAdapter, OmpWorkspaceSnapshot } from '../types';

const theme = {
	colors: {
		accent: '#d98942',
		border: '#39424e',
		bgMain: '#11161c',
		bgSidebar: '#161d25',
		bgActivity: '#1b252f',
		textMain: '#f2f5f7',
		textDim: '#9aa7b5',
	},
} as const;

function snapshot(overrides: Partial<OmpWorkspaceSnapshot> = {}): OmpWorkspaceSnapshot {
	return {
		connection: 'ready',
		models: ['anthropic/claude-opus-4-8', 'openai/gpt-5.4'],
		sessions: [
			{
				id: 'session-a',
				title: 'Refactor queue processing',
				updatedAt: 1_735_689_600_000,
				status: 'streaming',
				model: 'anthropic/claude-opus-4-8',
				mode: 'build',
				branch: 'feature/queue',
				events: [
					{ id: 'user-1', kind: 'user', text: 'Make queue delivery deterministic.' },
					{
						id: 'think-1',
						kind: 'thinking',
						text: 'Inspecting ordering constraints.',
						expanded: false,
					},
					{
						id: 'tool-1',
						kind: 'tool',
						name: 'read',
						status: 'complete',
						input: 'src/renderer/stores/queue.ts',
						output: '42 lines read',
					},
					{
						id: 'approval-1',
						kind: 'approval',
						requestId: 'approval-1',
						description: 'Apply queue ordering change?',
					},
					{
						id: 'artifact-1',
						kind: 'artifact',
						name: 'queue-ordering.patch',
						artifactType: 'patch',
					},
					{ id: 'usage-1', kind: 'usage', inputTokens: 120, outputTokens: 35, costUsd: 0.01 },
					{
						id: 'assistant-1',
						kind: 'assistant',
						text: 'The queue is now ordered by creation time.',
					},
				],
				tree: [{ id: 'root', label: 'Turn 1', children: [{ id: 'child', label: 'Tool: read' }] }],
				subagents: [{ id: 'reviewer', label: 'Reviewer', status: 'running' }],
				usage: { inputTokens: 120, outputTokens: 35, costUsd: 0.01 },
			},
		],
		activeSessionId: 'session-a',
		...overrides,
	};
}

class DeterministicOmpAdapter implements OmpWorkspaceAdapter {
	public readonly selectSession = vi.fn(async () => {});
	public readonly createSession = vi.fn(async () => {});
	public readonly sendMessage = vi.fn(async () => {});
	public readonly abort = vi.fn(async () => {});
	public readonly setModel = vi.fn(async () => {});
	public readonly setMode = vi.fn(async () => {});
	public readonly resolveApproval = vi.fn(async () => {});
	public readonly retry = vi.fn(async () => {});
	private listener: ((next: OmpWorkspaceSnapshot) => void) | null = null;

	public constructor(private next: OmpWorkspaceSnapshot) {}

	public async getSnapshot(): Promise<OmpWorkspaceSnapshot> {
		return this.next;
	}

	public subscribe(listener: (next: OmpWorkspaceSnapshot) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = null;
		};
	}

	public emit(next: OmpWorkspaceSnapshot): void {
		this.next = next;
		this.listener?.(next);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('OmpWorkspace', () => {
	it('renders streamed events and dispatches session controls through its adapter', async () => {
		const adapter = new DeterministicOmpAdapter(snapshot());
		render(<OmpWorkspace adapter={adapter} theme={theme} />);

		expect(await screen.findByRole('heading', { name: 'Refactor queue processing' })).toBeVisible();
		expect(screen.queryByText('Inspecting ordering constraints.')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Show thinking' }));
		expect(screen.getByText('Inspecting ordering constraints.')).toBeVisible();
		expect(screen.getByText('42 lines read')).toBeVisible();
		expect(screen.getByText('queue-ordering.patch')).toBeVisible();

		fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
		expect(adapter.resolveApproval).toHaveBeenCalledWith('session-a', 'approval-1', true);

		fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'openai/gpt-5.4' } });
		expect(adapter.setModel).toHaveBeenCalledWith('session-a', 'openai/gpt-5.4');
		fireEvent.click(screen.getByRole('button', { name: 'Plan mode' }));
		expect(adapter.setMode).toHaveBeenCalledWith('session-a', 'plan');

		const file = new File(['diagram'], 'design.txt', { type: 'text/plain' });
		fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [file] } });
		expect(screen.getByText('design.txt')).toBeVisible();
		fireEvent.change(screen.getByLabelText('OMP message'), {
			target: { value: 'Run the focused test.' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		expect(adapter.sendMessage).toHaveBeenCalledWith('session-a', 'Run the focused test.', [file]);
		fireEvent.click(screen.getByRole('button', { name: 'Abort stream' }));
		expect(adapter.abort).toHaveBeenCalledWith('session-a');
	});

	it('shows offline and incompatible recovery states emitted by the deterministic adapter', async () => {
		const adapter = new DeterministicOmpAdapter(snapshot({ connection: 'offline' }));
		render(<OmpWorkspace adapter={adapter} theme={theme} />);

		expect(await screen.findByRole('status')).toHaveTextContent('Offline');
		fireEvent.click(screen.getByRole('button', { name: 'Retry OMP connection' }));
		expect(adapter.retry).toHaveBeenCalledTimes(1);

		act(() =>
			adapter.emit(
				snapshot({ connection: 'incompatible', incompatibilityReason: 'OMP 16.4.8 required' })
			)
		);
		await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('OMP 16.4.8 required'));
	});
	it('marks a deep-linked event as the focused transcript target', async () => {
		const adapter = new DeterministicOmpAdapter(snapshot());
		render(<OmpWorkspace adapter={adapter} theme={theme} focusEventId="tool-1" />);

		const target = await screen.findByTestId('omp-event-tool-1');
		expect(target).toHaveAttribute('data-omp-focused', 'true');
	});
});
