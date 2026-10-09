import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Invoice Generator — Create Your Invoice" },
      { name: "description", content: "Create invoices with your business details, payment instructions, and item totals." },
      { property: "og:title", content: "Invoice Generator — Create Your Invoice" },
      { property: "og:description", content: "Create invoices with your business details, payment instructions, and item totals." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <iframe
      className="invoice-original"
      src="/invoice-generator.html"
      title="Invoice Generator"
    />
  );
}
