/**
 * fillerPhrases.ts
 *
 * Collection of filler phrases to display while waiting for AI responses
 * during the wizard conversation. Makes the experience feel more dynamic
 * and conversational.
 */

import { shuffle } from './shuffle';

const FILLER_PHRASES = [
	'Running the numbers...',
	'Interesting, give me a moment...',
	'Processing your thoughts...',
	'Let me consider this carefully...',
	'Analyzing your requirements...',
	'Thinking through the possibilities...',
	'Let me digest that...',
	'Mulling this over...',
	'Considering all angles...',
	'Let me work through this...',
	'Taking notes...',
	'Piecing things together...',
	'Connecting the dots...',
	'Let me map this out...',
	'Organizing my thoughts...',
	'Building a mental model...',
	'Processing...',
	'One moment while I think...',
	'Let me reflect on that...',
	'Diving deeper...',
	'Exploring the possibilities...',
	'Thinking...',
	'Working on it...',
	'Just a sec...',
	'Pondering your input...',
	'Crafting a response...',
	'Let me figure this out...',
	'Synthesizing information...',
	'Running through scenarios...',
	'Considering your approach...',
	'Let me wrap my head around this...',
	'Evaluating options...',
	'Formulating thoughts...',
	'Crunching the details...',
	'Putting pieces together...',
	'Weighing the considerations...',
	'Brainstorming...',
	'Let me parse that...',
	'Understanding your vision...',
	'Mapping out the landscape...',
	'Contemplating...',
	'Reasoning through this...',
	'Working through the logic...',
	'Let me sort this out...',
	'Examining the details...',
	'Processing your ideas...',
	'Forming a picture...',
	'Digesting your input...',
	'Let me chew on that...',
	'Considering the angles...',
	'Building understanding...',
	'Reflecting...',
	'Analyzing...',
	'Thinking it through...',
	'Pulling it together...',
	'Let me reason about this...',
	'Working out the details...',
	'Absorbing your thoughts...',
	'Contemplating the approach...',
	'Let me process this...',
	'Structuring my thoughts...',
	'Getting a clearer picture...',
	'Untangling the requirements...',
	'Sifting through ideas...',
	'Crystallizing thoughts...',
	'Laying out the groundwork...',
	'Charting the course...',
	'Sketching out ideas...',
	'Framing the problem...',
	'Distilling the essence...',
	'Wrapping my mind around it...',
	'Sorting through possibilities...',
	'Assembling the pieces...',
	'Calibrating my understanding...',
	'Tuning into your needs...',
	'Decoding your requirements...',
	'Unpacking that thought...',
	'Let me marinate on this...',
	'Steeping in the details...',
	'Letting that sink in...',
	'Percolating ideas...',
	'Brewing up a response...',
	'Churning through options...',
	'Spinning up thoughts...',
	'Revving the mental engines...',
	'Loading context...',
	'Querying my knowledge...',
	'Consulting my notes...',
	'Cross-referencing ideas...',
	'Triangulating possibilities...',
	'Zooming in on details...',
	'Zooming out for perspective...',
	'Balancing considerations...',
	'Fine-tuning my understanding...',
	'Sharpening the focus...',
	'Honing in on the key points...',
	'Drilling down...',
	'Surfacing insights...',
	'Excavating ideas...',
	'Mining for clarity...',
];

/**
 * Shuffled queue of filler phrases for the current session.
 * Once exhausted, it reshuffles automatically.
 */
let phraseQueue: string[] = [];

/**
 * Get the next filler phrase from the shuffled queue.
 * Automatically reshuffles when the queue is exhausted.
 */
export function getNextFillerPhrase(): string {
	if (phraseQueue.length === 0) {
		phraseQueue = shuffle(FILLER_PHRASES);
	}
	return phraseQueue.pop()!;
}

/**
 * Reset the phrase queue (e.g., when starting a new conversation)
 */
export function resetFillerPhrases(): void {
	phraseQueue = shuffle(FILLER_PHRASES);
}

/**
 * Get all filler phrases (for testing or display purposes)
 */
export function getAllFillerPhrases(): readonly string[] {
	return FILLER_PHRASES;
}

/**
 * Initial conversation starter questions - varied versions of asking
 * what the user wants to build. Randomly selected for each new conversation.
 */
