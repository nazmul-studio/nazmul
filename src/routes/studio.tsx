import { createFileRoute } from "@tanstack/react-router";
import { StudioGate } from "@/components/studio-gate";

export const Route = createFileRoute("/studio")({
  head: () => ({
    meta: [{ title: "Nazmul Hasan — Content Studio" }, { name: "description", content: "Manage Nazmul Hasan’s portfolio content and achievement book." }, { property: "og:title", content: "Nazmul Hasan — Content Studio" }, { property: "og:description", content: "Manage portfolio content and the achievement book." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: StudioGate,
});
