import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TaskCheckbox } from '../../../../renderer/components/FilePreview/TaskCheckbox';
import { mockTheme } from '../../../helpers/mockTheme';

describe('TaskCheckbox', () => {
	it('renders the state parsed from the document', () => {
		const { rerender } = render(
			<TaskCheckbox line={3} checked={false} theme={mockTheme} onToggle={vi.fn()} />
		);
		const box = screen.getByRole('checkbox') as HTMLInputElement;
		expect(box.checked).toBe(false);

		rerender(<TaskCheckbox line={3} checked={true} theme={mockTheme} onToggle={vi.fn()} />);
		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
	});

	it('reports the clicked line to the toggle handler', async () => {
		const onToggle = vi.fn().mockResolvedValue(true);
		render(<TaskCheckbox line={42} checked={false} theme={mockTheme} onToggle={onToggle} />);

		fireEvent.click(screen.getByRole('checkbox'));

		expect(onToggle).toHaveBeenCalledWith(42);
	});

	it('flips immediately instead of waiting for the write to land', async () => {
		// A never-resolving write stands in for a slow disk / SSH round trip.
		const onToggle = vi.fn().mockReturnValue(new Promise<boolean>(() => {}));
		render(<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />);

		fireEvent.click(screen.getByRole('checkbox'));

		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
	});

	it('reverts when the write does not happen', async () => {
		const onToggle = vi.fn().mockResolvedValue(false);
		render(<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />);

		fireEvent.click(screen.getByRole('checkbox'));

		await waitFor(() =>
			expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
		);
	});

	it('hands control back to the document once the saved content arrives', async () => {
		const onToggle = vi.fn().mockResolvedValue(true);
		const { rerender } = render(
			<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />
		);

		fireEvent.click(screen.getByRole('checkbox'));
		rerender(<TaskCheckbox line={1} checked={true} theme={mockTheme} onToggle={onToggle} />);
		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

		// An external edit unchecks it again; the stale optimistic flip must not win.
		rerender(<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />);
		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
	});
});
