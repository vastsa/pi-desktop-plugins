"use strict";

/* Git Lens panel renderer — talks to the plugin process through the host
 * bridge. Custom channels (git.*) are forwarded by the host to the plugin's
 * onPanelInvoke. All user-controlled text is inserted with textContent. */

const STRINGS = {
  en: {
    navOverview: "All",
    navHistory: "Log",
    navChanges: "Diff",
    navBranches: "Branch",
    navBlame: "Blame",
    current: "current",
    refresh: "Refresh",
    back: "Back",
    staged: "Staged",
    unstaged: "Unstaged",
    untracked: "Untracked",
    conflicts: "Conflicts",
    recentCommits: "Recent commits",
    changedFiles: "Changed files",
    branch: "Branch",
    upstream: "upstream",
    ahead: "ahead",
    behind: "behind",
    gone: "gone",
    noRepo: "The current project is not a git repository.",
    noWorkspace: "No project is open. Open a project folder, then retry.",
    loading: "Loading…",
    search: "Search commits…",
    author: "Author",
    query: "Query",
    fileFilter: "Path (optional)",
    showPatch: "Show patch",
    hidePatch: "Hide patch",
    commitMessage: "Commit message",
    stageAll: "Stage all changes",
    commit: "Commit",
    amend: "Amend",
    committed: "Committed",
    nothingCommitted: "Nothing to commit — the working tree is clean.",
    branchName: "Branch name",
    startPoint: "Start point (optional)",
    create: "Create",
    switchBranch: "Switch",
    deleteBranch: "Delete",
    deleteBranchConfirm: "Delete branch",
    created: "Created",
    switched: "Switched to",
    deleted: "Deleted",
    blamePath: "Repository-relative file path",
    blame: "Blame",
    line: "Line",
    commit: "Commit",
    date: "Date",
    stash: "Stash",
    stashes: "Stashes",
    stashMessage: "Message (optional)",
    pushStash: "Stash changes",
    popStash: "Pop",
    dropStash: "Drop",
    includeUntracked: "Include untracked",
    stashed: "Stashed",
    popped: "Popped",
    dropped: "Dropped",
    noChanges: "No changed files.",
    noCommits: "No commits found.",
    noBranches: "No local branches.",
    noStashes: "No stashes.",
    noBlame: "Enter a file path to blame.",
    openPanelFailed: "Could not open the Git Lens panel.",
    truncated: "showing first {n}",
    details: "Details",
    pageTitle: "Git Lens",
    viewsAria: "Git Lens pages",
    operationFailed: "operation failed",
    pageOverview: "Overview",
    pageHistory: "History",
    pageChanges: "Changes",
    pageBranches: "Branches",
    pageBlame: "Blame",
  },
  "zh-CN": {
    navOverview: "概览",
    navHistory: "历史",
    navChanges: "改动",
    navBranches: "分支",
    navBlame: "追溯",
    current: "当前",
    refresh: "刷新",
    back: "返回",
    staged: "已暂存",
    unstaged: "未暂存",
    untracked: "未跟踪",
    conflicts: "冲突",
    recentCommits: "最近提交",
    changedFiles: "改动文件",
    branch: "分支",
    upstream: "上游",
    ahead: "领先",
    behind: "落后",
    gone: "已删除",
    noRepo: "当前项目不是 git 仓库。",
    noWorkspace: "未打开项目。请先打开项目文件夹，再重试。",
    loading: "加载中…",
    search: "搜索提交…",
    author: "作者",
    query: "关键词",
    fileFilter: "路径（可选）",
    showPatch: "显示补丁",
    hidePatch: "隐藏补丁",
    commitMessage: "提交说明",
    stageAll: "暂存全部改动",
    commit: "提交",
    amend: "追加到上次提交",
    committed: "已提交",
    nothingCommitted: "没有可提交的内容——工作区是干净的。",
    branchName: "分支名",
    startPoint: "起点（可选）",
    create: "创建",
    switchBranch: "切换",
    deleteBranch: "删除",
    deleteBranchConfirm: "删除分支",
    created: "已创建",
    switched: "已切换到",
    deleted: "已删除",
    blamePath: "仓库相对文件路径",
    blame: "追溯",
    line: "行",
    commit: "提交",
    date: "日期",
    stash: "暂存",
    stashes: "暂存列表",
    stashMessage: "说明（可选）",
    pushStash: "暂存改动",
    popStash: "恢复",
    dropStash: "丢弃",
    includeUntracked: "包含未跟踪文件",
    stashed: "已暂存改动",
    popped: "已恢复",
    dropped: "已丢弃",
    noChanges: "没有改动文件。",
    noCommits: "没有找到提交。",
    noBranches: "没有本地分支。",
    noStashes: "没有暂存记录。",
    noBlame: "输入文件路径后进行逐行追溯。",
    openPanelFailed: "无法打开 Git Lens 面板。",
    truncated: "仅显示前 {n} 条",
    details: "详情",
    pageTitle: "Git Lens",
    viewsAria: "Git Lens 页面",
    operationFailed: "操作失败",
    pageOverview: "概览",
    pageHistory: "历史",
    pageChanges: "改动",
    pageBranches: "分支",
    pageBlame: "追溯",
  },
};

