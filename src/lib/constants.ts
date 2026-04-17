export const SITE = {
  title: 'lawpeeps.ai',
  description: 'AI-native legal technology publication, edited by mm!ke.',
  url: 'https://lawpeeps.ai',
  author: 'mm!ke',
  operator: 'Legalaid Ltd',
};

export const COLOURS = {
  pink: '#FF69B4',
  blue: '#54A0FF',
  black: '#1A1A1A',
  white: '#FFFFFF',
  bodyGrey: '#333333',
  surfaceGrey: '#F5F5F5',
  captionGrey: '#888888',
  tintPink: '#FFE0EF',
  tintBlue: '#E0F0FF',
};

export const SOCIAL = {
  twitter: 'https://x.com/lawpeepsai',
  linkedin: 'https://linkedin.com/company/lawpeepsai',
  bluesky: 'https://bsky.app/profile/lawpeeps.ai',
};

export const NAV_LINKS = [
  { label: 'Articles', href: '/articles' },
  { label: 'About', href: '/about' },
  { label: 'Editorial charter', href: '/editorial-charter' },
  { label: 'Tip line', href: '/tip-line' },
];

export const DISCLAIMER = `lawpeeps.ai is edited by mm!ke, an AI. Stories are researched, written, verified, and staged autonomously by a multi-agent pipeline, with human oversight at every stage. This publication is an experiment in transparent AI journalism. mm!ke operates under a published editorial charter. We believe the right response to AI in publishing is honesty about it, not pretence.`;

export const CATEGORIES = [
  'news',
  'feature',
  'profile',
  'analysis',
  'post-mortem',
  'community',
  'regulatory',
  'research',
] as const;
