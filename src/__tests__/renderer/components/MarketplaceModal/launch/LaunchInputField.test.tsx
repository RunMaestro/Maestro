/**
 * Tests for LaunchInputField.
 *
 * One component draws a field for every PlaybookLaunchInput type, so these tests walk the
 * eight types and pin what a person sees and what the host receives: the control each type
 * gets, the label, required marker, help and error every type shares, and the exact value
 * onChange reports (a number for a number, a list for a multiselect, `undefined` for an
 * emptied box). The component never validates; it draws the host's message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
	LaunchInputField,
	launchInputTestId,
	pathBrowseKind,
} from '../../../../../renderer/components/MarketplaceModal/launch/LaunchInputField';
import type {
	LaunchFieldValue,
	LaunchInputFieldProps,
} from '../../../../../renderer/components/MarketplaceModal/launch/LaunchInputField';
import type { PlaybookLaunchInput } from '../../../../../shared/marketplace-types';
import { mockTheme } from '../../../../helpers/mockTheme';

type InputType = PlaybookLaunchInput['type'];

const ALL_TYPES: InputType[] = [
	'text',
	'textarea',
	'url',
	'path',
	'number',
	'boolean',
	'select',
	'multiselect',
];

const OPTIONS = [
	{ value: 'hooks', label: 'Hooks' },
	{ value: 'statusline', label: 'Status line' },
	{ value: 'tooltips' },
];

function input(overrides: Partial<PlaybookLaunchInput> = {}): PlaybookLaunchInput {
	return { name: 'FIELD', label: 'Sample label', type: 'text', ...overrides };
}

/** An input of the given type with whatever that type needs to be drawable. */
function inputOfType(type: InputType, overrides: Partial<PlaybookLaunchInput> = {}) {
	const needsOptions = type === 'select' || type === 'multiselect';
	return input({ type, ...(needsOptions ? { options: OPTIONS } : {}), ...overrides });
}

type RenderProps = Partial<Omit<LaunchInputFieldProps, 'input' | 'theme'>>;

function renderField(field: PlaybookLaunchInput, props: RenderProps = {}) {
	const onChange = vi.fn();
	const view = render(
		<LaunchInputField
			theme={mockTheme}
			input={field}
			value={undefined}
			onChange={onChange}
			{...props}
		/>
	);
	return { onChange, ...view };
}

