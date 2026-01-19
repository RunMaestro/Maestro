/**
 * austinFacts.ts
 *
 * Collection of interesting, unique facts about Austin, Texas.
 * Used to entertain users during loading screens.
 *
 * Link syntax: [link text](url) - will be rendered as clickable links
 * that open in the system browser.
 */

import { shuffle } from './shuffle';

const AUSTIN_FACTS = [
	// Pedram's Picks - Weekly Specials
	"Sunday is half priced bottles of wine at Jeffrey's.",
	'Monday is steak night at Josephine\'s with a 3-course prix fixe and "Unlimited wine".',
	'Tuesday is half priced bottles of wine at Boa Steakhouse.',
	'Wednesday is half price bottles of wine at Mongers.',
	"Check out some of Pedram's favorite spots in Austin on [Google Maps](https://www.google.com/maps/@/data=!3m1!4b1!4m3!11m2!2s1azIgXGVoByyyoq1OxDbWzP91dgc!3e3?shorturl=1).",

	// Iconic Austin
	"Austin's official slogan 'Keep Austin Weird' was coined in 2000 by a local librarian during a radio pledge drive.",
	'The Texas State Capitol building is actually 14 feet taller than the U.S. Capitol in Washington, D.C.',
	"Austin is known as the 'Live Music Capital of the World' with over 250 live music venues.",
	'Barton Springs Pool stays a constant 68-70°F year-round, fed by underground springs.',
	'The Congress Avenue Bridge is home to the largest urban bat colony in North America—1.5 million Mexican free-tailed bats.',
	'Lady Bird Lake was renamed in 2007 to honor Lady Bird Johnson, former First Lady and Austin native.',
	'Mount Bonnell, at 775 feet, is one of the highest points in Austin and has been a tourist destination since the 1850s.',
	"The Driskill Hotel, built in 1886, is Austin's oldest operating hotel and is reportedly haunted.",
	'Zilker Park was named after Andrew Jackson Zilker, who donated the land to the city in 1917.',
	'The University of Texas tower was the first building in the U.S. to be lit orange for a sports victory, starting in 1930.',

	// Food & Drink
	'Franklin Barbecue has been named the best BBQ in Texas multiple times—lines regularly exceed 3 hours.',
	"Austin invented the frozen margarita machine in 1971 at Mariano's Mexican Cuisine.",
	"The breakfast taco is so beloved in Austin that there's an unofficial 'Taco Trail' with over 50 stops.",
	"Torchy's Tacos started as a food trailer in 2006 on South First Street before becoming a Texas empire.",
	'San Jac Saloon on 6th Street has been pouring drinks since the 1980s and is famous for its rooftop with downtown views.',
	"San Jac Saloon's rooftop bar offers one of the best spots to watch 6th Street chaos unfold from above.",
	"Amy's Ice Creams was founded in Austin in 1984 and is known for employees doing tricks with your order.",
	'The Salt Lick BBQ in Driftwood has been family-owned since 1967 and allows BYOB.',
	'Austin has more food trucks per capita than any other city in America.',
	'The original Whole Foods Market opened in Austin in 1980 with just 19 employees.',

	// Music & Culture
	'SXSW (South by Southwest) started in 1987 with just 700 attendees—now it draws over 400,000.',
	'Austin City Limits is the longest-running music series in American television history, starting in 1974.',
	"Stevie Ray Vaughan's bronze statue on Lady Bird Lake was erected in 1993, three years after his death.",
	'The Continental Club on South Congress has hosted live music every night since 1957.',
	'Willie Nelson has lived near Austin since 1972 and plays annual Fourth of July picnics.',
	"Janis Joplin got her start performing at Threadgill's in Austin in the 1960s.",
	"The Broken Spoke is Austin's last true Texas dance hall, operating since 1964.",
	"Antone's, 'Austin's Home of the Blues,' helped launch careers of Stevie Ray Vaughan and many others.",
	"The Armadillo World Headquarters (1970-1980) was Austin's legendary counterculture music venue.",
	'Austin is the only city where Leslie Cochran, a cross-dressing homeless man, became a beloved icon and ran for mayor.',

	// Tech & Innovation
	"Austin is nicknamed 'Silicon Hills' due to its booming tech industry.",
	"Dell Technologies was founded in Michael Dell's UT Austin dorm room in 1984.",
	"Tesla moved its headquarters to Austin in 2021, with Elon Musk calling it 'the biggest factory in the world.'",
	'Whole Foods, Dell, and Indeed are all headquartered in Austin.',
	'Austin has been ranked the #1 city for startups multiple years in a row.',
	'The city added over 180,000 tech jobs between 2015 and 2023.',
	'Oracle, Google, Apple, Meta, and Amazon all have major campuses in Austin.',
	"UT Austin's computer science program ranks among the top 10 in the nation.",
	"Austin's tech sector contributes over $50 billion annually to the local economy.",
	"The Domain, Austin's second downtown, has become a major tech hub with Apple's billion-dollar campus.",

	// Nature & Outdoors
	'Austin has over 300 days of sunshine per year.',
	'The city maintains over 300 parks and 50+ miles of hike and bike trails.',
	"Hamilton Pool, a natural swimming hole near Austin, was formed when an underground river's dome collapsed.",
	"Jacob's Well in Wimberley is one of Texas' longest underwater caves at 140+ feet deep.",
	'McKinney Falls State Park sits right inside Austin city limits.',
	'The Barton Creek Greenbelt has over 12 miles of trails and multiple swimming holes.',
	'Austin is built on the Balcones Fault, which creates the dramatic Hill Country terrain.',
	'Lady Bird Lake is actually a reservoir on the Colorado River, not a natural lake.',
	'The violet-crowned hummingbird was first documented in the U.S. in Austin.',
	"Austin's urban forest has over 30 million trees within city limits.",

	// History & Quirks
	'Austin was originally named Waterloo before being renamed after Stephen F. Austin in 1839.',
	'The city became the capital of the Republic of Texas in 1839, just three years after Texas independence.',
	"Austin's Moonlight Towers are the only remaining examples of this Victorian-era lighting technology in the world.",
	"Only 17 of the original 31 Moonlight Towers remain, and they're all listed on the National Register of Historic Places.",
	"The Moonlight Tower from the movie 'Dazed and Confused' still stands in Zilker Park.",
	'Austin was home to the first-ever registered historic district in Texas—Hyde Park in 1990.',
	'The O. Henry Museum is the former home of William Sydney Porter, who wrote his famous short stories here.',
	'Treaty Oak is an estimated 500-year-old tree that survived a poisoning attempt in 1989.',
	"The Texas Chili Parlor has been serving 'XXX' hot chili since 1976 and appeared in the Texas legislature's official history.",
	"Austin has no zoning laws, which is why you'll find a bar next to a house next to a taco truck.",

	// Sports & UT
	'The University of Texas Longhorns have won 4 national football championships.',
	"UT's mascot, Bevo, has been a live longhorn steer since 1916.",
	"Austin FC became the city's first major league sports team when it joined MLS in 2021.",
	"The Circuit of the Americas hosts Formula 1's U.S. Grand Prix every year.",
	"UT Austin's campus spans 431 acres and serves over 50,000 students.",
	"Hook 'em Horns, the UT hand sign, was invented in 1955 by head cheerleader Harley Clark.",
	'The Texas Longhorns have the most wins in college football history.',
	'COTA (Circuit of the Americas) is the only purpose-built F1 track in the United States.',
	'Austin Bold FC and Round Rock Express provide minor league sports action.',
	'UT has produced more NFL draft picks than any other school in Texas.',

	// Weird Austin
	'The Cathedral of Junk in South Austin is a 60-ton art installation made entirely of discarded items.',
	"Austin's Eeyore's Birthday Party has been held annually since 1963—it's the city's oldest tradition.",
	'The HOPE Outdoor Gallery (now closed) was a famous graffiti park that attracted artists worldwide.',
	'Uncommon Objects on South Congress has been selling oddities and antiques since 1991.',
	'Austin hosts the annual O. Henry Pun-Off World Championships.',
	"There's a museum dedicated to weird things called the Museum of the Weird on 6th Street.",
	'Peter Pan Mini-Golf has had 18 holes of quirky Austin fun since 1948.',
	"Austin's 'Hi, How Are You' frog mural by Daniel Johnston is a protected landmark.",
	"The city has an official 'Leslie Cochran Day' every March 8th.",
	"Hippie Hollow on Lake Travis is Texas' only legally clothing-optional public park.",

	// Modern Austin
	"Austin's population has more than doubled since 2000, from 656,000 to over 1 million.",
	'The city was named the #1 place to live in America by U.S. News & World Report multiple times.',
	'Austin-Bergstrom International Airport was converted from a military base in 1999.',
	'The Pennybacker Bridge (360 Bridge) is one of the most photographed spots in Texas.',
	'Rainey Street transformed from a residential neighborhood to a bar district around 2010.',
	'The East Austin arts district emerged from formerly industrial areas in the early 2000s.',
	'Austin has over 900 registered historic landmarks.',
	"The Congress Avenue 'Frost Bank Tower' is nicknamed 'the Owl Building' due to its distinctive top.",
	"Austin's Second Street District was created as a modern urban neighborhood in 2004.",
	'The Seaholm Power Plant was converted into a trendy mixed-use development in 2015.',

	// Local Favorites
	"Güero's Taco Bar on South Congress has been a celebrity hangout since Bill Clinton visited in 1999.",
	'BookPeople is the largest independent bookstore in Texas.',
	'The Alamo Drafthouse Cinema was founded in Austin in 1997 and pioneered dinner-and-a-movie.',
	"Jo's Coffee on South Congress is famous for the 'I Love You So Much' mural.",
	'Dirty Sixth refers to the rowdy bar scene on East 6th Street between Congress and I-35.',
	'West Sixth has a more upscale vibe with craft cocktail bars and rooftop lounges.',
	'South Congress (SoCo) transformed from seedy to trendy in the early 2000s.',
	'The Long Center for the Performing Arts opened in 2008 on the former Palmer Auditorium site.',
	"Waterloo Records has been Austin's favorite record store since 1982.",
	'Austin Java on Barton Springs has been a local coffee institution since 1995.',
];

