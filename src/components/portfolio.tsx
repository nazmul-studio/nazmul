import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, X, Volume2, VolumeX, Github, Linkedin, Facebook } from 'lucide-react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';
import { Button } from '@/components/ui/button';
import * as Popover from '@radix-ui/react-popover';
import * as Dialog from '@radix-ui/react-dialog';
import { Sanctuary } from './sanctuary';
import { ChromeButton } from './chrome-button';
import { Typed } from './typed';
import { BookFlat } from './book-flat';
import { useScenePlan } from '@/lib/scene-plan';
import { VISIT_TTL_DAYS } from '@/lib/visit-info';
import { usePortfolio, safeHref, chapterName, type Project } from '@/lib/portfolio-content';
import { resolveBook } from '@/lib/book/migrate';
import { leavesOf, pageLinks, pageText } from '@/lib/book/render';

const ids=['genesis','origin','artifacts','grimoire','transmission'];
export function Brand() {const {content}=usePortfolio();return <span className="brand"><span className="gate-symbol" aria-hidden="true"><i/><i/><i/></span><strong className="rgb-live">{content.name.toUpperCase()}</strong></span>;}
export function Portfolio({preview=false}:{preview?:boolean}) {
  const {content,previewing,reset}=usePortfolio();
  const chapters=ids.map((_,i)=>chapterName(content.site,i));
  const [active,setActive]=useState(0),[menu,setMenu]=useState(false),[page,setPage]=useState(0),[sound,setSound]=useState(false),[project,setProject]=useState<Project|null>(null);
  const audio=useRef<AudioContext|null>(null);
  const touch=useRef(0);
  const plan=useScenePlan();
  const projectTrigger=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{
    gsap.registerPlugin(ScrollTrigger,ScrollToPlugin);
    const motion=gsap.matchMedia();
    motion.add('(prefers-reduced-motion: no-preference)',()=>{
      document.querySelectorAll('.chapter-copy').forEach(el=>gsap.from(el,{y:20,opacity:0,duration:.65,scrollTrigger:{trigger:el,start:'top 92%',once:true},ease:'power2.out'}));
    });
    return ()=>{motion.revert();gsap.killTweensOf(window);audio.current?.close();};
  },[]);
  function go(index:number){
    const id=ids[index];if(!id)return;
    setMenu(false);gsap.killTweensOf(window);
    const target=document.getElementById(id);if(!target)return;
    const offset=document.querySelector('header')?.getBoundingClientRect().height??88;
    gsap.to(window,{scrollTo:{y:target,offsetY:offset,autoKill:true},duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:.85,ease:'power2.inOut',onComplete:()=>target.focus({preventScroll:true})});
  }
  async function toggleSound(){
    if(sound){await audio.current?.suspend();setSound(false);return;}
    if(!audio.current){const context=new AudioContext();audio.current=context;const gain=context.createGain();gain.gain.value=.018;gain.connect(context.destination);[110,164.81,220].forEach(freq=>{const oscillator=context.createOscillator();oscillator.type='sine';oscillator.frequency.value=freq;oscillator.connect(gain);oscillator.start();});}
    await audio.current.resume();setSound(true);
  }
  const leaves=useMemo(()=>leavesOf(resolveBook(content).pages),[content]);
  const links=useMemo(()=>[...pageLinks(leaves[page]?.front??null),...pageLinks(leaves[page]?.back??null)],[leaves,page]);
  const turn=(direction:number)=>setPage(p=>Math.max(0,Math.min(leaves.length-1,p+direction)));
  useEffect(()=>{if(page>leaves.length-1)setPage(Math.max(0,leaves.length-1));},[leaves.length,page]);
  return <div className={`portfolio ${preview?'is-preview':''}`}>
    {previewing&&<div className="preview-banner" role="status"><span>UNPUBLISHED PREVIEW</span><Link to="/studio">BACK TO STUDIO</Link><button type="button" onClick={reset}>DISCARD</button></div>}
    <Sanctuary page={page} onChapter={setActive}/>
    <div className="scene-shade" aria-hidden="true"/>
    <a className="skip-link" href="#portfolio-main">Skip to main content</a>
    <header className="site-header"><a href="#genesis" onClick={e=>{e.preventDefault();go(0);}} aria-label={`${content.name} home`}><Brand/></a>
      <Popover.Root open={menu} onOpenChange={setMenu}>
        <Popover.Trigger asChild><Button variant="ghost" type="button" className={menu?'menu-lines open':'menu-lines'} aria-label={menu?'Close menu':'Open menu'} aria-expanded={menu} aria-controls="chrome-navigation"><i aria-hidden="true"/><i aria-hidden="true"/><i aria-hidden="true"/></Button></Popover.Trigger>
        <Popover.Portal><Popover.Content id="chrome-navigation" className="chrome-menu" sideOffset={20} align="end" collisionPadding={20}>
          <nav aria-label="Main navigation">{chapters.map((label,i)=><ChromeButton key={ids[i]} label={label.toUpperCase()} onClick={()=>go(i)}/>)}</nav>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
    </header>
    <div className="portfolio-content">
      <section id="genesis" tabIndex={-1} data-chapter className="hero-section">
        <div className="hero-copy"><Typed as="h1" text={content.headline}/><Typed as="p" text={content.introduction} speed={18}/></div>
        <div className="hero-bottom"><Button variant="ghost" className="scroll-cta" aria-label={`Continue to ${chapters[1]}`} onClick={()=>go(1)}><ArrowDown size={14}/></Button></div>
      </section>
      <section id="origin" tabIndex={-1} data-chapter className="story-section"><div className="chapter-copy origin-copy"><Typed className="eyebrow" text={`01 — ${chapters[1]?.toUpperCase()}`}/><Typed as="h2" text={content.aboutTitle}/><Typed as="p" text={content.about} speed={14}/><div className="tech-list">{content.site.tech.map((t,i)=><span className="rgb-live" key={`${i}-${t}`}>{t}</span>)}</div></div></section>
      <section id="artifacts" tabIndex={-1} data-chapter className="artifacts-section"><div className="chapter-copy"><Typed className="eyebrow" text={`02 — ${chapters[2]?.toUpperCase()}`}/><div className="section-heading"><Typed as="h2" text={content.projectsTitle}/></div><div className="project-grid">{content.projects.map((item,i)=><Button key={i} variant="ghost" className="project-item" onClick={e=>{projectTrigger.current=e.currentTarget;setProject(item);}}><div className={`project-art project-art-${i%3}`}><span className="artifact-shape"/><span className="artifact-index">{String(i+1).padStart(2,'0')}</span><ArrowUpRight/></div><div className="project-meta"><span className="rgb-live">{item.category}</span><h3 className="rgb-live">{item.title}</h3></div></Button>)}</div></div></section>
      <section id="grimoire" tabIndex={-1} data-chapter className="grimoire-section" onTouchStart={e=>{touch.current=e.touches[0]?.clientX??0;}} onTouchEnd={e=>{const d=(e.changedTouches[0]?.clientX??0)-touch.current;if(Math.abs(d)>45)turn(d<0?1:-1);}}>
        <div className="grimoire-stage">
        <div className="chapter-copy tome-heading"><Typed className="eyebrow" text={`03 — ${chapters[3]?.toUpperCase()}`}/><Typed as="h2" text={content.bookTitle}/></div>
        {plan?.scene===false&&<BookFlat leaf={leaves[page]}/>}
        <div className="book-control"><Button variant="ghost" size="icon" aria-label="Previous page" disabled={page===0} onClick={()=>turn(-1)}><ArrowLeft/></Button><span className="rgb-live">{String(page+1).padStart(2,'0')} <i>/</i> {String(leaves.length).padStart(2,'0')}</span><Button variant="ghost" size="icon" aria-label="Next page" disabled={page>=leaves.length-1} onClick={()=>turn(1)}><ArrowRight/></Button></div>
        {links.length>0&&<nav className="book-links" aria-label="Links on this page">{links.map((link,i)=><a key={`${i}-${link.href}`} href={link.href} {...(link.href.startsWith('mailto:')?{}:{target:'_blank',rel:'noreferrer'})}>{link.label}<ArrowUpRight size={12}/></a>)}</nav>}
        <div className="book-accessible sr-only" aria-live="polite">{[pageText(leaves[page]?.front??null),pageText(leaves[page]?.back??null)].filter(Boolean).join(' / ')||`Page ${page+1}`}</div>
        </div>
      </section>
      <section id="transmission" tabIndex={-1} data-chapter className="contact-section"><div className="chapter-copy"><Typed className="eyebrow" text={`04 — ${chapters[4]?.toUpperCase()}`}/><Typed as="h2" text={content.contactTitle}/><Typed as="p" text={content.contactText} speed={18}/>{content.email&&<a className="contact-link rgb-live" href={`mailto:${content.email}`}>{content.site.contactCta} <ArrowUpRight/></a>}<div className="social-links">{safeHref(content.github)&&<a href={safeHref(content.github)} target="_blank" rel="noreferrer"><Github size={16}/>GitHub</a>}{safeHref(content.linkedin)&&<a href={safeHref(content.linkedin)} target="_blank" rel="noreferrer"><Linkedin size={16}/>LinkedIn</a>}{safeHref(content.facebook)&&<a href={safeHref(content.facebook)} target="_blank" rel="noreferrer"><Facebook size={16}/>Facebook</a>}</div></div><footer><span className="rgb-live">© {new Date().getFullYear()} {content.name}</span><span className="visit-notice">{`Visits are logged (time, IP address, device details) for ${VISIT_TTL_DAYS} days to keep this site fast and secure. Browsers that send Do Not Track are not logged.`}</span></footer></section>
    </div>
    <nav className="chapter-dock" aria-label="Chapter navigation">{chapters.map((chapter,i)=><Button variant="ghost" key={ids[i]} title={chapter} aria-label={chapter} aria-current={active===i?'location':undefined} onClick={()=>go(i)} className={active===i?'active':''}>{String(i).padStart(2,'0')}</Button>)}</nav>
    <div className="sound-control"><Button variant="ghost" size="icon" aria-label={sound?'Mute ambient sound':'Enable ambient sound'} onClick={toggleSound}>{sound?<Volume2/>:<VolumeX/>}</Button></div>
    <Dialog.Root open={Boolean(project)} onOpenChange={open=>{if(!open)setProject(null);}}>
      {project&&<Dialog.Portal><Dialog.Overlay className="modal-backdrop"/><Dialog.Content className="project-modal" onCloseAutoFocus={e=>{e.preventDefault();projectTrigger.current?.focus();}}>
        <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="Close project" className="modal-close"><X/></Button></Dialog.Close>
        <span className="eyebrow">{project.category}</span><Dialog.Title>{project.title}</Dialog.Title><Dialog.Description>{project.description}</Dialog.Description>
        {safeHref(project.url)&&<Button asChild variant="outline"><a href={safeHref(project.url)} target="_blank" rel="noreferrer">{content.site.viewProject}<ArrowUpRight/></a></Button>}
      </Dialog.Content></Dialog.Portal>}
    </Dialog.Root>
  </div>;
}