const NAV_ITEMS = [
  { id: "overview", label: "navOverview" },
  { id: "history", label: "navHistory" },
  { id: "diff", label: "navChanges" },
  { id: "branches", label: "navBranches" },
  { id: "blame", label: "navBlame" },
];

let t = STRINGS.en;
let locale = "en";
let currentView = "overview";
let repoRoot = null;
let workspace = null;
let initialPanelState = null;
let historyCache = null;
let diffCache = null;
let blameCache = null;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

function resolveLocale(value) {
  return String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function setLocale(next) {
  locale = resolveLocale(next);
  t = STRINGS[locale] || STRINGS.en;
  document.documentElement.lang = locale;
  document.title = t.pageTitle;
  const nav = $("nav");
  if (nav) nav.setAttribute("aria-label", t.viewsAria);
  const refreshBtn = $("refreshAll");
  if (refreshBtn) {
    refreshBtn.title = t.refresh;
    refreshBtn.setAttribute("aria-label", t.refresh);
  }
}

function bridge(channel, payload) {
  return window.pluginBridge.invoke(channel, payload || {}).then((result) => {
    if (result && typeof result === "object" && result.ok === false) {
      throw new Error(result.error || t.operationFailed);
    }
    return result;
  });
}

function toast(message, kind) {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = el("div", "toast-wrap");
    document.body.appendChild(wrap);
  }
  const node = el("div", `toast ${kind === "error" ? "error" : kind === "ok" ? "ok" : ""}`, message);
  wrap.appendChild(node);
  setTimeout(() => {
    node.remove();
    if (!wrap.children.length) wrap.remove();
  }, 2600);
}

function showBanner(message) {
  const banner = $("banner");
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.textContent = message;
  banner.hidden = false;
}

function fmtDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtCounts(file) {
  const parts = [];
  if (typeof file.additions === "number") parts.push(`+${file.additions}`);
  if (typeof file.deletions === "number") parts.push(`-${file.deletions}`);
  return parts.join(" ");
}

function statusLabel(file) {
  return file.x === "?" && file.y === "?" ? "??" : (file.x + file.y).replace(/ /g, "·");
}

/* ---- navigation -------------------------------------------------------- */

function buildNav() {
  const nav = $("nav");
  nav.textContent = "";
  for (const item of NAV_ITEMS) {
    const button = el("button", "tab", t[item.label]);
    button.type = "button";
    button.dataset.view = item.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", item.id === currentView ? "true" : "false");
    button.addEventListener("click", () => activateView(item.id));
    nav.appendChild(button);
  }
}