let austinFactQueue: string[] = [];

/**
 * Get the next random Austin fact.
 * Uses a shuffled queue to avoid repetition until all facts are shown.
 */
export function getNextAustinFact(): string {
	if (austinFactQueue.length === 0) {
		austinFactQueue = shuffle(AUSTIN_FACTS);
	}
	return austinFactQueue.pop()!;
}

/**
 * Reset the fact queue (useful for testing)
 */
export function resetAustinFactQueue(): void {
	austinFactQueue = [];
}

/**
 * Parse a fact string and extract any markdown-style links.
 * Returns an array of segments that are either plain text or link objects.
 *
 * Example: "Check out [Google Maps](https://example.com) for more."
 * Returns: [
 *   { type: 'text', content: 'Check out ' },
 *   { type: 'link', text: 'Google Maps', url: 'https://example.com' },
 *   { type: 'text', content: ' for more.' }
 * ]
 */
export type FactSegment =
	| { type: 'text'; content: string }
	| { type: 'link'; text: string; url: string };

export function parseFactWithLinks(fact: string): FactSegment[] {
	const segments: FactSegment[] = [];
	const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

	let lastIndex = 0;
	let match;

	// Use RegExp.prototype.exec to find all matches
	while ((match = linkRegex.exec(fact)) !== null) {
		// Add text before the link
		if (match.index > lastIndex) {
			segments.push({
				type: 'text',
				content: fact.slice(lastIndex, match.index),
			});
		}

		// Add the link
		segments.push({
			type: 'link',
			text: match[1],
			url: match[2],
		});

		lastIndex = match.index + match[0].length;
	}

	// Add remaining text after last link
	if (lastIndex < fact.length) {
		segments.push({
			type: 'text',
			content: fact.slice(lastIndex),
		});
	}

	// If no segments were added (no links found), return the whole fact as text
	if (segments.length === 0) {
		segments.push({ type: 'text', content: fact });
	}

	return segments;
}

/**
 * Check if a fact contains any links
 */
export function factHasLinks(fact: string): boolean {
	return /\[([^\]]+)\]\(([^)]+)\)/.test(fact);
}

export { AUSTIN_FACTS };
