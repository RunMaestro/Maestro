/**
 * AgentModelSection - the top of an agent form's Models tab: the provider's
 * model options (the Model field, effort, reasoning summary, context window),
 * with the Model field also listing every Local Models source model when the
 * form binds a model source.
 *
 * It is `AgentConfigOptions scope="model"` with the same props the form hands
 * `AgentConfigPanel` on its Provider tab (which hides them with
 * `hideModelOptions`), so a field reads and saves the same way on either tab.
 * A form whose agent runs on its provider only (the group chat moderator)
 * passes no `modelSource`, and nothing about sources is read or drawn.
 */

import { AgentConfigOptions, type AgentConfigOptionsProps } from '../shared/AgentConfigPanel';
import {
	ModelSourceDetails,
	useModelSourceChoices,
	type ModelSourceBinding,
} from '../shared/ModelSourceDetails';

export interface AgentModelSectionProps extends Omit<
	AgentConfigOptionsProps,
	'scope' | 'modelSources' | 'modelSourceDetails'
> {
	/** The agent's model source. Omit for an agent that runs on its provider only. */
	modelSource?: ModelSourceBinding;
}

export function AgentModelSection({ modelSource, ...options }: AgentModelSectionProps) {
	if (!modelSource) return <AgentConfigOptions {...options} scope="model" />;
	return <AgentModelSectionWithSource {...options} modelSource={modelSource} />;
}

function AgentModelSectionWithSource({
	modelSource,
	...options
}: AgentModelSectionProps & { modelSource: ModelSourceBinding }) {
	const state = useModelSourceChoices(options.agent.id, modelSource);
	return (
		<AgentConfigOptions
			{...options}
			scope="model"
			modelSources={state.choices}
			modelSourceDetails={
				<ModelSourceDetails
					theme={options.theme}
					toolType={options.agent.id}
					state={state}
					{...modelSource}
				/>
			}
		/>
	);
}
