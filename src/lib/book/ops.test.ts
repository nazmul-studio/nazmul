import { describe, expect, it } from 'vitest';
import { initialContent } from '../content-model';
import { migrateAchievements } from './migrate';
import { createPage, type TextElement } from './model';
import { applyOp, emptyHistory, record, redo, undo, type Op } from './ops';

const book = () => migrateAchievements(initialContent);

describe('operation history', () => {
  it('undo restores the exact previous element and redo re-applies it', () => {
    const b0 = book();
    const page = b0.pages[0]!;
    const before = page.elements.find((e) => e.role === 'title') as TextElement;
    const after: TextElement = { ...before, text: 'Moved', x: 10, rotation: 15 };
    const op: Op = { kind: 'element.update', pageId: page.id, before, after, label: 'edit' };
    const b1 = applyOp(b0, op);
    const h = record(emptyHistory(), op);
    const u = undo(b1, h)!;
    expect(u.book).toEqual(b0);
    expect(redo(u.book, u.history)!.book).toEqual(b1);
  });

  it('page insert, move and remove are reversible beyond 15 leaves', () => {
    let b = book();
    let h = emptyHistory();
    const start = b;
    for (let i = 0; i < 5; i++) {
      const op: Op = { kind: 'page.insert', index: b.pages.length, page: createPage({ id: `extra_${i}` }), label: 'add' };
      b = applyOp(b, op); h = record(h, op);
    }
    const move: Op = { kind: 'page.move', from: 0, to: b.pages.length - 1, label: 'move' };
    b = applyOp(b, move); h = record(h, move);
    expect(b.pages).toHaveLength(36);
    expect(b.pages.at(-1)!.id).toBe('page_1_front');
    while (h.past.length) { const r = undo(b, h)!; b = r.book; h = r.history; }
    expect(b).toEqual(start);
  });

  it('removing an element and undoing puts it back at the same index', () => {
    const b0 = book();
    const page = b0.pages[2]!;
    const element = page.elements[3]!;
    const op: Op = { kind: 'element.remove', pageId: page.id, index: 3, element, label: 'del' };
    const r = undo(applyOp(b0, op), record(emptyHistory(), op))!;
    expect(r.book).toEqual(b0);
  });
});
