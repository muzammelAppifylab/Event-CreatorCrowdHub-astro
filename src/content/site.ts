/**
 * The site's own words: navigation, home and about copy.
 *
 * Edit freely. The site's NAME and LOGO are not here: they come from the
 * platform (`GET /site-api/site`), so a rename in the dashboard shows
 * up without a Publish. Use `{name}` in any string below for the site name.
 * Real product claims only: no invented reviews, customers or numbers.
 */

/** Search and social basics. The NAME comes from the platform (above). */
export const SITE = {
  /** One sentence: the meta description of pages that have none of their own. Use `{name}`. */
  description:
    '{name} is the event platform for creators: branded event pages, email invites, RSVPs with a waitlist, reminders and live polls behind one link.',
  /** `en`, `fr`, … : the page language (screen readers, search engines). */
  lang: 'en',
  /**
   * The address search engines should treat as THE address (canonical URLs,
   * sitemap, social cards): set it to the custom domain once the owner has one
   * (`https://www.example.com`, no trailing slash). Empty = the address
   * The platform gives the site (`SITE_URL`, src/lib/seo.ts).
   */
  url: '',
};

export interface NavItem {
  label: string;
  href: string;
  /**
   * `false` for a page rendered on every visit (SSR, like `/events/`): it is
   * private (`no-store`), so fetching it ahead would be wasted. Every other
   * item is prerendered and prefetched as soon as the nav is on screen.
   */
  prefetch?: false;
}

/**
 * Top navigation. Every href is a page of THIS site (`/`, `/blog/`, `/events/`,
 * `/about/`, `/dashboard`, `/account/…`): plain links.
 */
export const NAV: NavItem[] = [
  {label: 'Home', href: '/'},
  {label: 'Events', href: '/events/', prefetch: false},
  {label: 'Blog', href: '/blog/'},
  {label: 'About', href: '/about/'},
];

/** The home page, top to bottom (`src/pages/index.astro`). Each block is one section. */
export const HOME = {
  hero: {
    eyebrow: '{name} for creators',
    /** The headline. `highlight` is the part of it shown with a marker behind it (or '' for none). */
    title: 'Events your people actually show up to',
    highlight: 'actually show up',
    body: 'Branded event pages, email invites, RSVPs and live polls behind one link. Guests reply in under 30 seconds, with no account.',
    note: 'Your guests stay in your own contacts list.',
    /** Three short benefits under the lede, shown as chips. */
    points: ['Branded event pages', 'Invites, RSVPs and a waitlist', 'Reminders and live polls'],
    /** The label above the search box (attendees). */
    searchLabel: 'Looking for an event to attend?',
    /** Guests: create an account, or jump down the page. */
    guest: {primary: 'Create an account', secondary: 'See how it works'},
    /** Signed-in visitors. */
    user: {primary: 'Open your dashboard', secondary: 'Browse events'},
  },
  /** The dashboard picture next to the headline: an illustrative example, hidden from screen readers. */
  visual: {
    nav: ['Events', 'Invites', 'Guests', 'Polls', 'Settings'],
    title: 'Example event',
    stats: [
      {label: 'Going', value: '42', trend: 'Example data'},
      {label: 'Maybe', value: '9', trend: 'Example data'},
      {label: 'Waitlist', value: '4', trend: 'Example data'},
    ],
    chart: 'RSVPs over time',
    /** The two cards floating over the picture (illustrative, like the rest of it). */
    floats: [
      {icon: 'user', title: 'New RSVP', text: 'Sam is going, plus one'},
      {icon: 'bell', title: 'Reminder sent', text: '24 hours before, with a calendar file'},
    ],
    rows: [
      {name: 'Invite sent', status: 'Done', tone: 'success'},
      {name: 'Reminder, 24 hours before', status: 'Scheduled', tone: 'info'},
      {name: 'Live poll', status: 'Draft', tone: 'warning'},
    ],
  },
  /** The search box under the headline and its quick filters (links into `/events/`). */
  search: {
    placeholder: 'Search events by name',
    quick: [
      {label: 'All events', href: '/events/'},
      {label: 'This week', href: '/events/?when=week'},
      {label: 'Online', href: '/events/?format=online'},
      {label: 'In person', href: '/events/?format=in_person'},
    ],
  },
  features: {
    eyebrow: 'What you get',
    title: 'Everything for one event, in one place',
    body: 'RSVPs, reminders and polls live behind one link, so there is no second tool to run.',
    /** `icon`: one of the names in `src/components/home/Icon.astro`. */
    items: [
      {icon: 'calendar', title: 'Branded event pages', body: 'Each event gets its own page with your details and one clear RSVP button.'},
      {icon: 'mail', title: 'Email invites', body: 'Invite people by email and see who has replied.'},
      {icon: 'user', title: 'Smart RSVPs', body: "Going, maybe or can't go, with custom questions, plus-ones, approval and a waitlist when you are full."},
      {icon: 'bell', title: 'Automatic reminders', body: 'Reminders go out before the event, with a calendar file guests can add in one tap.'},
      {icon: 'chart', title: 'Live polls', body: 'Ask the room a question and show the results on screen in a presenter view.'},
      {icon: 'shield', title: 'Your guests, your data', body: 'Every guest lands in your own contacts list with their marketing consent. Export a CSV any time.'},
    ],
  },
  how: {
    eyebrow: 'How it works',
    title: 'From idea to full room in three steps',
    steps: [
      {title: 'Create the event', body: 'Add the date, the place or link, a cover and your RSVP rules.'},
      {title: 'Send the invites', body: 'Share the link or email your list. Guests reply on their phone, no account needed.'},
      {title: 'Run it', body: 'Check guests in at the door, open a poll when you are ready, and follow up afterwards.'},
    ],
  },
  /** The next public events, loaded in the browser (the home page is static). */
  events: {title: 'Upcoming events', link: 'Browse all events'},
  blog: {title: 'Latest from the blog', link: 'All posts'},
  audience: {
    eyebrow: 'Who it is for',
    title: 'Come to an event, or host your own',
    cards: [
      {title: 'I want to attend', body: 'Browse what is coming up, RSVP on your phone and get a reminder with a calendar file. No account needed.', href: '/events/', cta: 'Browse events'},
      {title: 'I want to host', body: 'Create a branded event page, send invites, run a waitlist and a live poll, and keep your guest list.', href: '/account/register/', cta: 'Create an account'},
      {title: 'I want to learn more', body: 'Read how creators run better events, or find out who is behind {name}.', href: '/about/', cta: 'About us'},
    ],
  },
  faq: {
    eyebrow: 'Questions',
    title: 'Questions, answered',
    items: [
      {
        q: 'Do my guests need an account?',
        a: 'No. A guest opens the invite link, replies on one screen and, if you ask, answers your questions.',
      },
      {
        q: 'What happens when an event is full?',
        a: 'If you turn the waitlist on, guests can join it and are emailed when a seat opens up. Without a waitlist the page says the event is full.',
      },
      {
        q: 'Who owns the guest list?',
        a: 'You do. Guests are saved to your own contacts list with their marketing consent, and you can export them as a CSV.',
      },
      {
        q: 'Can I run polls during the event?',
        a: 'Yes. Open a poll when you are ready, guests vote in two taps, and the results show on screen in the presenter view.',
      },
    ],
  },
  cta: {
    title: 'Ready to host your next event on {name}?',
    body: 'Create your account, set up an event and send your first invites.',
    primary: 'Create an account',
    secondary: 'Sign in',
  },
};