const INITIAL_QUESTIONS = [
	'What would you like to build? A coding project? Research notes? Something else entirely?',
	'So, what are we building today? Code? Docs? Something wild?',
	'Tell me about your project. What are we making?',
	"What's on the agenda? A new app? Some research? I'm all ears.",
	"What kind of project are you envisioning? Let's hear it!",
	'What are we cooking up? A coding project? Documentation? Hit me.',
	"What's the vision? What would you like to create?",
	"I'm ready to help. What are we building together?",
	"What's the plan? New code? Research notes? Something creative?",
	"Tell me what you're working on. What should we build?",
	'What project can I help you bring to life?',
	"What are you looking to create? I'm curious!",
	'Give me the rundown. What are we making?',
	"What's your project idea? Code? Docs? I'm flexible.",
	"Let's get started! What would you like to build?",
	'What should we work on? A coding project? Notes? You name it.',
	"I'm here to help. What's the project?",
	'What are we tackling today? Tell me about your vision.',
	"What's brewing? A new codebase? Research? Let's dive in.",
	"What do you want to create? I'm ready when you are.",
	"So what's the mission? What are we building?",
	"Paint me a picture. What's this project about?",
	"What's the project you have in mind? Let's explore it.",
	'What are we putting together? Code? Content? Something new?',
	"I'm all ears. What would you like to build?",
	"What's on your mind? Tell me about the project.",
	'Ready to roll. What are we creating?',
	"What's the goal? What do you want to make?",
	"Alright, what's the project? I'm intrigued.",
	'What should we bring into existence today?',
	"What's the idea? A coding project? Research? Share away.",
	'Tell me your vision. What are we building?',
	"What's calling to you? What project should we tackle?",
	"I'm curious—what are we creating together?",
	"What project is on deck? Let's hear the details.",
	'What do you have in mind? Code? Documentation? Other?',
	"So, what's the project du jour? Tell me everything.",
	"What are we assembling? I'm ready to dive in.",
	"What's the creative endeavor? What should we build?",
	'Give me the scoop. What are we working on?',
	"What's your project vision? I want to hear it all.",
	'What shall we craft today? Code? Docs? Adventure?',
	"What's the plan, friend? What are we building?",
	'Tell me what excites you. What project are we starting?',
	"What do you want to bring to life? I'm here for it.",
	"What's your idea? I'm ready to help make it real.",
	'What kind of creation are we embarking on?',
	"So, what's the deal? What are we making?",
	"What project has been on your mind? Let's work on it.",
	"I'm primed and ready. What are we building?",
	'What are you itching to create? Tell me more.',
	"What's the next big thing we're working on?",
	'What project should we bring into the world?',
	"What's your creative spark today? What should we build?",
	'What are we dreaming up? Code? Research? Something fun?',
	'Hit me with the project idea. What are we making?',
	"What would you like to manifest? I'm here to help.",
	"What's your project pitch? I'm listening.",
	"So what's the grand plan? What are we building?",
	'What should we construct together?',
	"What's the project that's calling your name?",
	'Tell me about your idea. What are we creating?',
	"What are we engineering today? Let's hear it.",
	"What's the concept? A coding project? Something else?",
	'What masterpiece are we working on?',
	"Give me the details. What's the project?",
	"What's your brain cooking up? What should we build?",
	"What's in the pipeline? What are we creating?",
	'What project adventure awaits us?',
	'So tell me, what are we building from scratch?',
	"What's the project you've been thinking about?",
	"What should we develop together? I'm all in.",
	'What are we fabricating? Code? Content? You decide.',
	"What's your project idea? Don't hold back.",
	'What creation awaits? Tell me your vision.',
	'What are we conjuring up today?',
	"Let's build something. What did you have in mind?",
	"What's your project dream? Let's make it happen.",
	"What are we designing? I'm ready to help.",
	'What project should we breathe life into?',
	"What's the endeavor? What are we building?",
	'Tell me your project ambitions. What are we making?',
	"What's the big idea? What should we create?",
	'What shall we build from the ground up?',
	"What's brewing in your mind? What project awaits?",
	'What are we putting our energy into? Tell me.',
	'What project magic are we making today?',
	"What's your vision? What are we constructing?",
	"What should we piece together? I'm curious.",
	'What project journey are we embarking on?',
	"So, what's the project we're diving into?",
	'What are we going to build? The floor is yours.',
	'What creation should we focus on today?',
	"What's the initiative? What are we building?",
	"Tell me what you're passionate about building.",
	'What project is ready to come to life?',
	"What's your concept? Let's build it together.",
	"What are we architecting? I'm excited to hear.",
	"What's the project we're bringing into being?",
	'What should we make happen? Tell me your idea.',
];

/**
 * Shuffled queue of initial questions for the current session.
 */
let initialQuestionQueue: string[] = [];

/**
 * Get a random initial question from the shuffled queue.
 * Automatically reshuffles when the queue is exhausted.
 */
export function getRandomInitialQuestion(): string {
	if (initialQuestionQueue.length === 0) {
		initialQuestionQueue = shuffle(INITIAL_QUESTIONS);
	}
	return initialQuestionQueue.pop()!;
}

/**
 * Get all initial questions (for testing or display purposes)
 */
export function getAllInitialQuestions(): readonly string[] {
	return INITIAL_QUESTIONS;
}
