/**
 * Conductor Badge Achievement System
 *
 * Tracks cumulative AutoRun time and awards badges based on milestones.
 * Inspired by the hierarchy of orchestral conductors, from apprentice to legendary.
 */

export interface ConductorBadge {
	id: string;
	level: number;
	name: string;
	shortName: string;
	description: string;
	requiredTimeMs: number; // Cumulative AutoRun time required
	exampleConductor: {
		name: string;
		era: string;
		achievement: string;
		wikipediaUrl: string;
	};
	flavorText: string;
}

// Time constants in milliseconds
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export const CONDUCTOR_BADGES: ConductorBadge[] = [
	{
		id: 'apprentice-conductor',
		level: 1,
		name: 'Apprentice Conductor',
		shortName: 'Apprentice',
		description:
			'Just learning baton technique, cueing, and score reading. Assists rehearsals and may conduct small sections.',
		requiredTimeMs: 15 * MINUTE, // 15 minutes
		exampleConductor: {
			name: 'Gustavo Dudamel',
			era: 'Early Career (1999)',
			achievement: 'Started as a youth orchestra conductor at age 18 in Venezuela',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Gustavo_Dudamel',
		},
		flavorText: "Every maestro starts with their first downbeat. You've taken the podium.",
	},
	{
		id: 'assistant-conductor',
		level: 2,
		name: 'Assistant Conductor',
		shortName: 'Assistant',
		description:
			'Supports the main conductor at a professional orchestra. Leads rehearsals and covers when needed. The first real step into professional conducting.',
		requiredTimeMs: 1 * HOUR, // 1 hour
		exampleConductor: {
			name: 'Marin Alsop',
			era: 'Early Career (1989)',
			achievement: 'Assistant conductor to Leonard Bernstein at Tanglewood',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Marin_Alsop',
		},
		flavorText:
			"You've proven you can step in when the maestro needs you. The orchestra is starting to trust your cues.",
	},
	{
		id: 'associate-conductor',
		level: 3,
		name: 'Associate Conductor',
		shortName: 'Associate',
		description:
			'A trusted lieutenant who regularly conducts concerts, outreach programs, or B-series performances.',
		requiredTimeMs: 8 * HOUR, // 8 hours
		exampleConductor: {
			name: 'Yannick Nézet-Séguin',
			era: 'Mid Career (2008)',
			achievement:
				'Associate conductor at the Rotterdam Philharmonic before rising to Music Director',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Yannick_N%C3%A9zet-S%C3%A9guin',
		},
		flavorText:
			'The musicians look to you with confidence. Your interpretation is developing its own voice.',
	},
	{
		id: 'resident-conductor',
		level: 4,
		name: 'Resident Conductor',
		shortName: 'Resident',
		description:
			"Officially part of the artistic leadership team. Conducts full concerts, sometimes entire seasons. Has steady command of an orchestra's artistic identity.",
		requiredTimeMs: 1 * DAY, // 24 hours
		exampleConductor: {
			name: 'Jaap van Zweden',
			era: 'Mid Career (2005)',
			achievement:
				'Resident conductor of the Dallas Symphony before becoming Music Director of the NY Philharmonic',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Jaap_van_Zweden',
		},
		flavorText:
			'The orchestra knows your style. Your presence on the podium brings focused energy to every rehearsal.',
	},
	{
		id: 'principal-guest-conductor',
		level: 5,
		name: 'Principal Guest Conductor',
		shortName: 'Principal Guest',
		description:
			'Not employed full-time but invited repeatedly. Signals prestige and a strong artistic relationship with the orchestra.',
		requiredTimeMs: 1 * WEEK, // 1 week
		exampleConductor: {
			name: 'Esa-Pekka Salonen',
			era: '1990s-2000s',
			achievement: 'Principal Guest Conductor of the Philharmonia Orchestra while leading LA Phil',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Esa-Pekka_Salonen',
		},
		flavorText:
			'Orchestras across the world are taking notice. Your guest appearances are the highlight of their season.',
	},
	{
		id: 'chief-conductor',
		level: 6,
		name: 'Chief Conductor',
		shortName: 'Chief',
		description:
			'The equivalent of "head coach." Primary artistic vision holder who leads the majority of programs.',
		requiredTimeMs: 1 * MONTH, // 30 days
		exampleConductor: {
			name: 'Andris Nelsons',
			era: 'Current',
			achievement:
				'Chief Conductor of the Gewandhausorchester Leipzig and Music Director of the Boston Symphony',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Andris_Nelsons',
		},
		flavorText:
			'You command the artistic direction. Your vision shapes every performance the orchestra gives.',
	},
	{
		id: 'music-director',
		level: 7,
		name: 'Music Director',
		shortName: 'Director',
		description:
			'The apex of standard titles. Sets long-term artistic direction, hires musicians, and plans entire seasons. The ultimate orchestral leadership position.',
		requiredTimeMs: 3 * MONTH, // 3 months (quarter)
		exampleConductor: {
			name: 'Sir Simon Rattle',
			era: '2002-2018',
			achievement:
				'Music Director of the Berlin Philharmonic for 16 years, transforming its repertoire',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Simon_Rattle',
		},
		flavorText:
			'The orchestra is your instrument. You shape not just performances, but the very culture of music-making.',
	},
	{
		id: 'maestro-emeritus',
		level: 8,
		name: 'Maestro Emeritus',
		shortName: 'Emeritus',
		description:
			'An honorific status for legendary figures who shaped an orchestra. Still guest-conducts, but with legacy-level reverence.',
		requiredTimeMs: 6 * MONTH, // 6 months
		exampleConductor: {
			name: 'Bernard Haitink',
			era: '1961-2019',
			achievement:
				'Conductor Laureate of multiple orchestras after decades of transformative leadership',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Bernard_Haitink',
		},
		flavorText:
			"Your legacy is written into the DNA of the orchestras you've led. Standing ovations greet your every appearance.",
	},
	{
		id: 'world-maestro',
		level: 9,
		name: 'World Maestro',
		shortName: 'World',
		description:
			'Conducts top orchestras globally. Commands rarefied fees and has a distinctive interpretive "voice" recognized worldwide.',
		requiredTimeMs: 365 * DAY, // 1 year
		exampleConductor: {
			name: 'Kirill Petrenko',
			era: 'Current',
			achievement:
				'Chief Conductor of the Berlin Philharmonic, known for meticulous preparation and transformative performances',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Kirill_Petrenko',
		},
		flavorText:
			"Your name alone fills concert halls. The world's finest orchestras compete for your calendar.",
	},
	{
		id: 'grand-maestro',
		level: 10,
		name: 'Grand Maestro',
		shortName: 'Grand',
		description:
			'Among the top 20 living conductors. Near-universal critical acclaim, regularly leads elite orchestras worldwide. Known for landmark recordings and signature interpretations.',
		requiredTimeMs: 5 * 365 * DAY, // 5 years
		exampleConductor: {
			name: 'Riccardo Muti',
			era: 'Current',
			achievement:
				'Music Director of the Chicago Symphony, over 50 years of legendary performances across the globe',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Riccardo_Muti',
		},
		flavorText:
			'You stand among the titans. Your interpretations are studied, your recordings are definitive, your legacy is assured.',
	},
	{
		id: 'immortal-maestro',
		level: 11,
		name: 'Titan of the Baton',
		shortName: 'Titan',
		description:
			"The mythic peak—a once-in-a-generation artistic figure. Transformed the field's aesthetics, standards, and sound. Definitive recordings considered global references.",
		requiredTimeMs: 10 * 365 * DAY, // 10 years
		exampleConductor: {
			name: 'Leonard Bernstein',
			era: '1943-1990',
			achievement:
				'Transformed American classical music, legendary NY Philharmonic tenure, iconic educator and composer',
			wikipediaUrl: 'https://en.wikipedia.org/wiki/Leonard_Bernstein',
		},
		flavorText:
			'You have transcended conducting. Like Bernstein, Karajan, and Toscanini before you, your name will echo through the ages.',
	},
];

