import { memo, useEffect, useRef } from 'react';
import type { BookPage } from '@/lib/book/model';
import { onImageLoaded, renderPageToCanvas } from '@/lib/book/render';

/** React wrapper around the canonical renderer. Display size is set by CSS; pixels by `pixelRatio`. */
export const PageCanvas = memo(function PageCanvas({ page, pixelRatio, skip, className }: { page: BookPage | null; pixelRatio: number; skip?: string | null; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => ref.current && renderPageToCanvas(ref.current, page, pixelRatio, skip ? { skip: new Set([skip]) } : {});
    draw();
    const stop = onImageLoaded(draw);
    document.fonts?.ready.then(draw).catch(() => {});
    return () => { stop(); };
  }, [page, pixelRatio, skip]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
});
