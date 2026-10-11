import type { ReactNode } from 'react';

export function ChromeButton({label,onClick,icon}:{label:string;onClick?:()=>void;icon?:ReactNode}) {
  return <button type="button" className="chrome-cta" onClick={onClick} aria-label={label}>
    <span className="chrome-halo" aria-hidden="true"/>
    <span className="chrome-label">{label}</span>
    <span className="chrome-knob" aria-hidden="true">{icon??<svg viewBox="0 0 176 176"><path className="chrome-scribble" d="M63 108q5-5 10 0t10 0t10 0"/><g className="chrome-pen"><path d="M106.1 77.4a3.8 3.8 0 0 0-15.1-15.1L70.3 82.9a7.6 7.6 0 0 0-1.9 3.2l-5 16.5a1.9 1.9 0 0 0 2.4 2.4l16.5-5a7.6 7.6 0 0 0 3.2-1.9z"/><path d="M85.1 68.4l7.6 7.6"/></g></svg>}</span>
  </button>;
}
