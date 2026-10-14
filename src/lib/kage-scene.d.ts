import type { BookPage } from './book/model';
import type { QualityPlan } from './device-tier';
export type Leaf = { front: BookPage | null; back: BookPage | null };
export type SceneQuality = {
  /** Resolution, frame-rate and build limits for this device (see device-tier.ts). */
  plan?: Partial<QualityPlan>;
  /** 0…1 while the scene is being built. */
  onProgress?(fraction: number): void;
  /** The first frame has been drawn. */
  onReady?(): void;
  /** The scene cannot carry on (too slow, context lost, build failed); the host should fall back. */
  onGiveUp?(reason: string): void;
};
export function startSanctuary(canvas:HTMLCanvasElement,wordmark:string,coverUrl:string,pages:Leaf[],quality?:SceneQuality):{
  progress(value:number):void;
  page(index:number):void;
  pages(value:Leaf[]):void;
  cover(url:string):void;
  word(value:string):void;
  /** forceLoss releases the GPU context immediately instead of waiting for garbage collection. */
  dispose(forceLoss?:boolean):void;
};
