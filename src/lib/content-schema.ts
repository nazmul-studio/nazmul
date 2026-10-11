// Validation for portfolio content. Pure and isomorphic: the Studio uses it for instant
// feedback and the server uses it as the real gate before anything is stored.
import { parseBook } from "./book/validate";
import { mediaNameOfKey } from "./media";
import { initialContent, safeHref, type PageSide, type PortfolioContent, type Project, type SiteText } from "./content-model";

export type Issue = { path: string; message: string };
export type ParseResult = { content: PortfolioContent; issues: Issue[] };

export const LIMITS = {
  single: 300,
  multi: 1000,
  tag: 100,
  title: 100,
  year: 100,
  summary: 450,
  project: 500,
  projects: 12,
  pages: 15,
  chapter: 40,
  chapters: 5,
  tech: 12,
  techItem: 40,
  label: 60,
  seoTitle: 120,
  seoDescription: 300,
  note: 200,
} as const;

/** Largest content document (bytes) the server accepts and the Studio will import. One number, both sides. */
export const MAX_CONTENT_BYTES = 2_000_000;

/** Cleans a version note: single line, trimmed. Returns null when it is too long, so the caller can say so. */
export function cleanNote(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const note = value.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return note.length > LIMITS.note ? null : note;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Kind = "text" | "url" | "email";
type StrOptions = { kind?: Kind; required?: boolean; fallback?: string; silentMissing?: boolean };

function str(value: unknown, path: string, max: number, issues: Issue[], options: StrOptions = {}): string {
  const { kind = "text", required = false, fallback = "", silentMissing = false } = options;
  if (typeof value !== "string") {
    if (!(value === undefined && silentMissing)) issues.push({ path, message: "must be text" });
    return fallback;
  }
  let out = value;
  if (CONTROL.test(out)) {
    issues.push({ path, message: "contains control characters" });
    out = out.replace(CONTROL, "");
  }
  CONTROL.lastIndex = 0;
  if (out.length > max) {
    issues.push({ path, message: `must be at most ${max} characters` });
    out = out.slice(0, max);
  }
  if (kind === "url" || kind === "email") out = out.trim();
  if (kind === "url" && out !== "" && safeHref(out) === "") {
    issues.push({ path, message: "must be a full http(s) link, e.g. https://example.com" });
    out = "";
  }
  if (kind === "email" && out !== "" && !EMAIL.test(out)) {
    issues.push({ path, message: "must be a valid email address" });
    out = "";
  }
  if (required && out.trim() === "") issues.push({ path, message: "is required" });
  return out;
}

function side(raw: unknown, path: string, issues: Issue[], present: boolean): PageSide {
  const r = isRecord(raw) ? raw : {};
  if (present && !isRecord(raw)) issues.push({ path, message: "must be an object" });
  const quiet = !present;
  return {
    tag: str(r["tag"], `${path}.tag`, LIMITS.tag, issues, { silentMissing: quiet }),
    title: str(r["title"], `${path}.title`, LIMITS.title, issues, { silentMissing: quiet }),
    year: str(r["year"], `${path}.year`, LIMITS.year, issues, { silentMissing: quiet }),
    summary: str(r["summary"], `${path}.summary`, LIMITS.summary, issues, { silentMissing: quiet }),
  };
}

/**
 * Link-preview image: optional; an uploaded image ("media:<name>") or an https link (link previews do not load plain
 * http images).
 */
function parseOgImage(raw: unknown, issues: Issue[]): string {
  const value = str(raw, "site.ogImage", LIMITS.single, issues, { silentMissing: true }).trim();
  if (value === "" || mediaNameOfKey(value)) return value;
  if (value.startsWith("media:")) {
    issues.push({ path: "site.ogImage", message: "is not a valid uploaded image" });
    return "";
  }
  if (!/^https:\/\//i.test(value) || safeHref(value) === "") {
    issues.push({ path: "site.ogImage", message: "must be an uploaded image or a link starting with https://" });
    return "";
  }
  return value;
}

/** Cover of the 3D book: optional, and only ever an uploaded image (the 3D scene must read its pixels). */
function parseCoverImage(raw: unknown, issues: Issue[]): string {
  const value = str(raw, "site.coverImage", LIMITS.single, issues, { silentMissing: true }).trim();
  if (value === "" || mediaNameOfKey(value)) return value;
  issues.push({ path: "site.coverImage", message: "must be an uploaded image" });
  return "";
}

/** Site wording + SEO. Older stored content has no `site`, so a missing block or field silently takes the default. */
function parseSite(raw: unknown, issues: Issue[]): SiteText {
  const d = initialContent.site;
  if (raw !== undefined && !isRecord(raw)) issues.push({ path: "site", message: "must be an object" });
  const r = isRecord(raw) ? raw : {};
  const field = (key: "contactCta" | "viewProject" | "seoTitle" | "seoDescription", max: number, required: boolean) =>
    str(r[key], `site.${key}`, max, issues, { fallback: d[key], silentMissing: true, required });

  let chapters: string[];
  const rawChapters = r["chapters"];
  if (rawChapters === undefined) chapters = [...d.chapters];
  else if (!Array.isArray(rawChapters)) {
    issues.push({ path: "site.chapters", message: "must be a list" });
    chapters = [...d.chapters];
  } else {
    if (rawChapters.length !== LIMITS.chapters)
      issues.push({ path: "site.chapters", message: `must contain exactly ${LIMITS.chapters} names` });
    chapters = d.chapters.map((fallback, i) =>
      str(rawChapters[i], `site.chapters[${i}]`, LIMITS.chapter, issues, { fallback, silentMissing: true, required: true }),
    );
  }

  let tech: string[];
  const rawTech = r["tech"];
  if (rawTech === undefined) tech = [...d.tech];
  else if (!Array.isArray(rawTech)) {
    issues.push({ path: "site.tech", message: "must be a list" });
    tech = [...d.tech];
  } else {
    if (rawTech.length > LIMITS.tech) issues.push({ path: "site.tech", message: `can have at most ${LIMITS.tech} tags` });
    tech = rawTech.slice(0, LIMITS.tech).map((t: unknown, i: number) => str(t, `site.tech[${i}]`, LIMITS.techItem, issues, { required: true }));
  }

  return {
    chapters,
    tech,
    contactCta: field("contactCta", LIMITS.label, true),
    viewProject: field("viewProject", LIMITS.label, true),
    seoTitle: field("seoTitle", LIMITS.seoTitle, true),
    seoDescription: field("seoDescription", LIMITS.seoDescription, false),
    ogImage: parseOgImage(r["ogImage"], issues),
    coverImage: parseCoverImage(r["coverImage"], issues),
  };
}

/**
 * Turns unknown input into valid content. It never throws: anything wrong is replaced by a
 * safe default and reported in `issues`. Callers that must be strict reject when issues exist.
 */
export function parseContent(input: unknown): ParseResult {
  const issues: Issue[] = [];
  const root: Record<string, unknown> = isRecord(input) ? input : {};
  if (!isRecord(input)) issues.push({ path: "", message: "must be an object" });
  const d = initialContent;
  // name and wordmark are drawn as the brand and the 3D lettering: they must not be empty.
  const text = (key: "name" | "wordmark" | "projectsTitle" | "bookTitle", required = false) =>
    str(root[key], key, LIMITS.single, issues, { fallback: d[key], required });
  const long = (
    key: "headline" | "introduction" | "aboutTitle" | "about" | "bookDescription" | "contactTitle" | "contactText",
  ) => str(root[key], key, LIMITS.multi, issues, { fallback: d[key] });

  const rawPages = root["achievements"];
  if (!Array.isArray(rawPages)) issues.push({ path: "achievements", message: "must be a list" });
  else if (rawPages.length !== LIMITS.pages)
    issues.push({ path: "achievements", message: `must contain exactly ${LIMITS.pages} pages` });
  const pages: unknown[] = Array.isArray(rawPages) ? rawPages : [];
  const achievements = Array.from({ length: LIMITS.pages }, (_, i) => {
    const raw = pages[i];
    const present = raw !== undefined;
    const path = `achievements[${i}]`;
    const front = side(raw, path, issues, present);
    const back = side(isRecord(raw) ? raw["back"] : undefined, `${path}.back`, issues, present);
    return { ...front, back };
  });

  const rawProjects = root["projects"];
  let projects: Project[];
  if (!Array.isArray(rawProjects)) {
    issues.push({ path: "projects", message: "must be a list" });
    projects = d.projects.map((p) => ({ ...p }));
  } else {
    if (rawProjects.length > LIMITS.projects)
      issues.push({ path: "projects", message: `can have at most ${LIMITS.projects} projects` });
    projects = rawProjects.slice(0, LIMITS.projects).map((raw: unknown, i: number): Project => {
      const path = `projects[${i}]`;
      const r = isRecord(raw) ? raw : {};
      if (!isRecord(raw)) issues.push({ path, message: "must be an object" });
      return {
        title: str(r["title"], `${path}.title`, LIMITS.project, issues, { required: true }),
        category: str(r["category"], `${path}.category`, LIMITS.project, issues),
        description: str(r["description"], `${path}.description`, LIMITS.project, issues),
        url: str(r["url"], `${path}.url`, LIMITS.project, issues, { kind: "url" }),
      };
    });
  }

  const content: PortfolioContent = {
    name: text("name", true),
    wordmark: text("wordmark", true),
    headline: long("headline"),
    introduction: long("introduction"),
    aboutTitle: long("aboutTitle"),
    about: long("about"),
    projectsTitle: text("projectsTitle"),
    bookTitle: text("bookTitle"),
    bookDescription: long("bookDescription"),
    contactTitle: long("contactTitle"),
    contactText: long("contactText"),
    email: str(root["email"], "email", LIMITS.single, issues, { kind: "email" }),
    github: str(root["github"], "github", LIMITS.single, issues, { kind: "url" }),
    linkedin: str(root["linkedin"], "linkedin", LIMITS.single, issues, { kind: "url" }),
    // Added later: content saved before it existed has no `facebook`, which is fine.
    facebook: str(root["facebook"], "facebook", LIMITS.single, issues, { kind: "url", silentMissing: true }),
    site: parseSite(root["site"], issues),
    achievements,
    projects,
  };
  if (root["book"] !== undefined) {
    const parsed = parseBook(root["book"]);
    issues.push(...parsed.issues);
    content.book = parsed.book;
  }
  return { content, issues };
}
