/**
 * PlaybookRunSummary: the row above Run that prices one click (documents,
 * loops, agent and model), the loop cap and its raise control, and the
 * machine-scope notice.
 */

import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	PlaybookRunSummary,
	describePlaybookRunLoops,
	describePlaybookRunModel,
} from '../../../../renderer/components/PlaybookLaunch/PlaybookRunSummary';
import { mockTheme } from '../../../helpers/mockTheme';

function renderSummary(props: Partial<ComponentProps<typeof PlaybookRunSummary>> = {}) {
	const onMaxLoopsChange = vi.fn();
	render(
		<PlaybookRunSummary
			theme={mockTheme}
			playbook={{
				documents: [
					{ filename: 'a', resetOnCompletion: false },
					{ filename: 'b', resetOnCompletion: true },
				],
				loopEnabled: true,
			}}
			maxLoops={10}
			capped={false}
			onMaxLoopsChange={onMaxLoopsChange}
			agentName="Maestro"
			model="claude-opus-5-5"
			{...props}
		/>
	);
	return { onMaxLoopsChange };
}

describe('describePlaybookRunLoops', () => {
	it('names a single pass, a bound, and an unbounded loop', () => {
		expect(describePlaybookRunLoops(false, 10)).toBe('Runs once');
		expect(describePlaybookRunLoops(true, 1)).toBe('Up to 1 loop');
		expect(describePlaybookRunLoops(true, 10)).toBe('Up to 10 loops');
		expect(describePlaybookRunLoops(true, null)).toBe('Loops until done');
	});
});

describe('describePlaybookRunModel', () => {
	it('names the configured model, Auto, or the provider default', () => {
		expect(describePlaybookRunModel('claude-opus-5-5')).toBe('claude-opus-5-5');
		expect(describePlaybookRunModel('auto')).toBe('Auto');
		expect(describePlaybookRunModel(undefined)).toBe('default model');
		expect(describePlaybookRunModel('')).toBe('default model');
	});
});

describe('PlaybookRunSummary', () => {
	it('shows the document count, the loop bound, and the target agent with its model', () => {
		renderSummary();
		expect(screen.getByTestId('playbook-run-summary-documents').textContent).toContain(
			'2 documents'
		);
		expect(screen.getByTestId('playbook-run-summary-loops').textContent).toContain(
			'Up to 10 loops'
		);
		const agent = screen.getByTestId('playbook-run-summary-agent').textContent;
		expect(agent).toContain('Maestro');
		expect(agent).toContain('claude-opus-5-5');
		expect(screen.queryByTestId('playbook-run-summary-cap')).toBeNull();
		expect(screen.queryByTestId('playbook-run-summary-machine')).toBeNull();
	});

	it('says an unlimited loop was capped and lets the user raise the cap', () => {
		const { onMaxLoopsChange } = renderSummary({ capped: true });
		const cap = screen.getByTestId('playbook-run-summary-cap');
		expect(cap.textContent).toContain('unlimited loops');
		expect(cap.textContent).toContain('capped at 10');
		const slider = screen.getByRole('slider');
		fireEvent.change(slider, { target: { value: '25' } });
		expect(onMaxLoopsChange).toHaveBeenCalledWith(25);
	});

	it('hides the cap control for a playbook that does not loop', () => {
		renderSummary({ capped: true, playbook: { documents: [], loopEnabled: false } });
		expect(screen.queryByTestId('playbook-run-summary-cap')).toBeNull();
		expect(screen.getByTestId('playbook-run-summary-loops').textContent).toContain('Runs once');
		expect(screen.getByTestId('playbook-run-summary-documents').textContent).toContain(
			'0 documents'
		);
	});

	it('warns once when the playbook configures the machine', () => {
		renderSummary({
			playbook: {
				documents: [{ filename: 'a', resetOnCompletion: false }],
				loopEnabled: false,
				scope: 'machine',
			},
		});
		expect(screen.getByTestId('playbook-run-summary-documents').textContent).toContain(
			'1 document'
		);
		expect(screen.getByTestId('playbook-run-summary-machine').textContent).toBe(
			'This playbook configures your machine, not just this project.'
		);
	});
});
