import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Listing Matcher",
  description:
    "Match new listings to the right buyers and draft personal emails.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
