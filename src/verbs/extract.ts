/**
 * Readable-content extraction (R11): rendered HTML -> clean markdown.
 *
 * Pure and browser-free — operates on the HTML the core already rendered, so it is fully
 * unit-testable. Uses Readability for article extraction and Turndown for markdown, and
 * degrades to a direct body conversion (rather than returning empty/garbage) when
 * Readability can't find an article.
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

export interface Extraction {
  title: string;
  markdown: string;
  /** True when Readability found no article and we fell back to a direct conversion. */
  degraded: boolean;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.remove(["script", "style", "noscript", "iframe", "svg"]);

function toMarkdown(html: string): string {
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractMarkdown(html: string, url: string): Extraction {
  void url; // reserved for future base-URL resolution of relative links
  if (!html.trim()) return { title: "", markdown: "", degraded: true };

  // 1) Readability on a parsed DOM (it mutates the doc, so this parse is dedicated to it).
  let title = "";
  try {
    const { document } = parseHTML(html);
    title = document.title ?? "";
    const article = new Readability(document).parse();
    if (article?.content && (article.textContent ?? "").trim().length > 0) {
      const markdown = toMarkdown(article.content);
      if (markdown.length > 0) {
        return { title: article.title || title, markdown, degraded: false };
      }
    }
  } catch {
    // fall through to degradation
  }

  // 2) Degrade: convert the body directly on a fresh parse.
  try {
    const { document } = parseHTML(html);
    title = title || (document.title ?? "");
    const bodyHtml = document.body ? document.body.innerHTML : html;
    return { title, markdown: toMarkdown(bodyHtml), degraded: true };
  } catch {
    return { title, markdown: "", degraded: true };
  }
}
