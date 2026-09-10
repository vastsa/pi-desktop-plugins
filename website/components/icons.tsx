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
  Palette,
  type LucideIcon,
} from "lucide-react";

export function BrandMark({ className = "" }: { className?: string }) {
  return <img className={className} src="/pi-desktop-icon.png" alt="" aria-hidden="true" width={32} height={32} draggable={false} />;
}

const icons: Record<string, LucideIcon> = {
  "developer-tools": GitBranch,
  productivity: LayoutGrid,
  theme: Palette,
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
