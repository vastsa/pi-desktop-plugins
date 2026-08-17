"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyPackageButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button type="button" className="button secondary-button" onClick={copy}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      {copied ? "Copied" : "Copy package URL"}
    </button>
  );
}
