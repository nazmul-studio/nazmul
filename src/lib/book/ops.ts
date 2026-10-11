// Operation-based editing. Every Book Editor change is an invertible Op; undo applies the
// inverse, redo re-applies. Ops carry before/after snapshots of only what they touch.

import type { Book, BookElement, BookPage } from './model';

export type Op =
  | { kind: 'element.update'; pageId: string; before: BookElement; after: BookElement; label: string }
  | { kind: 'element.insert'; pageId: string; index: number; element: BookElement; label: string }
  | { kind: 'element.remove'; pageId: string; index: number; element: BookElement; label: string }
  | { kind: 'page.update'; before: BookPage; after: BookPage; label: string }
  | { kind: 'page.insert'; index: number; page: BookPage; label: string }
  | { kind: 'page.remove'; index: number; page: BookPage; label: string }
  | { kind: 'page.move'; from: number; to: number; label: string }
  | { kind: 'batch'; ops: Op[]; label: string };

const mapPage = (book: Book, pageId: string, fn: (p: BookPage) => BookPage): Book => ({
  ...book,
  pages: book.pages.map((p) => (p.id === pageId ? fn(p) : p)),
});

export function applyOp(book: Book, op: Op): Book {
  switch (op.kind) {
    case 'element.update':
      return mapPage(book, op.pageId, (p) => ({ ...p, elements: p.elements.map((e) => (e.id === op.after.id ? op.after : e)) }));
    case 'element.insert':
      return mapPage(book, op.pageId, (p) => {
        const elements = [...p.elements];
        elements.splice(Math.min(op.index, elements.length), 0, op.element);
        return { ...p, elements };
      });
    case 'element.remove':
      return mapPage(book, op.pageId, (p) => ({ ...p, elements: p.elements.filter((e) => e.id !== op.element.id) }));
    case 'page.update':
      return { ...book, pages: book.pages.map((p) => (p.id === op.after.id ? op.after : p)) };
    case 'page.insert': {
      const pages = [...book.pages];
      pages.splice(Math.min(op.index, pages.length), 0, op.page);
      return { ...book, pages };
    }
    case 'page.remove':
      return { ...book, pages: book.pages.filter((p) => p.id !== op.page.id) };
    case 'page.move': {
      const pages = [...book.pages];
      const [moved] = pages.splice(op.from, 1);
      if (!moved) return book;
      pages.splice(op.to, 0, moved);
      return { ...book, pages };
    }
    case 'batch':
      return op.ops.reduce(applyOp, book);
  }
}

export function invertOp(op: Op): Op {
  switch (op.kind) {
    case 'element.update':
      return { ...op, before: op.after, after: op.before };
    case 'element.insert':
      return { ...op, kind: 'element.remove' };
    case 'element.remove':
      return { ...op, kind: 'element.insert' };
    case 'page.update':
      return { ...op, before: op.after, after: op.before };
    case 'page.insert':
      return { ...op, kind: 'page.remove' };
    case 'page.remove':
      return { ...op, kind: 'page.insert' };
    case 'page.move':
      return { ...op, from: op.to, to: op.from };
    case 'batch':
      return { ...op, ops: op.ops.map(invertOp).reverse() };
  }
}

export type History = { past: Op[]; future: Op[] };
export const MAX_HISTORY = 200;
export const emptyHistory = (): History => ({ past: [], future: [] });

export function record(h: History, op: Op): History {
  return { past: [...h.past, op].slice(-MAX_HISTORY), future: [] };
}
export function undo(book: Book, h: History): { book: Book; history: History } | null {
  const op = h.past.at(-1);
  if (!op) return null;
  return { book: applyOp(book, invertOp(op)), history: { past: h.past.slice(0, -1), future: [op, ...h.future] } };
}
export function redo(book: Book, h: History): { book: Book; history: History } | null {
  const op = h.future[0];
  if (!op) return null;
  return { book: applyOp(book, op), history: { past: [...h.past, op], future: h.future.slice(1) } };
}
