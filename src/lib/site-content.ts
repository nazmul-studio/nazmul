import { createServerFn } from "@tanstack/react-start";
import type { PortfolioContent } from "./content-model";

export type SiteContent = { version: number; content: PortfolioContent };

// Runs on the server (during SSR, and via RPC on client-side navigation). The backend module is
// imported lazily so none of it is bundled for the browser.
export const getSiteContent = createServerFn({ method: "GET" }).handler(async (): Promise<SiteContent> => {
  const { loadPublishedContent } = await import("../backend/store");
  return loadPublishedContent();
});