function activateView(view) {
  currentView = view;
  for (const item of NAV_ITEMS) {
    const button = navButton(item.id);
    if (button) {
      button.classList.toggle("active", item.id === view);
      button.setAttribute("aria-selected", item.id === view ? "true" : "false");
    }
    const section = $(`view-${item.id}`);
    if (section) section.hidden = item.id !== view;
  }
  renderCurrentView();
}

function navButton(view) {
  return document.querySelector(`.tab[data-view="${view}"]`);
}

/* ---- rendering helpers -------------------------------------------------- */

function emptyState(text) {
  const box = el("div", "empty");
  box.appendChild(el("p", "empty-body", text));
  return box;
}

function sectionTitle(label, count) {
  const title = el("div", "section-title", label);
  if (count !== undefined && count !== null) {
    title.appendChild(el("span", "count", String(count)));
  }
  return title;
}

function grouped(nodes) {
  const group = el("div", "group");
  for (const node of nodes) group.appendChild(node);
  return group;
}

function fileRow(file, onClick) {
  const row = el(onClick ? "button" : "div", "file-row");
  if (onClick) row.type = "button";
  const main = el("div", "cell-main");
  main.appendChild(el("span", "file-path", file.path));
  const trail = el("div", "cell-trail");
  const counts = el("span", "counts");
  if (typeof file.additions === "number" || typeof file.deletions === "number") {
    counts.append(
      el("span", "add", typeof file.additions === "number" ? `+${file.additions} ` : ""),
      el("span", "del", typeof file.deletions === "number" ? `-${file.deletions}` : ""),
    );
    trail.appendChild(counts);
  }
  trail.appendChild(el("span", `status-badge ${file.status || "M"}`, file.status || "M"));
  row.append(main, trail);
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

function commitRow(commit, onClick) {
  const row = el("button", "commit-row");
  row.type = "button";
  const body = el("div", "commit-body");
  body.append(
    el("span", "subject", commit.subject || "—"),
    el("span", "meta", `${commit.shortSha} · ${commit.author} · ${fmtDate(commit.authorDate)}`),
  );
  row.appendChild(body);
  if (onClick) row.addEventListener("click", () => onClick(commit));
  return row;
}

function renderPatch(container, patch) {
  container.textContent = "";
  if (!patch) return;
  const box = el("div", "patch");
  const pre = el("pre");
  const lines = String(patch).replace(/\n$/, "").split("\n");
  for (const line of lines) {
    const lineNode = el("div");
    let cls = "";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) cls = "hunk";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    lineNode.className = cls;
    lineNode.textContent = line;
    pre.appendChild(lineNode);
  }
  box.appendChild(pre);
  container.appendChild(box);
}

/* ---- sheet navigation (list → full-page detail, Back to return) ------ */

function closeSheet(view) {
  if (!view) return;
  view.classList.remove("is-sheet");
  view._sheetStack = [];
  const sheet = view.querySelector(":scope > .sheet");
  if (sheet) sheet.remove();
}

function pushSheet(view, frame) {
  if (!view._sheetStack) view._sheetStack = [];
  view._sheetStack.push(frame);
  view.classList.add("is-sheet");
  renderSheet(view);
}

function popSheet(view) {
  if (!view._sheetStack || !view._sheetStack.length) return;
  view._sheetStack.pop();
  if (!view._sheetStack.length) {
    closeSheet(view);
    return;
  }
  renderSheet(view);
}

function renderSheet(view) {
  const frame = view._sheetStack[view._sheetStack.length - 1];
  let sheet = view.querySelector(":scope > .sheet");
  if (!sheet) {
    sheet = el("div", "sheet");
    view.appendChild(sheet);
  }
  sheet.textContent = "";
  const bar = el("div", "sheet-bar");
  const back = el("button", "sheet-back", t.back);
  back.type = "button";
  back.addEventListener("click", () => popSheet(view));
  bar.append(back, el("div", "sheet-title", frame.title || ""));
  const body = el("div", "sheet-body");
  sheet.append(bar, body);
  Promise.resolve(frame.fill(body)).catch((error) => {
    body.textContent = "";
    body.appendChild(emptyState(error.message || String(error)));
  });
}

