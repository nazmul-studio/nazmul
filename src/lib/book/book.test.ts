import { describe, expect, it } from 'vitest';
import { initialContent, type PortfolioContent } from '../content-model';
import { parseContent } from '../content-schema';
import { migrateAchievements, resolveBook, syncContactFields } from './migrate';
import { createImage, createText } from './model';
import { pageLinks } from './render';
import { parseBook } from './validate';

const legacy = (): PortfolioContent => {
  const c = JSON.parse(JSON.stringify(initialContent)) as PortfolioContent;
  c.achievements[0] = { tag: 'Award', title: 'First Prize', year: '2024', summary: 'Won it.', back: { tag: 'B', title: 'Back title', year: '2023', summary: 'Back text' } };
  c.github = 'https://github.com/nazmul';
  return c;
};
const textOf = (book: ReturnType<typeof migrateAchievements>, page: number, role: string) =>
  book.pages[page]!.elements.find((e) => e.role === role && e.type === 'text') as { text: string } | undefined;

describe('migrateAchievements', () => {
  it('turns 15 leaves into 30 pages plus a final contact page', () => {
    const book = migrateAchievements(legacy());
    expect(book.pages).toHaveLength(31);
    expect(book.pages.at(-1)!.kind).toBe('contact');
  });

  it('preserves tag, title, year and summary on front and back sides', () => {
    const book = migrateAchievements(legacy());
    expect(textOf(book, 0, 'title')!.text).toBe('First Prize');
    expect(textOf(book, 0, 'year')!.text).toBe('2024');
    expect(textOf(book, 0, 'tag')!.text).toBe('Award');
    expect(textOf(book, 1, 'title')!.text).toBe('Back title');
    expect(textOf(book, 1, 'summary')!.text).toBe('Back text');
  });

  it('links contact entries from existing fields', () => {
    const contact = migrateAchievements(legacy()).pages.at(-1)!;
    const gh = contact.elements.find((e) => e.role === 'contact.github');
    expect(gh && gh.type === 'text' && gh.href).toBe('https://github.com/nazmul');
    expect(contact.elements.some((e) => e.role === 'contact.facebook')).toBe(true);
  });

  it('migrated books pass validation without issues', () => {
    expect(parseBook(migrateAchievements(legacy())).issues).toEqual([]);
  });

  it('resolveBook prefers a stored book', () => {
    const c = legacy();
    c.book = { schemaVersion: 1, title: 'Mine', pages: [] };
    expect(resolveBook(c).title).toBe('Mine');
  });
});

describe('parseBook', () => {
  it('allows more than 15 pages', () => {
    const book = migrateAchievements(legacy());
    book.pages = [...book.pages, ...book.pages.map((p, i) => ({ ...p, id: `extra_${i}` }))];
    const r = parseBook(book);
    expect(r.issues).toEqual([]);
    expect(r.book.pages).toHaveLength(62);
  });

  it('rejects inline image data and unsafe links', () => {
    const book = migrateAchievements(legacy());
    book.pages[0]!.elements.push(createImage({ id: 'bad', src: { key: 'url:data:image/png;base64,AAAA' } }));
    book.pages[0]!.elements.push(createText({ id: 'js', href: 'javascript:alert(1)' }));
    const r = parseBook(book);
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['book.pages[0].elements[6].src.key', 'book.pages[0].elements[7].href']));
    expect(r.book.pages[0]!.elements.some((e) => e.id === 'bad')).toBe(false);
  });

  it('clamps opacity and scale', () => {
    const book = migrateAchievements(legacy());
    book.pages[0]!.elements[2]!.opacity = 5;
    book.pages[0]!.elements[2]!.scale = 999;
    const el = parseBook(book).book.pages[0]!.elements[2]!;
    expect(el.opacity).toBe(1);
    expect(el.scale).toBe(20);
  });

  it('content round-trips a stored book through parseContent', () => {
    const c = legacy();
    c.book = migrateAchievements(c);
    const r = parseContent(JSON.parse(JSON.stringify(c)));
    expect(r.issues).toEqual([]);
    expect(r.content.book).toEqual(c.book);
  });
});

