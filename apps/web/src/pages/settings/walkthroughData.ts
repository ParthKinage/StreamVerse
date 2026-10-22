/** Where the walkthrough remembers the step a viewer left from, so the "Back to walkthrough" button can return there. */
export const WALKTHROUGH_KEY = 'streamverse.walkthrough';

export function rememberStep(step: number): void {
  try {
    sessionStorage.setItem(WALKTHROUGH_KEY, String(step));
  } catch {
    // private mode or storage blocked: the return button just won't show
  }
}

export function rememberedStep(): number | null {
  try {
    const raw = sessionStorage.getItem(WALKTHROUGH_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function forgetStep(): void {
  try {
    sessionStorage.removeItem(WALKTHROUGH_KEY);
  } catch {
    // nothing to forget
  }
}

export interface MoneyWords {
  /** The button that adds money: "Add money", "Buy coins" or "Top up". */
  addMoney: string;
  /** What the balance is called. */
  balance: string;
}

export interface Chapter {
  id: string;
  title: string;
  /** One or two sentences: what this part of the app is for. */
  intro: string;
  /** The key things to know, short and practical. */
  points: string[];
  /** Pages to open from this step. */
  links: Array<{ to: string; label: string }>;
  adminOnly?: boolean;
}

/** The chapters of the walkthrough, in the order a new viewer meets the app. */
export function chapters(m: MoneyWords): Chapter[] {
  return [
    {
      id: 'welcome',
      title: 'Welcome to StreamVerse',
      intro: 'StreamVerse is a video and live-streaming site where you pay only for what you actually watch. Payments are made in StreamCoin (STRM) and recorded on a blockchain, so every payment can be checked.',
      points: [
        'Use the dock on the left (at the bottom on a phone) to move around. Point at an icon to see its name.',
        'The search box at the top finds videos, channels and live streams.',
        'The sun and moon button switches between the dark and light themes.',
        'This walkthrough is always here, in Settings → Walkthrough.',
      ],
      links: [{ to: '/', label: 'Open Home' }],
    },
    {
      id: 'discover',
      title: 'Find something to watch',
      intro: 'Home shows a featured video, streams that are live now, recommendations, trending videos and categories.',
      points: [
        'Browse has three tabs: Videos, Channels and Live now.',
        'Filter videos by price (free, paid, or ones you own), by length, by category, and sort by newest, most viewed or trending.',
        'Every card shows the price: a rate per minute for videos, or one price for a live stream.',
      ],
      links: [
        { to: '/', label: 'Open Home' },
        { to: '/search', label: 'Open Browse' },
      ],
    },
    {
      id: 'watch',
      title: 'Watching and paying by the second',
      intro: 'Videos have a rate per minute set by their creator. You are charged only for the seconds the player actually loads for you.',
      points: [
        'Video arrives in 4-second pieces. Each piece is charged once; watching it again is free, for ever.',
        'Skipped parts are never loaded, so they cost nothing.',
        'The player keeps about 10 seconds ready ahead, so stopping early can cost those few extra seconds.',
        'The meter on the player shows time watched, the rate and what this session has cost.',
        `Starting a paid video needs about a minute of balance. If you run low, use ${m.addMoney}.`,
      ],
      links: [{ to: '/', label: 'Pick a video' }],
    },
    {
      id: 'live',
      title: 'Live streams',
      intro: 'Creators stream live from their browser. A stream has one price: pay once and you can watch the stream and its recording as often as you like.',
      points: [
        'Live streams appear under Live now on Home and in Browse.',
        'Press Get access to pay once; free streams need nothing.',
        'Chat with the creator and other viewers next to the player.',
        'Send a tip (10, 50, 100 or any amount) to support the creator. It shows highlighted in the chat.',
        'Viewers are about 10 to 20 seconds behind the creator.',
      ],
      links: [{ to: '/search?view=live', label: 'See who is live' }],
    },
    {
      id: 'wallet',
      title: 'Your wallet and StreamCoin',
      intro: `Your ${m.balance} pays for everything you watch. New accounts get a welcome bonus.`,
      points: [
        `${m.addMoney} adds to your balance.`,
        'Every account gets a built-in wallet automatically; there is nothing to install and no crypto knowledge needed.',
        'The platform pays all blockchain fees for you.',
        'The transactions list shows every purchase, bonus and payment, with a link to the blockchain explorer when it has been recorded on chain.',
      ],
      links: [{ to: '/wallet', label: 'Open Wallet' }],
    },
    {
      id: 'library',
      title: 'Your library, history and channels',
      intro: 'StreamVerse remembers what you watch, so you can pick up where you left off.',
      points: [
        'Continue watching on Home resumes videos where you stopped.',
        'Library has two tabs: Saved (videos you added to your watchlist) and Owned (videos you bought or fully paid for, free to watch again).',
        'History lists everything you watched and what it cost.',
        'Follow a channel to see its new videos and live streams under Following.',
      ],
      links: [
        { to: '/watchlist', label: 'Open Library' },
        { to: '/history', label: 'Open History' },
        { to: '/following', label: 'Open Following' },
      ],
    },
    {
      id: 'studio',
      title: 'Creating: your channel and Studio',
      intro: 'Anyone can publish. Studio is where you upload, price and manage your videos and see what you earn.',
      points: [
        'Create your channel once, then upload a video with a title, category, tags and a rate per minute (0 makes it free).',
        'After upload the video is processed; press Publish when it is ready.',
        'You can add a custom thumbnail.',
        'Analytics shows views and watch time; Earnings shows what viewers paid you after the platform fee, and lets you pay it out.',
      ],
      links: [{ to: '/studio', label: 'Open Studio' }],
    },
    {
      id: 'go-live',
      title: 'Going live',
      intro: 'Stream straight from your browser in Studio → Go live; no extra software is needed.',
      points: [
        'Set a title and a price to watch (pay once), and choose whether to keep the recording as a video.',
        'Stream your camera, a screen or window, or your screen with your camera in the corner.',
        'Using OBS: start its Virtual Camera and pick it as your camera.',
        'You can switch tabs or use other apps while live; keep the StreamVerse page open until you press End stream.',
        'Moderate your chat by removing messages, and watch viewers, sales and tips as they happen.',
      ],
      links: [{ to: '/studio?tab=live', label: 'Open Go live' }],
    },
    {
      id: 'safety',
      title: 'Safety and reports',
      intro: 'If something breaks the rules, report it and our team will review it.',
      points: [
        'Use Report on a video, a chat message or a channel, and choose a reason.',
        'Moderators can hide videos, remove messages and suspend accounts.',
      ],
      links: [],
    },
    {
      id: 'account',
      title: 'Your account',
      intro: 'Settings is where you change your username and password, and where this walkthrough lives.',
      points: ['Change your username or password under Account.', 'Log out with the button at the top right.'],
      links: [{ to: '/settings', label: 'Open Account settings' }],
    },
    {
      id: 'admin',
      title: 'For admins',
      intro: 'The Admin area keeps the platform healthy.',
      points: [
        'Reports: an overview and a queue of reported items with actions (hide, delete, suspend, dismiss).',
        'Revenue, settlements and health show what the platform earns, payments in flight, and whether every service is up.',
        'Videos and Users let you hide videos and suspend or restore accounts.',
      ],
      links: [{ to: '/admin', label: 'Open Admin' }],
      adminOnly: true,
    },
  ];
}
