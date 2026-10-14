import "@testing-library/jest-dom/vitest";
import { Blob as NodeBlob } from "node:buffer";

// jsdom's Blob lacks the streaming API used by the supplied storage mocks.
Object.defineProperty(globalThis, "Blob", { configurable: true, writable: true, value: NodeBlob });

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
