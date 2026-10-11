import { createElement, useEffect, useRef, useState } from 'react';

export function Typed({text,as='span',className='',speed=28}:{text:string;as?:string;className?:string;speed?:number}) {
  const ref=useRef<HTMLElement>(null);
  const [count,setCount]=useState(0);
  useEffect(()=>{
    const el=ref.current; if(!el)return;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){setCount(text.length);return;}
    setCount(0); let timer=0;
    const io=new IntersectionObserver(([entry])=>{if(!entry?.isIntersecting)return;io.disconnect();let n=0;timer=window.setInterval(()=>{n++;setCount(n);if(n>=text.length)clearInterval(timer);},speed);},{threshold:.2});
    io.observe(el); return ()=>{io.disconnect();clearInterval(timer);};
  },[text,speed]);
  const done=count>=text.length;
  return createElement(as,{ref,className:`rgb-live typed ${className}`,'aria-label':text},
    createElement('span',{'aria-hidden':true},text.slice(0,count)),
    createElement('span',{className:done?'caret done':'caret','aria-hidden':true}));
}
