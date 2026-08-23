/**
 * Tests for EnvVarSuggestInput
 *
 * The control has to stay a text field first: environment variables are
 * open-ended, so anything that traps the user inside the offered list is a
 * regression. These pin that, plus the open-vs-filter distinction that makes
 * the caret useful on a field whose current text matches nothing.
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EnvVarSuggestInput } from '../../../../renderer/components/shared/EnvVarSuggestInput';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

/**
 * The component is controlled, so the harness has to own the value or typing
 * never changes what it renders and the filter assertions are meaningless.
 */
function renderInput(props: Partial<React.ComponentProps<typeof EnvVarSuggestInput>> = {}) {
	const onChange = vi.fn();
	function Harness() {
		const [value, setValue] = useState(props.value ?? '');
		return (
			<EnvVarSuggestInput
				suggestions={['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HTTPS_PROXY']}
				placeholder="VARIABLE_NAME"
				ariaLabel="Environment variable name"
				theme={theme}
				className="input"
				style={{}}
				{...props}
				value={value}
				onChange={(next) => {
					onChange(next);
					setValue(next);
				}}
			/>
		);
	}
	render(<Harness />);
	return { onChange };
}

const CARET_TITLE = 'Show environment variable name suggestions';

beforeEach(() => {
	cleanup();
});

describe('EnvVarSuggestInput', () => {
	it('renders a plain input with no caret when there is nothing to suggest', () => {
		renderInput({ suggestions: [] });

		expect(screen.getByLabelText('Environment variable name')).toBeInTheDocument();
		expect(screen.queryByTitle(CARET_TITLE)).toBeNull();
	});

	it('shows every suggestion when opened via the caret', () => {
		renderInput();
		fireEvent.click(screen.getByTitle(CARET_TITLE));

		expect(screen.getAllByRole('option')).toHaveLength(3);
	});

	it('shows every suggestion when opened by focusing the field', () => {
		renderInput();
		fireEvent.focus(screen.getByLabelText('Environment variable name'));

		expect(screen.getAllByRole('option')).toHaveLength(3);
	});

	it('filters the list as the user types', () => {
		const { onChange } = renderInput();
		fireEvent.change(screen.getByLabelText('Environment variable name'), {
			target: { value: 'codex' },
		});

		expect(onChange).toHaveBeenCalledWith('codex');
		expect(screen.getAllByRole('option')).toHaveLength(1);
		expect(screen.getByRole('option')).toHaveTextContent('CODEX_HOME');
	});

	it('hides the popover when the typed text matches nothing', () => {
		renderInput();
		fireEvent.change(screen.getByLabelText('Environment variable name'), {
			target: { value: 'zzz-no-such-var' },
		});

		expect(screen.queryAllByRole('option')).toHaveLength(0);
	});

	it('does NOT filter by existing text when opened via the caret', () => {
		// A freshly added row is named `VAR`, which matches nothing. Filtering
		// on caret-open would answer "show me my options" with an empty box.
		renderInput({ value: 'VAR' });
		fireEvent.click(screen.getByTitle(CARET_TITLE));

		expect(screen.getAllByRole('option')).toHaveLength(3);
	});

	it('commits the picked suggestion and closes', () => {
		const { onChange } = renderInput();
		fireEvent.click(screen.getByTitle(CARET_TITLE));
		fireEvent.mouseDown(screen.getByTitle('CODEX_HOME'));

		expect(onChange).toHaveBeenCalledWith('CODEX_HOME');
		expect(screen.queryAllByRole('option')).toHaveLength(0);
	});

	it('keeps free text that is not in the list', () => {
		// The list is a shortcut, not a constraint - a private variable must
		// still be typeable.
		const { onChange } = renderInput();
		fireEvent.change(screen.getByLabelText('Environment variable name'), {
			target: { value: 'MY_PRIVATE_TOOL' },
		});

		expect(onChange).toHaveBeenCalledWith('MY_PRIVATE_TOOL');
		expect(screen.getByLabelText('Environment variable name')).toHaveValue('MY_PRIVATE_TOOL');
	});

	it('closes on Escape without letting it reach the surrounding modal', () => {
		const onModalEscape = vi.fn();
		render(
			<div onKeyDown={onModalEscape}>
				<EnvVarSuggestInput
					value=""
					suggestions={['CLAUDE_CONFIG_DIR']}
					onChange={vi.fn()}
					placeholder="VARIABLE_NAME"
					ariaLabel="Environment variable name"
					theme={theme}
					className="input"
					style={{}}
				/>
			</div>
		);

		const field = screen.getAllByLabelText('Environment variable name')[0];
		fireEvent.focus(field);
		expect(screen.getAllByRole('option').length).toBeGreaterThan(0);

		fireEvent.keyDown(field, { key: 'Escape' });

		expect(screen.queryAllByRole('option')).toHaveLength(0);
		expect(onModalEscape).not.toHaveBeenCalled();
	});

	it('abbreviates $HOME in the option label but keeps the absolute value', () => {
		const { onChange } = renderInput({
			suggestions: ['/home/testuser/.claude-work'],
			abbreviateHome: true,
			ariaLabel: 'Environment variable value',
		});
		fireEvent.click(screen.getByTitle('Show environment variable value suggestions'));

		const option = screen.getByRole('option');
		expect(option).toHaveTextContent('~/.claude-work');
		fireEvent.mouseDown(option);
		expect(onChange).toHaveBeenCalledWith('/home/testuser/.claude-work');
	});

	it('leaves paths outside $HOME unabbreviated', () => {
		renderInput({
			suggestions: ['/opt/shared/.claude'],
			abbreviateHome: true,
			ariaLabel: 'Environment variable value',
		});
		fireEvent.click(screen.getByTitle('Show environment variable value suggestions'));

		expect(screen.getByRole('option')).toHaveTextContent('/opt/shared/.claude');
	});
});
