/**
 * Tests for the Gate on a trigger node: what TriggerConfig stores on the
 * trigger's config, which is what `pipelineToYaml` writes to every
 * subscription the trigger fans out into.
 *
 * The stored shape matters beyond tidiness: `triggerGroupKey` compares `gate`
 * and `gate_on_unavailable` as written, so an empty gate or a spelled-out
 * default policy would stop a trigger grouping with its own siblings.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
		data: { eventType, label: 'Trigger', config } satisfies TriggerNodeData,
	};
}

/** The config the panel last wrote to the node. */
function lastConfig(onUpdateNode: ReturnType<typeof vi.fn>): TriggerNodeData['config'] {
	flushAllPendingEdits();
	const [, patch] = onUpdateNode.mock.calls.at(-1)!;
	return (patch as Partial<TriggerNodeData>).config!;
}

describe('TriggerConfig gate', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.localModels.taskReadiness).mockResolvedValue([]);
	});

	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});

	it('stores a typed gate beside the rest of the trigger config', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('github.issue', { repo: 'org/repo' })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.change(screen.getByTestId('cue-gate-condition'), {
			target: { value: 'the issue reports a bug' },
		});

		expect(lastConfig(onUpdateNode)).toEqual({
			repo: 'org/repo',
			gate: 'the issue reports a bug',
		});
	});

	it('stores the policy only when it is not the default', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('file.changed', { watch: 'src/**', gate: 'a source file changed' })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'If no model can answer' }));
		fireEvent.click(screen.getByText('Skip the event'));
		expect(lastConfig(onUpdateNode)).toMatchObject({
			gate: 'a source file changed',
			gate_on_unavailable: 'skip',
		});

		fireEvent.click(screen.getByRole('button', { name: 'If no model can answer' }));
		fireEvent.click(screen.getByText('Start the run and warn me'));
		expect(lastConfig(onUpdateNode)).not.toHaveProperty('gate_on_unavailable');
	});

	it('removes both keys when the condition is cleared', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode('time.heartbeat', {
					interval_minutes: 30,
					gate: 'the build is red',
					gate_on_unavailable: 'skip',
				})}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.change(screen.getByTestId('cue-gate-condition'), { target: { value: '' } });

		expect(lastConfig(onUpdateNode)).toEqual({ interval_minutes: 30 });
	});

	it('offers the gate on every trigger that fires by itself', () => {
		const eventTypes: CueEventType[] = [
			'time.heartbeat',
			'time.scheduled',
			'file.changed',
			'github.pull_request',
			'github.issue',
			'github.label',
			'task.pending',
			'app.startup',
			'webhook.received',
		];
		for (const eventType of eventTypes) {
			const { unmount } = render(
				<TriggerConfig node={makeTriggerNode(eventType)} theme={theme} onUpdateNode={vi.fn()} />
			);
			expect(screen.getByTestId('cue-gate-field'), eventType).toBeInTheDocument();
			unmount();
		}
	});

	it('leaves the gate off a CLI trigger, which only fires from a manual run', () => {
		// A manual run is never gated, so a gate there could not apply.
		render(
			<TriggerConfig node={makeTriggerNode('cli.trigger')} theme={theme} onUpdateNode={vi.fn()} />
		);
		expect(screen.queryByTestId('cue-gate-field')).not.toBeInTheDocument();
	});
});