function openCommitSheet(view, commit) {
  pushSheet(view, {
    title: commit.shortSha || t.details,
    fill: (body) => fillCommitSheet(view, body, commit),
  });
}

async function fillCommitSheet(view, body, commit) {
  const meta = el("div", "detail-meta");
  meta.append(
    el("span", "", `${commit.author}${commit.authorEmail ? ` <${commit.authorEmail}>` : ""}`),
    el("span", "", fmtDate(commit.authorDate)),
  );
  if (commit.refs) meta.appendChild(el("span", "", commit.refs));
  body.appendChild(meta);
  body.appendChild(el("div", "sheet-subject", commit.subject || "—"));
  if (commit.body) body.appendChild(el("div", "detail-body", commit.body));

  const filesBox = el("div", "group");
  body.appendChild(filesBox);
  try {
    const detail = await bridge("git.show", { ref: commit.sha, stat: true, patch: false });
    if (!detail.files.length) {
      filesBox.appendChild(el("div", "empty", t.noChanges));
      return;
    }
    for (const file of detail.files) {
      filesBox.appendChild(fileRow(file, () => {
        pushSheet(view, {
          title: file.path,
          fill: async (patchBody) => {
            const withPatch = await bridge("git.show", {
              ref: commit.sha,
              path: file.path,
              patch: true,
              stat: false,
            });
            renderPatch(patchBody, withPatch.patch);
            if (!withPatch.patch) patchBody.appendChild(emptyState("—"));
          },
        });
      }));
    }
  } catch (error) {
    filesBox.appendChild(emptyState(error.message || String(error)));
  }
}

function openFileSheet(view, file) {
  pushSheet(view, {
    title: file.path,
    fill: async (body) => {
      try {
        const result = await bridge("git.diff", { path: file.path, patch: true, stat: false });
        renderPatch(body, result.patch);
        if (!result.patch) body.appendChild(emptyState("—"));
      } catch (error) {
        body.appendChild(emptyState(error.message || String(error)));
      }
    },
  });
}

/* ---- view: overview ----------------------------------------------------- */

async function renderOverview() {
  const view = $("view-overview");
  closeSheet(view);
  view.textContent = "";
  const listPane = el("div", "list-pane");
  const status = await bridge("git.status");
  const log = await bridge("git.log", { count: 10 });

  const stats = [
    { label: t.staged, value: status.staged.length, cls: "staged" },
    { label: t.unstaged, value: status.unstaged.length, cls: "unstaged" },
    { label: t.untracked, value: status.untracked.length, cls: "untracked" },
    { label: t.conflicts, value: status.conflicts.length, cls: "conflicts" },
  ];
  const bar = el("div", "counts-bar");
  for (const item of stats) {
    const chip = el("button", "count-chip");
    chip.type = "button";
    const nClass = `n ${item.cls}${item.value === 0 ? " is-zero" : ""}`;
    chip.append(el("span", nClass, String(item.value)), el("span", "k", item.label));
    chip.addEventListener("click", () => activateView("diff"));
    bar.appendChild(chip);
  }
  listPane.appendChild(bar);

  listPane.appendChild(sectionTitle(t.recentCommits, log.commits.length));
  if (!log.commits.length) {
    listPane.appendChild(emptyState(t.noCommits));
  } else {
    listPane.appendChild(grouped(log.commits.map((commit) => (
      commitRow(commit, () => openCommitSheet(view, commit))
    ))));
  }
  view.appendChild(listPane);
}

/* ---- view: history ------------------------------------------------------ */

