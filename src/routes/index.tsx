import { createFileRoute } from "@tanstack/react-router";
import { Portfolio } from "@/components/portfolio";
import { SITE_URL } from "@/lib/site";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      ...(SITE_URL
        ? [
            { property: "og:url", content: `${SITE_URL}/` },
          ]
        : []),
    ],
    links: SITE_URL ? [{ rel: "canonical", href: `${SITE_URL}/` }] : [],
  }),
  component: Portfolio,
});
