import { GENERAL_SECTIONS } from './sections';
import type { GeneralTabProps } from './types';

export type { GeneralTabProps } from './types';

export function GeneralTab({ theme, isOpen }: GeneralTabProps) {
	return (
		<div className="space-y-5">
			{GENERAL_SECTIONS.map(({ key, Component }) => (
				<Component key={key} theme={theme} isOpen={isOpen} />
			))}
		</div>
	);
}
