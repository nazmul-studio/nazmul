import { useEffect, useMemo, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import cover from '@/assets/tome-cover.jpg';
import { resolveImage } from '@/lib/book/image-store';
import { usePortfolio } from '@/lib/portfolio-content';
import { resolveBook } from '@/lib/book/migrate';
import { leavesOf } from '@/lib/book/render';
import { chapterProgress } from '@/lib/scene-performance';

type SceneController = ReturnType<typeof import('@/lib/kage-scene')['startSanctuary']>;
export function Sanctuary({page,onChapter}:{page:number;onChapter:(index:number)=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const control=useRef<SceneController|null>(null);
  const {content}=usePortfolio();
  const leaves=useMemo(()=>leavesOf(resolveBook(content).pages),[content]);
  // The cover is the owner's uploaded image when there is one, otherwise the bundled one.
  const coverUrl=useMemo(()=>resolveImage({key:content.site?.coverImage??''})||cover,[content.site?.coverImage]);
  const latest=useRef({content,page,coverUrl});latest.current={content,page,coverUrl};
  const chapterCallback=useRef(onChapter); chapterCallback.current=onChapter;
  useEffect(()=>{
    let disposed=false; let trigger:ScrollTrigger|undefined;
    let observer:ResizeObserver|undefined;
    let refreshFrame=0;
    gsap.registerPlugin(ScrollTrigger);
    import('@/lib/kage-scene').then(({startSanctuary})=>{
      if(disposed || !canvas.current) return;
      const scene=startSanctuary(canvas.current,latest.current.content.wordmark,latest.current.coverUrl,leavesOf(resolveBook(latest.current.content).pages)); control.current=scene;scene.page(latest.current.page);
      const chapters=Array.from(document.querySelectorAll<HTMLElement>('[data-chapter]'));
      let tops:number[]=[], lastChapter=-1;
      const measure=()=>{tops=chapters.map(chapter=>chapter.offsetTop);};
      const sync=(y:number)=>{
        const progress=chapterProgress(y,tops);
        // The renderer performs the only damping, once per rendered frame.
        scene.progress(progress);
        const chapter=Math.min(4,Math.round(progress));
        if(chapter!==lastChapter){lastChapter=chapter;chapterCallback.current(chapter);}
      };
      measure();
      trigger=ScrollTrigger.create({trigger:document.querySelector('main'),start:'top top',end:'bottom bottom',onRefreshInit:measure,onRefresh(self){sync(self.scroll());},onUpdate(self){sync(self.scroll());}});
      sync(window.scrollY);
      const scheduleRefresh=()=>{
        cancelAnimationFrame(refreshFrame);
        refreshFrame=requestAnimationFrame(()=>{if(!disposed)trigger?.refresh();});
      };
      // Also catches font loads and content changes without measuring during scroll.
      observer=new ResizeObserver(scheduleRefresh);
      chapters.forEach(chapter=>observer?.observe(chapter));
      document.fonts?.ready.then(()=>{if(!disposed)scheduleRefresh();});
    });
    return ()=>{disposed=true;cancelAnimationFrame(refreshFrame);observer?.disconnect();trigger?.kill();control.current?.dispose();control.current=null;};
  },[]);
  useEffect(()=>{control.current?.page(page);},[page]);
  useEffect(()=>{control.current?.cover(coverUrl);},[coverUrl]);
  useEffect(()=>{control.current?.pages(leaves);control.current?.word(content.wordmark);},[content.wordmark,leaves]);
  return <canvas ref={canvas} className="sanctuary-canvas" aria-label="Moonlit Kyoto sanctuary with a red moon, torii gate, falling maple leaves and an animated achievement book" />;
}