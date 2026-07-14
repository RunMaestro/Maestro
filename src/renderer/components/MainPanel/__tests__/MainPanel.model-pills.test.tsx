import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelEffortPills } from '../../InputArea/components/ModelEffortPills';
import { THEMES } from '../../../constants/themes';
import { resolvePillModels } from '../MainPanel';

describe('OMP model pill', () => {
	it('uses the live native model control when discovery has no models', () => {
		const models = resolvePillModels(
			'omp',
			[],
			[
				{
					id: 'model',
					label: 'Model',
					kind: 'select',
					value: 'anthropic:claude-fable-5',
					options: [
						{ id: 'anthropic:claude-fable-5', label: 'Claude Fable 5' },
						{ id: 'openai:gpt-5.4', label: 'GPT-5.4' },
					],
				},
			]
		);

		render(
			<ModelEffortPills
				isVisible
				theme={THEMES.dracula}
				currentModel="anthropic:claude-fable-5"
				availableModels={models}
				availableEfforts={[]}
				onModelChange={() => undefined}
				modelMenuOpen={false}
				setModelMenuOpen={() => undefined}
				modelMenuRef={{ current: null }}
				effortMenuOpen={false}
				setEffortMenuOpen={() => undefined}
				effortMenuRef={{ current: null }}
			/>
		);

		expect(screen.getByTitle('Change model')).toBeInTheDocument();
	});
});