describe('syncContactFields (Contact & links tab → stored book)', () => {
  const fields = { contactTitle: 'New title', contactText: 'New intro', email: 'me@example.com', github: 'https://github.com/a', linkedin: 'https://linkedin.com/in/a', facebook: 'https://facebook.com/a' };
  const contact = (book: ReturnType<typeof migrateAchievements>) => book.pages.at(-1)!;
  const el = (book: ReturnType<typeof migrateAchievements>, role: string) =>
    contact(book).elements.find((e) => e.role === role) as { text: string; href?: string };

  it('writes heading, intro, email and every link target into the contact page', () => {
    const book = syncContactFields(migrateAchievements(legacy()), fields);
    expect(el(book, 'title').text).toBe('New title');
    expect(el(book, 'text').text).toBe('New intro');
    expect(el(book, 'contact.email')).toEqual(expect.objectContaining({ text: 'me@example.com', href: 'mailto:me@example.com' }));
    expect(el(book, 'contact.github').href).toBe('https://github.com/a');
    expect(el(book, 'contact.linkedin').href).toBe('https://linkedin.com/in/a');
    expect(el(book, 'contact.facebook').href).toBe('https://facebook.com/a');
    expect(parseBook(book).issues).toEqual([]);
  });

  it('keeps a link label the editor customised, and removes the link when the field is cleared', () => {
    const start = migrateAchievements(legacy());
    (el(start, 'contact.github') as { text: string }).text = 'My code';
    const synced = syncContactFields(start, { ...fields, github: '' });
    expect(el(synced, 'contact.github').text).toBe('My code');
    expect(el(synced, 'contact.github').href).toBeUndefined();
    expect(el(syncContactFields(synced, { ...fields, email: '' }), 'contact.email').text).toBe('Email');
  });

  it('returns the very same book when nothing changed, and never touches non-contact pages or role-less elements', () => {
    const synced = syncContactFields(migrateAchievements(legacy()), fields);
    expect(syncContactFields(synced, fields)).toBe(synced);
    const base = migrateAchievements(legacy());
    const after = syncContactFields(base, fields);
    expect(after.pages[0]).toBe(base.pages[0]);
    const roleless = migrateAchievements(legacy());
    const stray = createText({ id: 'stray', text: 'my own note' });
    contact(roleless).elements.push(stray);
    expect(contact(syncContactFields(roleless, fields)).elements.at(-1)).toBe(stray);
  });

  it('migration itself links Facebook from the new field', () => {
    const c = legacy();
    c.facebook = 'https://facebook.com/nazmul';
    const fb = migrateAchievements(c).pages.at(-1)!.elements.find((e) => e.role === 'contact.facebook');
    expect(fb && fb.type === 'text' && fb.href).toBe('https://facebook.com/nazmul');
  });
});

describe('pageLinks', () => {
  it('lists visible linked text in paint order and ignores everything else', () => {
    const page = migrateAchievements(legacy()).pages[0]!;
    page.elements = [
      createText({ id: 'b', text: 'Second', href: 'https://b.test', zIndex: 5 }),
      createText({ id: 'a', text: 'First', href: 'https://a.test', zIndex: 1 }),
      createText({ id: 'hidden', text: 'Hidden', href: 'https://h.test', visible: false }),
      createText({ id: 'plain', text: 'No link' }),
      createText({ id: 'bare', text: '   ', href: 'mailto:me@example.com', zIndex: 9 }),
      createText({ id: 'evil', text: 'Click me', href: 'javascript:alert(1)', zIndex: 10 }),
    ];
    expect(pageLinks(page)).toEqual([
      { label: 'First', href: 'https://a.test' },
      { label: 'Second', href: 'https://b.test' },
      { label: 'mailto:me@example.com', href: 'mailto:me@example.com' },
    ]);
    expect(pageLinks(null)).toEqual([]);
  });
});

describe('image links', () => {
  it('accepts https image URLs and refuses plain http (mixed content on an https site)', () => {
    const book = migrateAchievements(legacy());
    book.pages[0]!.elements.push(createImage({ id: 'ok', src: { key: 'url:https://cdn.example/a.png' } }));
    book.pages[0]!.elements.push(createImage({ id: 'plain', src: { key: 'url:http://cdn.example/a.png' } }));
    const r = parseBook(book);
    expect(r.book.pages[0]!.elements.some((e) => e.id === 'ok')).toBe(true);
    expect(r.book.pages[0]!.elements.some((e) => e.id === 'plain')).toBe(false);
    expect(r.issues.some((i) => i.path.endsWith('.src.key'))).toBe(true);
  });
});

describe('uploaded image keys in a book', () => {
  it('keeps an element that points at an uploaded image and drops one with a malformed name', () => {
    const name = 'abcdef0123456789abcdef0123456789.webp';
    const book = migrateAchievements(legacy());
    book.pages[0]!.elements.push(createImage({ id: 'up', src: { key: `media:${name}` } }));
    book.pages[0]!.elements.push(createImage({ id: 'trav', src: { key: 'media:../../secret.png' } }));
    book.pages[0]!.elements.push(createImage({ id: 'svg', src: { key: 'media:abcdef0123456789abcdef0123456789.svg' } }));
    const r = parseBook(book);
    const ids = r.book.pages[0]!.elements.map((e) => e.id);
    expect(ids).toContain('up');
    expect(ids).not.toContain('trav');
    expect(ids).not.toContain('svg');
    expect(r.issues.filter((i) => i.path.endsWith('.src.key'))).toHaveLength(2);
  });
});

