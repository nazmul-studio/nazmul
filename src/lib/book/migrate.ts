// Backward-compatible adapter: legacy achievements (leaves with front/back sides) → Book.
// Reproduces the tome's original canvas layout (768×1024) as positioned elements so the
// visual result is unchanged. Ids are deterministic so repeated migrations are stable.

import type { Achievement, PageSide, PortfolioContent } from '../content-model';
import {
  BOOK_SCHEMA_VERSION,
  createPage,
  createShape,
  createText,
  PAPER,
  type Book,
  type BookPage,
  type TextElement,
} from './model';

const W = 768;

/** One legacy side → one free-form page, mirroring tome-scene.js pageTexture(). */
export function pageFromSide(side: PageSide, id: string): BookPage {
  const el = (role: string) => `${id}_${role}`;
  return createPage({
    id,
    kind: 'content',
    background: { ...PAPER },
    elements: [
      createShape({ id: el('frame-outer'), role: 'frame', x: 40, y: 40, width: 688, height: 944, stroke: '#9d894e', strokeWidth: 3, zIndex: 0, locked: true }),
      createShape({ id: el('frame-inner'), role: 'frame', x: 52, y: 52, width: 664, height: 920, stroke: '#9d894e', strokeWidth: 3, zIndex: 1, locked: true }),
      // Legacy text used canvas baselines; box top = baseline − (0.8·fontSize + (lineHeight−fontSize)/2),
      // matching the renderer's first-line baseline so text lands on the same pixels.
      createText({ id: el('tag'), role: 'tag', text: side.tag, x: (W - 590) / 2, y: 120.2, width: 590, height: 34, zIndex: 10,
        style: { fontFamily: 'Onest, sans-serif', fontSize: 26, color: '#33484b', align: 'center', lineHeight: 34 } }),
      createText({ id: el('title'), role: 'title', text: side.title, x: (W - 570) / 2, y: 257, width: 570, height: 210, zIndex: 10,
        style: { fontFamily: 'Cinzel, serif', fontSize: 60, fontWeight: 700, color: '#172b34', align: 'center', lineHeight: 70 } }),
      createText({ id: el('year'), role: 'year', text: side.year, x: (W - 580) / 2, y: 519.4, width: 580, height: 42, zIndex: 10,
        style: { fontFamily: 'Cinzel, serif', fontSize: 32, color: '#665020', align: 'center', lineHeight: 42 } }),
      createText({ id: el('summary'), role: 'summary', text: side.summary, x: (W - 580) / 2, y: 604.4, width: 580, height: 330, zIndex: 10,
        style: { fontFamily: 'Onest, sans-serif', fontSize: 32, color: '#293e41', align: 'center', lineHeight: 42 } }),
    ],
  });
}

/** Contact page built from the existing email/GitHub/LinkedIn fields, plus a Facebook slot. */
export function contactPage(content: Pick<PortfolioContent, 'contactTitle' | 'contactText' | 'email' | 'github' | 'linkedin'> & { facebook?: string }): BookPage {
  const id = 'page_contact';
  const link = (role: string, label: string, href: string, y: number) =>
    createText({ id: `${id}_${role}`, role: `contact.${role}`, text: label, ...(href ? { href } : {}), x: 114, y, width: 540, height: 44, zIndex: 10,
      style: { fontFamily: 'Onest, sans-serif', fontSize: 30, color: '#172b34', align: 'center', lineHeight: 40 } });
  return createPage({
    id,
    kind: 'contact',
    background: { ...PAPER },
    elements: [
      createShape({ id: `${id}_frame-outer`, role: 'frame', x: 40, y: 40, width: 688, height: 944, zIndex: 0, locked: true }),
      createShape({ id: `${id}_frame-inner`, role: 'frame', x: 52, y: 52, width: 664, height: 920, zIndex: 1, locked: true }),
      createText({ id: `${id}_title`, role: 'title', text: content.contactTitle, x: 89, y: 150, width: 590, height: 160, zIndex: 10,
        style: { fontFamily: 'Cinzel, serif', fontSize: 48, fontWeight: 700, color: '#172b34', align: 'center', lineHeight: 58 } }),
      createText({ id: `${id}_text`, role: 'text', text: content.contactText, x: 94, y: 340, width: 580, height: 130, zIndex: 10,
        style: { fontFamily: 'Onest, sans-serif', fontSize: 28, color: '#293e41', align: 'center', lineHeight: 38 } }),
      createShape({ id: `${id}_rule`, role: 'divider', shape: 'line', x: 234, y: 500, width: 300, height: 0, stroke: '#9d894e', strokeWidth: 2, zIndex: 5 }),
      link('email', content.email || 'Email', content.email ? `mailto:${content.email}` : '', 540),
      link('github', 'GitHub', content.github, 610),
      link('linkedin', 'LinkedIn', content.linkedin, 680),
      link('facebook', 'Facebook', content.facebook ?? '', 750),
    ],
  });
}

