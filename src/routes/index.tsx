import { createFileRoute } from "@tanstack/react-router";
import { Portfolio } from "@/components/portfolio";
import { initialContent } from "@/lib/content-model";
import { SITE_URL } from "@/lib/site";

export const Route = createFileRoute("/")({
  head: ({ matches }) => {
    const data = matches[0]?.loaderData as { content?: typeof initialContent } | undefined;
    const content = data?.content ?? initialContent;
    return ({
    meta: [
      { title: content.site.seoTitle },
      { name: "description", content: content.site.seoDescription },
      { property: "og:title", content: content.site.seoTitle },
      { property: "og:description", content: content.site.seoDescription },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      ...(SITE_URL
        ? [
            { property: "og:url", content: `${SITE_URL}/` },
          ]
        : []),
    ],
    links: SITE_URL ? [{ rel: "canonical", href: `${SITE_URL}/` }] : [],
  }); },
  component: Portfolio,
});
