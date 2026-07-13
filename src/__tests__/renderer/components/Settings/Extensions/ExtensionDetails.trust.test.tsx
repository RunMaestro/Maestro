/**
 * FC1 surfacing: ExtensionDetails explains WHY a code plugin's code is
 * disabled under the Option-B trusted-to-run gate, with distinct copy per
 * signature state:
 * - unsigned / untrusted → code never runs, declarative contributions apply
 * - invalid (tampered)   → fully inert, nothing applies
 * - trusted              → no gate message at all
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import type {
	ExtensionTrust,
	UnifiedExtension,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import type { Theme } from '../../../../../renderer/types';

const theme = {
	colors: {
		textMain: '#eee',
		textDim: '#999',
		bgMain: '#111',
		accent: '#4af',
		border: '#333',
		warning: '#fa0',
		error: '#f44',
		success: '#4f4',
	},
} as unknown as Theme;

function record(id: string): PluginRecord {
	return {
		id,
		source: `/plugins/${id}`,
		folderName: id,
		enabled: true,
		loadStatus: 'ok',
		errors: [],
		manifest: {
			id,
			name: 'Demo Plugin',
			version: '1.0.0',
			tier: 1,
			maestro: { minHostApi: '1.0.0' },
			entry: 'main.js',
		},
	};
}

function ext(trust: ExtensionTrust | undefined): UnifiedExtension {
	return {
		key: 'plugin:demo',
		kind: 'plugin',
		id: 'demo',
		name: 'Demo Plugin',
		description: 'A demo.',
		category: 'automation',
		state: 'enabled',
		tier: 1,
		trust,
		version: '1.0.0',
		loadStatus: 'ok',
		record: record('demo'),
	} as UnifiedExtension;
}

function renderDetails(trust: ExtensionTrust | undefined): void {
	render(
		<ExtensionDetails
			theme={theme}
			ext={ext(trust)}
			contributions={null}
			busy={false}
			onBack={vi.fn()}
			onTogglePlugin={vi.fn()}
			onToggleBuiltin={vi.fn()}
			onUninstall={vi.fn()}
			onRevoke={vi.fn()}
			getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
		/>
	);
}

afterEach(cleanup);

describe('ExtensionDetails trust-gate surfacing (FC1)', () => {
	it('unsigned code plugin: explains code will not run but declarative contributions apply', () => {
		renderDetails('unsigned');
		const note = screen.getByTestId('extension-code-disabled');
		expect(note.textContent).toContain('trusted signature');
		expect(note.textContent).toContain('unsigned');
		expect(note.textContent).toContain('declarative contributions');
	});

	it('untrusted code plugin: names the untrusted key as the reason', () => {
		renderDetails('untrusted');
		const note = screen.getByTestId('extension-code-disabled');
		expect(note.textContent).toContain('untrusted key');
	});

	it('invalid (tampered) plugin: fully-disabled copy, no "contributions still apply" claim', () => {
		renderDetails('invalid');
		const note = screen.getByTestId('extension-code-disabled');
		expect(note.textContent).toContain('tampered');
		expect(note.textContent).toContain('fully');
		expect(note.textContent).not.toContain('still apply');
	});

	it('trusted plugin: no gate message rendered', () => {
		renderDetails('trusted');
		expect(screen.queryByTestId('extension-code-disabled')).toBeNull();
	});
});

describe('ExtensionDetails provided plugin actions', () => {
	it('keeps enable, disable, and revoke for bundled OMP while omitting Uninstall', () => {
		const omp = {
			...ext('trusted'),
			key: 'plugin:com.maestro.omp',
			id: 'com.maestro.omp',
			name: 'OMP',
			firstParty: true,
			provided: true,
			record: { ...record('com.maestro.omp'), installOwner: 'bundle' },
		} as UnifiedExtension;
		render(
			<ExtensionDetails
				theme={theme}
				ext={omp}
				contributions={null}
				busy={false}
				onBack={vi.fn()}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
			/>
		);

		expect(screen.getByText('Provided by Maestro')).toBeTruthy();
		expect(screen.getByTestId('extension-enable-toggle')).toBeTruthy();
		expect(screen.getByTestId('extension-revoke')).toBeTruthy();
		expect(screen.queryByTestId('extension-uninstall')).toBeNull();
	});
});
