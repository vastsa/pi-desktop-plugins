import {
  BarChart3,
  Calculator,
  FileText,
  FlaskConical,
  FolderKanban,
  GitBranch,
  Globe2,
  LayoutGrid,
  ListTodo,
  NotebookPen,
  type LucideIcon,
} from "lucide-react";

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="34" height="34" rx="10" fill="currentColor" />
      <path d="M10 11.5h16M10 17.9h10.5M10 24.3h16" stroke="var(--brand-mark-line)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="25.3" cy="17.9" r="2.7" fill="var(--brand-mark-dot)" />
    </svg>
  );
}

const icons: Record<string, LucideIcon> = {
  "developer-tools": GitBranch,
  productivity: LayoutGrid,
  community: Globe2,
  official: FlaskConical,
  template: FolderKanban,
  "pi.gitlens": GitBranch,
  "pi.token-insights": BarChart3,
  "pi.markdown": NotebookPen,
  "pi.todo": ListTodo,
  "pi.scratch-calc": Calculator,
  "pi.super-domain-man": Globe2,
  "demo.workspace-summary": FolderKanban,
  "demo.workspace-notes": FileText,
};

export function PluginIcon({ id, category }: { id?: string; category?: string }) {
  const Icon = (id && icons[id]) || (category && icons[category]) || LayoutGrid;
  return <Icon size={20} strokeWidth={1.8} aria-hidden="true" />;
}
