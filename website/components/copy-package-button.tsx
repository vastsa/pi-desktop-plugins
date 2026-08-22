"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { Locale } from "../lib/i18n";
import { getCopy } from "../lib/i18n";

export function CopyPackageButton({ url, locale }: { url: string; locale: Locale }) {
  const [copied, setCopied] = useState(false);
  const copyLabels = getCopy(locale);

  async function copyPackageUrl() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button type="button" className="button secondary-button" onClick={copyPackageUrl}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      {copied ? copyLabels.detail.copied : copyLabels.detail.copyUrl}
    </button>
  );
}
