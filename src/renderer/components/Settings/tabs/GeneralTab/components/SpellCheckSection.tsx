import { SpellCheck } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingCheckbox } from '../../../../SettingCheckbox';

interface SpellCheckSectionProps {
	theme: Theme;
	spellCheck: boolean;
	setSpellCheck: (enabled: boolean) => void;
}

export function SpellCheckSection({ theme, spellCheck, setSpellCheck }: SpellCheckSectionProps) {
	return (
		<div data-setting-id="general-spell-check">
			<SettingCheckbox
				icon={SpellCheck}
				sectionLabel="Spell Check"
				title="Enable spell checking"
				description="Show spell check suggestions in input areas (prompt input, group chat, file editor). Disabled by default."
				checked={spellCheck}
				onChange={setSpellCheck}
				theme={theme}
			/>
		</div>
	);
}
