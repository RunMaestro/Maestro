/**
 * Tests for GatewayUrlField - the one control for an agent's Local Models
 * gateway URL, and the line under it that says what the launch will do.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Theme } from '../../../../renderer/types';
import {
	GatewayUrlField,
	describeGatewayStatus,
} from '../../../../renderer/components/shared/GatewayUrlField';

const theme = {
	colors: {
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		error: '#ff0000',
		warning: '#ffaa00',
	},
} as unknown as Theme;

function renderField(props: Partial<React.ComponentProps<typeof GatewayUrlField>> = {}) {
	const onChange = vi.fn();
	const onCommit = vi.fn();
	render(
		<GatewayUrlField
			theme={theme}
			toolType="claude-code"
			value=""
			onChange={onChange}
			onCommit={onCommit}
			{...props}
		/>
	);
	return { onChange, onCommit, input: screen.getByRole('textbox') as HTMLInputElement };
}

function status() {
	return screen.queryByTestId('gateway-url-field-status');
}

describe('GatewayUrlField', () => {
	it('shows no status line for an agent with no gateway', () => {
		const { input } = renderField();

		expect(input.disabled).toBe(false);
		expect(status()).toBeNull();
	});

	it('names the variable the gateway sets', () => {
		renderField({ value: 'http://127.0.0.1:8787' });

		expect(status()).toHaveTextContent('Sets ANTHROPIC_BASE_URL when this agent starts.');
		expect(status()).toHaveAttribute('data-tone', 'dim');
	});

	it('is disabled with the reason the host gives, keeping the stored URL', () => {
		const { input } = renderField({
			value: 'http://127.0.0.1:8787',
			disabledReason: 'Not applied while Run on is a source.',
		});

		expect(input.disabled).toBe(true);
		expect(input.value).toBe('http://127.0.0.1:8787');
		// The reason takes the place of what the launch would have done.
		expect(status()).toHaveTextContent('Not applied while Run on is a source.');
		expect(status()).toHaveAttribute('data-tone', 'dim');
	});

	it('shows a save error over the reason it is disabled', () => {
		renderField({ disabledReason: 'Not applied.', error: 'That is not a URL.' });

		expect(status()).toHaveTextContent('That is not a URL.');
	});

	it('is disabled for Copilot CLI, with the reason', () => {
		const { input } = renderField({ toolType: 'copilot-cli' });

		expect(input.disabled).toBe(true);
		expect(status()).toHaveTextContent('Copilot CLI ignores base-URL variables');
	});

	it("says the gateway is not applied when the agent's own variable wins", () => {
		renderField({
			value: 'http://127.0.0.1:8787',
			userEnvVars: { ANTHROPIC_BASE_URL: 'https://mine.example.com' },
		});

		expect(status()).toHaveTextContent('Not applied: ANTHROPIC_BASE_URL is set');
		expect(status()).toHaveAttribute('data-tone', 'warning');
	});

	it('flags a loopback URL on an SSH-remote agent before the launch refuses it', () => {
		renderField({ value: 'http://127.0.0.1:8787', sshRemoteName: 'Build Box' });

		expect(status()).toHaveTextContent('SSH remote "Build Box" cannot reach');
		expect(status()).toHaveAttribute('data-tone', 'warning');
	});

	it('reports a value that is not a URL', () => {
		renderField({ value: 'nope' });

		expect(status()).toHaveAttribute('data-tone', 'error');
	});

	it("shows the host's save error in place of the status", () => {
		renderField({ value: 'http://127.0.0.1:8787', error: 'Agent not found' });

		expect(status()).toHaveTextContent('Agent not found');
		expect(status()).toHaveAttribute('data-tone', 'error');
	});

	it('reports edits, and commits on Enter and on blur', () => {
		const { input, onChange, onCommit } = renderField({ value: 'http://a' });

		fireEvent.change(input, { target: { value: 'http://ab' } });
		expect(onChange).toHaveBeenCalledWith('http://ab');

		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onCommit).toHaveBeenCalledTimes(1);

		fireEvent.blur(input);
		expect(onCommit).toHaveBeenCalledTimes(2);
	});
});

describe('describeGatewayStatus', () => {
	it('has nothing to say about an agent with no gateway', () => {
		expect(describeGatewayStatus({ kind: 'none' })).toBeNull();
	});

	it('treats an unusable gateway as an error', () => {
		expect(
			describeGatewayStatus({
				kind: 'refused',
				code: 'gateway-invalid-url',
				message: 'bad',
			})
		).toEqual({ tone: 'error', text: 'bad' });
	});
});
