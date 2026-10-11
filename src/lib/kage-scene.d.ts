import type { BookPage } from './book/model';
export type Leaf = { front: BookPage | null; back: BookPage | null };
export function startSanctuary(canvas:HTMLCanvasElement,wordmark:string,coverUrl:string,pages:Leaf[]):{
  progress(value:number):void;
  page(index:number):void;
  pages(value:Leaf[]):void;
  cover(url:string):void;
  word(value:string):void;
  dispose():void;
};
