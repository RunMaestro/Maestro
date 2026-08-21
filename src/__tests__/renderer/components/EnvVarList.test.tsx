/**
 * Tests for EnvVarList - the read-only effective-environment view.
 *
 * The masking behavior is the load-bearing part: this list is rendered by a
 * dialog that opens on a credential failure, which is when a user is most
 * likely to be sharing their screen.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnvVarList } from '../../../renderer/components/ui/EnvVarList';
import { mockTheme } from '../../helpers/mockTheme';
import { resolveAgentEnvironment } from '../../../shared/agentEnvironment';

function renderList(layers: Parameters<typeof resolveAgentEnvironment>[0]) {
	return render(<EnvVarList theme={mockTheme} vars={resolveAgentEnvironment(layers)} />);
}

describe('EnvVarList', () => {
	it('shows the empty message when nothing is set', () => {
		render(<EnvVarList theme={mockTheme} vars={[]} emptyMessage="Nothing here." />);
		expect(screen.getByTestId('env-var-list-empty')).toHaveTextContent('Nothing here.');
	});

	it('lists non-secret values in full', () => {
		renderList({ global: { ANTHROPIC_BASE_URL: 'https://proxy.internal' } });
		expect(screen.getByText('https://proxy.internal')).toBeInTheDocument();
	});

	it('masks a secret value until it is revealed', () => {
		renderList({ session: { ANTHROPIC_API_KEY: 'sk-ant-super-secret-value' } });

		expect(screen.queryByText('sk-ant-super-secret-value')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /reveal ANTHROPIC_API_KEY/i }));
		expect(screen.getByText('sk-ant-super-secret-value')).toBeInTheDocument();

		// ...and can be hidden again.
		fireEvent.click(screen.getByRole('button', { name: /hide ANTHROPIC_API_KEY/i }));
		expect(screen.queryByText('sk-ant-super-secret-value')).not.toBeInTheDocument();
	});

	it('offers no reveal control for a non-secret key', () => {
		renderList({ global: { NODE_ENV: 'production' } });
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
	});

	it('reveals one secret without revealing the others', () => {
		renderList({ session: { A_TOKEN: 'first-secret-value', B_TOKEN: 'second-secret-value' } });

		fireEvent.click(screen.getByRole('button', { name: /reveal A_TOKEN/i }));

		expect(screen.getByText('first-secret-value')).toBeInTheDocument();
		expect(screen.queryByText('second-secret-value')).not.toBeInTheDocument();
	});

	// The source badge is the point of the view: the same variable set globally
	// and per-agent means very different things.
	it('labels which layer each surviving value came from', () => {
		renderList({ global: { A: '1' }, agent: { B: '2' }, session: { C: '3' } });

		expect(screen.getByText('Global')).toBeInTheDocument();
		expect(screen.getByText('Provider')).toBeInTheDocument();
		expect(screen.getByText('This agent')).toBeInTheDocument();
	});

	it('reports an overridden value as belonging to the winning layer', () => {
		renderList({ global: { MODEL: 'old' }, session: { MODEL: 'new' } });

		expect(screen.getAllByTestId('env-var-list-row')).toHaveLength(1);
		expect(screen.getByText('new')).toBeInTheDocument();
		expect(screen.queryByText('old')).not.toBeInTheDocument();
		expect(screen.getByText('This agent')).toBeInTheDocument();
	});

	it('renders an empty value visibly rather than as blank space', () => {
		renderList({ session: { EMPTY_VAR: '' } });
		expect(screen.getByText('(empty)')).toBeInTheDocument();
	});
});