async function renderHistory() {
  const view = $("view-history");
  closeSheet(view);
  view.textContent = "";

  const listPane = el("div", "list-pane");
  const toolbar = el("div", "toolbar");
  const search = el("input", "input");
  search.placeholder = t.search;
  search.type = "search";
  search.value = historyCache?.query || "";
  const pathInput = el("input", "input");
  pathInput.placeholder = t.fileFilter;
  pathInput.value = historyCache?.path || "";
  toolbar.append(search, pathInput);
  const listBox = el("div");
  listPane.append(toolbar, listBox);
  view.appendChild(listPane);

  const run = async () => {
    closeSheet(view);
    listBox.textContent = "";
    listBox.appendChild(el("div", "loading", t.loading));
    try {
      const payload = { count: 100 };
      if (search.value.trim()) payload.query = search.value.trim();
      if (pathInput.value.trim()) payload.path = pathInput.value.trim();
      const log = await bridge("git.log", payload);
      const focusSha = historyCache?.focusSha || null;
      historyCache = { query: search.value, path: pathInput.value };
      listBox.textContent = "";
      if (!log.commits.length) {
        listBox.appendChild(emptyState(t.noCommits));
        return;
      }
      listBox.appendChild(grouped(log.commits.map((commit) => (
        commitRow(commit, (c) => openCommitSheet(view, c))
      ))));
      if (focusSha) {
        const focus = log.commits.find((c) => c.sha.startsWith(focusSha));
        if (focus) openCommitSheet(view, focus);
      }
    } catch (error) {
      listBox.textContent = "";
      listBox.appendChild(emptyState(error.message || String(error)));
    }
  };

  search.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  run();
}

function openCommitDetail(viewName, sha) {
  if (viewName === "history") {
    historyCache = historyCache || {};
    historyCache.focusSha = sha;
    activateView("history");
  }
}

/* ---- view: changes (diff) ------------------------------------------------ */

async function renderChanges() {
  const view = $("view-diff");
  closeSheet(view);
  view.textContent = "";

  const listPane = el("div", "list-pane");
  const toolbar = el("div", "toolbar");
  const pathInput = el("input", "input");
  pathInput.placeholder = t.fileFilter;
  pathInput.value = diffCache?.path || "";
  toolbar.append(pathInput);
  const groups = el("div");
  listPane.append(toolbar, groups);
  view.appendChild(listPane);
  renderCommitBox(listPane);

  const run = async () => {
    closeSheet(view);
    groups.textContent = "";
    groups.appendChild(el("div", "loading", t.loading));
    try {
      const payload = pathInput.value.trim() ? { path: pathInput.value.trim() } : {};
      const status = await bridge("git.status", payload);
      diffCache = { path: pathInput.value };
      groups.textContent = "";

      const buckets = [
        { title: t.staged, entries: status.staged },
        { title: t.unstaged, entries: status.unstaged },
        { title: t.untracked, entries: status.untracked },
        { title: t.conflicts, entries: status.conflicts },
      ];
      let any = false;
      for (const bucket of buckets) {
        if (!bucket.entries.length) continue;
        any = true;
        groups.appendChild(sectionTitle(bucket.title, bucket.entries.length));
        const rows = bucket.entries.map((entry) => {
          const file = {
            path: entry.path,
            origPath: entry.origPath,
            status: entry.x === "?" && entry.y === "?" ? "U" : entry.y !== " " ? entry.y : entry.x,
          };
          return fileRow(file, () => openFileSheet(view, file));
        });
        groups.appendChild(grouped(rows));
      }
      if (!any) groups.appendChild(emptyState(t.noChanges));
    } catch (error) {
      groups.textContent = "";
      groups.appendChild(emptyState(error.message || String(error)));
    }
  };

  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  run();
}

