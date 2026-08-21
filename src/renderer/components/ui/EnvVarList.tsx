/**
 * EnvVarList - read-only view of an agent's effective environment.
 *
 * Distinct from `Settings/EnvVarsEditor`, which edits ONE layer. This shows the
 * merged result of all three layers with the winning source per key, which is
 * what answers "which profile is this agent actually running as?".
 *
 * Secret-looking values are masked behind a per-row reveal. This is shown
 * during a credential failure, which is when someone is most likely to be
 * screen-sharing for help.
 */

import { useCallback, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import {
	envSourceLabel,
	isSecretEnvKey,
	maskEnvValue,
	type ResolvedEnvVar,
} from '../../../shared/agentEnvironment';
import type { Theme } from '../../types';

export interface EnvVarListProps {
	theme: Theme;
	vars: ResolvedEnvVar[];
	/** Rendered when there is nothing to show. */
	emptyMessage?: string;
	testId?: string;
}

export function EnvVarList({
	theme,
	vars,
	emptyMessage = 'No environment variables are set for this agent.',
	testId = 'env-var-list',
}: EnvVarListProps) {
	const [revealed, setRevealed] = useState<Set<string>>(() => new Set());

	const toggleReveal = useCallback((key: string) => {
		setRevealed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	if (vars.length === 0) {
		return (
			<p
				className="text-xs"
				style={{ color: theme.colors.textDim }}
				data-testid={`${testId}-empty`}
			>
				{emptyMessage}
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-1 select-text" data-testid={testId}>
			{vars.map((entry) => {
				const secret = isSecretEnvKey(entry.key);
				const isRevealed = revealed.has(entry.key);
				const shown = secret && !isRevealed ? maskEnvValue(entry.value) : entry.value;

				return (
					<div
						key={entry.key}
						className="flex items-baseline gap-2 text-xs font-mono"
						data-testid={`${testId}-row`}
						data-env-key={entry.key}
					>
						<span className="shrink-0" style={{ color: theme.colors.textMain }}>
							{entry.key}
						</span>
						<span style={{ color: theme.colors.textDim }}>=</span>
						<span
							className="min-w-0 flex-1 break-all"
							style={{ color: theme.colors.textDim }}
							data-testid={`${testId}-value`}
						>
							{shown || <span style={{ opacity: 0.6 }}>(empty)</span>}
						</span>
						{secret && (
							<button
								type="button"
								onClick={() => toggleReveal(entry.key)}
								className="shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title={isRevealed ? `Hide ${entry.key}` : `Reveal ${entry.key}`}
								aria-label={isRevealed ? `Hide ${entry.key}` : `Reveal ${entry.key}`}
							>
								{isRevealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
							</button>
						)}
						<span
							className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-sans"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title={
								entry.shadowedBy.length
									? `Set in ${envSourceLabel(entry.source)}, overriding ${entry.shadowedBy
											.map(envSourceLabel)
											.join(', ')}`
									: `Set in ${envSourceLabel(entry.source)}`
							}
						>
							{envSourceLabel(entry.source)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

export default EnvVarList;
