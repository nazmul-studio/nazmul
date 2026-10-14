import { useEffect, useRef } from 'react';
import type { BookPage } from '@/lib/book/model';
import { onImageLoaded, renderPageToCanvas } from '@/lib/book/render';

type Leaf = { front: BookPage | null; back: BookPage | null };

/**
 * The achievement book as two flat pages, for light mode where there is no 3D scene.
 * It paints with the same renderer as the 3D tome, so the pages are identical, just not animated.
 */
export function BookFlat({leaf}:{leaf:Leaf|undefined}) {
  const front=useRef<HTMLCanvasElement>(null);
  const back=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    let disposed=false;
    const paint=()=>{
      if(disposed)return;
      const ratio=Math.min(window.devicePixelRatio||1,2);
      if(front.current)renderPageToCanvas(front.current,leaf?.front??null,ratio);
      if(back.current&&leaf?.back)renderPageToCanvas(back.current,leaf.back,ratio);
    };
    paint();
    const stop=onImageLoaded(paint);
    // Page text uses the site's web fonts, which may arrive after the first paint.
    document.fonts?.ready.then(paint);
    return ()=>{disposed=true;stop();};
  },[leaf]);
  return <div className="book-flat" aria-hidden="true">
    <canvas ref={front} className="book-flat-page"/>
    {leaf?.back&&<canvas ref={back} className="book-flat-page"/>}
  </div>;
}
