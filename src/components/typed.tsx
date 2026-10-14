import { createElement, useEffect, useRef, useState } from 'react';

export function Typed({text,as='span',className='',speed=28}:{text:string;as?:string;className?:string;speed?:number}) {
  const ref=useRef<HTMLElement>(null);
  const [count,setCount]=useState(text.length);
  useEffect(()=>{
    const el=ref.current; if(!el)return;
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    let timer=0; let io:IntersectionObserver|undefined;
    const finish=()=>{clearInterval(timer);io?.disconnect();setCount(text.length);};
    const onMotion=()=>{if(motion.matches)finish();};
    if(motion.matches || !('IntersectionObserver' in window)){finish();return;}
    setCount(0);
    io=new IntersectionObserver(([entry])=>{if(!entry?.isIntersecting)return;io?.disconnect();let n=0;timer=window.setInterval(()=>{n++;setCount(n);if(n>=text.length)clearInterval(timer);},Math.max(1,speed));},{threshold:.2});
    io.observe(el);motion.addEventListener('change',onMotion);
    return ()=>{io?.disconnect();clearInterval(timer);motion.removeEventListener('change',onMotion);};
  },[text,speed]);
  const done=count>=text.length;
  return createElement(as,{ref,className:`rgb-live typed ${className}`},
    createElement('span',{className:'typed-measure','aria-hidden':true},text),
    createElement('span',{className:'sr-only'},text),
    createElement('span',{className:'typed-visual','aria-hidden':true},text.slice(0,count),
      createElement('span',{className:done?'caret done':'caret'})));
}