describe('LaunchInputField', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.dialog.selectFolder).mockClear();
		vi.mocked(window.maestro.dialog.selectFile).mockClear();
	});

	describe.each(ALL_TYPES)('%s: what every field shows', (type) => {
		it('labels the field and gives it a test id', () => {
			renderField(inputOfType(type, { name: 'SAMPLE' }));

			expect(screen.getByText('Sample label')).toBeInTheDocument();
			expect(screen.getByTestId(launchInputTestId('SAMPLE'))).toBeInTheDocument();
			expect(launchInputTestId('SAMPLE')).toBe('launch-input-SAMPLE');
		});

		it('shows the help text', () => {
			renderField(inputOfType(type, { help: 'Only the part after the slash.' }));

			expect(screen.getByText('Only the part after the slash.')).toBeInTheDocument();
		});

		it('draws a red asterisk when the input is required, and none otherwise', () => {
			const { rerender } = renderField(inputOfType(type, { required: true }));

			const mark = screen.getByText('*');
			expect(mark).toHaveStyle({ color: mockTheme.colors.error });
			// The asterisk is decoration. Required is conveyed to assistive tech separately.
			expect(mark).toHaveAttribute('aria-hidden', 'true');

			rerender(
				<LaunchInputField
					theme={mockTheme}
					input={inputOfType(type)}
					value={undefined}
					onChange={vi.fn()}
				/>
			);
			expect(screen.queryByText('*')).not.toBeInTheDocument();
		});

		it('shows the validation message in the error color', () => {
			renderField(inputOfType(type), { error: 'This field is required' });

			expect(screen.getByText('This field is required')).toHaveStyle({
				color: mockTheme.colors.error,
			});
		});

		it('draws nothing extra when there is no help and no error', () => {
			const { container } = renderField(inputOfType(type));

			expect(container.querySelector('p')).toBeNull();
		});
	});

	describe.each(ALL_TYPES.filter((type) => type !== 'boolean'))(
		'%s: the message replaces the help',
		(type) => {
			it('hides the help while an error shows, as FormInput does', () => {
				renderField(inputOfType(type, { help: 'Helpful words' }), { error: 'Not valid' });

				expect(screen.getByText('Not valid')).toBeInTheDocument();
				expect(screen.queryByText('Helpful words')).not.toBeInTheDocument();
			});
		}
	);

	describe('text', () => {
		it('draws a text box with the answer', () => {
			renderField(input({ type: 'text' }), { value: 'main' });

			const box = screen.getByRole('textbox');
			expect(box).toHaveValue('main');
			expect(box).toHaveAttribute('type', 'text');
		});

		it('is named by its label', () => {
			renderField(input({ type: 'text', label: 'Base branch' }));

			expect(screen.getByLabelText('Base branch')).toBe(screen.getByRole('textbox'));
		});

		it('draws an empty box for no answer and shows the placeholder', () => {
			renderField(input({ type: 'text', placeholder: 'coderabbitai,greptile' }));

			expect(screen.getByRole('textbox')).toHaveValue('');
			expect(screen.getByPlaceholderText('coderabbitai,greptile')).toBeInTheDocument();
		});

		it('reports the text with the input name', () => {
			const { onChange } = renderField(input({ name: 'BASE_BRANCH', type: 'text' }));

			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'develop' } });

			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith('BASE_BRANCH', 'develop');
		});

		it('reports an emptied box as an empty string, not as no answer', () => {
			const { onChange } = renderField(input({ name: 'BASE_BRANCH', type: 'text' }), {
				value: 'main',
			});

			fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });

			expect(onChange).toHaveBeenCalledWith('BASE_BRANCH', '');
		});

		it('sets aria-required on a required box', () => {
			renderField(input({ type: 'text', required: true }));

			expect(screen.getByRole('textbox')).toHaveAttribute('aria-required', 'true');
		});

		it('turns the border red on an error', () => {
			renderField(input({ type: 'text' }), { error: 'Nope' });

			expect(screen.getByRole('textbox')).toHaveStyle({ borderColor: mockTheme.colors.error });
		});

		it('blocks typing while disabled', () => {
			renderField(input({ type: 'text' }), { disabled: true });

			expect(screen.getByRole('textbox')).toBeDisabled();
		});

		it('shows a stray non-text answer as text rather than crashing', () => {
			renderField(input({ type: 'text' }), { value: 42 });

			expect(screen.getByRole('textbox')).toHaveValue('42');
		});
	});

	describe('url', () => {
		it('draws a URL box in a fixed-pitch font', () => {
			renderField(input({ type: 'url' }), { value: 'https://github.com/o/r/pull/1' });

			const box = screen.getByLabelText('Sample label');
			expect(box).toHaveAttribute('type', 'url');
			expect(box).toHaveValue('https://github.com/o/r/pull/1');
			expect(box).toHaveClass('font-mono');
		});

		it('reports the URL with the input name', () => {
			const { onChange } = renderField(input({ name: 'PR_URL', type: 'url' }));

			fireEvent.change(screen.getByLabelText('Sample label'), {
				target: { value: 'https://github.com/o/r/pull/2' },
			});

			expect(onChange).toHaveBeenCalledWith('PR_URL', 'https://github.com/o/r/pull/2');
		});
	});

	describe('textarea', () => {
		it('draws a multi-line box named by its label', () => {
			renderField(input({ type: 'textarea', label: 'Scope in' }), { value: 'line one\nline two' });

			const box = screen.getByLabelText('Scope in');
			expect(box.tagName).toBe('TEXTAREA');
			expect(box).toHaveValue('line one\nline two');
			expect(box).toHaveAttribute('rows', '3');
		});

		it('reports the text with the input name', () => {
			const { onChange } = renderField(input({ name: 'SCOPE_IN', type: 'textarea' }));

			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a\nb' } });

			expect(onChange).toHaveBeenCalledWith('SCOPE_IN', 'a\nb');
		});

		it('shows the placeholder', () => {
			renderField(input({ type: 'textarea', placeholder: 'One topic per line' }));

			expect(screen.getByPlaceholderText('One topic per line')).toBeInTheDocument();
		});

		it('tells assistive tech that it is required and invalid', () => {
			renderField(input({ type: 'textarea', required: true }), { error: 'This field is required' });

			const box = screen.getByRole('textbox');
			expect(box).toHaveAttribute('aria-required', 'true');
			expect(box).toHaveAttribute('aria-invalid', 'true');
			expect(box).toHaveStyle({ borderColor: mockTheme.colors.error });
		});

		it('leaves aria-invalid off while the answer is fine', () => {
			renderField(input({ type: 'textarea' }));

			const box = screen.getByRole('textbox');
			expect(box).not.toHaveAttribute('aria-invalid');
			expect(box).not.toHaveAttribute('aria-required');
			expect(box).toHaveStyle({ borderColor: mockTheme.colors.border });
		});

		it('blocks typing while disabled', () => {
			renderField(input({ type: 'textarea' }), { disabled: true });

			expect(screen.getByRole('textbox')).toBeDisabled();
		});

		describe('growing with its content', () => {
			const scrollHeightOf = (height: number) =>
				vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(height);

			it('sizes itself to its content', () => {
				const spy = scrollHeightOf(120);
				try {
					renderField(input({ type: 'textarea' }), { value: 'some\ntext' });

					expect(screen.getByRole('textbox').style.height).toBe('120px');
				} finally {
					spy.mockRestore();
				}
			});

			it('stops growing at the cap and scrolls instead', () => {
				const spy = scrollHeightOf(900);
				try {
					renderField(input({ type: 'textarea' }), { value: 'a long answer' });

					expect(screen.getByRole('textbox').style.height).toBe('240px');
				} finally {
					spy.mockRestore();
				}
			});

			it('re-measures when the answer changes', () => {
				const spy = scrollHeightOf(80);
				try {
					const { rerender } = renderField(input({ type: 'textarea' }), { value: 'short' });
					expect(screen.getByRole('textbox').style.height).toBe('80px');

					spy.mockReturnValue(200);
					rerender(
						<LaunchInputField
							theme={mockTheme}
							input={input({ type: 'textarea' })}
							value={'short\n'.repeat(8)}
							onChange={vi.fn()}
						/>
					);
					expect(screen.getByRole('textbox').style.height).toBe('200px');
				} finally {
					spy.mockRestore();
				}
			});
		});
	});

	describe('number', () => {
		it('draws a number box with the answer', () => {
			renderField(input({ type: 'number' }), { value: 500 });

			const box = screen.getByRole('spinbutton');
			expect(box).toHaveValue(500);
			expect(box).toHaveAttribute('type', 'number');
		});

		it('is named by its label', () => {
			renderField(input({ type: 'number', label: 'Max file LOC' }));

			expect(screen.getByLabelText('Max file LOC')).toBe(screen.getByRole('spinbutton'));
		});

		it('passes min and max to the box', () => {
			renderField(input({ type: 'number', min: 1, max: 100 }));

			const box = screen.getByRole('spinbutton');
			expect(box).toHaveAttribute('min', '1');
			expect(box).toHaveAttribute('max', '100');
		});

		it('keeps a min or max of zero', () => {
			renderField(input({ type: 'number', min: 0, max: 0 }));

			const box = screen.getByRole('spinbutton');
			expect(box).toHaveAttribute('min', '0');
			expect(box).toHaveAttribute('max', '0');
		});

		it('sets no bound the input does not declare', () => {
			renderField(input({ type: 'number' }));

			const box = screen.getByRole('spinbutton');
			expect(box).not.toHaveAttribute('min');
			expect(box).not.toHaveAttribute('max');
		});

		it('accepts decimals, because the validator does', () => {
			renderField(input({ type: 'number' }));

			expect(screen.getByRole('spinbutton')).toHaveAttribute('step', 'any');
		});

		it('reports a typed number as a number, not as text', () => {
			const { onChange } = renderField(input({ name: 'MAX_FILE_LOC', type: 'number' }));

			fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '750' } });

			expect(onChange).toHaveBeenCalledWith('MAX_FILE_LOC', 750);
		});

		it('reports a decimal and a negative number', () => {
			const { onChange } = renderField(input({ name: 'WEIGHT', type: 'number' }));

			fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2.5' } });
			expect(onChange).toHaveBeenLastCalledWith('WEIGHT', 2.5);

			fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-3' } });
			expect(onChange).toHaveBeenLastCalledWith('WEIGHT', -3);
		});

		it('reports zero as zero, an answer, not as no answer', () => {
			const { onChange } = renderField(input({ name: 'BACKFILL_DAYS', type: 'number' }), {
				value: 7,
			});

			fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });

			expect(onChange).toHaveBeenCalledWith('BACKFILL_DAYS', 0);
		});

		it('reports an emptied box as no answer', () => {
			const { onChange } = renderField(input({ name: 'MAX_FILE_LOC', type: 'number' }), {
				value: 500,
			});

			fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });

			expect(onChange).toHaveBeenCalledWith('MAX_FILE_LOC', undefined);
		});

		it('reports text the browser cannot read as a number as no answer', () => {
			const { onChange } = renderField(input({ name: 'MAX_FILE_LOC', type: 'number' }), {
				value: 500,
			});

			// A number box drops anything that is not a number, leaving it empty.
			fireEvent.change(screen.getByRole('spinbutton'), { target: { value: 'abc' } });

			expect(onChange).toHaveBeenCalledWith('MAX_FILE_LOC', undefined);
		});

		describe('typing into a box whose host keeps the answer', () => {
			/** A host that stores the answer, as the launch modal does, so the field sees its own report come back. */
			function NumberHost({
				onReport,
			}: {
				onReport: (answer: LaunchFieldValue | undefined) => void;
			}) {
				const [answer, setAnswer] = useState<LaunchFieldValue | undefined>(undefined);
				return (
					<LaunchInputField
						theme={mockTheme}
						input={input({ name: 'WEIGHT', type: 'number' })}
						value={answer}
						onChange={(_name, next) => {
							setAnswer(next);
							onReport(next);
						}}
					/>
				);
			}
			const boxText = () => (screen.getByRole('spinbutton') as HTMLInputElement).value;

			// "2.50" is the number 2.5. Writing the number back into the box would turn "2.50"
			// into "2.5" and make "2.505" impossible to type.
			it('keeps what was typed while it still reads as the answer', () => {
				render(<NumberHost onReport={vi.fn()} />);

				fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2.50' } });

				expect(boxText()).toBe('2.50');
			});

			it('lets a number be typed past a trailing zero', () => {
				const onReport = vi.fn();
				render(<NumberHost onReport={onReport} />);

				fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2.5' } });
				fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2.50' } });
				fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2.505' } });

				expect(boxText()).toBe('2.505');
				expect(onReport.mock.calls.map(([answer]) => answer)).toEqual([2.5, 2.5, 2.505]);
			});

			it('shows the answer once the host changes it to something else', () => {
				const { rerender, onChange } = renderField(input({ type: 'number' }), { value: 5 });
				fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
				expect(boxText()).toBe('7');

				// The host resets the field, for example to the playbook's default.
				rerender(
					<LaunchInputField
						theme={mockTheme}
						input={input({ type: 'number' })}
						value={8}
						onChange={onChange}
					/>
				);

				expect(boxText()).toBe('8');
			});

			it('empties the box when the host clears the answer', () => {
				const { rerender, onChange } = renderField(input({ type: 'number' }), { value: 5 });
				expect(boxText()).toBe('5');

				rerender(
					<LaunchInputField
						theme={mockTheme}
						input={input({ type: 'number' })}
						value={undefined}
						onChange={onChange}
					/>
				);

				expect(boxText()).toBe('');
			});

			it('keeps an emptied box empty', () => {
				const onReport = vi.fn();
				render(<NumberHost onReport={onReport} />);
				fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });

				fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });

				expect(boxText()).toBe('');
				expect(onReport).toHaveBeenLastCalledWith(undefined);
			});
		});

		it('draws an empty box for no answer and for an answer of the wrong type', () => {
			const { rerender } = renderField(input({ type: 'number' }));
			expect(screen.getByRole('spinbutton')).toHaveValue(null);

			rerender(
				<LaunchInputField
					theme={mockTheme}
					input={input({ type: 'number' })}
					value="not a number"
					onChange={vi.fn()}
				/>
			);
			expect(screen.getByRole('spinbutton')).toHaveValue(null);
		});

		it('shows the unit beside the box', () => {
			renderField(input({ type: 'number', unit: '%' }), { value: 80 });

			expect(screen.getByText('%')).toBeInTheDocument();
		});

		it('shows no unit when the input has none', () => {
			const { container } = renderField(input({ type: 'number' }), { value: 80 });

			expect(container.querySelectorAll('span').length).toBe(0);
		});

		it('sets aria-required on a required box', () => {
			renderField(input({ type: 'number', required: true }));

			expect(screen.getByRole('spinbutton')).toHaveAttribute('aria-required', 'true');
		});
	});

	describe('boolean', () => {
		it('draws a switch named by the label', () => {
			renderField(input({ type: 'boolean', label: 'Wire the launch alias' }), { value: true });

			const toggle = screen.getByRole('switch', { name: 'Wire the launch alias' });
			expect(toggle).toHaveAttribute('aria-checked', 'true');
		});

		it('draws the switch off for false and for no answer', () => {
			const { rerender } = renderField(input({ type: 'boolean' }), { value: false });
			expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

			rerender(
				<LaunchInputField
					theme={mockTheme}
					input={input({ type: 'boolean' })}
					value={undefined}
					onChange={vi.fn()}
				/>
			);
			expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
		});

		it('reports true when switched on and false when switched off', () => {
			const { onChange, rerender } = renderField(
				input({ name: 'WIRE_LAUNCH_ALIAS', type: 'boolean' }),
				{
					value: false,
				}
			);

			fireEvent.click(screen.getByRole('switch'));
			expect(onChange).toHaveBeenLastCalledWith('WIRE_LAUNCH_ALIAS', true);

			rerender(
				<LaunchInputField
					theme={mockTheme}
					input={input({ name: 'WIRE_LAUNCH_ALIAS', type: 'boolean' })}
					value={true}
					onChange={onChange}
				/>
			);
			fireEvent.click(screen.getByRole('switch'));
			expect(onChange).toHaveBeenLastCalledWith('WIRE_LAUNCH_ALIAS', false);
			expect(onChange).toHaveBeenCalledTimes(2);
		});

		it('keeps the help beside the label and the message below', () => {
			renderField(input({ type: 'boolean', help: 'About 1 GB.' }), { error: 'Must be yes or no' });

			expect(screen.getByText('About 1 GB.')).toBeInTheDocument();
			expect(screen.getByText('Must be yes or no')).toBeInTheDocument();
		});

		it('does not switch while disabled', () => {
			const { onChange } = renderField(input({ type: 'boolean' }), { disabled: true });

			fireEvent.click(screen.getByRole('switch'));

			expect(screen.getByRole('switch')).toBeDisabled();
			expect(onChange).not.toHaveBeenCalled();
		});
	});

	describe('select with four options or fewer', () => {
		const SCOPES: NonNullable<PlaybookLaunchInput['options']> = [
			{ value: 'user', label: 'User' },
			{ value: 'project' },
		];

		it('draws a segmented bar named by the label', () => {
			renderField(input({ type: 'select', label: 'Install scope', options: SCOPES }), {
				value: 'user',
			});

			const bar = screen.getByRole('radiogroup', { name: 'Install scope' });
			expect(within(bar).getAllByRole('radio')).toHaveLength(2);
		});

		it('draws four options as a bar and five as a dropdown', () => {
			const four = ['a', 'b', 'c', 'd'].map((value) => ({ value }));
			const { rerender } = renderField(input({ type: 'select', options: four }));
			expect(screen.getByRole('radiogroup')).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /Sample label/ })).not.toBeInTheDocument();

			rerender(
				<LaunchInputField
					theme={mockTheme}
					input={input({ type: 'select', options: [...four, { value: 'e' }] })}
					value={undefined}
					onChange={vi.fn()}
				/>
			);
			expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Sample label/ })).toBeInTheDocument();
		});

		it('shows the option label, else its value', () => {
			renderField(input({ type: 'select', options: SCOPES }), { value: 'user' });

			expect(screen.getByRole('radio', { name: 'User' })).toBeInTheDocument();
			expect(screen.getByRole('radio', { name: 'project' })).toBeInTheDocument();
		});

		it('marks the chosen option', () => {
			renderField(input({ type: 'select', options: SCOPES }), { value: 'project' });

			expect(screen.getByRole('radio', { name: 'User' })).toHaveAttribute('aria-checked', 'false');
			expect(screen.getByRole('radio', { name: 'project' })).toHaveAttribute(
				'aria-checked',
				'true'
			);
		});

		it('reports the option value, not its label', () => {
			const { onChange } = renderField(
				input({ name: 'INSTALL_SCOPE', type: 'select', options: SCOPES }),
				{ value: 'project' }
			);

			fireEvent.click(screen.getByRole('radio', { name: 'User' }));

			expect(onChange).toHaveBeenCalledWith('INSTALL_SCOPE', 'user');
		});

		it('leaves every option unchosen for no answer, and a keyboard can still reach the bar', () => {
			renderField(input({ type: 'select', options: SCOPES }));

			for (const radio of screen.getAllByRole('radio')) {
				expect(radio).toHaveAttribute('aria-checked', 'false');
			}
			expect(screen.getByRole('radio', { name: 'User' })).toHaveAttribute('tabindex', '0');
		});

		it('lets a click answer a bar that had no answer', () => {
			const { onChange } = renderField(
				input({ name: 'INSTALL_SCOPE', type: 'select', options: SCOPES })
			);

			fireEvent.click(screen.getByRole('radio', { name: 'project' }));

			expect(onChange).toHaveBeenCalledWith('INSTALL_SCOPE', 'project');
		});
	});

	describe('select with more than four options', () => {
		const SCHEDULES = ['hourly', 'every-15', 'daily', 'weekly', 'none'].map((value) => ({
			value,
			label: value === 'every-15' ? 'Every 15 minutes' : value[0].toUpperCase() + value.slice(1),
		}));
		const schedule = (overrides: Partial<PlaybookLaunchInput> = {}) =>
			input({
				name: 'SCHEDULE',
				label: 'Schedule',
				type: 'select',
				options: SCHEDULES,
				...overrides,
			});

		const openDropdown = () => fireEvent.click(screen.getByRole('button', { name: /Schedule/ }));
		const rows = () => within(screen.getByRole('listbox')).getAllByRole('option');

		it('draws a dropdown named by the label and showing the chosen label', () => {
			renderField(schedule(), { value: 'every-15' });

			const trigger = screen.getByRole('button', { name: /Schedule/ });
			expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
			expect(trigger).toHaveTextContent('Every 15 minutes');
			expect(screen.getByLabelText(/Schedule/)).toBe(trigger);
		});

		it('lists the options when opened', () => {
			renderField(schedule({ required: true }), { value: 'hourly' });

			openDropdown();

			expect(rows().map((row) => row.textContent)).toEqual([
				'Hourly',
				'Every 15 minutes',
				'Daily',
				'Weekly',
				'None',
			]);
		});

		it('reports the picked value, not its label', () => {
			const { onChange } = renderField(schedule(), { value: 'hourly' });

			openDropdown();
			fireEvent.click(screen.getByRole('option', { name: 'Every 15 minutes' }));

			expect(onChange).toHaveBeenCalledWith('SCHEDULE', 'every-15');
		});

		it('offers a "Not set" row first on an optional field, and picking it clears the answer', () => {
			const { onChange } = renderField(schedule(), { value: 'daily' });

			openDropdown();
			expect(rows()[0]).toHaveTextContent('Not set');

			fireEvent.click(screen.getByRole('option', { name: 'Not set' }));
			expect(onChange).toHaveBeenCalledWith('SCHEDULE', undefined);
		});

		it('shows "Not set" on an optional field with no answer', () => {
			renderField(schedule());

			expect(screen.getByRole('button', { name: /Schedule/ })).toHaveTextContent('Not set');
		});

		it('shows "Select..." on a required field with no answer, and offers that row to go back', () => {
			renderField(schedule({ required: true }));

			const trigger = screen.getByRole('button', { name: /Schedule/ });
			expect(trigger).toHaveTextContent('Select...');

			fireEvent.click(trigger);
			expect(rows()[0]).toHaveTextContent('Select...');
		});

		it('offers no way back to empty on a required field that has an answer', () => {
			renderField(schedule({ required: true }), { value: 'daily' });

			openDropdown();

			expect(rows()).toHaveLength(5);
			expect(screen.queryByRole('option', { name: 'Select...' })).not.toBeInTheDocument();
		});

		it('uses the placeholder as the name of the empty row', () => {
			renderField(schedule({ placeholder: 'Choose a schedule' }));

			expect(screen.getByRole('button', { name: /Schedule/ })).toHaveTextContent(
				'Choose a schedule'
			);
		});

		it('does not open while disabled', () => {
			renderField(schedule(), { disabled: true });

			expect(screen.getByRole('button', { name: /Schedule/ })).toBeDisabled();
		});
	});

	describe('multiselect', () => {
		const SEVERITY = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((value) => ({ value }));
		const severity = (overrides: Partial<PlaybookLaunchInput> = {}) =>
			input({
				name: 'AUTO_FIX_SEVERITY',
				label: 'Auto fix severity',
				type: 'multiselect',
				options: SEVERITY,
				...overrides,
			});

		it('draws a group of chips named by the label', () => {
			renderField(severity());

			const group = screen.getByRole('group', { name: 'Auto fix severity' });
			expect(within(group).getAllByRole('button')).toHaveLength(4);
		});

		it('shows the option label, else its value', () => {
			renderField(inputOfType('multiselect'));

			expect(screen.getByRole('button', { name: 'Hooks' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Status line' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'tooltips' })).toBeInTheDocument();
		});

		it('presses the chips that are in the answer', () => {
			renderField(severity(), { value: ['CRITICAL', 'MEDIUM'] });

			expect(screen.getByRole('button', { name: 'CRITICAL' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(screen.getByRole('button', { name: 'HIGH' })).toHaveAttribute('aria-pressed', 'false');
			expect(screen.getByRole('button', { name: 'MEDIUM' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(screen.getByRole('button', { name: 'LOW' })).toHaveAttribute('aria-pressed', 'false');
		});

		it('presses no chip for no answer', () => {
			renderField(severity());

			for (const chip of screen.getAllByRole('button')) {
				expect(chip).toHaveAttribute('aria-pressed', 'false');
			}
		});

		it('adds a picked option to the answer', () => {
			const { onChange } = renderField(severity(), { value: ['CRITICAL'] });

			fireEvent.click(screen.getByRole('button', { name: 'HIGH' }));

			expect(onChange).toHaveBeenCalledWith('AUTO_FIX_SEVERITY', ['CRITICAL', 'HIGH']);
		});

		it('keeps the answer in the order the options were declared, not the order of the clicks', () => {
			const { onChange } = renderField(severity(), { value: ['LOW', 'HIGH'] });

			fireEvent.click(screen.getByRole('button', { name: 'CRITICAL' }));

			expect(onChange).toHaveBeenCalledWith('AUTO_FIX_SEVERITY', ['CRITICAL', 'HIGH', 'LOW']);
		});

		it('removes an option that is already picked', () => {
			const { onChange } = renderField(severity(), { value: ['CRITICAL', 'HIGH'] });

			fireEvent.click(screen.getByRole('button', { name: 'CRITICAL' }));

			expect(onChange).toHaveBeenCalledWith('AUTO_FIX_SEVERITY', ['HIGH']);
		});

		it('reports an empty list, an answer, when the last pick is removed', () => {
			const { onChange } = renderField(severity(), { value: ['LOW'] });

			fireEvent.click(screen.getByRole('button', { name: 'LOW' }));

			expect(onChange).toHaveBeenCalledWith('AUTO_FIX_SEVERITY', []);
		});

		it('starts a list from no answer', () => {
			const { onChange } = renderField(severity());

			fireEvent.click(screen.getByRole('button', { name: 'MEDIUM' }));

			expect(onChange).toHaveBeenCalledWith('AUTO_FIX_SEVERITY', ['MEDIUM']);
		});

		it('passes a fresh list each time and never edits the one it was given', () => {
			const answer = ['HIGH'];
			const { onChange } = renderField(severity(), { value: answer });

			fireEvent.click(screen.getByRole('button', { name: 'LOW' }));

			expect(answer).toEqual(['HIGH']);
			expect(onChange.mock.calls[0][1]).not.toBe(answer);
		});

		it('treats an answer of the wrong type as no answer', () => {
			renderField(severity(), { value: 'HIGH' });

			for (const chip of screen.getAllByRole('button')) {
				expect(chip).toHaveAttribute('aria-pressed', 'false');
			}
		});

		it('does not toggle while disabled', () => {
			const { onChange } = renderField(severity(), { disabled: true });

			fireEvent.click(screen.getByRole('button', { name: 'HIGH' }));

			expect(screen.getByRole('button', { name: 'HIGH' })).toBeDisabled();
			expect(onChange).not.toHaveBeenCalled();
		});

		it('draws no chips for an input without options', () => {
			renderField(input({ type: 'multiselect' }));

			expect(screen.queryByRole('button')).not.toBeInTheDocument();
		});
	});

	describe('path', () => {
		const folderInput = (overrides: Partial<PlaybookLaunchInput> = {}) =>
			input({ name: 'OUTPUT_FOLDER', label: 'Output folder', type: 'path', ...overrides });

		it('draws a text box with the path and a Browse button', () => {
			renderField(folderInput(), { value: '~/Journal' });

			const box = screen.getByLabelText('Output folder');
			expect(box).toHaveValue('~/Journal');
			expect(box).toHaveClass('font-mono');
			expect(screen.getByRole('button', { name: 'Browse for a folder' })).toHaveTextContent(
				'Browse'
			);
		});

		it('reports a typed path with the input name', () => {
			const { onChange } = renderField(folderInput());

			fireEvent.change(screen.getByLabelText('Output folder'), { target: { value: '/tmp/out' } });

			expect(onChange).toHaveBeenCalledWith('OUTPUT_FOLDER', '/tmp/out');
		});

		it('opens the folder dialog for a folder and reports the pick', async () => {
			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValueOnce('/Users/me/vault');
			const { onChange } = renderField(folderInput({ default: '{{AUTORUN_FOLDER}}/vault' }));

			fireEvent.click(screen.getByRole('button', { name: 'Browse for a folder' }));

			await waitFor(() =>
				expect(onChange).toHaveBeenCalledWith('OUTPUT_FOLDER', '/Users/me/vault')
			);
			expect(window.maestro.dialog.selectFolder).toHaveBeenCalledTimes(1);
			expect(window.maestro.dialog.selectFile).not.toHaveBeenCalled();
		});

		it('opens the file dialog for a file, titled with the label, and reports the pick', async () => {
			vi.mocked(window.maestro.dialog.selectFile).mockResolvedValueOnce('/Users/me/docs/README.md');
			const { onChange } = renderField(
				folderInput({ name: 'README_PATH', label: 'README path', default: 'README.md' })
			);

			fireEvent.click(screen.getByRole('button', { name: 'Browse for a file' }));

			await waitFor(() =>
				expect(onChange).toHaveBeenCalledWith('README_PATH', '/Users/me/docs/README.md')
			);
			expect(window.maestro.dialog.selectFile).toHaveBeenCalledWith({ title: 'README path' });
			expect(window.maestro.dialog.selectFolder).not.toHaveBeenCalled();
		});

		it('keeps the path when the dialog is cancelled', async () => {
			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValueOnce(null);
			const { onChange } = renderField(folderInput(), { value: '~/Journal' });

			// Let the dialog's promise settle before looking at what was reported.
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Browse for a folder' }));
			});

			expect(window.maestro.dialog.selectFolder).toHaveBeenCalledTimes(1);
			expect(onChange).not.toHaveBeenCalled();
		});

		it('disables Browse and says why when the host gives a reason', () => {
			renderField(folderInput(), {
				browseDisabledReason: 'Browse is not available for remote agents',
			});

			const browse = screen.getByRole('button', { name: 'Browse for a folder' });
			expect(browse).toBeDisabled();
			expect(browse).toHaveAttribute('title', 'Browse is not available for remote agents');

			fireEvent.click(browse);
			expect(window.maestro.dialog.selectFolder).not.toHaveBeenCalled();
		});

		it('still lets the person type a path when Browse is disabled', () => {
			const { onChange } = renderField(folderInput(), {
				browseDisabledReason: 'Browse is not available for remote agents',
			});

			fireEvent.change(screen.getByLabelText('Output folder'), { target: { value: '/srv/out' } });

			expect(onChange).toHaveBeenCalledWith('OUTPUT_FOLDER', '/srv/out');
		});

		it('titles an enabled Browse by what it opens', () => {
			renderField(folderInput());

			expect(screen.getByRole('button', { name: 'Browse for a folder' })).toHaveAttribute(
				'title',
				'Browse for a folder'
			);
		});

		it('disables the box and Browse together while the whole field is disabled', () => {
			renderField(folderInput(), { disabled: true });

			expect(screen.getByLabelText('Output folder')).toBeDisabled();
			expect(screen.getByRole('button', { name: 'Browse for a folder' })).toBeDisabled();
		});

		it('gives Browse its own test id', () => {
			renderField(folderInput());

			expect(screen.getByTestId('launch-input-OUTPUT_FOLDER-browse')).toBeInTheDocument();
		});
	});

	describe('pathBrowseKind', () => {
		it.each([
			['a file name with an extension', { default: 'README.md' }, 'file'],
			['a path to a file', { default: '~/docs/guide.pdf' }, 'file'],
			['a Windows path to a file', { default: 'C:\\docs\\notes.txt' }, 'file'],
			['a home folder', { default: '~/Journal' }, 'folder'],
			['a folder under a template variable', { default: '{{AUTORUN_FOLDER}}/vault' }, 'folder'],
			['a bare template variable', { default: '{{AGENT_PATH}}' }, 'folder'],
			['a folder under a dotted parent', { default: '~/.config/tool/data' }, 'folder'],
			['a dotfile folder', { default: '~/.maestro' }, 'folder'],
			['a trailing slash', { default: '~/Journal/' }, 'folder'],
			['no hint at all', {}, 'folder'],
			['an extension in the placeholder only', { placeholder: 'notes.md' }, 'file'],
			[
				'a blank default, falling back to the placeholder',
				{ default: '  ', placeholder: 'a.txt' },
				'file',
			],
			[
				'a default that wins over the placeholder',
				{ default: '~/Journal', placeholder: 'a.txt' },
				'folder',
			],
			['a default that is not text', { default: 5 }, 'folder'],
		] as const)('reads %s', (_label, hint, expected) => {
			expect(pathBrowseKind(hint)).toBe(expected);
		});
	});

	describe('one callback for a whole form', () => {
		it('tags each report with the name of the input that changed', () => {
			const onChange = vi.fn();
			render(
				<>
					<LaunchInputField
						theme={mockTheme}
						input={input({ name: 'FIRST', label: 'First', type: 'text' })}
						value=""
						onChange={onChange}
					/>
					<LaunchInputField
						theme={mockTheme}
						input={input({ name: 'SECOND', label: 'Second', type: 'text' })}
						value=""
						onChange={onChange}
					/>
				</>
			);

			fireEvent.change(screen.getByLabelText('First'), { target: { value: 'a' } });
			fireEvent.change(screen.getByLabelText('Second'), { target: { value: 'b' } });

			expect(onChange).toHaveBeenNthCalledWith(1, 'FIRST', 'a');
			expect(onChange).toHaveBeenNthCalledWith(2, 'SECOND', 'b');
		});
	});
});