function renderCommitBox(listPane) {
  const existing = listPane.querySelector(".commit-box");
  if (existing) existing.remove();

  const box = el("div", "commit-box");
  const textarea = el("textarea", "input");
  textarea.rows = 2;
  textarea.placeholder = t.commitMessage;

  const row = el("div", "toolbar");
  const stageLabel = el("label", "", "");
  const stageCheck = el("input");
  stageCheck.type = "checkbox";
  stageCheck.checked = true;
  stageLabel.append(stageCheck, el("span", "", ` ${t.stageAll}`));
  const amendLabel = el("label", "", "");
  const amendCheck = el("input");
  amendCheck.type = "checkbox";
  amendLabel.append(amendCheck, el("span", "", ` ${t.amend}`));
  const commitBtn = el("button", "button primary", t.commit);
  row.append(stageLabel, amendLabel, el("div", "spacer"), commitBtn);
  box.append(textarea, row);
  listPane.appendChild(box);

  commitBtn.addEventListener("click", async () => {
    const message = textarea.value.trim();
    if (!message) {
      toast(t.commitMessage, "error");
      return;
    }
    commitBtn.disabled = true;
    try {
      const result = await bridge("git.commit", {
        message,
        stage: stageCheck.checked ? "all" : "tracked",
        amend: amendCheck.checked,
      });
      toast(`${t.committed} ${result.sha} · ${result.subject}`, "ok");
      textarea.value = "";
      amendCheck.checked = false;
      renderChanges();
    } catch (error) {
      const msg = error.message || String(error);
      toast(msg.includes("nothing to commit") ? t.nothingCommitted : msg, "error");
    } finally {
      commitBtn.disabled = false;
    }
  });
}

/* ---- view: branches ------------------------------------------------------ */

async function renderBranches() {
  const view = $("view-branches");
  closeSheet(view);
  view.textContent = "";

  const listPane = el("div", "list-pane");
  const formRow = el("div", "toolbar");
  const nameInput = el("input", "input");
  nameInput.placeholder = t.branchName;
  nameInput.style.flex = "1";
  const startInput = el("input", "input");
  startInput.placeholder = t.startPoint;
  startInput.style.flex = "1";
  const createBtn = el("button", "button primary", t.create);
  formRow.append(nameInput, startInput, createBtn);
  const listBox = el("div");
  listPane.append(formRow, listBox);
  view.appendChild(listPane);

  const run = async () => {
    listBox.textContent = "";
    listBox.appendChild(el("div", "loading", t.loading));
    try {
      const result = await bridge("git.branch", { action: "list" });
      listBox.textContent = "";
      if (!result.branches.length) {
        listBox.appendChild(emptyState(t.noBranches));
        return;
      }
      const rows = [];
      for (const branch of result.branches) {
        const row = el("div", "branch-row");
        row.append(el("span", "name", branch.name));
        if (branch.name === result.current) row.appendChild(el("span", "current-badge", t.current));
        const last = branch.committerDate
          ? `${fmtDate(branch.committerDate)}${branch.subject ? " · " + branch.subject : ""}`
          : "";
        row.appendChild(el("span", "last", last));
        const actions = el("div", "actions");
        if (branch.name !== result.current) {
          const switchBtn = el("button", "button", t.switchBranch);
          switchBtn.addEventListener("click", async () => {
            try {
              await bridge("git.branch", { action: "switch", name: branch.name });
              toast(`${t.switched} ${branch.name}`, "ok");
              run();
            } catch (error) {
              toast(error.message || String(error), "error");
            }
          });
          actions.appendChild(switchBtn);
          const deleteBtn = el("button", "button danger", t.deleteBranch);
          let arming = false;
          deleteBtn.addEventListener("click", async () => {
            // Two-step confirmation: the sandboxed panel window does not get a
            // reliable window.confirm, so the first click arms the button.
            if (!arming) {
              arming = true;
              deleteBtn.textContent = `${t.deleteBranchConfirm}: ${branch.name}?`;
              setTimeout(() => {
                arming = false;
                deleteBtn.textContent = t.deleteBranch;
              }, 3000);
              return;
            }
            arming = false;
            deleteBtn.disabled = true;
            try {
              await bridge("git.branch", { action: "delete", name: branch.name });
              toast(`${t.deleted} ${branch.name}`, "ok");
              run();
            } catch (error) {
              toast(error.message || String(error), "error");
              deleteBtn.disabled = false;
              deleteBtn.textContent = t.deleteBranch;
            }
          });
          actions.appendChild(deleteBtn);
        }
        row.appendChild(actions);
        rows.push(row);
      }
      listBox.appendChild(grouped(rows));
    } catch (error) {
      listBox.textContent = "";
      listBox.appendChild(emptyState(error.message || String(error)));
    }
  };

  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast(t.branchName, "error");
      return;
    }
    createBtn.disabled = true;
    try {
      const payload = { action: "create", name };
      if (startInput.value.trim()) payload.startPoint = startInput.value.trim();
      await bridge("git.branch", payload);
      toast(`${t.created} ${name}`, "ok");
      nameInput.value = "";
      startInput.value = "";
      run();
    } catch (error) {
      toast(error.message || String(error), "error");
    } finally {
      createBtn.disabled = false;
    }
  });

  run();
}

