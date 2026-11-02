// quotes.js — shared built-in motivational quotes (feature #15).
//
// Loaded as a classic script in both options.html and blocked.html before
// their consumer scripts. Defines a page-global BUILTIN_MOTIVATION_QUOTES so
// the options page can pre-fill the quotes box and blocked.js can fall back to
// the same list when the user's custom list is empty. Also exposed on window
// for defensive access.
const BUILTIN_MOTIVATION_QUOTES = [
    'Stay focused. Every blocked visit is a small win.',
    'Your future self will thank you.',
    'Discipline is choosing between what you want now and what you want most.',
    'Small steps every day add up to big results.',
    'The distraction will still be there later. Your focus won’t.',
    'You don’t have to be extreme, just consistent.',
    'Focus is a muscle. Every time you resist, it grows stronger.',
    'The best time to start was yesterday. The next best time is now.',
    'Done is better than perfect. Start now.',
    'Motivation gets you started. Habit keeps you going.',
    'What you do today can improve all your tomorrows.',
    'A little progress each day adds up to big results.',
    'Don’t watch the clock; do what it does. Keep going.',
    'The secret of getting ahead is getting started.',
    'You are what you repeatedly do. Excellence is a habit.',
    'The pain of discipline weighs ounces; the pain of regret weighs tons.',
    'Success is the sum of small efforts repeated day in and day out.',
    'Great things never came from comfort zones.',
    'Every minute you stay focused is a minute invested in who you’re becoming.',
    'The only way to do great work is to not get distracted from it.',
    'Direction is so much more important than speed.',
    'Fall in love with the process and the results will come.',
    'You will never always be motivated. Learn to be disciplined.',
    'One day or day one. You decide.',
    'Starve your distractions, feed your focus.',
    'The future depends on what you do today.',
    'Work hard in silence; let your success be your noise.',
    'Energy and persistence conquer all things.',
    'Little by little, one travels far.',
    'The expert in anything was once a beginner.',
    'Don’t count the days; make the days count.',
    'Your only limit is the amount of focus you’re willing to give.',
    'Deep work is the superpower of the 21st century.',
    'Protect your attention. It is the most valuable thing you own.',
    'Progress, not perfection.',
    'The things you do today are the stories you tell tomorrow.',
    'Stay patient and trust your journey.',
    'A goal without focus is just a wish.',
    'What consumes your attention consumes your life.',
    'Choose the discomfort of discipline over the discomfort of regret.',
    'Quitting the distraction is a victory in itself.',
    'Every no to distraction is a yes to your goals.',
    'Hard choices, easy life. Easy choices, hard life.',
    'The reward for focus is more of what matters.',
    'You can do anything, but not everything. Focus.',
    'Make each day your masterpiece.',
    'The distance between dreams and reality is called action.',
    'Be stronger than your strongest excuse.',
    'Keep going. Everything you need will come to you at the perfect time.',
    'This moment of focus is a gift to the person you’re becoming.'
];

// eslint-disable-next-line no-unused-vars
if (typeof window !== 'undefined') window.BUILTIN_MOTIVATION_QUOTES = BUILTIN_MOTIVATION_QUOTES;
