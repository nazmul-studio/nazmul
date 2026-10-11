import { describe, expect, it } from "vitest";
import { describeChanges } from "./content-diff";
import { initialContent, moveItem, type PortfolioContent } from "./content-model";
import { migrateAchievements } from "./book/migrate";

const clone = () => JSON.parse(JSON.stringify(initialContent)) as PortfolioContent;
const project = (title: string, extra = "") => ({ title, category: "C", description: extra, url: "" });
const summaries = (a: PortfolioContent, b: PortfolioContent) => describeChanges(a, b).map((c) => c.summary);

describe("describeChanges", () => {
  it("is empty for identical content", () => {
    expect(describeChanges(clone(), clone())).toEqual([]);
  });

  it("names changed fields and the tab they live on", () => {
    const b = clone();
    b.headline = "New";
    b.email = "me@example.com";
    b.site.seoTitle = "T";
    b.site.chapters[2] = "Work";
    b.site.tech = ["Only"];
    b.site.ogImage = "https://x.test/a.png";
    b.site.coverImage = "media:0123456789abcdef0123456789abcdef.png";
    expect(describeChanges(clone(), b)).toEqual([
      { area: "Story & identity", summary: "Opening headline changed" },
      { area: "Contact & links", summary: "Email address changed" },
      { area: "Site text & SEO", summary: "Page title changed" },
      { area: "Site text & SEO", summary: "Share preview image changed" },
      { area: "Site text & SEO", summary: "Book cover changed" },
      { area: "Site text & SEO", summary: "Section name 3 changed" },
      { area: "Site text & SEO", summary: "Story tags changed" },
    ]);
  });

  it("tells project edits, additions, removals and reordering apart", () => {
    const a = clone();
    a.projects = [project("One"), project("Two"), project("Three")];
    const edited = clone();
    edited.projects = [project("One"), project("Two", "now with text"), project("Three")];
    expect(summaries(a, edited)).toEqual(["Project “Two” edited"]);
    const added = clone();
    added.projects = [...a.projects, project("Four")];
    expect(summaries(a, added)).toEqual(["Project “Four” added"]);
    const removedFirst = clone();
    removedFirst.projects = [project("Two"), project("Three")];
    expect(summaries(a, removedFirst)).toEqual(["Project “One” removed"]);
    const reordered = clone();
    reordered.projects = [project("Three"), project("One"), project("Two")];
    expect(summaries(a, reordered)).toEqual(["Projects reordered"]);
  });

  it("describes book changes by page, not by raw JSON", () => {
    const base = clone();
    base.book = migrateAchievements(base);
    const edited = JSON.parse(JSON.stringify(base)) as PortfolioContent;
    const first = edited.book!.pages[0]!;
    const text = first.elements.find((e) => e.type === "text")!;
    if (text.type === "text") text.text = "Changed";
    expect(summaries(base, edited)).toEqual(["1 page edited"]);

    const grown = JSON.parse(JSON.stringify(edited)) as PortfolioContent;
    grown.book!.pages.push({ ...JSON.parse(JSON.stringify(first)), id: "brand-new" });
    expect(summaries(edited, grown)).toEqual(["1 page added"]);

    const shrunk = JSON.parse(JSON.stringify(base)) as PortfolioContent;
    shrunk.book!.pages.pop();
    expect(summaries(base, shrunk)).toEqual(["1 page removed"]);

    const swapped = JSON.parse(JSON.stringify(base)) as PortfolioContent;
    swapped.book!.pages = moveItem(swapped.book!.pages, 0, 3);
    expect(summaries(base, swapped)).toEqual(["Pages reordered"]);

    expect(summaries(clone(), base)[0]).toContain("for the first time");
  });
});

describe("moveItem", () => {
  it("moves an item and never mutates or loses anything", () => {
    const list = ["a", "b", "c", "d"];
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an unchanged copy for out-of-range or no-op moves", () => {
    const list = ["a", "b"];
    for (const [from, to] of [[0, 0], [-1, 1], [0, 2], [5, 0]] as const) {
      const out = moveItem(list, from, to);
      expect(out).toEqual(["a", "b"]);
      expect(out).not.toBe(list);
    }
  });
});
