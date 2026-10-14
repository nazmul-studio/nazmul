// Studio Book Editor: direct manipulation on top of the canonical renderer. The page pixels
// come from paintPage(); this file only adds selection, handles, guides and inspectors.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent as RPointerEvent, type SetStateAction } from 'react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDown, ArrowUp, BringToFront, Circle, Copy, Eye, EyeOff, Image as ImageIcon,
  Link2, Lock, Maximize, Minus, Plus, Redo2, SendToBack, Square, Trash2, Type, Undo2, Unlock, ZoomIn, ZoomOut, ChevronUp, ChevronDown, Squircle, Scan,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  createImage, createPage, createShape, createText, newId, paintOrder,
  type Book, type BookElement, type BookPage, type ImageElement, type ShapeElement, type ShapeKind, type TextElement, type TextStyle,
} from '@/lib/book/model';
import { applyOp, record, redo as redoOp, undo as undoOp, type History, type Op } from '@/lib/book/ops';
import { safeLink } from '@/lib/book/validate';
import { getUploadStore, urlRef } from '@/lib/book/image-store';
import { ACCEPT_ATTR, MAX_UPLOAD_BYTES, isAcceptedMime } from '@/lib/media';
import { describeUploadError } from '@/lib/studio-client';
import { fontString } from '@/lib/book/render';
import { PageCanvas } from './page-canvas';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
const FONTS = ['Onest, sans-serif', 'Cinzel, serif', 'Georgia, serif', 'Helvetica, Arial, sans-serif', '"Courier New", monospace'];
const SNAP = 6;

type Drag =
  | { mode: 'move'; id: string; start: { x: number; y: number }; before: BookElement }
  | { mode: 'resize'; id: string; sx: -1 | 1; sy: -1 | 1; start: { x: number; y: number }; before: BookElement }
  | { mode: 'rotate'; id: string; before: BookElement }
  | { mode: 'pan'; start: { x: number; y: number }; pan0: { x: number; y: number } };

type Guide = { axis: 'x' | 'y'; at: number };

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function duplicatePage(page: BookPage): BookPage {
  const copy = clone(page);
  return { ...copy, id: newId('pg'), elements: copy.elements.map((e) => ({ ...e, id: newId(e.type.slice(0, 3)) })) };
}

/** Image links must be https (plain http is blocked as mixed content on an https site). Returns '' when not acceptable. */
const httpsUrl = (v: string): string => {
  const url = safeLink(v);
  return /^https:\/\//i.test(url) ? url : '';
};

/**
 * The undo history is owned by the Studio (passed in), not by this component: switching to another Studio tab
 * unmounts the editor, and the history must survive that. The Studio clears it when it replaces the whole book.
 */