/** Legacy leaves → ordered pages (leaf i → pages 2i front, 2i+1 back) + final contact page. */
export function migrateAchievements(content: PortfolioContent): Book {
  const pages: BookPage[] = [];
  content.achievements.forEach((leaf: Achievement, i) => {
    const { back, ...front } = leaf;
    pages.push(pageFromSide(front, `page_${i + 1}_front`));
    pages.push(pageFromSide(back, `page_${i + 1}_back`));
  });
  pages.push(contactPage(content));
  return { schemaVersion: BOOK_SCHEMA_VERSION, title: content.bookTitle, pages };
}

/** The canonical book for any content: the stored book if present, otherwise migrated. */
export function resolveBook(content: PortfolioContent): Book {
  return content.book ?? migrateAchievements(content);
}

// ---------- Contact & links tab → stored book ----------
//
// Before the first book edit the contact page is derived live from the contact fields. Once a book is
// stored it is its own source of truth, so without this the "Contact & links" tab would silently stop
// affecting it. The tab stays authoritative for exactly these things, matched by element `role`:
//   title / text           → the heading and intro text
//   contact.email          → label (the address) and mailto: target
//   contact.github|linkedin|facebook → link target only (the label stays whatever the editor typed)
// Elements the editor renamed or deleted (role gone) are left alone.

export type ContactFields = Pick<PortfolioContent, 'contactTitle' | 'contactText' | 'email' | 'github' | 'linkedin'> & { facebook?: string };
export const CONTACT_KEYS = ['contactTitle', 'contactText', 'email', 'github', 'linkedin', 'facebook'] as const;

function withLink(el: TextElement, href: string, label?: string): TextElement {
  const { href: _old, ...rest } = el;
  return { ...rest, ...(label !== undefined ? { text: label } : {}), ...(href ? { href } : {}) };
}

export function syncContactFields(book: Book, fields: ContactFields): Book {
  let touched = false;
  const pages = book.pages.map((page) => {
    if (page.kind !== 'contact') return page;
    let pageTouched = false;
    const elements = page.elements.map((el) => {
      if (el.type !== 'text' || !el.role) return el;
      let next: TextElement;
      switch (el.role) {
        case 'title': next = { ...el, text: fields.contactTitle }; break;
        case 'text': next = { ...el, text: fields.contactText }; break;
        case 'contact.email': next = withLink(el, fields.email ? `mailto:${fields.email}` : '', fields.email || 'Email'); break;
        case 'contact.github': next = withLink(el, fields.github); break;
        case 'contact.linkedin': next = withLink(el, fields.linkedin); break;
        case 'contact.facebook': next = withLink(el, fields.facebook ?? ''); break;
        default: return el;
      }
      if (next.text === el.text && next.href === el.href) return el;
      pageTouched = true;
      return next;
    });
    if (!pageTouched) return page;
    touched = true;
    return { ...page, elements };
  });
  return touched ? { ...book, pages } : book;
}