/* ---- view: blame --------------------------------------------------------- */

async function renderBlame() {
  const view = $("view-blame");
  closeSheet(view);
  view.textContent = "";

  const listPane = el("div", "list-pane");
  const toolbar = el("div", "toolbar");
  const pathInput = el("input", "input");
  pathInput.placeholder = t.blamePath;
  pathInput.value = blameCache?.path || "";
  pathInput.style.flex = "1";
  const go = el("button", "button primary", t.blame);
  toolbar.append(pathInput, go);
  const out = el("div");
  listPane.append(toolbar, out);
  view.appendChild(listPane);

  const run = async () => {
    const pathValue = pathInput.value.trim();
    if (!pathValue) {
      out.textContent = "";
      out.appendChild(emptyState(t.noBlame));
      return;
    }
    out.textContent = "";
    out.appendChild(el("div", "loading", t.loading));
    try {
      const result = await bridge("git.blame", { path: pathValue, limit: 5000 });
      blameCache = { path: pathValue };
      out.textContent = "";
      const table = el("table", "blame-table");
      const headRow = el("tr");
      for (const label of [t.line, t.commit, t.author, t.date, t.commit, ""]) {
        headRow.appendChild(el("th", "", label));
      }
      table.appendChild(headRow);
      for (const line of result.lines) {
        const tr = el("tr");
        tr.append(
          el("td", "num", String(line.finalLine)),
          el("td", "sha", line.sha.slice(0, 7)),
          el("td", "author", line.author),
          el("td", "subject", fmtDate(line.authorTime ? new Date(line.authorTime * 1000).toISOString() : "")),
          el("td", "subject", line.summary),
          el("td", "line", line.content),
        );
        table.appendChild(tr);
      }
      out.appendChild(table);
      if (result.truncated) {
        out.appendChild(el("div", "empty", t.truncated.replace("{n}", String(result.lines.length))));
      }
    } catch (error) {
      out.textContent = "";
      out.appendChild(emptyState(error.message || String(error)));
    }
  };

  go.addEventListener("click", run);
  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  run();
}

/* ---- shared --------------------------------------------------------------- */

function refreshButton() {
  const button = el("button", "icon-button");
  button.title = t.refresh;
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
  button.addEventListener("click", () => renderCurrentView());
  return button;
}

function renderCurrentView() {
  const showBannerMessage = () => {
    if (!repoRoot) showBanner(workspace ? t.noRepo : t.noWorkspace);
    else showBanner(null);
  };
  showBannerMessage();
  const view = $("view-" + currentView);
  closeSheet(view);
  view.textContent = "";
  if (!repoRoot) {
    view.appendChild(emptyState(workspace ? t.noRepo : t.noWorkspace));
    return;
  }
  const renderers = {
    overview: renderOverview,
    history: renderHistory,
    diff: renderChanges,
    branches: renderBranches,
    blame: renderBlame,
  };
  (renderers[currentView] || renderOverview)().catch((error) => {
    view.textContent = "";
    view.appendChild(emptyState(error.message || String(error)));
  });
}

let lastOpenedAt = null;