export function BookEditor({ book, onChange, saveState, onPreview, history, onHistory: setHistory, onNotify }: { book: Book; onChange: (book: Book) => void; saveState: SaveState; onPreview: () => void; history: History; onHistory: Dispatch<SetStateAction<History>>; onNotify?: (notice: { kind: 'ok' | 'warn' | 'error'; text: string }) => void }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.6);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [guides, setGuides] = useState<Guide[]>([]);
  const [snapOn, setSnapOn] = useState(true);
  const [imageUrl, setImageUrl] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number; mid: { x: number; y: number }; pan: { x: number; y: number } } | null>(null);
  const bookRef = useRef(book); bookRef.current = book;
  const lastOpAt = useRef(0);

  const page = book.pages[Math.min(pageIndex, book.pages.length - 1)] ?? null;
  const selected = page?.elements.find((e) => e.id === selectedId) ?? null;
  useEffect(() => { if (pageIndex > book.pages.length - 1) setPageIndex(Math.max(0, book.pages.length - 1)); }, [book.pages.length, pageIndex]);

  // ---------- commits ----------
  const commit = useCallback((op: Op, mergeable = false) => {
    const now = Date.now();
    setHistory((h) => {
      const last = h.past.at(-1);
      if (mergeable && last && last.kind === 'element.update' && op.kind === 'element.update' && last.after.id === op.after.id && last.label === op.label && now - lastOpAt.current < 800) {
        return { past: [...h.past.slice(0, -1), { ...last, after: op.after }], future: [] };
      }
      return record(h, op);
    });
    lastOpAt.current = now;
    onChange(applyOp(bookRef.current, op));
  }, [onChange]);
  /** Apply without history (live drag frames). */
  const live = useCallback((pageId: string, el: BookElement) => {
    const b = bookRef.current;
    const prev = b.pages.find((p) => p.id === pageId)?.elements.find((e) => e.id === el.id);
    if (prev) onChange(applyOp(b, { kind: 'element.update', pageId, before: prev, after: el, label: 'live' }));
  }, [onChange]);
  const updateSelected = useCallback((patch: Partial<BookElement> | ((e: BookElement) => BookElement), label: string) => {
    if (!page || !selected) return;
    const after = typeof patch === 'function' ? patch(selected) : ({ ...selected, ...patch } as BookElement);
    commit({ kind: 'element.update', pageId: page.id, before: selected, after, label }, true);
  }, [page, selected, commit]);
  const updateStyle = (patch: Partial<TextStyle>, label: string) => updateSelected((e) => (e.type === 'text' ? { ...e, style: { ...e.style, ...patch } } : e), label);

  const doUndo = useCallback(() => { const r = undoOp(bookRef.current, history); if (r) { setHistory(r.history); onChange(r.book); } }, [history, onChange]);
  const doRedo = useCallback(() => { const r = redoOp(bookRef.current, history); if (r) { setHistory(r.history); onChange(r.book); } }, [history, onChange]);

  // ---------- element actions ----------
  function addElement(el: BookElement) {
    if (!page) return;
    const top = page.elements.reduce((m, e) => Math.max(m, e.zIndex), 0);
    const placed = { ...el, x: (page.size.width - el.width) / 2, y: (page.size.height - el.height) / 2, zIndex: top + 1 } as BookElement;
    commit({ kind: 'element.insert', pageId: page.id, index: page.elements.length, element: placed, label: `Add ${el.type}` });
    setSelectedId(placed.id);
  }
  const addText = (link = false) => addElement(createText({ text: link ? 'New link' : 'Double-click to edit', width: 420, height: 50, ...(link ? { href: 'https://' } : {}), style: { align: 'center', ...(link ? { color: '#172b34' } : {}) } }));
  const addShape = (shape: ShapeKind) => addElement(createShape({ shape, width: shape === 'line' ? 300 : 220, height: shape === 'line' ? 0 : 160, ...(shape === 'line' ? {} : { fill: 'rgba(157,137,78,0.15)' }), cornerRadius: shape === 'rounded-rectangle' ? 24 : 0 }));
  function addImage() {
    const url = httpsUrl(imageUrl);
    if (!url) return;
    addElement(createImage({ src: urlRef(url) }));
    setImageUrl('');
  }
  /** Local file → the media store (Cloudflare R2, through the admin API). The server checks the bytes again. */
  const [uploadMsg, setUploadMsg] = useState('');
  async function uploadFile(file: File, replaceId?: string) {
    setUploadMsg('');
    if (!isAcceptedMime(file.type)) { setUploadMsg('Please choose a JPEG, PNG, WebP or GIF image.'); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setUploadMsg(`Image is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.`); return; }
    const store = getUploadStore();
    if (!store?.put) { setUploadMsg('Image upload is not available here. Paste an https image link instead.'); return; }
    try {
      setUploadMsg('Uploading…');
      const { ref, warning } = await store.put(file, { filename: file.name, contentType: file.type });
      // Not in R2, but stored and about to be placed on the page: keep saying so beside the toolbar and in the Studio.
      setUploadMsg(warning ?? '');
      if (warning) onNotify?.({ kind: 'warn', text: warning });
      const pg = page; if (!pg) return;
      const target = replaceId ? pg.elements.find((e) => e.id === replaceId) : null;
      if (target && target.type === 'image') commit({ kind: 'element.update', pageId: pg.id, before: target, after: { ...target, src: ref }, label: 'Replace image' });
      else addElement(createImage({ src: ref }));
    } catch (err) { setUploadMsg(describeUploadError(err)); }
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | undefined>(undefined);
  const pickFile = (replaceId?: string) => { replaceTarget.current = replaceId; fileInput.current?.click(); };
  function replaceImageUrl(id: string, raw: string) {
    const url = httpsUrl(raw);
    const el = page?.elements.find((e) => e.id === id);
    if (!page || !url || !el || el.type !== 'image') return;
    commit({ kind: 'element.update', pageId: page.id, before: el, after: { ...el, src: { ...urlRef(url), ...(el.src.alt !== undefined ? { alt: el.src.alt } : {}) } }, label: 'Replace image' });
  }
  const [dragPage, setDragPage] = useState<number | null>(null);
  function dropPage(to: number) {
    if (dragPage === null || dragPage === to) { setDragPage(null); return; }
    commit({ kind: 'page.move', from: dragPage, to, label: 'Move page' });
    setPageIndex(to); setDragPage(null);
  }
  function setBackground(patch: Partial<BookPage['background']>) {
    if (!page) return;
    commit({ kind: 'page.update', before: page, after: { ...page, background: { ...page.background, ...patch } }, label: 'Page background' });
  }
  function removeSelected() {
    if (!page || !selected || selected.locked) return; // unlock first: a locked element must not vanish by a stray Delete key
    commit({ kind: 'element.remove', pageId: page.id, index: page.elements.indexOf(selected), element: selected, label: 'Delete' });
    setSelectedId(null);
  }
  function duplicateSelected() {
    if (!page || !selected) return;
    const copy = { ...clone(selected), id: newId(selected.type.slice(0, 3)), x: selected.x + 20, y: selected.y + 20, zIndex: selected.zIndex + 1, locked: false } as BookElement;
    commit({ kind: 'element.insert', pageId: page.id, index: page.elements.length, element: copy, label: 'Duplicate' });
    setSelectedId(copy.id);
  }
  function layer(dir: 'front' | 'back' | 'up' | 'down') {
    if (!page || !selected) return;
    const sorted = paintOrder(page.elements);
    const zs = sorted.map((e) => e.zIndex);
    const i = sorted.findIndex((e) => e.id === selected.id);
    let z = selected.zIndex;
    if (dir === 'front') z = Math.max(...zs) + 1;
    else if (dir === 'back') z = Math.min(...zs) - 1;
    else if (dir === 'up') { const next = sorted[i + 1]; if (!next) return; z = next.zIndex + 1; }
    else { const prev = sorted[i - 1]; if (!prev) return; z = prev.zIndex - 1; }
    updateSelected({ zIndex: z }, 'Layer');
  }

  // ---------- page actions ----------
  function addPage() {
    const p = createPage();
    commit({ kind: 'page.insert', index: pageIndex + 1, page: p, label: 'Add page' });
    setPageIndex(pageIndex + 1); setSelectedId(null);
  }
  function dupPage() {
    if (!page) return;
    commit({ kind: 'page.insert', index: pageIndex + 1, page: duplicatePage(page), label: 'Duplicate page' });
    setPageIndex(pageIndex + 1); setSelectedId(null);
  }
  function deletePage() {
    if (!page || book.pages.length <= 1) return;
    if (!window.confirm(`Delete page ${pageIndex + 1}${page.kind === 'contact' ? ' (contact page)' : ''}? You can undo this.`)) return;
    commit({ kind: 'page.remove', index: pageIndex, page, label: 'Delete page' });
    setSelectedId(null);
  }
  function movePage(dir: -1 | 1) {
    const to = pageIndex + dir;
    if (to < 0 || to >= book.pages.length) return;
    commit({ kind: 'page.move', from: pageIndex, to, label: 'Move page' });
    setPageIndex(to);
  }

  // ---------- view ----------
  const fit = useCallback(() => {
    const vp = viewport.current;
    if (!vp || !page) return;
    const z = Math.min((vp.clientWidth - 60) / page.size.width, (vp.clientHeight - 60) / page.size.height);
    setZoom(z);
    setPan({ x: (vp.clientWidth - page.size.width * z) / 2, y: (vp.clientHeight - page.size.height * z) / 2 });
  }, [page?.size.width, page?.size.height]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { fit(); }, [fit]);
  function zoomAt(next: number, cx?: number, cy?: number) {
    const vp = viewport.current; if (!vp) return;
    const z = Math.min(4, Math.max(0.15, next));
    const px = cx ?? vp.clientWidth / 2, py = cy ?? vp.clientHeight / 2;
    setPan((p) => ({ x: px - ((px - p.x) / zoom) * z, y: py - ((py - p.y) / zoom) * z }));
    setZoom(z);
  }
  useEffect(() => {
    const vp = viewport.current; if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(zoom * Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
      else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }); // re-bind each render so the closure sees the current zoom

  // ---------- pointer helpers ----------
  const toPage = (clientX: number, clientY: number) => {
    const r = stage.current?.getBoundingClientRect();
    return r ? { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom } : { x: 0, y: 0 };
  };
  function begin(e: RPointerEvent, d: Drag) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = d;
  }
  function snapMove(el: BookElement, x: number, y: number): { x: number; y: number; guides: Guide[] } {
    if (!page || !snapOn) return { x, y, guides: [] };
    const w = el.width * el.scale, h = el.height * el.scale;
    const offX = (el.width - w) / 2, offY = (el.height - h) / 2;
    const xs = [0, page.size.width / 2, page.size.width], ys = [0, page.size.height / 2, page.size.height];
    for (const o of page.elements) if (o.id !== el.id && o.visible) { xs.push(o.x, o.x + o.width / 2, o.x + o.width); ys.push(o.y, o.y + o.height / 2, o.y + o.height); }
    const t = SNAP / zoom, out: Guide[] = [];
    let bx = x, by = y;
    const tryAxis = (pos: number, size: number, off: number, targets: number[], axis: 'x' | 'y') => {
      for (const edge of [0, size / 2, size]) {
        for (const tg of targets) if (Math.abs(pos + off + edge - tg) < t) { out.push({ axis, at: tg }); return tg - edge - off; }
      }
      return pos;
    };
    bx = tryAxis(x, w, offX, xs, 'x');
    by = tryAxis(y, h, offY, ys, 'y');
    return { x: bx, y: by, guides: out };
  }
  function onMove(e: RPointerEvent) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const vr = viewport.current!.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - vr.left, y: (a.y + b.y) / 2 - vr.top };
      const p0 = pinch.current;
      const z = Math.min(4, Math.max(0.15, p0.zoom * (dist / p0.dist)));
      setZoom(z);
      setPan({ x: mid.x - ((p0.mid.x - p0.pan.x) / p0.zoom) * z, y: mid.y - ((p0.mid.y - p0.pan.y) / p0.zoom) * z });
      return;
    }
    const d = drag.current; if (!d || !page) return;
    if (d.mode === 'pan') { setPan({ x: d.pan0.x + e.clientX - d.start.x, y: d.pan0.y + e.clientY - d.start.y }); return; }
    const pt = toPage(e.clientX, e.clientY);
    const b = d.before;
    if (d.mode === 'move') {
      let x = b.x + pt.x - d.start.x, y = b.y + pt.y - d.start.y;
      const s = snapMove(b, x, y); x = s.x; y = s.y; setGuides(s.guides);
      // Keep at least the element's center on the page so nothing gets lost off-canvas.
      x = Math.min(page.size.width - b.width / 2, Math.max(-b.width / 2, x));
      y = Math.min(page.size.height - b.height / 2, Math.max(-b.height / 2, y));
      live(page.id, { ...b, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 } as BookElement);
    } else if (d.mode === 'resize') {
      const th = (b.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
      const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
      const lx = (dx * cos + dy * sin) / b.scale, ly = (-dx * sin + dy * cos) / b.scale;
      let w = Math.max(8, b.width + d.sx * lx), h = b.type === 'shape' && b.shape === 'line' ? 0 : Math.max(8, b.height + d.sy * ly);
      if (e.shiftKey && b.type === 'image' && b.height > 0) { const r = b.width / b.height; if (w / r > h) h = w / r; else w = h * r; }
      const cxl = (d.sx * (w - b.width) * b.scale) / 2, cyl = (d.sy * (h - b.height) * b.scale) / 2;
      const cx = b.x + b.width / 2 + cxl * cos - cyl * sin, cy = b.y + b.height / 2 + cxl * sin + cyl * cos;
      live(page.id, { ...b, width: Math.round(w), height: Math.round(h), x: Math.round(cx - w / 2), y: Math.round(cy - h / 2) } as BookElement);
    } else if (d.mode === 'rotate') {
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      let deg = (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI + 90;
      if (deg > 180) deg -= 360;
      deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.abs(deg) < 3 ? 0 : Math.round(deg);
      live(page.id, { ...b, rotation: deg } as BookElement);
    }
  }
  function onUp(e: RPointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current; drag.current = null; setGuides([]);
    if (!d || d.mode === 'pan' || !page) return;
    const after = bookRef.current.pages.find((p) => p.id === page.id)?.elements.find((x) => x.id === d.id);
    if (after && JSON.stringify(after) !== JSON.stringify(d.before)) {
      setHistory((h) => record(h, { kind: 'element.update', pageId: page.id, before: d.before, after, label: d.mode }));
    }
  }
  function onViewportDown(e: RPointerEvent) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const vr = viewport.current!.getBoundingClientRect();
      if (a && b) pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom, mid: { x: (a.x + b.x) / 2 - vr.left, y: (a.y + b.y) / 2 - vr.top }, pan };
      drag.current = null;
      return;
    }
    setSelectedId(null); setEditingId(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode: 'pan', start: { x: e.clientX, y: e.clientY }, pan0: pan };
  }
  function onElementDown(e: RPointerEvent, el: BookElement) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) { onViewportDown(e); return; }
    if (editingId === el.id) { e.stopPropagation(); return; }
    setSelectedId(el.id); setEditingId(null);
    if (el.locked) { e.stopPropagation(); return; }
    begin(e, { mode: 'move', id: el.id, start: toPage(e.clientX, e.clientY), before: el });
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); doRedo(); return; }
      if (typing) return;
      if (e.key === 'Escape') { setSelectedId(null); setEditingId(null); return; }
      if (!selected || !page) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
      if (e.key === 'Enter' && selected.type === 'text') { e.preventDefault(); setEditingId(selected.id); return; }
      const step = e.shiftKey ? 10 : 1;
      const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const n = nudge[e.key];
      if (n && !selected.locked) { e.preventDefault(); updateSelected({ x: selected.x + n[0], y: selected.y + n[1] }, 'Nudge'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pixelRatio = useMemo(() => Math.min(3, Math.max(0.5, zoom * (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))), [zoom]);
  const ordered = page ? paintOrder(page.elements).filter((e) => e.visible) : [];
  const saveLabel = { idle: 'All changes kept', saving: 'Saving draft…', saved: 'Draft saved', error: 'Draft could not be saved' }[saveState];

  return <div className="book-editor">
    <div className="be-toolbar" role="toolbar" aria-label="Book editor tools">
      <div className="be-group">
        <Button variant="ghost" size="icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!history.past.length} onClick={doUndo}><Undo2/></Button>
        <Button variant="ghost" size="icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!history.future.length} onClick={doRedo}><Redo2/></Button>
      </div>
      <div className="be-group">
        <Button variant="ghost" size="sm" onClick={() => addText()}><Type/>Text</Button>
        <Button variant="ghost" size="sm" onClick={() => addText(true)}><Link2/>Link</Button>
        <Button variant="ghost" size="icon" title="Rectangle" aria-label="Add rectangle" onClick={() => addShape('rectangle')}><Square/></Button>
        <Button variant="ghost" size="icon" title="Rounded rectangle" aria-label="Add rounded rectangle" onClick={() => addShape('rounded-rectangle')}><Squircle/></Button>
        <Button variant="ghost" size="icon" title="Ellipse" aria-label="Add ellipse" onClick={() => addShape('ellipse')}><Circle/></Button>
        <Button variant="ghost" size="icon" title="Line" aria-label="Add line" onClick={() => addShape('line')}><Minus/></Button>
        <form className="be-image-add" onSubmit={(e) => { e.preventDefault(); addImage(); }}>
          <input aria-label="Image link" placeholder="https://… image link" value={imageUrl} aria-invalid={imageUrl.trim() !== '' && !httpsUrl(imageUrl)} onChange={(e) => setImageUrl(e.target.value)} />
          <Button variant="ghost" size="sm" type="submit" disabled={!httpsUrl(imageUrl)}><ImageIcon/>Image</Button>
        </form>
        <Button variant="ghost" size="sm" title="Upload an image from this device" onClick={() => pickFile()}><ImageIcon/>Upload</Button>
        <input ref={fileInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadFile(f, replaceTarget.current); }} />
        {uploadMsg && <span className="be-hint" role="status">{uploadMsg}</span>}
      </div>
      <div className="be-group">
        <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => zoomAt(zoom / 1.2)}><ZoomOut/></Button>
        <button type="button" className="be-zoom" title="Reset to 100%" onClick={() => zoomAt(1)}>{Math.round(zoom * 100)}%</button>
        <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => zoomAt(zoom * 1.2)}><ZoomIn/></Button>
        <Button variant="ghost" size="icon" title="Fit page" aria-label="Fit page" onClick={fit}><Maximize/></Button>
        <Button variant="ghost" size="icon" title={snapOn ? 'Snapping on' : 'Snapping off'} aria-label="Toggle snapping" aria-pressed={snapOn} className={snapOn ? 'on' : ''} onClick={() => setSnapOn(!snapOn)}><Scan/></Button>
      </div>
      <div className="be-group be-status"><span className={`be-save ${saveState}`} role="status">{saveLabel}</span><Button variant="outline" size="sm" onClick={onPreview}><Eye/>Preview</Button></div>
    </div>

    <div className="be-body">
      <aside className="be-pages" aria-label="Pages">
        <div className="be-pages-head"><span>{book.pages.length} PAGES</span>
          <div><Button variant="ghost" size="icon" title="Add page after this one" aria-label="Add page" onClick={addPage}><Plus/></Button>
            <Button variant="ghost" size="icon" title="Duplicate page" aria-label="Duplicate page" onClick={dupPage}><Copy/></Button>
            <Button variant="ghost" size="icon" title="Move page up" aria-label="Move page up" disabled={pageIndex === 0} onClick={() => movePage(-1)}><ChevronUp/></Button>
            <Button variant="ghost" size="icon" title="Move page down" aria-label="Move page down" disabled={pageIndex >= book.pages.length - 1} onClick={() => movePage(1)}><ChevronDown/></Button>
            <Button variant="ghost" size="icon" title="Delete page" aria-label="Delete page" disabled={book.pages.length <= 1} onClick={deletePage}><Trash2/></Button></div>
        </div>
        <div className="be-thumbs">
          {book.pages.map((p, i) => <button type="button" key={p.id} className={i === pageIndex ? 'be-thumb active' : 'be-thumb'} draggable
            onDragStart={(e) => { setDragPage(i); e.dataTransfer.effectAllowed = 'move'; }} onDragOver={(e) => { if (dragPage !== null) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); dropPage(i); }} onDragEnd={() => setDragPage(null)}
            onClick={() => { setPageIndex(i); setSelectedId(null); setEditingId(null); }} aria-label={`Page ${i + 1}`}>
            <PageCanvas page={p} pixelRatio={0.18} className="be-thumb-canvas" />
            <span>{i + 1}{p.kind === 'contact' ? ' · Contact' : ` · Leaf ${Math.floor(i / 2) + 1} ${i % 2 ? 'back' : 'front'}`}</span>
          </button>)}
        </div>
      </aside>

      <div className="be-viewport" ref={viewport} onPointerDown={onViewportDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {page && <div className="be-stage" ref={stage} style={{ width: page.size.width, height: page.size.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <PageCanvas page={page} pixelRatio={pixelRatio} skip={editingId} className="be-page-canvas" />
          {ordered.map((el) => <div key={el.id}
            className={`be-box${el.id === selectedId ? ' selected' : ''}${el.locked ? ' locked' : ''}`}
            style={{ left: el.x, top: el.y, width: el.width, height: Math.max(el.height, 6), transform: `rotate(${el.rotation}deg) scale(${el.scale})`, ['--z' as string]: zoom }}
            onPointerDown={(e) => onElementDown(e, el)}
            onDoubleClick={(e) => { e.stopPropagation(); if (el.type === 'text') { setSelectedId(el.id); setEditingId(el.id); } }}
            title={el.locked ? 'Locked — unlock in the panel to move' : undefined}>
            {editingId === el.id && el.type === 'text' && <InlineText el={el} onDone={(text) => { setEditingId(null); if (text !== el.text) commit({ kind: 'element.update', pageId: page.id, before: el, after: { ...el, text }, label: 'Edit text' }); }} />}
            {el.id === selectedId && !el.locked && editingId !== el.id && <>
              {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sy]) => <span key={`${sx}${sy}`} className="be-handle" style={{ left: sx < 0 ? 0 : '100%', top: sy < 0 ? 0 : '100%' }}
                onPointerDown={(e) => begin(e, { mode: 'resize', id: el.id, sx, sy, start: toPage(e.clientX, e.clientY), before: el })} aria-hidden="true" />)}
              <span className="be-rotate" onPointerDown={(e) => begin(e, { mode: 'rotate', id: el.id, before: el })} aria-hidden="true" />
            </>}
          </div>)}
          {guides.map((g, i) => <div key={i} className={`be-guide ${g.axis}`} style={g.axis === 'x' ? { left: g.at } : { top: g.at }} />)}
        </div>}
      </div>

      <aside className="be-inspector" aria-label="Element settings">
        {selected && page ? <Inspector el={selected} update={updateSelected} updateStyle={updateStyle} onLayer={layer} onDelete={removeSelected} onDuplicate={duplicateSelected} onEdit={() => setEditingId(selected.id)} onReplaceFile={() => pickFile(selected.id)} onReplaceUrl={(u) => replaceImageUrl(selected.id, u)} />
          : <p className="be-hint">Click anything on the page to select it. Double-click text to type. Drag to move, use the corner handles to resize and the top dot to rotate. Drag empty space to pan; pinch or Ctrl+scroll to zoom. Upload a JPEG, PNG, WebP or GIF (up to 8 MB), or paste an https link: for a link, the image's host must allow other sites to load it (CORS), otherwise the page shows a grey box.</p>}
        {!selected && page && <div className="be-inspect"><div className="be-label">PAGE BACKGROUND</div>
          <Color label="Color" value={page.background.color} onChange={(v) => setBackground({ color: v })} />
          <label className="be-field"><span>Texture</span><select value={page.background.texture} onChange={(e) => setBackground({ texture: e.target.value as BookPage['background']['texture'] })}><option value="paper-grain">Paper grain</option><option value="none">None</option></select></label>
        </div>}
        {page && <div className="be-layers"><div className="be-label">LAYERS (TOP FIRST)</div>
          {[...paintOrder(page.elements)].reverse().map((el) => <button type="button" key={el.id} className={el.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(el.id)}>
            <span>{el.type === 'text' ? (el.text.slice(0, 26) || 'Empty text') : el.type === 'image' ? 'Image' : el.shape}</span>{!el.visible && <EyeOff size={12}/>}{el.locked && <Lock size={12}/>}
          </button>)}
        </div>}
      </aside>
    </div>
  </div>;
}

