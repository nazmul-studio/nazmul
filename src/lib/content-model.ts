import type { Book } from './book/model';
export type PageSide = { tag: string; title: string; year: string; summary: string };
export type Achievement = PageSide & { back: PageSide };
export const blankPage = (): Achievement => ({tag:'',title:'',year:'',summary:'',back:{tag:'',title:'',year:'',summary:''}});
export function normalizePages(value: unknown): Achievement[] {
  const list=Array.isArray(value)?value:[];
  const side=(value: unknown): PageSide=>{const item=value&&typeof value==='object'?value as Record<string,unknown>:{};return {tag:typeof item['tag']==='string'?item['tag']:'',title:typeof item['title']==='string'?item['title']:'',year:typeof item['year']==='string'?item['year']:'',summary:typeof item['summary']==='string'?item['summary']:''};};
  return Array.from({length:15},(_,i)=>{const item=list[i];return {...side(item),back:side(item?.back)};});
}
export type Project = { title: string; category: string; description: string; url: string };
/** Public-site wording and SEO that used to be hard-coded in the components. Edited in the Studio. */
export type SiteText = {
  /** Exactly 5 names for the navigation / dock: Genesis, Origin, Artifacts, Grimoire, Transmission. */
  chapters: string[];
  /** Tags under the story section. */
  tech: string[];
  contactCta: string;
  viewProject: string;
  seoTitle: string;
  seoDescription: string;
  /** Image shown in link previews: an https link or an uploaded image ("media:<name>"). Empty = the built-in /og-image.jpg. */
  ogImage: string;
  /** Cover of the 3D book: an uploaded image ("media:<name>"). Empty = the built-in cover. */
  coverImage: string;
};
export type PortfolioContent = {
  name: string; wordmark: string; headline: string; introduction: string; aboutTitle: string; about: string;
  projectsTitle: string; bookTitle: string; bookDescription: string; contactTitle: string; contactText: string; email: string; github: string; linkedin: string; facebook: string;
  site: SiteText;
  achievements: Achievement[]; projects: Project[];
  /** Canonical visual book. Absent in legacy content: derived from `achievements` via resolveBook(). */
  book?: Book;
};
export const initialContent: PortfolioContent = {
  name: 'Mohammad Nazmul Hasan', wordmark: 'NAZMUL HASAN', headline: 'Architect of immersive web & engineered systems.',
  introduction: 'Where engineering meets imagination. A journey through the worlds I build and the ideas that shape them.',
  aboutTitle: 'Precision in thought.\nWonder in creation.', about: 'I’m Nazmul Hasan. I explore the space between thoughtful engineering and immersive digital experiences — building for the web with curiosity, intention, and a love for the details.',
  projectsTitle: 'Ideas, made tangible.', bookTitle: 'The Tome of Triumphs', bookDescription: 'A living chronicle of curiosity, craft, and the milestones along the way.',
  contactTitle: 'Every great creation\nbegins with a conversation.', contactText: 'Have a vision worth bringing to life? Let’s create something meaningful.', email: '', github: '', linkedin: '', facebook: '',
  site: {
    chapters: ['Genesis', 'Origin', 'Artifacts', 'Grimoire', 'Transmission'],
    tech: ['React', 'Three.js', 'TypeScript', 'Cloud Architecture'],
    contactCta: 'LET’S TALK', viewProject: 'View project',
    seoTitle: 'Nazmul Hasan — Engineering meets imagination',
    seoDescription: 'Step into the immersive portfolio of Mohammad Nazmul Hasan. Discover creative work, engineering, and a living book of milestones.',
    ogImage: '',
    coverImage: '',
  },
  achievements: Array.from({length:15},blankPage),
  projects: [
    {title:'Immersive experiences',category:'CREATIVE DEVELOPMENT',description:'A study in atmosphere, interaction, and the possibilities of the three-dimensional web.',url:''},
    {title:'Engineered systems',category:'WEB ENGINEERING',description:'Thoughtful interfaces built on a foundation of structured, scalable engineering.',url:''},
    {title:'Beyond the ordinary',category:'EXPERIMENTS & EXPLORATIONS',description:'An ongoing collection of ideas at the intersection of design and technology.',url:''},
  ],
};

/** Returns the link if it is an http(s) URL, otherwise an empty string. */
export function safeHref(value: string): string {
  const v = value.trim();
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : '';
  } catch {
    return '';
  }
}

/** One chapter name, falling back to the built-in default if the stored one is empty. */
export function chapterName(site: SiteText | undefined, index: number): string {
  return site?.chapters[index]?.trim() || initialContent.site.chapters[index] || '';
}

/** A copy of `list` with the item at `from` moved to `to`. Out-of-range indexes return an unchanged copy. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}
