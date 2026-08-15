"use strict";

/* Git Lens panel renderer — talks to the plugin process through the host
 * bridge. Custom channels (git.*) are forwarded by the host to the plugin's
 * onPanelInvoke. All user-controlled text is inserted with textContent. */

const STRINGS = {
  en: {
    navOverview: "Overview",
    navHistory: "History",
    navChanges: "Changes",
    navBranches: "Branches",
    navBlame: "Blame",
    refresh: "Refresh",
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
  },
  "zh-CN": {
    navOverview: "概览",
    navHistory: "历史",
    navChanges: "改动",
    navBranches: "分支",
    navBlame: "逐行追溯",
    refresh: "刷新",
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
  },
};

const NAV_ITEMS = [
  { id: "overview", icon: "M3 4h18v16H3z M3 9h18 M9 4v16", label: "navOverview" },
  { id: "history", icon: "M4 5h16M4 12h16M4 19h10 M15 19l3 3 5-5", label: "navHistory" },
  { id: "diff", icon: "M12 3v18M4 8l-2 4 2 4M20 8l2 4-2 4", label: "navChanges" },
  { id: "branches", icon: "M6 3v12M6 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM18 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6 6h8a4 4 0 0 1 4 4", label: "navBranches" },
  { id: "blame", icon: "M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4", label: "navBlame" },
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

function bridge(channel, payload) {
  return window.pluginBridge.invoke(channel, payload || {}).then((result) => {
    if (result && typeof result === "object" && result.ok === false) {
      throw new Error(result.error || "operation failed");
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
    const button = el("button", "nav-item");
    button.type = "button";
    button.dataset.view = item.id;
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${item.icon}"/></svg>`;
    button.appendChild(el("span", "", t[item.label]));
    button.addEventListener("click", () => activateView(item.id));
    nav.appendChild(button);
  }
}

function activateView(view) {
  currentView = view;
  for (const item of NAV_ITEMS) {
    const button = navButton(item.id);
    if (button) button.classList.toggle("active", item.id === view);
    const section = $(`view-${item.id}`);
    if (section) section.hidden = item.id !== view;
  }
  renderCurrentView();
}

function navButton(view) {
  return document.querySelector(`.nav-item[data-view="${view}"]`);
}

/* ---- rendering helpers -------------------------------------------------- */

function emptyState(text) {
  const box = el("div", "empty", text);
  return box;
}

function fileRow(file, onClick) {
  const row = el("div", "file-row");
  const badge = el("span", `status-badge ${file.status || "M"}`, file.status || "M");
  const pathNode = el("span", "file-path", file.path);
  const counts = el("span", "counts");
  if (typeof file.additions === "number" || typeof file.deletions === "number") {
    counts.append(
      el("span", "add", typeof file.additions === "number" ? `+${file.additions} ` : ""),
      el("span", "del", typeof file.deletions === "number" ? `-${file.deletions}` : ""),
    );
  }
  row.append(badge, pathNode, counts);
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

function commitRow(commit, onClick) {
  const row = el("div", "commit-row");
  row.append(
    el("span", "sha", commit.shortSha),
    el("span", "subject", commit.subject || "—"),
    el("span", "meta", `${commit.author} · ${fmtDate(commit.authorDate)}`),
  );
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

/* ---- view: overview ----------------------------------------------------- */

async function renderOverview() {
  const view = $("view-overview");
  view.textContent = "";
  const status = await bridge("git.status");
  const log = await bridge("git.log", { count: 10 });

  const grid = el("div", "stat-grid");
  const stats = [
    { label: t.staged, value: status.staged.length, cls: "staged" },
    { label: t.unstaged, value: status.unstaged.length, cls: "unstaged" },
    { label: t.untracked, value: status.untracked.length, cls: "untracked" },
    { label: t.conflicts, value: status.conflicts.length, cls: "conflicts" },
  ];
  for (const item of stats) {
    const stat = el("div", "stat");
    stat.append(el("div", `value ${item.cls}`, String(item.value)), el("div", "label", item.label));
    grid.appendChild(stat);
  }
  view.appendChild(grid);

  view.appendChild(el("div", "section-title", t.recentCommits));
  const list = el("div", "commit-list");
  if (!log.commits.length) list.appendChild(emptyState(t.noCommits));
  for (const commit of log.commits) {
    list.appendChild(commitRow(commit, () => openCommitDetail("history", commit.sha)));
  }
  view.appendChild(list);
}

/* ---- view: history ------------------------------------------------------ */

async function renderHistory() {
  const view = $("view-history");
  view.textContent = "";

  const toolbar = el("div", "toolbar");
  const search = el("input", "input");
  search.placeholder = t.search;
  search.type = "search";
  search.value = historyCache?.query || "";
  const pathInput = el("input", "input");
  pathInput.placeholder = t.fileFilter;
  pathInput.value = historyCache?.path || "";
  const go = el("button", "button primary", t.refresh);
  toolbar.append(search, pathInput, go, el("div", "spacer"), refreshButton());
  view.appendChild(toolbar);

  const listBox = el("div", "commit-list");
  const detailBox = el("div", "detail");
  detailBox.hidden = true;
  view.append(listBox, detailBox);

  let current = null;
  const run = async () => {
    listBox.textContent = "";
    listBox.appendChild(el("div", "loading", t.loading));
    try {
      const payload = { count: 100 };
      if (search.value.trim()) payload.query = search.value.trim();
      if (pathInput.value.trim()) payload.path = pathInput.value.trim();
      const log = await bridge("git.log", payload);
      historyCache = { query: search.value, path: pathInput.value };
      listBox.textContent = "";
      if (!log.commits.length) {
        listBox.appendChild(emptyState(t.noCommits));
        return;
      }
      for (const commit of log.commits) {
        listBox.appendChild(commitRow(commit, (c) => {
          current = c;
          renderCommitDetail(detailBox, c);
        }));
      }
      let focus = current;
      if (historyCache && historyCache.focusSha) {
        focus = log.commits.find((c) => c.sha.startsWith(historyCache.focusSha)) || current;
        historyCache.focusSha = null;
      }
      if (focus) {
        current = focus;
        detailBox.hidden = false;
        renderCommitDetail(detailBox, focus);
      }
    } catch (error) {
      listBox.textContent = "";
      listBox.appendChild(emptyState(error.message || String(error)));
    }
  };

  go.addEventListener("click", run);
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  run();
}

async function renderCommitDetail(box, commit) {
  box.hidden = false;
  box.textContent = "";
  const head = el("div", "detail-head");
  head.append(
    el("span", "sha", commit.shortSha),
    el("strong", "", commit.subject || ""),
    el("div", "spacer"),
    el("button", "button", t.details + " · " + t.showPatch),
  );
  const showPatchBtn = head.lastChild;
  box.appendChild(head);

  const meta = el("div", "detail-meta");
  meta.append(
    el("span", "", `${t.author}: ${commit.author} <${commit.authorEmail}>`),
    el("span", "", `${t.date}: ${fmtDate(commit.authorDate)}`),
  );
  if (commit.refs) meta.appendChild(el("span", "", commit.refs));
  box.appendChild(meta);

  if (commit.body) box.appendChild(el("div", "detail-body", commit.body));

  const filesBox = el("div", "file-list");
  const patchBox = el("div");
  patchBox.hidden = true;
  box.append(filesBox, patchBox);

  try {
    const detail = await bridge("git.show", { ref: commit.sha, stat: true, patch: false });
    for (const file of detail.files) {
      filesBox.appendChild(fileRow(file, async () => {
        patchBox.textContent = "";
        const withPatch = await bridge("git.show", { ref: commit.sha, path: file.path, patch: true, stat: false });
        renderPatch(patchBox, withPatch.patch);
      }));
    }
  } catch (error) {
    filesBox.appendChild(emptyState(error.message || String(error)));
  }

  showPatchBtn.addEventListener("click", async () => {
    if (!patchBox.hidden) {
      patchBox.hidden = true;
      showPatchBtn.textContent = t.details + " · " + t.showPatch;
      return;
    }
    patchBox.hidden = false;
    if (!patchBox.childElementCount) {
      try {
        const withPatch = await bridge("git.show", { ref: commit.sha, patch: true, stat: false });
        renderPatch(patchBox, withPatch.patch);
      } catch (error) {
        patchBox.appendChild(emptyState(error.message || String(error)));
      }
    }
    showPatchBtn.textContent = t.details + " · " + t.hidePatch;
  });
}

function openCommitDetail(viewName, sha) {
  if (viewName === "history") {
    activateView("history");
    const detailBox = document.querySelector("#view-history .detail");
    // The history view refetches on activate; stash the sha to open after render.
    historyCache = historyCache || {};
    historyCache.focusSha = sha;
  }
}

/* ---- view: changes (diff) ------------------------------------------------ */

async function renderChanges() {
  const view = $("view-diff");
  view.textContent = "";

  const toolbar = el("div", "toolbar");
  const pathInput = el("input", "input");
  pathInput.placeholder = t.fileFilter;
  pathInput.value = diffCache?.path || "";
  const go = el("button", "button primary", t.refresh);
  toolbar.append(pathInput, go, el("div", "spacer"), refreshButton());
  view.appendChild(toolbar);

  const groups = el("div");
  const detailBox = el("div");
  detailBox.hidden = true;
  view.append(groups, detailBox);

  const run = async () => {
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
        groups.appendChild(el("div", "section-title", `${bucket.title} (${bucket.entries.length})`));
        const list = el("div", "file-list");
        for (const entry of bucket.entries) {
          const file = {
            path: entry.path,
            origPath: entry.origPath,
            status: entry.x === "?" && entry.y === "?" ? "U" : entry.y !== " " ? entry.y : entry.x,
          };
          list.appendChild(fileRow(file, () => openFileDiff(detailBox, file, status)));
        }
        groups.appendChild(list);
      }
      if (!any) groups.appendChild(emptyState(t.noChanges));

      renderCommitBox(view, detailBox);
    } catch (error) {
      groups.textContent = "";
      groups.appendChild(emptyState(error.message || String(error)));
    }
  };

  go.addEventListener("click", run);
  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  run();
}

async function openFileDiff(box, file, status) {
  box.hidden = false;
  box.textContent = "";
  const head = el("div", "detail-head");
  head.append(el("span", "sha", file.status), el("strong", "", file.path));
  box.appendChild(head);
  const patchBox = el("div");
  box.appendChild(patchBox);
  try {
    const result = await bridge("git.diff", { path: file.path, patch: true, stat: false });
    renderPatch(patchBox, result.patch);
    if (!result.patch) patchBox.appendChild(emptyState("—"));
  } catch (error) {
    patchBox.appendChild(emptyState(error.message || String(error)));
  }
}

function renderCommitBox(view, detailBox) {
  const existing = document.querySelector("#view-diff .commit-box");
  if (existing) existing.remove();

  const box = el("div", "card commit-box");
  const title = el("div", "section-title", t.commit);
  const textarea = el("textarea", "input");
  textarea.rows = 2;
  textarea.placeholder = t.commitMessage;
  textarea.style.width = "100%";
  textarea.style.resize = "vertical";

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
  box.append(title, textarea, row);
  view.appendChild(box);

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
      detailBox.hidden = true;
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
  view.textContent = "";

  const toolbar = el("div", "toolbar");
  toolbar.append(el("div", "spacer"), refreshButton());
  view.appendChild(toolbar);

  const card = el("div", "card");
  const formRow = el("div", "toolbar");
  const nameInput = el("input", "input");
  nameInput.placeholder = t.branchName;
  const startInput = el("input", "input");
  startInput.placeholder = t.startPoint;
  const createBtn = el("button", "button primary", t.create);
  formRow.append(nameInput, startInput, createBtn);
  card.append(el("div", "section-title", t.create), formRow);
  view.appendChild(card);

  const listBox = el("div", "commit-list");
  view.appendChild(listBox);

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
      for (const branch of result.branches) {
        const row = el("div", "branch-row");
        row.append(el("span", "name", branch.name));
        if (branch.name === result.current) row.appendChild(el("span", "current-badge", t.branch));
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
        listBox.appendChild(row);
      }
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
  view.textContent = "";

  const toolbar = el("div", "toolbar");
  const pathInput = el("input", "input");
  pathInput.placeholder = t.blamePath;
  pathInput.value = blameCache?.path || "";
  pathInput.style.flex = "1";
  const go = el("button", "button primary", t.blame);
  toolbar.append(pathInput, go, el("div", "spacer"), refreshButton());
  view.appendChild(toolbar);

  const out = el("div");
  view.appendChild(out);

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

async function init() {
  buildNav();
  const appearance = window.__appearance;
  if (appearance && typeof appearance.init === "function") appearance.init(window.pluginBridge);
  if (appearance && typeof appearance.onLocaleChange === "function") {
    appearance.onLocaleChange((next) => {
      locale = next;
      t = STRINGS[next] || STRINGS.en;
      buildNav();
      renderCurrentView();
    });
  }

  try {
    const state = await bridge("git.state");
    repoRoot = state.repoRoot;
    workspace = state.workspace;
    initialPanelState = state.state;
    if (initialPanelState && initialPanelState.view) {
      activateView(initialPanelState.view);
      if (initialPanelState.path) {
        if (initialPanelState.view === "blame") blameCache = { path: initialPanelState.path };
        if (initialPanelState.view === "diff") diffCache = { path: initialPanelState.path };
        if (initialPanelState.view === "history") {
          historyCache = historyCache || {};
          historyCache.path = initialPanelState.path;
        }
      }
      if (initialPanelState.view === "history" && initialPanelState.ref) {
        historyCache = historyCache || {};
        historyCache.focusSha = initialPanelState.ref;
      }
    } else {
      activateView("overview");
    }
    updateChips();
  } catch (error) {
    showBanner(error.message || String(error));
    activateView("overview");
  }
}

function updateChips() {
  const repoChip = $("repoChip");
  repoChip.textContent = "";
  repoChip.append(el("span", "dot"), el("span", "", workspace ? workspace.name : "—"));
  repoChip.title = repoRoot || "";
  const branchChip = $("branchChip");
  branchChip.textContent = "";
  if (repoRoot) {
    bridge("git.status").then((status) => {
      branchChip.append(el("span", "dot"), el("span", "", status.branch || "HEAD"));
      branchChip.title = status.upstream
        ? `${status.branch} ↔ ${status.upstream}`
        : status.branch || "";
    }).catch(() => {
      branchChip.append(el("span", "dot"), el("span", "", "—"));
    });
  } else {
    branchChip.append(el("span", "dot"), el("span", "", "—"));
  }
}

init().catch((error) => {
  showBanner(error.message || String(error));
});
