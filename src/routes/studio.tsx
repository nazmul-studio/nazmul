import { createFileRoute } from "@tanstack/react-router";
import { StudioGate } from "@/components/studio-gate";

export const Route = createFileRoute("/studio")({
  head: () => ({
    meta: [{ title: "Content Studio" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: StudioGate,
});
