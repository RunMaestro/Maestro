/**
 * Regression test: TriggerConfig must flush its debounced `onUpdateNode`
 * writes when (a) the panel unmounts and (b) `flushAllPendingEdits()` runs
 * before a save.
 *
 * Without the flush hooks, toggling the GitHub re-trigger checkbox (or
 * editing the custom label) and immediately closing the panel or saving
 * inside the 300ms debounce window silently drops the edit, producing the
 * user-visible "toggle does not stick across app restart" bug.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';

import { TriggerConfig } from '../../../../../renderer/components/CuePipelineEditor/panels/triggers/TriggerConfig';
import { THEMES } from '../../../../../renderer/constants/themes';
import {
	flushAllPendingEdits,
	__resetPendingEditsRegistryForTests,
} from '../../../../../renderer/hooks/cue/pendingEditsRegistry';
import type { PipelineNode, TriggerNodeData } from '../../../../../shared/cue-pipeline-types';

const theme = THEMES['dracula'];

function makeTriggerNode(config: TriggerNodeData['config'] = {}): PipelineNode {
	return {
		id: 'trigger-1',
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType: 'github.pull_request',
			label: 'Pull Request',
			config: { repo: 'org/repo', poll_minutes: 5, ...config },
		} satisfies TriggerNodeData,
	};
}

describe('TriggerConfig debounced-edit flushing', () => {
	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});

	it('flushAllPendingEdits propagates a pending retrigger_on_comments toggle before the 300ms debounce', () => {
		const onUpdateNode = vi.fn();
		render(
			<TriggerConfig
				node={makeTriggerNode({ retrigger_on_comments: false })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		const checkbox = screen.getByRole('checkbox', {
			name: /Re-trigger on new activity/i,
		});
		fireEvent.click(checkbox);

		// Debounced, so no immediate write.
		expect(onUpdateNode).not.toHaveBeenCalled();

		// handleSave's flush path must pick up the pending toggle.
		flushAllPendingEdits();

		expect(onUpdateNode).toHaveBeenCalledTimes(1);
		const [nodeId, patch] = onUpdateNode.mock.calls[0];
		expect(nodeId).toBe('trigger-1');
		expect((patch as Partial<TriggerNodeData>).config?.retrigger_on_comments).toBe(true);
	});

	it('unmounting flushes a pending retrigger toggle (closing the panel preserves the edit)', () => {
		const onUpdateNode = vi.fn();
		const { unmount } = render(
			<TriggerConfig
				node={makeTriggerNode({ retrigger_on_comments: false })}
				theme={theme}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.click(screen.getByRole('checkbox', { name: /Re-trigger on new activity/i }));
		expect(onUpdateNode).not.toHaveBeenCalled();

		unmount();

		expect(onUpdateNode).toHaveBeenCalledTimes(1);
		const [, patch] = onUpdateNode.mock.calls[0];
		expect((patch as Partial<TriggerNodeData>).config?.retrigger_on_comments).toBe(true);
	});

	it('registers and unregisters with the pending-edits registry on mount/unmount', () => {
		const onUpdateNode = vi.fn();
		const { unmount } = render(
			<TriggerConfig node={makeTriggerNode()} theme={theme} onUpdateNode={onUpdateNode} />
		);

		// Before unmount: a flush via the registry hits the panel.
		fireEvent.click(screen.getByRole('checkbox', { name: /Re-trigger on new activity/i }));
		flushAllPendingEdits();
		expect(onUpdateNode).toHaveBeenCalledTimes(1);

		onUpdateNode.mockClear();
		unmount();

		// After unmount the panel's flush callback must be removed from the
		// registry, otherwise registry leaks would keep firing stale closures.
		flushAllPendingEdits();
		expect(onUpdateNode).not.toHaveBeenCalled();
	});
});