function applyRequestedState(state) {
  if (!state || !state.view) return false;
  const stamp = state.openedAt || 0;
  if (stamp === lastOpenedAt) return false;
  lastOpenedAt = stamp;
  initialPanelState = state;
  if (state.path) {
    if (state.view === "blame") blameCache = { path: state.path };
    if (state.view === "diff") diffCache = { path: state.path };
    if (state.view === "history") {
      historyCache = historyCache || {};
      historyCache.path = state.path;
    }
  }
  if (state.view === "history" && state.ref) {
    historyCache = historyCache || {};
    historyCache.focusSha = state.ref;
  }
  activateView(state.view);
  return true;
}

function applyHostAppearance(appearance) {
  if (!appearance || typeof appearance !== "object") return;
  if (
    appearance.base !== "light" &&
    appearance.base !== "dark" &&
    appearance.theme !== "light" &&
    appearance.theme !== "dark"
  ) {
    return;
  }
  const adapter = window.__appearance;
  if (adapter && typeof adapter.apply === "function") adapter.apply(appearance);
}

async function syncHostState() {
  const state = await bridge("git.state");
  const repoChanged = repoRoot !== state.repoRoot;
  repoRoot = state.repoRoot;
  workspace = state.workspace;
  applyHostAppearance(state.appearance);
  const switched = applyRequestedState(state.state);
  if (repoChanged && !switched) renderCurrentView();
  if (repoChanged || switched) updateStatus();
}

async function init() {
  setLocale(document.documentElement.lang || document.documentElement.dataset.lang);
  buildNav();
  const refresh = $("refreshAll");
  if (refresh) {
    refresh.title = t.refresh;
    refresh.setAttribute("aria-label", t.refresh);
    refresh.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
    refresh.addEventListener("click", () => {
      updateStatus();
      renderCurrentView();
    });
  }
  const appearance = window.__appearance;
  if (appearance && typeof appearance.init === "function") appearance.init(window.pluginBridge);
  if (appearance && typeof appearance.current === "function") {
    const current = appearance.current();
    if (current && current.locale) setLocale(current.locale);
  }
  if (appearance && typeof appearance.onLocaleChange === "function") {
    appearance.onLocaleChange((next) => {
      setLocale(next);
      buildNav();
      updateStatus();
      renderCurrentView();
    });
  }

  try {
    const state = await bridge("git.state");
    repoRoot = state.repoRoot;
    workspace = state.workspace;
    applyHostAppearance(state.appearance);
    if (!applyRequestedState(state.state)) activateView("overview");
    updateStatus();
  } catch (error) {
    showBanner(error.message || String(error));
    activateView("overview");
  } finally {
    document.documentElement.dataset.booting = "false";
  }

  window.setInterval(() => {
    if (document.hidden) return;
    syncHostState().catch(() => {});
  }, 1000);
}

function updateStatus() {
  const repo = $("repoChip");
  const branch = $("branchChip");
  if (!repo || !branch) return;
  if (!repoRoot) {
    branch.textContent = workspace ? workspace.name : "—";
    repo.textContent = workspace ? t.noRepo : t.noWorkspace;
    repo.title = "";
    return;
  }
  branch.textContent = "…";
  repo.textContent = workspace ? workspace.name : "";
  repo.title = repoRoot || "";
  bridge("git.status").then((status) => {
    branch.textContent = status.branch || "HEAD";
    const bits = [];
    if (workspace?.name) bits.push(workspace.name);
    if (status.upstream) bits.push(status.upstream);
    if (status.ahead) bits.push(`↑${status.ahead}`);
    if (status.behind) bits.push(`↓${status.behind}`);
    repo.textContent = bits.join(" · ") || repoRoot;
    repo.title = status.upstream ? `${status.branch} ↔ ${status.upstream}` : repoRoot;
  }).catch(() => {
    branch.textContent = "—";
  });
}

init().catch((error) => {
  showBanner(error.message || String(error));
});
