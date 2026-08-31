import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockTheme } from '../../../helpers/mockTheme';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import {
	AutoRunHumanStepBanner,
	AutoRunHumanStepBannerProps,
} from '../../../../renderer/components/AutoRun/AutoRunHumanStepBanner';
import type { HumanOnlyTask } from '../../../../renderer/hooks/batch/batchUtils';

const tasks: HumanOnlyTask[] = [
	{ line: 128, text: 'Spruce Health has a web app after all', reason: 'manual action' },
	{ line: 140, text: 'Call the pharmacy', reason: 'phone call' },
];

const defaultProps: AutoRunHumanStepBannerProps = {
	theme: createMockTheme() as any,
	tasks,
};

function renderBanner(overrides: Partial<AutoRunHumanStepBannerProps> = {}) {
	return render(<AutoRunHumanStepBanner {...defaultProps} {...overrides} />);
}

describe('AutoRunHumanStepBanner', () => {
	beforeEach(() => {
		// jsdom here has no working Storage, and the collapse state is persisted -
		// install the shared in-memory stand-in, which also resets it per test.
		installLocalStorageMock();
	});

	it('renders nothing when there are no human-only tasks', () => {
		const { container } = renderBanner({ tasks: [] });
		expect(container).toBeEmptyDOMElement();
	});

	it('pluralizes the heading by task count', () => {
		renderBanner({ tasks: tasks.slice(0, 1) });
		expect(screen.getByText('1 task looks like a human step')).toBeInTheDocument();
	});

	it('lists each task with its 1-based line number', () => {
		renderBanner();
		expect(screen.getByText(/Line 129: Spruce Health has a web app after all/)).toBeInTheDocument();
		expect(screen.getByText(/Line 141: Call the pharmacy/)).toBeInTheDocument();
	});

	it('jumps to a task line when the list entry is clicked', () => {
		const onSelectLine = vi.fn();
		renderBanner({ onSelectLine });
		fireEvent.click(screen.getByText(/Line 129:/));
		expect(onSelectLine).toHaveBeenCalledWith(128);
	});

	it('starts expanded and collapses to just the heading when toggled', () => {
		renderBanner();
		const toggle = screen.getByRole('button', { name: /tasks look like human steps/ });
		expect(toggle).toHaveAttribute('aria-expanded', 'true');

		fireEvent.click(toggle);

		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(screen.getByText('2 tasks look like human steps')).toBeInTheDocument();
		expect(screen.queryByText(/Line 129:/)).not.toBeInTheDocument();
		expect(screen.queryByText(/MAESTRO:HITL/)).not.toBeInTheDocument();
	});

	it('re-expands on a second click', () => {
		renderBanner();
		const toggle = screen.getByRole('button', { name: /tasks look like human steps/ });
		fireEvent.click(toggle);
		fireEvent.click(toggle);
		expect(screen.getByText(/Line 129:/)).toBeInTheDocument();
	});

	it('remembers the collapsed state across remounts', () => {
		const first = renderBanner();
		fireEvent.click(screen.getByRole('button', { name: /tasks look like human steps/ }));
		first.unmount();

		renderBanner();
		expect(screen.getByText('2 tasks look like human steps')).toBeInTheDocument();
		expect(screen.queryByText(/Line 129:/)).not.toBeInTheDocument();
	});
});