/**
 * Get badge for a given cumulative time
 */
export function getBadgeForTime(cumulativeTimeMs: number): ConductorBadge | null {
	// Find the highest badge the user qualifies for
	let currentBadge: ConductorBadge | null = null;

	for (const badge of CONDUCTOR_BADGES) {
		if (cumulativeTimeMs >= badge.requiredTimeMs) {
			currentBadge = badge;
		} else {
			break;
		}
	}

	return currentBadge;
}

/**
 * Get the next badge after the current one
 */
export function getNextBadge(currentBadge: ConductorBadge | null): ConductorBadge | null {
	if (!currentBadge) {
		return CONDUCTOR_BADGES[0];
	}

	const currentIndex = CONDUCTOR_BADGES.findIndex((b) => b.id === currentBadge.id);
	if (currentIndex === -1 || currentIndex >= CONDUCTOR_BADGES.length - 1) {
		return null;
	}

	return CONDUCTOR_BADGES[currentIndex + 1];
}

/**
 * Calculate progress toward the next badge (0-100)
 */
export function getProgressToNextBadge(
	cumulativeTimeMs: number,
	currentBadge: ConductorBadge | null,
	nextBadge: ConductorBadge | null
): number {
	if (!nextBadge) {
		return 100; // At max level
	}

	const startTime = currentBadge?.requiredTimeMs || 0;
	const endTime = nextBadge.requiredTimeMs;
	const range = endTime - startTime;

	if (range <= 0) return 100;

	const progress = ((cumulativeTimeMs - startTime) / range) * 100;
	return Math.min(100, Math.max(0, progress));
}

/**
 * Format time remaining to next badge
 */
export function formatTimeRemaining(
	cumulativeTimeMs: number,
	nextBadge: ConductorBadge | null
): string {
	if (!nextBadge) {
		return 'Maximum level achieved!';
	}

	const remaining = nextBadge.requiredTimeMs - cumulativeTimeMs;
	if (remaining <= 0) return 'Ready to unlock!';

	const days = Math.floor(remaining / DAY);
	const hours = Math.floor((remaining % DAY) / HOUR);
	const minutes = Math.floor((remaining % HOUR) / MINUTE);

	if (days >= 365) {
		const years = Math.floor(days / 365);
		const remainingDays = days % 365;
		return `${years}y ${remainingDays}d remaining`;
	}
	if (days > 30) {
		const months = Math.floor(days / 30);
		const remainingDays = days % 30;
		return `${months}mo ${remainingDays}d remaining`;
	}
	if (days > 0) {
		return `${days}d ${hours}h remaining`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m remaining`;
	}
	return `${minutes}m remaining`;
}

/**
 * Format cumulative time for display
 */
export function formatCumulativeTime(timeMs: number): string {
	const days = Math.floor(timeMs / DAY);
	const hours = Math.floor((timeMs % DAY) / HOUR);
	const minutes = Math.floor((timeMs % HOUR) / MINUTE);
	const seconds = Math.floor((timeMs % MINUTE) / 1000);

	if (days >= 365) {
		const years = Math.floor(days / 365);
		const remainingDays = days % 365;
		return `${years}y ${remainingDays}d`;
	}
	if (days > 0) {
		return `${days}d ${hours}h ${minutes}m`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}
