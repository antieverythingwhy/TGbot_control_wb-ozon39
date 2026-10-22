import { createFileRoute } from "@tanstack/react-router";
import { App } from "@/components/pvz/app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <App />;
}