export const ABOUT = {
  title: 'About {name}',
  lede: 'An event platform for creators: invites, RSVPs, reminders and live polls behind one link.',
  /** The strip under the hero: facts from how the product works, no invented numbers. */
  stats: [
    {value: '30s', label: 'for a guest to reply'},
    {value: '0', label: 'accounts guests need'},
    {value: '1', label: 'link per event'},
    {value: 'CSV', label: 'export, any time'},
  ],
  /** Three principles, shown as cards (`icon`: a name in `src/components/home/Icon.astro`). */
  values: {
    eyebrow: 'What we care about',
    title: 'Built around three promises',
    items: [
      {icon: 'user', title: 'Guests first', body: 'No sign-up wall, no app to install. A guest opens the link and replies on their phone.'},
      {icon: 'shield', title: 'Your data, your list', body: 'Every guest lands in your own contacts with their consent. You decide where it goes.'},
      {icon: 'bell', title: 'Nothing falls through', body: 'Reminders, a waitlist and check-in are built in, so a full room stays full.'},
    ],
  },
  cta: {title: 'Ready to host your next event?', body: 'Create your account and send your first invites today.', primary: 'Create an account', secondary: 'Browse events'},
  sections: [
    {
      heading: 'What it is',
      body: '{name} is for coaches, community owners and course creators who run free webinars, paid workshops and meetups. It puts the event page, the invite, the RSVP, the reminders and the live poll in one tool.',
    },
    {
      heading: 'How it treats guests',
      body: 'A guest never needs an account. They open the invite on their phone, reply in under 30 seconds and vote in a poll in two taps.',
    },
    {
      heading: 'How it treats creators',
      body: 'The page carries your brand, not ours. Every guest lands in your own contacts list with their marketing consent, and leaves only through your webhooks or a CSV export you control.',
    },
    {
      heading: 'How to take part',
      body: 'Browse the upcoming events and RSVP, or create an account to host your own.',
    },
  ],
};

/** The brand panel beside the sign-in and sign-up forms (`src/components/AuthShell.astro`). */
export const AUTH = {
  login: {
    eyebrow: '{name} for creators',
    title: 'Welcome back. Your next full room is waiting.',
    points: ['See who has replied to your invites', 'Run check-in and live polls from your phone', 'Your guest list stays yours'],
  },
  register: {
    eyebrow: 'Host on {name}',
    title: 'Set up your first event in minutes.',
    points: ['A branded event page with one clear RSVP button', 'Email invites, reminders and a waitlist built in', 'Guests reply in under 30 seconds, with no account'],
  },
};

/** Fill `{name}` with the site's name. */
export function withName(text: string, name: string): string {
  return text.replaceAll('{name}', name);
}
