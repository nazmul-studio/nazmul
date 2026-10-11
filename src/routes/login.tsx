import { createFileRoute, redirect } from "@tanstack/react-router";

// Old bookmark: the admin lives at /studio now.
export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    throw redirect({ to: "/studio" });
  },
});
