// Plain-language summary of what differs between two versions of the content. Pure and isomorphic: the Studio
// uses it for "what will I publish?" and for comparing a past version with the current draft.
import type { BookPage } from "./book/model";
import type { PortfolioContent, Project } from "./content-model";

export type Change = { area: string; summary: string };

const TEXT_FIELDS: ReadonlyArray<readonly [keyof PortfolioContent, string, string]> = [
  ["name", "Story & identity", "Full name"],
  ["wordmark", "Story & identity", "Sanctuary wordmark"],
  ["headline", "Story & identity", "Opening headline"],
  ["introduction", "Story & identity", "Opening introduction"],
  ["aboutTitle", "Story & identity", "Origin headline"],
  ["about", "Story & identity", "Your story"],
  ["projectsTitle", "Story & identity", "Artifacts headline"],
  ["bookTitle", "Story & identity", "Grimoire headline"],
  ["bookDescription", "Story & identity", "Grimoire introduction"],
  ["contactTitle", "Contact & links", "Closing headline"],
  ["contactText", "Contact & links", "Closing introduction"],
  ["email", "Contact & links", "Email address"],
  ["github", "Contact & links", "GitHub link"],
  ["linkedin", "Contact & links", "LinkedIn link"],
  ["facebook", "Contact & links", "Facebook link"],
];

const SITE_FIELDS: ReadonlyArray<readonly [keyof PortfolioContent["site"], string]> = [
  ["contactCta", "Contact button text"],
  ["viewProject", "Project link button text"],
  ["seoTitle", "Page title"],
  ["seoDescription", "Page description"],
  ["ogImage", "Share preview image"],
  ["coverImage", "Book cover"],
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (text: string) => `“${text.length > 40 ? `${text.slice(0, 37)}…` : text || "Untitled"}”`;

function projectChanges(from: Project[], to: Project[]): Change[] {
  const area = "Selected projects";
  const key = (p: Project) => JSON.stringify([p.title, p.category, p.description, p.url]);
  const fromKeys = from.map(key);
  const toKeys = to.map(key);
  if (fromKeys.length === toKeys.length && fromKeys.every((k, i) => k === toKeys[i])) return [];

  // Match identical projects first; whatever is left over is an edit (paired in order), an addition or a removal.
  const leftoverFrom: Project[] = [];
  const unmatched = [...toKeys];
  from.forEach((p, i) => {
    const at = unmatched.indexOf(fromKeys[i] as string);
    if (at >= 0) unmatched[at] = "\u0000matched";
    else leftoverFrom.push(p);
  });
  const leftoverTo = to.filter((_, i) => unmatched[i] !== "\u0000matched");

  const out: Change[] = [];
  const edits = Math.min(leftoverFrom.length, leftoverTo.length);
  for (let i = 0; i < edits; i++) out.push({ area, summary: `Project ${quote((leftoverTo[i] as Project).title)} edited` });
  for (const p of leftoverTo.slice(edits)) out.push({ area, summary: `Project ${quote(p.title)} added` });
  for (const p of leftoverFrom.slice(edits)) out.push({ area, summary: `Project ${quote(p.title)} removed` });
  if (out.length === 0) out.push({ area, summary: "Projects reordered" });
  return out;
}

function bookChanges(from: PortfolioContent, to: PortfolioContent): Change[] {
  const area = "Book";
  if (!from.book && !to.book) {
    return JSON.stringify(from.achievements) === JSON.stringify(to.achievements)
      ? []
      : [{ area, summary: "Book pages changed" }];
  }
  if (!from.book && to.book) return [{ area, summary: `Book edited in the editor for the first time (${plural(to.book.pages.length, "page")})` }];
  if (from.book && !to.book) return [{ area, summary: "Book edits dropped; the book is rebuilt from the older page list" }];
  const a = (from.book as NonNullable<typeof from.book>).pages;
  const b = (to.book as NonNullable<typeof to.book>).pages;
  const byId = new Map<string, BookPage>(a.map((p) => [p.id, p]));
  const out: Change[] = [];
  const added = b.filter((p) => !byId.has(p.id)).length;
  const bIds = new Set(b.map((p) => p.id));
  const removed = a.filter((p) => !bIds.has(p.id)).length;
  const edited = b.filter((p) => {
    const before = byId.get(p.id);
    // Same object = untouched (edits replace only the pages they change), which keeps this cheap on every keystroke.
    return before !== undefined && before !== p && JSON.stringify(before) !== JSON.stringify(p);
  }).length;
  const orderA = a.filter((p) => bIds.has(p.id)).map((p) => p.id);
  const orderB = b.filter((p) => byId.has(p.id)).map((p) => p.id);
  if (added) out.push({ area, summary: `${plural(added, "page")} added` });
  if (removed) out.push({ area, summary: `${plural(removed, "page")} removed` });
  if (edited) out.push({ area, summary: `${plural(edited, "page")} edited` });
  if (orderA.some((id, i) => id !== orderB[i])) out.push({ area, summary: "Pages reordered" });
  return out;
}

/** What you would change by turning `from` into `to`, in the order the Studio's tabs appear. Empty when identical. */
export function describeChanges(from: PortfolioContent, to: PortfolioContent): Change[] {
  const out: Change[] = [];
  for (const [key, area, label] of TEXT_FIELDS) if (from[key] !== to[key]) out.push({ area, summary: `${label} changed` });
  out.push(...projectChanges(from.projects, to.projects));
  out.push(...bookChanges(from, to));
  const a = from.site;
  const b = to.site;
  for (const [key, label] of SITE_FIELDS) if (a[key] !== b[key]) out.push({ area: "Site text & SEO", summary: `${label} changed` });
  a.chapters.forEach((name, i) => {
    if (name !== b.chapters[i]) out.push({ area: "Site text & SEO", summary: `Section name ${i + 1} changed` });
  });
  if (JSON.stringify(a.tech) !== JSON.stringify(b.tech)) out.push({ area: "Site text & SEO", summary: "Story tags changed" });
  return out;
}
