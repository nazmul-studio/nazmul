import { describe, expect, it } from "vitest";
import { initialContent } from "./content-model";
import { MAX_CONTENT_BYTES, cleanNote, parseContent } from "./content-schema";

const clone = () => JSON.parse(JSON.stringify(initialContent)) as typeof initialContent;

describe("parseContent", () => {
  it("accepts the built-in content unchanged", () => {
    const result = parseContent(initialContent);
    expect(result.issues).toEqual([]);
    expect(result.content).toEqual(initialContent);
  });

  it("rejects non-http(s) links and drops them", () => {
    const input = clone();
    input.github = "javascript:alert(1)";
    input.projects[0]!.url = "data:text/html,hi";
    const result = parseContent(input);
    expect(result.issues.map((i) => i.path).sort()).toEqual(["github", "projects[0].url"]);
    expect(result.content.github).toBe("");
    expect(result.content.projects[0]!.url).toBe("");
  });

  it("accepts https links and a valid email", () => {
    const input = clone();
    input.github = "https://github.com/nazmul";
    input.email = "hello@example.com";
    expect(parseContent(input).issues).toEqual([]);
  });

  it("enforces length limits and the fixed page count", () => {
    const input = clone();
    input.headline = "x".repeat(1001);
    input.achievements = input.achievements.slice(0, 3);
    const paths = parseContent(input).issues.map((i) => i.path);
    expect(paths).toContain("headline");
    expect(paths).toContain("achievements");
  });

  it("requires a project title and caps the number of projects", () => {
    const input = clone();
    input.projects = Array.from({ length: 13 }, () => ({ title: "", category: "", description: "", url: "" }));
    const result = parseContent(input);
    expect(result.issues.some((i) => i.path === "projects")).toBe(true);
    expect(result.content.projects).toHaveLength(12);
  });

  it("never throws on garbage and drops unknown keys", () => {
    expect(parseContent(null).issues.length).toBeGreaterThan(0);
    const input = { ...clone(), evil: "<script>" } as unknown;
    expect("evil" in parseContent(input).content).toBe(false);
  });

  it("accepts content saved before `facebook` and `site` existed, filling in the defaults silently", () => {
    const old = clone() as Record<string, unknown>;
    delete old["facebook"];
    delete old["site"];
    const result = parseContent(old);
    expect(result.issues).toEqual([]);
    expect(result.content.facebook).toBe("");
    expect(result.content.site).toEqual(initialContent.site);
  });

  it("validates the Facebook link like the other links", () => {
    const input = clone();
    input.facebook = "javascript:alert(1)";
    expect(parseContent(input).issues.map((i) => i.path)).toEqual(["facebook"]);
    input.facebook = "https://facebook.com/nazmul";
    expect(parseContent(input).issues).toEqual([]);
  });

  it("requires exactly five chapter names, none empty", () => {
    const input = clone();
    input.site.chapters = ["A", "B", "C"];
    expect(parseContent(input).issues.map((i) => i.path)).toContain("site.chapters");
    const blank = clone();
    blank.site.chapters[2] = "  ";
    expect(parseContent(blank).issues.map((i) => i.path)).toEqual(["site.chapters[2]"]);
  });

  it("limits and validates the tech tags, label texts and SEO fields", () => {
    const many = clone();
    many.site.tech = Array.from({ length: 13 }, (_, i) => `T${i}`);
    const r = parseContent(many);
    expect(r.issues.map((i) => i.path)).toContain("site.tech");
    expect(r.content.site.tech).toHaveLength(12);
    const bad = clone();
    bad.site.seoTitle = "";
    bad.site.contactCta = "x".repeat(61);
    expect(parseContent(bad).issues.map((i) => i.path).sort()).toEqual(["site.contactCta", "site.seoTitle"]);
    const emptyDescription = clone();
    emptyDescription.site.seoDescription = "";
    expect(parseContent(emptyDescription).issues).toEqual([]);
  });

  it("exposes one shared size limit for the server and the Studio's Import button", () => {
    expect(MAX_CONTENT_BYTES).toBe(2_000_000);
  });

  it("requires a name and a wordmark (they are the brand and the 3D lettering)", () => {
    const input = clone();
    input.name = "";
    input.wordmark = "   ";
    expect(parseContent(input).issues.map((i) => i.path).sort()).toEqual(["name", "wordmark"]);
  });

  it("accepts an https share-preview image, refuses plain http or non-links, and treats a missing one as empty", () => {
    const ok = clone();
    ok.site.ogImage = "https://cdn.example/og.png";
    expect(parseContent(ok).issues).toEqual([]);
    const http = clone();
    http.site.ogImage = "http://cdn.example/og.png";
    expect(parseContent(http).issues.map((i) => i.path)).toEqual(["site.ogImage"]);
    expect(parseContent(http).content.site.ogImage).toBe("");
    const junk = clone();
    junk.site.ogImage = "javascript:alert(1)";
    expect(parseContent(junk).content.site.ogImage).toBe("");
    const old = clone() as Record<string, any>;
    delete old["site"].ogImage;
    expect(parseContent(old).issues).toEqual([]);
    expect(parseContent(old).content.site.ogImage).toBe("");
  });

  it("cleans version notes: one line, trimmed, at most 200 characters", () => {
    expect(cleanNote(undefined)).toBe("");
    expect(cleanNote("  a \n\t b  ")).toBe("a b");
    expect(cleanNote("x".repeat(200))).toHaveLength(200);
    expect(cleanNote("x".repeat(201))).toBeNull();
    expect(cleanNote(5)).toBeNull();
  });
});

