/**
 * The optional "Also take GitHub webhooks" section on GitHub triggers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';

import { TriggerConfig } from '../../../../../renderer/components/CuePipelineEditor/panels/triggers/TriggerConfig';
import { THEMES } from '../../../../../renderer/constants/themes';
import {
	flushAllPendingEdits,
	__resetPendingEditsRegistryForTests,
} from '../../../../../renderer/hooks/cue/pendingEditsRegistry';
import type {
	CueEventType,
	PipelineNode,
	TriggerNodeData,
} from '../../../../../shared/cue-pipeline-types';

const theme = THEMES['dracula'];

function makeTriggerNode(
	eventType: CueEventType,
	config: TriggerNodeData['config'] = {}
): PipelineNode {
	return {
		id: 'trigger-1',
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType,
			label: 'Review PRs',
			config: { repo: 'org/repo', ...config },
		} satisfies TriggerNodeData,
	};
}

function lastConfig(onUpdateNode: ReturnType<typeof vi.fn>): TriggerNodeData['config'] {
	const calls = onUpdateNode.mock.calls;
	return (calls[calls.length - 1][1] as Partial<TriggerNodeData>).config!;
}

describe('TriggerConfig GitHub webhook section', () => {
	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});

	it.each(['github.pull_request', 'github.issue', 'github.label'] as const)(
		'%s starts collapsed without webhook settings and opens on the checkbox',
		(eventType) => {
			render(
				<TriggerConfig node={makeTriggerNode(eventType)} theme={theme} onUpdateNode={vi.fn()} />
			);
			const checkbox = screen.getByRole('checkbox', { name: /Also take GitHub webhooks/i });
			expect(checkbox).not.toBeChecked();
			expect(screen.queryByPlaceholderText('GITHUB_WEBHOOK_SECRET')).toBeNull();

			fireEvent.click(checkbox);
			expect(screen.getByPlaceholderText('GITHUB_WEBHOOK_SECRET')).toBeInTheDocument();
			expect(screen.getByText('/cue/review-prs')).toBeInTheDocument();
		}
	);

	it('saves the shown path when switched on, so the choice survives a reload', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.pull_request')}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);
		fireEvent.click(screen.getByRole('checkbox', { name: /Also take GitHub webhooks/i }));
		flushAllPendingEdits();
		expect(lastConfig(onUpdateNode)).toMatchObject({ webhook_path: 'review-prs' });
	});

	it("shows a saved trigger's subscription name as the default path", () => {
		const node = makeTriggerNode('github.issue', { webhook_secret_env: 'GH_SECRET' });
		(node.data as TriggerNodeData).subscriptionName = 'Nightly Triage';
		render(<TriggerConfig node={node} theme={theme} onUpdateNode={vi.fn()} />);
		expect(screen.getByText('/cue/nightly-triage')).toBeInTheDocument();
	});

	it('opens already filled in for a trigger that carries webhook settings', () => {
		render(
			<TriggerConfig
				node={makeTriggerNode('github.pull_request', { webhook_secret_env: 'GH_SECRET' })}
				theme={theme}
				onUpdateNode={vi.fn()}
			/>
		);
		expect(screen.getByRole('checkbox', { name: /Also take GitHub webhooks/i })).toBeChecked();
		expect(screen.getByDisplayValue('GH_SECRET')).toBeInTheDocument();
	});

	it('writes the secret env var and path into the trigger config', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.issue')}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);
		fireEvent.click(screen.getByRole('checkbox', { name: /Also take GitHub webhooks/i }));
		fireEvent.change(screen.getByPlaceholderText('GITHUB_WEBHOOK_SECRET'), {
			target: { value: 'GH_SECRET' },
		});
		flushAllPendingEdits();
		expect(lastConfig(onUpdateNode)).toMatchObject({ webhook_secret_env: 'GH_SECRET' });
	});

	it('drops every webhook setting when turned off', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.pull_request', {
					webhook_path: 'gh',
					webhook_secret_env: 'GH_SECRET',
					webhook_signature_header: 'X-Hub-Signature-256',
				})}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);
		fireEvent.click(screen.getByRole('checkbox', { name: /Also take GitHub webhooks/i }));
		flushAllPendingEdits();

		const config = lastConfig(onUpdateNode);
		expect(config.webhook_path).toBeUndefined();
		expect(config.webhook_secret_env).toBeUndefined();
		expect(config.webhook_signature_header).toBeUndefined();
		expect(config.repo).toBe('org/repo');
	});

	it('shows the slower reconcile interval as the poll default once webhooks are on', () => {
		render(
			<TriggerConfig
				node={makeTriggerNode('github.pull_request')}
				theme={theme}
				onUpdateNode={vi.fn()}
			/>
		);
		expect(screen.getByPlaceholderText('5')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('checkbox', { name: /Also take GitHub webhooks/i }));
		expect(screen.getByPlaceholderText('30')).toBeInTheDocument();
	});
});
