import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { MAX_CONSULTATIONS_PER_TURN_CEILING } from '../../../../../../shared/consultBudget';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';

interface ConsultationBudgetSectionProps {
	theme: Theme;
	maxConsultationsPerTurn: number;
	setMaxConsultationsPerTurn: (value: number) => void;
}

const INPUT_ID = 'consultation-budget-input';

export function ConsultationBudgetSection({
	theme,
	maxConsultationsPerTurn,
	setMaxConsultationsPerTurn,
}: ConsultationBudgetSectionProps) {
	// The field holds a draft so it can be emptied while a new number is typed.
	// An empty or partial draft never reaches the store: 0 is a real value here
	// (peer consults off), so falling back to it mid-edit would switch the
	// feature off under the user.
	const [draft, setDraft] = useState(String(maxConsultationsPerTurn));
	useEffect(() => {
		setDraft(String(maxConsultationsPerTurn));
	}, [maxConsultationsPerTurn]);

	const handleChange = (text: string) => {
		setDraft(text);
		if (/^\d+$/.test(text.trim())) setMaxConsultationsPerTurn(Number(text));
	};

	return (
		<div data-setting-id="general-consultation-budget">
			<SettingsSectionHeading icon={Gauge}>Consultation Budget</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div>
					<label
						htmlFor={INPUT_ID}
						className="block font-medium"
						style={{ color: theme.colors.textMain }}
					>
						Peer consults and delegations per message
					</label>
					<div className="text-xs opacity-70 mt-0.5 mb-2">
						The most consults and delegations an agent&apos;s peers may make in total while working
						on one of your messages. Counts the whole chain, so an agent that consults a peer who
						consults another spends two.{' '}
						{maxConsultationsPerTurn === 0
							? 'At 0, agents cannot consult or delegate to their peers at all.'
							: 'Set it to 0 to stop agents from consulting or delegating to their peers at all.'}
					</div>
					<input
						id={INPUT_ID}
						type="number"
						inputMode="numeric"
						min={0}
						max={MAX_CONSULTATIONS_PER_TURN_CEILING}
						step={1}
						value={draft}
						onChange={(e) => handleChange(e.target.value)}
						onBlur={() => setDraft(String(maxConsultationsPerTurn))}
						className="w-full p-1.5 rounded border bg-transparent outline-none text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>
			</SectionCard>
		</div>
	);
}
