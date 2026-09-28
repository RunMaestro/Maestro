import { User } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { useResizableTextarea } from '../../../../../hooks/ui/useResizableTextarea';

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
	const conductorProfileResize = useResizableTextarea({
		sizeKey: 'settings-conductor-profile',
		minHeight: 100,
	});

	return (
		<div data-setting-id="general-conductor-profile">
			<SettingsSectionHeading icon={User}>Conductor Profile (aka, About Me)</SettingsSectionHeading>
			<p className="text-xs opacity-70 mb-2">
				Tell us a little about yourself so that agents created under Maestro know how to work and
				communicate with you. As the conductor, you orchestrate the symphony of AI agents.
				(Optional, max 5000 characters)
			</p>
			<textarea
				ref={conductorProfileResize.textareaRef}
				aria-label="Conductor Profile"
				value={conductorProfile}
				onChange={(e) => setConductorProfile(e.target.value)}
				placeholder="e.g., I'm a senior developer working on a React/TypeScript project. I prefer concise explanations and clean code patterns..."
				className="w-full p-3 rounded border bg-transparent outline-none text-sm resize-y"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					minHeight: '100px',
					...conductorProfileResize.style,
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
