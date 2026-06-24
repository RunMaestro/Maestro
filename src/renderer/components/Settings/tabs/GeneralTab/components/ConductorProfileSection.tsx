import { User } from 'lucide-react';
import type { Theme } from '../../../../../types';

interface ConductorProfileSectionProps {
	theme: Theme;
	conductorProfile: string;
	setConductorProfile: (value: string) => void;
}

export function ConductorProfileSection({
	theme,
	conductorProfile,
	setConductorProfile,
}: ConductorProfileSectionProps) {
	return (
		<div data-setting-id="general-conductor-profile">
			<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
				<User className="w-3 h-3" />
				Conductor Profile (aka, About Me)
			</div>
			<p className="text-xs opacity-50 mb-2">
				Tell us a little about yourself so that agents created under Maestro know how to work and
				communicate with you. As the conductor, you orchestrate the symphony of AI agents.
				(Optional, max 5000 characters)
			</p>
			<textarea
				aria-label="Conductor Profile"
				value={conductorProfile}
				onChange={(e) => setConductorProfile(e.target.value)}
				placeholder="e.g., I'm a senior developer working on a React/TypeScript project. I prefer concise explanations and clean code patterns..."
				className="w-full p-3 rounded border bg-transparent outline-none text-sm resize-y"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					minHeight: '100px',
				}}
				maxLength={5000}
			/>
			<div
				className="text-xs mt-1 text-right"
				style={{
					color: conductorProfile.length > 4500 ? theme.colors.warning : theme.colors.textDim,
				}}
			>
				{conductorProfile.length}/5000
			</div>
		</div>
	);
}