function InlineText({ el, onDone }: { el: TextElement; onDone: (text: string) => void }) {
  const [value, setValue] = useState(el.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const s = el.style;
  return <textarea ref={ref} className="be-inline" value={value} maxLength={5000}
    onChange={(e) => setValue(e.target.value)} onBlur={() => onDone(value)} onPointerDown={(e) => e.stopPropagation()}
    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(value); } e.stopPropagation(); }}
    style={{ font: fontString(s), color: s.color, textAlign: s.align, lineHeight: `${s.lineHeight}px`, letterSpacing: `${s.letterSpacing}px`, textTransform: s.textTransform, padding: 0 }}
    aria-label="Edit text" />;
}

function Num({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <label className="be-field"><span>{label}</span><input type="number" value={Math.round(value * 100) / 100} min={min} max={max} step={step} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }} /></label>;
}
function Range({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <label className="be-field be-range"><span>{label}</span><input type="range" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}
function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return <label className="be-field be-color"><span>{label}</span><input type="color" value={hex} onChange={(e) => onChange(e.target.value)} /></label>;
}

function Inspector({ el, update, updateStyle, onLayer, onDelete, onDuplicate, onEdit, onReplaceFile, onReplaceUrl }: {
  el: BookElement;
  update: (patch: Partial<BookElement> | ((e: BookElement) => BookElement), label: string) => void;
  updateStyle: (patch: Partial<TextStyle>, label: string) => void;
  onLayer: (d: 'front' | 'back' | 'up' | 'down') => void; onDelete: () => void; onDuplicate: () => void; onEdit: () => void;
  onReplaceFile: () => void; onReplaceUrl: (url: string) => void;
}) {
  const [newSrc, setNewSrc] = useState('');
  const [href, setHref] = useState(el.type === 'text' ? el.href ?? '' : '');
  useEffect(() => { setHref(el.type === 'text' ? el.href ?? '' : ''); }, [el.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const img = (patch: Partial<ImageElement>, label: string) => update((e) => (e.type === 'image' ? { ...e, ...patch } : e), label);
  const shp = (patch: Partial<ShapeElement>, label: string) => update((e) => (e.type === 'shape' ? { ...e, ...patch } : e), label);
  return <div className="be-inspect">
    <div className="be-label">{el.type === 'shape' ? el.shape.toUpperCase() : el.type.toUpperCase()}{el.role ? ` · ${el.role}` : ''}</div>
    <div className="be-row">
      <Button variant="ghost" size="icon" title="Bring to front" aria-label="Bring to front" onClick={() => onLayer('front')}><BringToFront/></Button>
      <Button variant="ghost" size="icon" title="Bring forward" aria-label="Bring forward" onClick={() => onLayer('up')}><ArrowUp/></Button>
      <Button variant="ghost" size="icon" title="Send backward" aria-label="Send backward" onClick={() => onLayer('down')}><ArrowDown/></Button>
      <Button variant="ghost" size="icon" title="Send to back" aria-label="Send to back" onClick={() => onLayer('back')}><SendToBack/></Button>
      <Button variant="ghost" size="icon" title={el.locked ? 'Unlock' : 'Lock'} aria-label={el.locked ? 'Unlock' : 'Lock'} onClick={() => update({ locked: !el.locked }, 'Lock')}>{el.locked ? <Unlock/> : <Lock/>}</Button>
      <Button variant="ghost" size="icon" title={el.visible ? 'Hide' : 'Show'} aria-label={el.visible ? 'Hide' : 'Show'} onClick={() => update({ visible: !el.visible }, 'Visibility')}>{el.visible ? <EyeOff/> : <Eye/>}</Button>
      <Button variant="ghost" size="icon" title="Duplicate (Ctrl+D)" aria-label="Duplicate" onClick={onDuplicate}><Copy/></Button>
      <Button variant="ghost" size="icon" title={el.locked ? 'Unlock to delete' : 'Delete'} aria-label="Delete element" disabled={el.locked} onClick={onDelete}><Trash2/></Button>
    </div>
    <Range label={`Opacity ${Math.round(el.opacity * 100)}%`} value={el.opacity} min={0} max={1} step={0.01} onChange={(v) => update({ opacity: v }, 'Opacity')} />
    <div className="be-grid2">
      <Num label="Rotation°" value={el.rotation} min={-360} max={360} onChange={(v) => update({ rotation: v }, 'Rotation')} />
      <Num label="Scale" value={el.scale} min={0.05} max={20} step={0.05} onChange={(v) => update({ scale: v }, 'Scale')} />
    </div>

    {el.type === 'text' && <>
      <Button variant="outline" size="sm" onClick={onEdit}><Type/>Edit text</Button>
      <label className="be-field"><span>Font</span><select value={el.style.fontFamily} onChange={(e) => updateStyle({ fontFamily: e.target.value }, 'Font')}>
        {[...new Set([el.style.fontFamily, ...FONTS])].map((f) => <option key={f} value={f}>{f.split(',')[0]?.replace(/"/g, '')}</option>)}</select></label>
      <div className="be-grid2">
        <Num label="Size" value={el.style.fontSize} min={4} max={400} onChange={(v) => updateStyle({ fontSize: v }, 'Size')} />
        <label className="be-field"><span>Weight</span><select value={el.style.fontWeight} onChange={(e) => updateStyle({ fontWeight: Number(e.target.value) }, 'Weight')}>{[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
        <Num label="Line height" value={el.style.lineHeight} min={1} max={800} onChange={(v) => updateStyle({ lineHeight: v }, 'Line height')} />
        <Num label="Letter spacing" value={el.style.letterSpacing} min={-50} max={200} step={0.5} onChange={(v) => updateStyle({ letterSpacing: v }, 'Letter spacing')} />
      </div>
      <div className="be-row">
        <Button variant="ghost" size="sm" className={el.style.fontWeight >= 700 ? 'on' : ''} aria-pressed={el.style.fontWeight >= 700} onClick={() => updateStyle({ fontWeight: el.style.fontWeight >= 700 ? 400 : 700 }, 'Bold')}><b>B</b></Button>
        <Button variant="ghost" size="sm" className={el.style.italic ? 'on' : ''} aria-pressed={el.style.italic} onClick={() => updateStyle({ italic: !el.style.italic }, 'Italic')}><i>I</i></Button>
        {(['left', 'center', 'right', 'justify'] as const).map((a) => { const Icon = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify }[a]; return <Button key={a} variant="ghost" size="icon" aria-label={`Align ${a}`} className={el.style.align === a ? 'on' : ''} onClick={() => updateStyle({ align: a }, 'Align')}><Icon/></Button>; })}
      </div>
      <div className="be-grid2">
        <Color label="Color" value={el.style.color} onChange={(v) => updateStyle({ color: v }, 'Color')} />
        <label className="be-field"><span>Case</span><select value={el.style.textTransform} onChange={(e) => updateStyle({ textTransform: e.target.value as TextStyle['textTransform'] }, 'Case')}>{['none', 'uppercase', 'lowercase', 'capitalize'].map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      </div>
      <form className="be-field" onSubmit={(e) => { e.preventDefault(); const v = href.trim(); const ok = v === '' ? '' : safeLink(v); if (v && !ok) return; update((x) => { if (x.type !== 'text') return x; const { href: _h, ...rest } = x; return ok ? { ...rest, href: ok } : rest; }, 'Link'); }}>
        <span>Link (https:// or mailto:)</span>
        <div className="be-inline-form"><input value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://facebook.com/you" aria-invalid={href.trim() !== '' && !safeLink(href)} /><Button variant="outline" size="sm" type="submit">Set</Button></div>
      </form>
    </>}

    {el.type === 'image' && <>
      <div className="be-label">REPLACE IMAGE</div>
      <form className="be-image-add" onSubmit={(e) => { e.preventDefault(); onReplaceUrl(newSrc); setNewSrc(''); }}>
        <input aria-label="New image link" placeholder="https://… new image" value={newSrc} onChange={(e) => setNewSrc(e.target.value)} />
        <Button variant="ghost" size="sm" type="submit" disabled={!httpsUrl(newSrc)}>Replace</Button>
      </form>
      <Button variant="outline" size="sm" onClick={onReplaceFile}><ImageIcon/>Replace from device</Button>
      <label className="be-field"><span>Alt text</span><input value={el.src.alt ?? ''} maxLength={300} onChange={(e) => img({ src: { ...el.src, alt: e.target.value } }, 'Alt text')} /></label>
      <label className="be-field"><span>Fit</span><select value={el.fit} onChange={(e) => img({ fit: e.target.value as ImageElement['fit'] }, 'Fit')}><option value="cover">Fill frame (crop)</option><option value="contain">Show whole image</option><option value="fill">Stretch</option></select></label>
      <Range label="Focus left ↔ right" value={el.objectPosition.x} min={0} max={100} onChange={(v) => img({ objectPosition: { ...el.objectPosition, x: v } }, 'Position')} />
      <Range label="Focus top ↕ bottom" value={el.objectPosition.y} min={0} max={100} onChange={(v) => img({ objectPosition: { ...el.objectPosition, y: v } }, 'Position')} />
      <div className="be-label">CROP</div>
      <Range label="Left" value={el.crop.x} min={0} max={0.95} step={0.01} onChange={(v) => img({ crop: { ...el.crop, x: v, width: Math.min(el.crop.width, 1 - v) } }, 'Crop')} />
      <Range label="Top" value={el.crop.y} min={0} max={0.95} step={0.01} onChange={(v) => img({ crop: { ...el.crop, y: v, height: Math.min(el.crop.height, 1 - v) } }, 'Crop')} />
      <Range label="Width" value={el.crop.width} min={0.05} max={1 - el.crop.x} step={0.01} onChange={(v) => img({ crop: { ...el.crop, width: v } }, 'Crop')} />
      <Range label="Height" value={el.crop.height} min={0.05} max={1 - el.crop.y} step={0.01} onChange={(v) => img({ crop: { ...el.crop, height: v } }, 'Crop')} />
      <Button variant="ghost" size="sm" onClick={() => img({ crop: { x: 0, y: 0, width: 1, height: 1 }, objectPosition: { x: 50, y: 50 } }, 'Reset crop')}>Reset crop</Button>
      <Num label="Corner radius" value={el.borderRadius} min={0} max={2000} onChange={(v) => img({ borderRadius: v }, 'Radius')} />
      <p className="be-hint">Hold Shift while resizing to keep proportions.</p>
    </>}

    {el.type === 'shape' && <>
      <label className="be-field"><span>Shape</span><select value={el.shape} onChange={(e) => shp({ shape: e.target.value as ShapeKind }, 'Shape')}><option value="rectangle">Rectangle</option><option value="rounded-rectangle">Rounded rectangle</option><option value="ellipse">Circle / ellipse</option><option value="line">Line</option></select></label>
      <div className="be-grid2">
        {el.shape !== 'line' && <label className="be-field be-color"><span>Fill</span><div className="be-inline-form"><input type="color" value={/^#[0-9a-f]{6}$/i.test(el.fill) ? el.fill : '#ffffff'} onChange={(e) => shp({ fill: e.target.value }, 'Fill')} /><Button variant="ghost" size="sm" onClick={() => shp({ fill: 'transparent' }, 'Fill')}>None</Button></div></label>}
        <Color label="Stroke" value={el.stroke} onChange={(v) => shp({ stroke: v }, 'Stroke')} />
        <Num label="Stroke width" value={el.strokeWidth} min={0} max={200} onChange={(v) => shp({ strokeWidth: v }, 'Stroke width')} />
        {el.shape === 'rounded-rectangle' && <Num label="Corner radius" value={el.cornerRadius} min={0} max={2000} onChange={(v) => shp({ cornerRadius: v }, 'Radius')} />}
      </div>
    </>}
  </div>;
}
