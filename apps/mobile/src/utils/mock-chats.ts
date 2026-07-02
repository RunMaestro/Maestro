export type MockChat = {
	id: string;
	title: string;
	daysAgo: number;
	starred: boolean;
};

export const MOCK_CHATS: MockChat[] = [
	{ id: '1', title: 'Expo Job offer', daysAgo: 5, starred: false },
	{
		id: '2',
		title: 'Existing tools for iOS app tech stack detection',
		daysAgo: 5,
		starred: false,
	},
	{
		id: '3',
		title: 'Headless iOS simulator gateway for concurrent testing',
		daysAgo: 7,
		starred: false,
	},
	{ id: '4', title: 'Top three.js projects', daysAgo: 7, starred: true },
	{ id: '5', title: 'Austin magician review', daysAgo: 7, starred: false },
	{
		id: '6',
		title: 'Expo agent GitHub bot description',
		daysAgo: 14,
		starred: false,
	},
	{
		id: '7',
		title: 'Building an iMessage bot with Claude',
		daysAgo: 14,
		starred: true,
	},
	{
		id: '8',
		title: 'Conditional HMR disabling in web frameworks',
		daysAgo: 14,
		starred: false,
	},
	{
		id: '10',
		title: 'Optimizing parallel git config queries',
		daysAgo: 14,
		starred: false,
	},
	{
		id: '11',
		title: 'Choosing between Tailwind and StyleX',
		daysAgo: 21,
		starred: false,
	},
	{
		id: '12',
		title: 'Structuring messages and timelines',
		daysAgo: 28,
		starred: false,
	},
	{
		id: '13',
		title: 'SVG morphing animation between shapes',
		daysAgo: 28,
		starred: false,
	},
	{
		id: '14',
		title: 'Expo navigation patterns',
		daysAgo: 30,
		starred: false,
	},
	{
		id: '15',
		title: 'Debugging Expo CLI',
		daysAgo: 35,
		starred: false,
	},
];
