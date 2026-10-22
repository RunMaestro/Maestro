/**
 * EndpointTestVerdictLine - the one-line result of an endpoint Test: the
 * latency and the model that answered, or the error the server (or the call)
 * gave back. Shared by the endpoint row and the add/edit form so the two never
 * word a verdict differently.
 */

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { EndpointTestState } from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';

export interface EndpointTestVerdictLineProps {
	theme: Theme;
	state: EndpointTestState;
	testId?: string;
}

export function EndpointTestVerdictLine({
	theme,
	state,
	testId = 'endpoint-test-verdict',
}: EndpointTestVerdictLineProps) {
	if ('status' in state) {
		return (
			<div
				className="flex items-center gap-1.5 text-xs"
				style={{ color: theme.colors.textDim }}
				data-testid={testId}
			>
				<Loader2 className="w-3.5 h-3.5 animate-spin" />
				<span>Testing...</span>
			</div>
		);
	}
	if (state.ok) {
		return (
			<div
				className="flex items-center gap-1.5 text-xs select-text"
				style={{ color: theme.colors.success }}
				data-testid={testId}
			>
				<CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
				<span>
					{state.model} answered in {Math.round(state.latencyMs)} ms
				</span>
			</div>
		);
	}
	return (
		<div
			className="flex items-start gap-1.5 text-xs select-text"
			style={{ color: theme.colors.error }}
			data-testid={testId}
		>
			<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
			<span>{state.error.message}</span>
		</div>
	);
}
