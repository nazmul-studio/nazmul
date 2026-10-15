import { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import coverAsset from '@/assets/tome-cover.jpg.asset.json';
import { resolveImage } from '@/lib/book/image-store';
import { usePortfolio } from '@/lib/portfolio-content';
import { resolveBook } from '@/lib/book/migrate';
import { leavesOf } from '@/lib/book/render';
import { chapterProgress } from '@/lib/scene-performance';
import { beginSceneAttempt, degradeScene, detectScenePlan, requestScene, sceneAttemptHealthy, sceneReady, useScenePlan } from '@/lib/scene-plan';

type SceneController = ReturnType<typeof import('@/lib/kage-scene')['startSanctuary']>;

/** Runs `fn` once the browser is idle (or soon after, on browsers without requestIdleCallback). */
function whenIdle(fn: () => void): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) { const id = w.requestIdleCallback(fn, { timeout: 1200 }); return () => w.cancelIdleCallback?.(id); }
  const id = window.setTimeout(fn, 250);
  return () => window.clearTimeout(id);
}

export function Sanctuary({page,onChapter}:{page:number;onChapter:(index:number)=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const poster=useRef<HTMLDivElement>(null);
  const control=useRef<SceneController|null>(null);
  const progress=useRef(0);
  const {content}=usePortfolio();
  const leaves=useMemo(()=>leavesOf(resolveBook(content).pages),[content]);
  // The cover is the owner's uploaded image when there is one, otherwise the bundled one.
  const coverUrl=useMemo(()=>resolveImage({key:content.site?.coverImage??''})||coverAsset.url,[content.site?.coverImage]);
  const latest=useRef({content,page,coverUrl});latest.current={content,page,coverUrl};
  const chapterCallback=useRef(onChapter); chapterCallback.current=onChapter;
  // null until the browser has judged the device (and on the server), so the first render matches the server's.
  const plan=useScenePlan();
  const [ready,setReady]=useState(false);

  useEffect(()=>{detectScenePlan();},[]);
  useEffect(()=>{
    // Lets the stylesheet trim decoration (animated gradients, blur) on lighter tiers.
    if(plan?.tier)document.documentElement.dataset.tier=plan.tier;
    return ()=>{delete document.documentElement.dataset.tier;};
  },[plan?.tier]);

  // Chapter tracking works in every tier; the scene, when there is one, just follows the progress.
  useEffect(()=>{
    gsap.registerPlugin(ScrollTrigger);
    let disposed=false; let refreshFrame=0;
    let tops:number[]=[], lastChapter=-1;
    const chapters=Array.from(document.querySelectorAll<HTMLElement>('[data-chapter]'));
    const measure=()=>{tops=chapters.map(chapter=>chapter.offsetTop);};
    const sync=(y:number)=>{
      const value=chapterProgress(y,tops);
      progress.current=value;
      // The renderer performs the only damping, once per rendered frame.
      control.current?.progress(value);
      const chapter=Math.min(4,Math.round(value));
      if(chapter!==lastChapter){lastChapter=chapter;chapterCallback.current(chapter);}
    };
    measure();
    const trigger=ScrollTrigger.create({trigger:document.querySelector('main'),start:'top top',end:'bottom bottom',onRefreshInit:measure,onRefresh(self){sync(self.scroll());},onUpdate(self){sync(self.scroll());}});
    sync(window.scrollY);
    const scheduleRefresh=()=>{
      cancelAnimationFrame(refreshFrame);
      refreshFrame=requestAnimationFrame(()=>{if(!disposed)trigger.refresh();});
    };
    // Also catches font loads and content changes without measuring during scroll.
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(scheduleRefresh);
    chapters.forEach(chapter=>observer?.observe(chapter));
    document.fonts?.ready.then(()=>{if(!disposed)scheduleRefresh();});
    return ()=>{disposed=true;cancelAnimationFrame(refreshFrame);observer?.disconnect();trigger.kill();};
  },[]);

  // The 3D scene: only for tiers that have one, only once the page itself is up, and always with a way out.
  useEffect(()=>{
    if(!plan?.scene)return;
    let disposed=false, abandoned=false, healthy=0;
    let scene:SceneController|undefined;
    setReady(false);
    const cancelIdle=whenIdle(()=>{
      beginSceneAttempt();
      const began=performance.now();
      import('@/lib/kage-scene').then(({startSanctuary})=>{
        if(disposed||!canvas.current)return;
        const now=latest.current;
        scene=startSanctuary(canvas.current,now.content.wordmark,now.coverUrl,leavesOf(resolveBook(now.content).pages),{
          plan,
          onProgress:fraction=>poster.current?.style.setProperty('--boot',fraction.toFixed(3)),
          onReady:()=>{if(disposed)return;setReady(true);sceneReady(Math.round(performance.now()-began));healthy=window.setTimeout(sceneAttemptHealthy,4000);},
          onGiveUp:reason=>{if(disposed)return;abandoned=true;degradeScene(reason);},
        });
        control.current=scene;scene.page(now.page);scene.progress(progress.current);
      }).catch(error=>{console.error(error);if(!disposed)degradeScene('scene code failed to load');});
    });
    return ()=>{disposed=true;cancelIdle();window.clearTimeout(healthy);scene?.dispose(abandoned);control.current=null;setReady(false);};
  },[plan]);

  useEffect(()=>{control.current?.page(page);},[page]);
  useEffect(()=>{control.current?.cover(coverUrl);},[coverUrl]);
  useEffect(()=>{control.current?.pages(leaves);control.current?.word(content.wordmark);},[content.wordmark,leaves]);
  const loading=plan?.scene===true&&!ready;
  return <>
    {/* The poster is plain CSS, so it paints with the first frame on any device and stays as the backdrop in light mode. */}
    <div ref={poster} className={`sanctuary-poster${ready?' is-hidden':''}${loading?' is-loading':''}`} aria-hidden="true"><i className="poster-moon"/><i className="poster-ridge"/><i className="poster-ridge near"/><i className="poster-mist"/><b className="poster-bar"/></div>
    {plan?.scene!==false&&<canvas key={plan?.gen??0} ref={canvas} className={`sanctuary-canvas${ready?' is-ready':''}`} aria-label="Moonlit Kyoto sanctuary with a red moon, torii gate, falling maple leaves and an animated achievement book" />}
    {plan?.tier==='lite'&&plan.retry&&<button type="button" className="scene-lite-note" onClick={requestScene}>Light mode · Try the 3D scene</button>}
  </>;
}
