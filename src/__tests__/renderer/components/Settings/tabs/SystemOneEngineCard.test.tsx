/**
 * Tests for the System One engine card in Models > System One: the picker and
 * the sentence that says where task text goes, the key field (typed into a
 * password box, handed to main, never read back), the rows each engine shows,
 * and the Test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Theme } from '../../../../../renderer/types';
import {
	SystemOneEngineCard,
	SystemOneEngineSection,
	describeSystemOneTest,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/SystemOneEngineCard';
import type { SystemOneHookState } from '../../../../../renderer/hooks/localModels';
import {
	SYSTEM_ONE_ENGINE_DISCLOSURES,
	type SystemOneReport,
	type SystemOneTestResult,
} from '../../../../../shared/local-models/system-one-settings';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#a78bfa33',
		accentForeground: '#ffffff',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

const KEY = 'sk-card-test-0123456789abcdef';

function report(overrides: Partial<SystemOneReport> = {}): SystemOneReport {
	const engine = overrides.settings?.engine ?? 'jev-cloud';
	return {
		settings: {
			engine,
			openJevUrl: null,
			timeoutMs: 1500,
			models: {},
			failPolicies: {},
			keepInputs: false,
		},
		engineLabel: 'Jev (TypeSafe cloud)',
		disclosure: SYSTEM_ONE_ENGINE_DISCLOSURES[engine],
		baseUrl: 'https://api.typesafe.ai',
		model: null,
		modelLabel: null,
		timeoutMs: 1500,
		calibrated: true,
		keys: { 'jev-cloud': { source: 'none' }, openjev: { source: 'none' } },
		problem: null,
		failPolicies: [],
		...overrides,
	};
}

function withEngine(
	engine: SystemOneReport['settings']['engine'],
	overrides: Partial<SystemOneReport> = {}
): SystemOneReport {
	return report({
		...overrides,
		settings: {
			engine,
			openJevUrl: null,
			timeoutMs: 1500,
			models: {},
			failPolicies: {},
			keepInputs: false,
			...overrides.settings,
		},
	});
}

function hook(overrides: Partial<SystemOneHookState> = {}): SystemOneHookState {
	return {
		report: report(),
		busy: null,
		error: null,
		test: null,
		refresh: vi.fn().mockResolvedValue(undefined),
		set: vi.fn().mockResolvedValue(true),
		setKey: vi.fn().mockResolvedValue(true),
		clearKey: vi.fn().mockResolvedValue(true),
		runTest: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

/** `FormInput` puts its test id on the field's wrapper; the control is the input inside. */
const field = (testId: string) =>
	screen.getByTestId(testId).querySelector('input') as HTMLInputElement;
const keyInput = () => field('system-one-key-input');

