import { ArrowRightLeft } from 'lucide-react';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { ContextTranslationRecord } from '../../shared/maestro-lib/translation/types';
import type { Theme } from '../types';

/** Uses the compaction/delegation pill treatment with native keyboard and touch disclosure. */
export function ContextTranslationCard({
	translation,
	theme,
}: {
	translation: ContextTranslationRecord;
	theme: Theme;
}): React.ReactElement {
	const source = getAgentDisplayName(translation.source.provider);
	const destination = getAgentDisplayName(translation.destination.provider);
	const warnings = translation.limitations.filter(
		(limitation) => limitation.severity === 'warning'
	);
	const information = translation.limitations.filter(
		(limitation) => limitation.severity === 'info'
	);
	const detail = `${source} ${translation.source.version} to ${destination} ${translation.destination.version}. Native translation ${translation.verification}.`;
	const accent = theme.colors.accent;

	return (
		<details className="max-w-full text-xs" data-testid="context-translation-card">
			<summary
				className="w-fit max-w-full cursor-pointer rounded-full border px-2.5 py-1 select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
				style={{
					color: accent,
					backgroundColor: `color-mix(in srgb, ${accent} 10%, transparent)`,
					borderColor: `color-mix(in srgb, ${accent} 35%, ${theme.colors.border})`,
				}}
				title={detail}
			>
				<ArrowRightLeft className="inline w-3.5 h-3.5 mr-2" aria-hidden />
				Context translated from {source}
			</summary>
			<div className="mt-2 space-y-2 break-words" style={{ color: theme.colors.textDim }}>
				<p>{detail}</p>
				<p>
					{translation.counts.records} records, {translation.counts.artifacts} resources
				</p>
				<p>Plan: {translation.operationId}</p>
				{warnings.length > 0 && (
					<div>
						<p className="font-semibold" style={{ color: theme.colors.warning }}>
							Accepted warnings
						</p>
						<ul className="list-disc pl-5">
							{warnings.map((warning, index) => (
								<li key={`${warning.code}:${index}`}>{warning.message}</li>
							))}
						</ul>
					</div>
				)}
				{information.length > 0 && (
					<ul className="list-disc pl-5" aria-label="Translation information">
						{information.map((limitation, index) => (
							<li key={`${limitation.code}:${index}`}>{limitation.message}</li>
						))}
					</ul>
				)}
			</div>
		</details>
	);
}
