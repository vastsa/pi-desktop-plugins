import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PI-Desktop Plugins — Local-first extensions",
    template: "%s — PI-Desktop Plugins",
  },
  description: "Find tools, panels, skills and workflows for your local PI-Desktop workspace.",
  metadataBase: new URL("https://pi-desktop-plugins.vercel.app"),
  openGraph: {
    title: "PI-Desktop Plugins",
    description: "Extend your local AI coding workspace.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