describe('SystemOneEngineCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('says it is reading until the first report arrives, and shows a read failure', () => {
		const { rerender } = render(
			<SystemOneEngineCard theme={theme} systemOne={hook({ report: null })} />
		);
		expect(screen.getByText('Reading System One...')).toBeInTheDocument();
		rerender(
			<SystemOneEngineCard theme={theme} systemOne={hook({ report: null, error: 'no bridge' })} />
		);
		expect(screen.getByText('no bridge')).toBeInTheDocument();
	});

	it('offers off and the three engines, and never names the local judge as Jev', () => {
		render(<SystemOneEngineCard theme={theme} systemOne={hook()} />);
		const options = Array.from(
			screen.getByTestId('system-one-engine-select').querySelectorAll('option')
		).map((option) => [option.value, option.textContent]);
		expect(options).toEqual([
			['off', 'Off'],
			['jev-cloud', 'Jev (TypeSafe cloud)'],
			['openjev', 'OpenJev'],
			['local-judge', 'Local judge, not calibrated'],
		]);
	});

	it('shows only the picker when System One is off', () => {
		render(<SystemOneEngineCard theme={theme} systemOne={hook({ report: withEngine('off') })} />);
		expect(screen.getByTestId('system-one-disclosure')).toHaveTextContent('System One is off');
		for (const id of [
			'system-one-key',
			'system-one-model',
			'system-one-timeout',
			'system-one-test',
		]) {
			expect(screen.queryByTestId(id)).toBeNull();
		}
	});

	it('says that choosing Jev sends task text to TypeSafe', () => {
		render(<SystemOneEngineCard theme={theme} systemOne={hook()} />);
		const disclosure = screen.getByTestId('system-one-disclosure');
		expect(disclosure).toHaveTextContent('TypeSafe');
		expect(disclosure).toHaveTextContent('redacted');
	});

	it('says so when TYPESAFE_BASE_URL sends the text and the key somewhere else', () => {
		const { rerender } = render(<SystemOneEngineCard theme={theme} systemOne={hook()} />);
		expect(screen.queryByTestId('system-one-address-override')).toBeNull();

		rerender(
			<SystemOneEngineCard
				theme={theme}
				systemOne={hook({ report: report({ baseUrl: 'https://proxy.example.com' }) })}
			/>
		);
		const override = screen.getByTestId('system-one-address-override');
		expect(override).toHaveTextContent('TYPESAFE_BASE_URL');
		expect(override).toHaveTextContent('https://proxy.example.com');
	});

	it('sends a new engine choice, and nothing when the same one is picked', () => {
		const systemOne = hook();
		render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
		const select = screen.getByTestId('system-one-engine-select');
		fireEvent.change(select, { target: { value: 'jev-cloud' } });
		expect(systemOne.set).not.toHaveBeenCalled();
		fireEvent.change(select, { target: { value: 'local-judge' } });
		expect(systemOne.set).toHaveBeenCalledWith({ engine: 'local-judge' });
	});

	it('shows why the engine cannot answer as it is set up', () => {
		const problem =
			'Jev (TypeSafe cloud) has no API key. Add one in Settings > Models > System One.';
		render(<SystemOneEngineCard theme={theme} systemOne={hook({ report: report({ problem }) })} />);
		expect(screen.getByText(problem)).toBeInTheDocument();
	});

	describe('the key', () => {
		it('is typed into a password field and handed to main, then dropped', async () => {
			const systemOne = hook();
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			expect(keyInput().type).toBe('password');
			expect(screen.getByTestId('system-one-key-save')).toBeDisabled();
			expect(screen.getByTestId('system-one-key-save')).toHaveTextContent('Save');
			expect(screen.queryByTestId('system-one-key-clear')).toBeNull();

			fireEvent.change(keyInput(), { target: { value: ` ${KEY} ` } });
			fireEvent.click(screen.getByTestId('system-one-key-save'));
			expect(systemOne.setKey).toHaveBeenCalledWith('jev-cloud', KEY);
			await waitFor(() => expect(keyInput().value).toBe(''));
		});

		it('keeps what was typed when main refuses it, so it can be fixed in place', async () => {
			const systemOne = hook({ setKey: vi.fn().mockResolvedValue(false) });
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			fireEvent.change(keyInput(), { target: { value: KEY } });
			fireEvent.click(screen.getByTestId('system-one-key-save'));
			await waitFor(() => expect(systemOne.setKey).toHaveBeenCalled());
			expect(keyInput().value).toBe(KEY);
		});

		it('offers Replace and Clear for a stored key, and never shows the key', () => {
			const systemOne = hook({
				report: report({
					keys: { 'jev-cloud': { source: 'stored', storage: 'os' }, openjev: { source: 'none' } },
				}),
			});
			const { container } = render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			expect(screen.getByTestId('system-one-key-source')).toHaveTextContent(
				'Stored sealed by the system key store.'
			);
			expect(screen.getByTestId('system-one-key-save')).toHaveTextContent('Replace');
			expect(keyInput().value).toBe('');
			expect(container.textContent).not.toContain('sk-');

			fireEvent.click(screen.getByTestId('system-one-key-clear'));
			expect(systemOne.clearKey).toHaveBeenCalledWith('jev-cloud');
		});

		it('names the variable or the file a fallback key comes from, with no Clear', () => {
			const { rerender } = render(
				<SystemOneEngineCard
					theme={theme}
					systemOne={hook({
						report: report({
							keys: {
								'jev-cloud': { source: 'env', envVar: 'TYPESAFE_API_KEY', from: 'settings' },
								openjev: { source: 'none' },
							},
						}),
					})}
				/>
			);
			expect(screen.getByTestId('system-one-key-source')).toHaveTextContent(
				'Read from TYPESAFE_API_KEY in Settings > Environment.'
			);
			expect(screen.queryByTestId('system-one-key-clear')).toBeNull();

			rerender(
				<SystemOneEngineCard
					theme={theme}
					systemOne={hook({
						report: report({
							keys: {
								'jev-cloud': { source: 'file', path: '/home/u/.config/typesafe/api_key' },
								openjev: { source: 'none' },
							},
						}),
					})}
				/>
			);
			expect(screen.getByTestId('system-one-key-source')).toHaveTextContent(
				'/home/u/.config/typesafe/api_key'
			);
		});

		it('warns when a stored key is only obscured, or will not open', () => {
			const { rerender } = render(
				<SystemOneEngineCard
					theme={theme}
					systemOne={hook({
						report: report({
							keys: {
								'jev-cloud': { source: 'stored', storage: 'obscured' },
								openjev: { source: 'none' },
							},
						}),
					})}
				/>
			);
			expect(screen.getByText(/stored obscured, not encrypted/)).toBeInTheDocument();

			const problem = 'The stored key for Jev (TypeSafe cloud) could not be unsealed.';
			rerender(
				<SystemOneEngineCard
					theme={theme}
					systemOne={hook({
						report: report({
							keys: {
								'jev-cloud': { source: 'stored', storage: 'os', problem },
								openjev: { source: 'none' },
							},
						}),
					})}
				/>
			);
			expect(screen.getByText(problem)).toBeInTheDocument();
			expect(screen.getByTestId('system-one-key-clear')).toBeInTheDocument();
		});

		it('refuses a pasted value that is not one key', () => {
			const systemOne = hook();
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			fireEvent.change(keyInput(), { target: { value: 'two words' } });
			expect(screen.getByText('A key is one line with no spaces.')).toBeInTheDocument();
			expect(screen.getByTestId('system-one-key-save')).toBeDisabled();
		});
	});

	describe('OpenJev', () => {
		it('asks for the server URL, and says a key is optional', () => {
			const systemOne = hook({
				report: withEngine('openjev', { problem: 'OpenJev has no URL. Set it in Settings.' }),
			});
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			expect(screen.getByTestId('system-one-key-source')).toHaveTextContent(
				'Only a server that asks for one needs it.'
			);

			const url = field('system-one-openjev-url-input');
			expect(screen.getByTestId('system-one-openjev-url-save')).toBeDisabled();
			fireEvent.change(url, { target: { value: 'ftp://gpu.lan' } });
			expect(screen.getByTestId('system-one-openjev-url-save')).toBeDisabled();
			fireEvent.change(url, { target: { value: 'https://gpu.lan:8000' } });
			fireEvent.click(screen.getByTestId('system-one-openjev-url-save'));
			expect(systemOne.set).toHaveBeenCalledWith({ openJevUrl: 'https://gpu.lan:8000' });
		});

		it('stores a key for OpenJev, not for Jev', () => {
			const systemOne = hook({ report: withEngine('openjev') });
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			fireEvent.change(keyInput(), { target: { value: KEY } });
			fireEvent.click(screen.getByTestId('system-one-key-save'));
			expect(systemOne.setKey).toHaveBeenCalledWith('openjev', KEY);
		});
	});

	describe('the model and the timeout', () => {
		it('pins a model, and removes the pin when the field is emptied', () => {
			const systemOne = hook();
			const { rerender } = render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			const model = () => field('system-one-model-input');
			fireEvent.change(model(), { target: { value: 'jev-1.13.0' } });
			fireEvent.click(screen.getByTestId('system-one-model-save'));
			expect(systemOne.set).toHaveBeenCalledWith({ model: 'jev-1.13.0' });

			const pinned = hook({
				report: report({
					settings: { ...report().settings, models: { 'jev-cloud': 'jev-1.13.0' } },
					model: 'jev-1.13.0',
				}),
			});
			rerender(<SystemOneEngineCard theme={theme} systemOne={pinned} />);
			expect(model().value).toBe('jev-1.13.0');
			fireEvent.change(model(), { target: { value: '' } });
			fireEvent.click(screen.getByTestId('system-one-model-save'));
			expect(pinned.set).toHaveBeenCalledWith({ model: null });
		});

		it('saves a timeout in range, and refuses one that is not', () => {
			const systemOne = hook();
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			const timeout = field('system-one-timeout-input');
			fireEvent.change(timeout, { target: { value: '20' } });
			expect(screen.getByTestId('system-one-timeout-save')).toBeDisabled();
			fireEvent.change(timeout, { target: { value: '900' } });
			fireEvent.click(screen.getByTestId('system-one-timeout-save'));
			expect(systemOne.set).toHaveBeenCalledWith({ timeoutMs: 900 });
		});

		it("points the local judge's model at its task row, with no key, pin or timeout field", () => {
			const systemOne = hook({
				report: withEngine('local-judge', {
					engineLabel: 'Local judge (Qwen3 1.7B), not calibrated',
					model: 'local:qwen3-1.7b-instruct-q4km',
					modelLabel: 'Qwen3 1.7B',
					calibrated: false,
				}),
			});
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			expect(screen.getByTestId('system-one-judge-model')).toHaveTextContent('Qwen3 1.7B');
			expect(screen.getByTestId('system-one-judge-model')).toHaveTextContent('Local judge row');
			expect(screen.getByTestId('system-one-disclosure')).toHaveTextContent('not calibrated');
			for (const id of ['system-one-key', 'system-one-model', 'system-one-timeout']) {
				expect(screen.queryByTestId(id)).toBeNull();
			}
		});
	});

	describe('Test', () => {
		const OK: SystemOneTestResult = {
			ok: true,
			engine: 'jev-cloud',
			engineLabel: 'Jev (TypeSafe cloud)',
			model: 'jev-1.13.0',
			probability: 0.97,
			latencyMs: 212,
			calibrated: true,
			usage: { inputTokens: 41, outputTokens: 1 },
			costUsd: 0.0000017,
		};

		it('runs the test, and shows the answer, the latency and the engine', () => {
			const systemOne = hook({ test: OK });
			render(<SystemOneEngineCard theme={theme} systemOne={systemOne} />);
			fireEvent.click(screen.getByTestId('system-one-test-run'));
			expect(systemOne.runTest).toHaveBeenCalledTimes(1);
			const result = screen.getByTestId('system-one-test-result');
			expect(result).toHaveAttribute('data-test-ok', 'true');
			expect(result).toHaveTextContent(
				'Jev (TypeSafe cloud) answered yes (P(yes) 0.97) in 212 ms on jev-1.13.0.'
			);
		});

		it('shows a failure in the words of the engine that was asked', () => {
			const error = 'Jev (TypeSafe cloud) did not answer within 1500 ms.';
			render(
				<SystemOneEngineCard
					theme={theme}
					systemOne={hook({
						test: {
							ok: false,
							engine: 'jev-cloud',
							engineLabel: 'Jev (TypeSafe cloud)',
							code: 'timeout',
							error,
						},
					})}
				/>
			);
			expect(screen.getByTestId('system-one-test-result')).toHaveTextContent(error);
			expect(screen.getByTestId('system-one-test-result')).toHaveAttribute('data-test-ok', 'false');
		});

		it('marks a local judge answer as not calibrated, and flags a wrong answer', () => {
			expect(
				describeSystemOneTest({
					...OK,
					engine: 'local-judge',
					engineLabel: 'Local judge (Qwen3 1.7B), not calibrated',
					calibrated: false,
					probability: 0.2,
				})
			).toContain('answered no (P(yes) 0.20, not calibrated)');

			render(
				<SystemOneEngineCard
					theme={theme}
					systemOne={hook({ test: { ...OK, probability: 0.2 } })}
				/>
			);
			expect(screen.getByText('The right answer to the test question is yes.')).toBeInTheDocument();
		});

		it('disables every control while an action runs', () => {
			render(<SystemOneEngineCard theme={theme} systemOne={hook({ busy: 'test' })} />);
			expect(screen.getByTestId('system-one-test-run')).toBeDisabled();
			expect(screen.getByTestId('system-one-test-run')).toHaveTextContent('Testing...');
			expect(screen.getByTestId('system-one-engine-select')).toBeDisabled();
			expect(keyInput()).toBeDisabled();
		});
	});

	it('is findable from settings search', () => {
		const { container } = render(<SystemOneEngineSection theme={theme} systemOne={hook()} />);
		expect(
			container.querySelector('[data-setting-id="local-models-system-one-engine"]')
		).not.toBeNull();
	});
});
