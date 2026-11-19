/**
 * 面板样式：只使用宿主 token，类名前缀 `dbqa-`（AGENTS.md R23）。
 *
 * 设计基线：紧凑的开发者工具密度、8px 间距节奏、4.5:1 文本对比、
 * 键盘可见焦点、`prefers-reduced-motion` 降级。
 *
 * @module
 */
export const STYLES = `
.dbqa-root {
  display:flex; flex-direction:column; height:100%; min-height:0;
  color:var(--dsw-alias-text, #1f2328);
  background:var(--dsw-alias-bg, transparent);
  font-size:13px; line-height:1.5;
}
.dbqa-root :focus-visible { outline:2px solid var(--dsw-alias-accent, #2563eb); outline-offset:2px; }
.dbqa-sr-only {
  position:absolute; width:1px; height:1px; margin:-1px; padding:0;
  overflow:hidden; clip:rect(0 0 0 0); clip-path:inset(50%); white-space:nowrap; border:0;
}

/* ── 顶部 ─────────────────────────────────────────────── */
.dbqa-header {
  display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding:16px 22px 12px;
  border-bottom:1px solid var(--dsw-alias-border, #e5e7eb);
}
.dbqa-heading { display:flex; align-items:center; gap:12px; min-width:0; }
.dbqa-heading-text { min-width:0; }
.dbqa-brand-mark {
  flex:none; display:grid; place-items:center; width:34px; height:34px;
  border-radius:10px;
  background:var(--dsw-alias-bg-subtle, #f3f4f6);
  color:var(--dsw-alias-accent, #2563eb);
  border:1px solid var(--dsw-alias-border, #e5e7eb);
}
.dbqa-title { margin:0; font-size:16px; font-weight:600; line-height:1.35; letter-spacing:-.01em; }
.dbqa-subtitle { margin:3px 0 0; color:var(--dsw-alias-text-secondary, #6b7280); font-size:12px; line-height:1.5; }
.dbqa-header-action { flex:none; }
.dbqa-body { flex:1; min-height:0; overflow:auto; padding:16px 22px 28px; }

/* ── 通用按钮 ─────────────────────────────────────────── */
.dbqa-button {
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  min-height:30px; padding:0 12px;
  border:1px solid var(--dsw-alias-border, #d0d7de);
  border-radius:8px;
  background:var(--dsw-alias-bg-elevated, #fff);
  color:inherit; font:inherit; font-size:13px; line-height:1;
  white-space:nowrap; cursor:pointer;
  transition:background-color .14s ease, border-color .14s ease, color .14s ease, box-shadow .14s ease;
}
.dbqa-button:hover:not(:disabled) {
  border-color:var(--dsw-alias-accent, #2563eb);
  background:var(--dsw-alias-bg-subtle, #f9fafb);
}
.dbqa-button:active:not(:disabled) { transform:translateY(.5px); }
.dbqa-button:disabled { opacity:.55; cursor:default; }
.dbqa-button--primary {
  background:var(--dsw-alias-accent, #2563eb);
  border-color:var(--dsw-alias-accent, #2563eb);
  color:#fff;
  box-shadow:0 1px 2px rgba(15, 23, 42, .16);
}
.dbqa-button--primary:hover:not(:disabled) {
  background:var(--dsw-alias-accent, #2563eb);
  filter:brightness(1.06);
}
.dbqa-button--ghost { background:transparent; border-color:transparent; color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-button--ghost:hover:not(:disabled) { background:var(--dsw-alias-bg-subtle, #f3f4f6); color:var(--dsw-alias-text, #1f2328); }
.dbqa-button--selected { background:var(--dsw-alias-bg-subtle, #f3f4f6); color:var(--dsw-alias-text, #1f2328); }
.dbqa-button--danger { color:var(--dsw-alias-danger, #b91c1c); border-color:var(--dsw-alias-danger, #b91c1c); }
.dbqa-button--danger:hover:not(:disabled) { background:var(--dsw-alias-danger-bg, #fef2f2); border-color:var(--dsw-alias-danger, #b91c1c); }
.dbqa-button--link { border-color:transparent; background:transparent; padding:2px 4px; min-height:24px; color:var(--dsw-alias-accent, #2563eb); }
.dbqa-button--link:hover:not(:disabled) { background:transparent; text-decoration:underline; }
.dbqa-button--sm { min-height:26px; padding:0 9px; font-size:12px; }
.dbqa-icon-button {
  display:inline-flex; align-items:center; justify-content:center; flex:none;
  width:30px; height:30px; padding:0;
  border:1px solid var(--dsw-alias-border, #d0d7de); border-radius:8px;
  background:var(--dsw-alias-bg-elevated, #fff); color:inherit; cursor:pointer;
  transition:background-color .14s ease, border-color .14s ease, color .14s ease;
}
.dbqa-icon-button:hover:not(:disabled) { border-color:var(--dsw-alias-accent, #2563eb); color:var(--dsw-alias-accent, #2563eb); }
.dbqa-icon-button:disabled { opacity:.5; cursor:default; }
.dbqa-icon-button--danger:hover:not(:disabled) { border-color:var(--dsw-alias-danger, #b91c1c); color:var(--dsw-alias-danger, #b91c1c); }
.dbqa-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dbqa-row-actions { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }

/* ── 页头 / 分区 ──────────────────────────────────────── */
.dbqa-page-head {
  display:flex; align-items:flex-start; justify-content:space-between; gap:16px;
  margin:0 0 16px;
}
.dbqa-page-head-text { min-width:0; }
.dbqa-section-title {
  display:flex; align-items:center; gap:8px;
  margin:0; font-size:15px; font-weight:600; line-height:1.4; letter-spacing:-.005em;
}
.dbqa-section-title::before {
  content:''; flex:none; width:3px; height:14px; border-radius:2px;
  background:var(--dsw-alias-accent, #2563eb);
}
.dbqa-title-row { display:flex; align-items:center; gap:6px; margin-left:-6px; }
.dbqa-title-row .dbqa-back {
  width:26px; height:26px; border-color:transparent; background:transparent;
  color:var(--dsw-alias-text-secondary, #6b7280);
}
.dbqa-title-row .dbqa-back:hover { border-color:transparent; color:var(--dsw-alias-text, #1f2328); background:var(--dsw-alias-bg-subtle, #f3f4f6); }
.dbqa-title-row + .dbqa-subtitle { margin-left:34px; }
.dbqa-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 12px; }
.dbqa-toolbar h2 { margin:0; font-size:15px; }
.dbqa-notice {
  margin:0 0 12px; padding:9px 12px; border-radius:9px;
  background:var(--dsw-alias-warning-bg, #fff7ed);
  border:1px solid var(--dsw-alias-warning-border, #fdba74);
  color:var(--dsw-alias-warning-text, #9a3412);
}
.dbqa-error-bar {
  margin:0 0 12px; padding:9px 12px; border-radius:9px;
  background:var(--dsw-alias-danger-bg, #fef2f2);
  border:1px solid var(--dsw-alias-danger, #fca5a5);
  color:var(--dsw-alias-danger, #b91c1c);
}
.dbqa-muted { color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-mono {
  font-family:var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size:12px;
  font-variant-numeric:tabular-nums;
}
.dbqa-hint { color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-loading { padding:24px; color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-toast { margin-left:12px; color:var(--dsw-alias-success, #15803d); }

/* ── 空态 ─────────────────────────────────────────────── */
.dbqa-empty {
  display:flex; flex-direction:column; align-items:center; gap:8px;
  padding:44px 20px; text-align:center;
  border:1px dashed var(--dsw-alias-border, #d0d7de); border-radius:14px;
  background:var(--dsw-alias-bg, transparent);
}
.dbqa-empty-icon {
  display:grid; place-items:center; width:44px; height:44px; margin-bottom:2px;
  border-radius:12px; background:var(--dsw-alias-bg-subtle, #f3f4f6);
  color:var(--dsw-alias-text-secondary, #6b7280);
}
.dbqa-empty h3 { margin:0; font-size:14px; font-weight:600; }
.dbqa-empty p { margin:0; max-width:46ch; color:var(--dsw-alias-text-secondary, #6b7280); line-height:1.65; }
.dbqa-empty-note { font-size:12px; }
.dbqa-home-empty-actions { justify-content:center; margin-top:6px; }

/* ── 标签页 / 计数 ────────────────────────────────────── */
.dbqa-tabs {
  display:inline-flex; gap:2px; padding:2px;
  border-radius:9px; background:var(--dsw-alias-bg-subtle, #f3f4f6);
}
.dbqa-tab {
  min-height:28px; padding:0 12px;
  border:0; border-radius:7px; background:transparent;
  color:var(--dsw-alias-text-secondary, #6b7280);
  font:inherit; font-size:13px; white-space:nowrap; cursor:pointer;
  transition:background-color .14s ease, color .14s ease, box-shadow .14s ease;
}
.dbqa-tab:hover { color:var(--dsw-alias-text, #1f2328); }
.dbqa-tab--active {
  background:var(--dsw-alias-bg-elevated, #fff);
  color:var(--dsw-alias-text, #1f2328);
  font-weight:600;
  box-shadow:0 1px 2px rgba(15, 23, 42, .12);
}
.dbqa-count {
  color:var(--dsw-alias-text-secondary, #6b7280);
  font-size:12px; font-variant-numeric:tabular-nums;
}

/* ── 统计卡 ───────────────────────────────────────────── */
.dbqa-stats {
  display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));
  gap:10px; margin:0 0 14px;
}
.dbqa-stat {
  display:flex; flex-direction:column; gap:2px;
  padding:11px 14px;
  border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:11px;
  background:var(--dsw-alias-bg-elevated, #fff);
}
.dbqa-stat-value { font-size:20px; font-weight:600; line-height:1.2; font-variant-numeric:tabular-nums; }
.dbqa-stat-label { color:var(--dsw-alias-text-secondary, #6b7280); font-size:11.5px; }
.dbqa-stat--ok .dbqa-stat-value { color:var(--dsw-alias-success, #16a34a); }
.dbqa-stat--warn .dbqa-stat-value { color:var(--dsw-alias-warning-text, #b45309); }

/* ── 数据源表格 ───────────────────────────────────────── */
.dbqa-table-wrap {
  overflow-x:auto;
  border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:12px;
  background:var(--dsw-alias-bg-elevated, #fff);
}
.dbqa-table { width:100%; min-width:680px; border-collapse:collapse; }
.dbqa-table th, .dbqa-table td {
  text-align:left; padding:10px 12px;
  border-bottom:1px solid var(--dsw-alias-border, #e5e7eb);
  vertical-align:middle;
}
.dbqa-table th {
  position:sticky; top:0; z-index:1;
  background:var(--dsw-alias-bg-subtle, #f9fafb);
  color:var(--dsw-alias-text-secondary, #6b7280);
  font-size:11.5px; font-weight:600; letter-spacing:.02em;
}
.dbqa-table tbody tr:last-child td { border-bottom:0; }
.dbqa-table tbody tr { transition:background-color .12s ease; }
.dbqa-table tbody tr:hover { background:var(--dsw-alias-bg-subtle, #f9fafb); }
.dbqa-ds-name { font-weight:600; line-height:1.4; }
.dbqa-ds-sub { margin-top:2px; color:var(--dsw-alias-text-secondary, #6b7280); font-size:11.5px; line-height:1.45; }
.dbqa-ds-actions-head { text-align:right; }
.dbqa-ds-actions { justify-content:flex-end; flex-wrap:nowrap; }
.dbqa-endpoint {
  display:inline-block; max-width:38ch;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-text-secondary, #6b7280);
}
.dbqa-type {
  display:inline-block; padding:2px 8px; border-radius:999px;
  background:var(--dsw-alias-bg-subtle, #f3f4f6);
  border:1px solid var(--dsw-alias-border, #e5e7eb);
  color:var(--dsw-alias-text-secondary, #6b7280);
  font-size:11px; font-weight:500; white-space:nowrap;
}
.dbqa-pill {
  display:inline-flex; align-items:center; gap:6px;
  padding:2px 9px 2px 8px;
  border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:999px;
  background:var(--dsw-alias-bg-elevated, #fff);
  font-size:11.5px; white-space:nowrap;
}
.dbqa-pill--ok { color:var(--dsw-alias-success, #15803d); }
.dbqa-pill--fail { color:var(--dsw-alias-danger, #b91c1c); }
.dbqa-pill--idle { color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-pill--busy { color:var(--dsw-alias-warning-text, #b45309); }
.dbqa-dot { flex:none; width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-border, #9ca3af); }
.dbqa-dot--ok, .dbqa-pill--ok .dbqa-dot { background:var(--dsw-alias-success, #16a34a); }
.dbqa-dot--fail, .dbqa-pill--fail .dbqa-dot { background:var(--dsw-alias-danger, #dc2626); }
.dbqa-pill--busy .dbqa-dot { background:var(--dsw-alias-warning-text, #d97706); animation:dbqa-pulse 1.4s ease-in-out infinite; }
.dbqa-spinner {
  width:13px; height:13px; border-radius:50%;
  border:1.5px solid var(--dsw-alias-border, #d0d7de);
  border-top-color:var(--dsw-alias-accent, #2563eb);
  animation:dbqa-spin .8s linear infinite;
}

/* ── 问答列表 ─────────────────────────────────────────── */
.dbqa-home { display:flex; flex-direction:column; min-width:0; }
.dbqa-home-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 12px; }
.dbqa-home-list {
  list-style:none; margin:0; padding:0;
  border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:12px;
  overflow:hidden; background:var(--dsw-alias-bg-elevated, #fff);
}
.dbqa-home-item {
  display:flex; align-items:center; gap:10px;
  padding:11px 12px; cursor:pointer;
  transition:opacity .16s ease, background-color .12s ease;
}
.dbqa-home-item + .dbqa-home-item { border-top:1px solid var(--dsw-alias-border, #e5e7eb); }
.dbqa-home-item:hover, .dbqa-home-item:focus-within { background:var(--dsw-alias-bg-subtle, #f9fafb); }
.dbqa-home-item--leaving { opacity:0; }
.dbqa-home-icon {
  flex:none; display:grid; place-items:center; width:30px; height:30px;
  border-radius:8px; background:var(--dsw-alias-bg-subtle, #f3f4f6);
  color:var(--dsw-alias-text-secondary, #6b7280);
}
.dbqa-home-open {
  display:flex; flex-direction:column; gap:3px; flex:1; min-width:0;
  outline:none; border-radius:6px;
}
.dbqa-home-open:focus-visible { box-shadow:0 0 0 2px var(--dsw-alias-accent, #2563eb); }
.dbqa-home-item-title {
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-weight:500; line-height:1.45;
}
.dbqa-home-item-meta {
  display:flex; align-items:center; gap:7px; min-width:0;
  color:var(--dsw-alias-text-secondary, #6b7280); font-size:12px;
}
.dbqa-home-item-source { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:42ch; }
.dbqa-meta-dot { flex:none; width:3px; height:3px; border-radius:50%; background:currentColor; opacity:.55; }
.dbqa-star {
  display:inline-flex; align-items:center; justify-content:center; flex:none;
  width:30px; height:30px; padding:0;
  border:0; border-radius:8px; background:transparent;
  color:var(--dsw-alias-text-secondary, #9ca3af); cursor:pointer;
  transition:background-color .14s ease, color .14s ease;
}
.dbqa-star:hover:not(:disabled) { background:var(--dsw-alias-bg-subtle, #f3f4f6); color:var(--dsw-alias-warning-text, #d97706); }
.dbqa-star--on { color:var(--dsw-alias-warning-text, #d97706); }
.dbqa-star:disabled { cursor:default; opacity:.6; }
.dbqa-home-more {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  margin-top:12px;
}

/* ── 骨架屏 ───────────────────────────────────────────── */
.dbqa-skeleton-list {
  display:flex; flex-direction:column;
  border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:12px;
  overflow:hidden;
}
.dbqa-skeleton-row { display:flex; align-items:center; gap:10px; padding:13px 12px; }
.dbqa-skeleton-row + .dbqa-skeleton-row { border-top:1px solid var(--dsw-alias-border, #e5e7eb); }
.dbqa-skeleton-lines { display:flex; flex-direction:column; gap:7px; flex:1; }
.dbqa-skeleton {
  display:block; border-radius:6px;
  background:linear-gradient(90deg,
    var(--dsw-alias-bg-subtle, #f3f4f6) 25%,
    var(--dsw-alias-border, #e5e7eb) 37%,
    var(--dsw-alias-bg-subtle, #f3f4f6) 63%);
  background-size:400% 100%;
  animation:dbqa-shimmer 1.4s ease infinite;
}
.dbqa-skeleton--icon { flex:none; width:30px; height:30px; border-radius:8px; }
.dbqa-skeleton--title { width:42%; height:11px; }
.dbqa-skeleton--meta { width:64%; height:9px; }

/* ── 表单 ─────────────────────────────────────────────── */
.dbqa-form { display:flex; flex-direction:column; gap:14px; max-width:940px; }
/* 类型选择：左侧标签、右侧控件，与下面的字段区同一条 200px 轴对齐。 */
.dbqa-form-identity {
  display:grid; grid-template-columns:220px minmax(0, 1fr); gap:20px; align-items:start;
  padding:14px 18px; border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:12px;
  background:var(--dsw-alias-bg-elevated, #fff);
}
.dbqa-form-identity-label { display:flex; flex-direction:column; gap:3px; min-width:0; }
.dbqa-form-label { font-size:13px; font-weight:600; }
.dbqa-form-identity-control { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; min-width:0; }
.dbqa-form-identity-control .dbqa-segmented { flex:none; }
/* 分组卡片：整块一个表面，分组之间只留分隔线，避免一叠小卡片。 */
.dbqa-form-sheet {
  border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:12px;
  background:var(--dsw-alias-bg-elevated, #fff); overflow:hidden;
}
.dbqa-section {
  display:grid; grid-template-columns:220px minmax(0, 1fr); gap:22px;
  padding:16px 18px;
}
.dbqa-section + .dbqa-section { border-top:1px solid var(--dsw-alias-border, #e5e7eb); }
.dbqa-section-intro { min-width:0; }
.dbqa-section h3 { margin:0; font-size:13px; font-weight:600; line-height:1.4; }
.dbqa-section-intro p { margin:4px 0 0; font-size:12px; line-height:1.5; color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-section-fields { display:flex; flex-direction:column; gap:12px; min-width:0; }
.dbqa-section-fields .dbqa-grid { grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); }
/* TLS 证书类字段默认折叠，表单默认只展示模式。 */
.dbqa-disclosure { border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:9px; padding:0 12px; }
.dbqa-disclosure > summary {
  display:flex; align-items:center; gap:7px; padding:9px 0;
  font-size:12px; color:var(--dsw-alias-text-secondary, #6b7280); cursor:pointer; list-style:none;
}
.dbqa-disclosure > summary::-webkit-details-marker { display:none; }
.dbqa-disclosure > summary::before {
  content:''; flex:none; width:0; height:0;
  border-left:5px solid currentColor; border-top:4px solid transparent; border-bottom:4px solid transparent;
  transition:transform .15s ease;
}
.dbqa-disclosure[open] > summary::before { transform:rotate(90deg); }
.dbqa-disclosure > summary:focus-visible { outline:2px solid var(--dsw-alias-accent, #2563eb); outline-offset:2px; border-radius:6px; }
.dbqa-disclosure > .dbqa-grid { padding:2px 0 12px; }
.dbqa-form-footer { margin-top:2px; }
.dbqa-form-footer-hint { font-size:12px; color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:14px; }
.dbqa-field { display:flex; flex-direction:column; gap:5px; min-width:0; }
.dbqa-field--wide { grid-column:1 / -1; }
.dbqa-field label { font-size:12px; font-weight:500; }
.dbqa-field input[type=text], .dbqa-field input[type=number], .dbqa-field select, .dbqa-field textarea {
  width:100%; box-sizing:border-box;
  padding:7px 9px;
  border:1px solid var(--dsw-alias-border, #d0d7de); border-radius:8px;
  background:var(--dsw-alias-bg-elevated, #fff); color:inherit; font:inherit;
  transition:border-color .14s ease, box-shadow .14s ease;
}
.dbqa-field input[type=text]:focus, .dbqa-field input[type=number]:focus, .dbqa-field select:focus, .dbqa-field textarea:focus {
  outline:none; border-color:var(--dsw-alias-accent, #2563eb);
  box-shadow:0 0 0 3px var(--dsw-alias-bg-subtle, #eff6ff);
}
.dbqa-field input:disabled, .dbqa-field select:disabled { opacity:.6; }
.dbqa-field--invalid input, .dbqa-field--invalid select { border-color:var(--dsw-alias-danger, #dc2626); }
.dbqa-field-error { color:var(--dsw-alias-danger, #b91c1c); font-size:11px; }
.dbqa-field-hint { color:var(--dsw-alias-text-secondary, #6b7280); font-size:11px; line-height:1.5; }
.dbqa-switch { display:flex; align-items:center; gap:8px; }
.dbqa-switch input { width:16px; height:16px; }
.dbqa-segmented { display:inline-flex; border:1px solid var(--dsw-alias-border, #d0d7de); border-radius:9px; overflow:hidden; }
.dbqa-segmented button {
  min-height:30px; padding:0 14px;
  border:0; background:var(--dsw-alias-bg-elevated, #fff); color:inherit;
  font:inherit; cursor:pointer;
}
.dbqa-segmented button + button { border-left:1px solid var(--dsw-alias-border, #d0d7de); }
.dbqa-segmented button[aria-pressed=true] { background:var(--dsw-alias-accent, #2563eb); color:#fff; }
.dbqa-segmented button:disabled { cursor:default; opacity:.7; }
.dbqa-list-editor { display:flex; flex-direction:column; gap:8px; }
.dbqa-list-row { display:grid; grid-template-columns:1fr 2fr auto; gap:8px; }
.dbqa-test-result { padding:9px 11px; border-radius:9px; border:1px solid var(--dsw-alias-border, #e5e7eb); font-size:12px; }
.dbqa-test-result--ok { border-color:var(--dsw-alias-success, #16a34a); color:var(--dsw-alias-success, #15803d); }
.dbqa-test-result--fail { border-color:var(--dsw-alias-danger, #dc2626); color:var(--dsw-alias-danger, #b91c1c); }
.dbqa-footer {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding-top:14px; margin-top:2px;
  border-top:1px solid var(--dsw-alias-border, #e5e7eb);
}

/* ── 知识库 ───────────────────────────────────────────── */
.dbqa-kb-section-title {
  display:flex; align-items:center; gap:8px; margin:0 0 12px;
  font-size:15px; font-weight:600; color:var(--dsw-alias-text, #111827);
}
.dbqa-kb-section-title::before { content:''; width:3px; height:14px; border-radius:2px; background:var(--dsw-alias-accent, #2563eb); }
.dbqa-kb-section + .dbqa-kb-section { margin-top:24px; padding-top:18px; border-top:1px solid var(--dsw-alias-border, #e5e7eb); }
.dbqa-kb-legend { display:flex; flex-wrap:wrap; gap:4px 12px; margin:2px 0 6px; color:var(--dsw-alias-text-secondary, #6b7280); font-size:11px; }
.dbqa-kb-legend-item { display:inline-flex; align-items:center; gap:4px; }
/* 实心圆 = 齐全，半心圆 = 缺一份，空心圆 = 没有。形状区分状态，颜色沿用成功 / 警告 / 边框三档。 */
.dbqa-kb-mark { display:inline-block; flex:none; box-sizing:border-box; width:10px; height:10px; border-radius:50%; }
.dbqa-kb-mark--full { background:var(--dsw-alias-success, #16a34a); }
.dbqa-kb-mark--half { border:1px solid var(--dsw-alias-warning-text, #d97706); background:linear-gradient(90deg, var(--dsw-alias-warning-text, #d97706) 0 50%, transparent 50% 100%); }
.dbqa-kb-mark--empty { border:1px solid var(--dsw-alias-border, #9ca3af); background:transparent; }
.dbqa-kb { display:grid; grid-template-columns:minmax(180px, 240px) 1fr; gap:16px; min-height:320px; }
.dbqa-kb-nav {
  display:flex; flex-direction:column; gap:2px;
  border-right:1px solid var(--dsw-alias-border, #e5e7eb);
  padding-right:12px; overflow:auto;
}
.dbqa-kb-group-title { margin:10px 0 2px; font-size:11px; font-weight:600; color:var(--dsw-alias-text-secondary, #6b7280); }
.dbqa-kb-item {
  display:flex; align-items:center; gap:6px; width:100%;
  padding:6px 8px; border:0; border-radius:7px; background:transparent;
  color:inherit; font:inherit; text-align:left; cursor:pointer;
}
.dbqa-kb-item:hover { background:var(--dsw-alias-bg-subtle, #f3f4f6); }
.dbqa-kb-item--active { background:var(--dsw-alias-bg-subtle, #f3f4f6); font-weight:600; }
.dbqa-kb-doc { display:flex; flex-direction:column; gap:10px; min-width:0; }
.dbqa-kb-doc-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.dbqa-kb-doc-head h3 { margin:0; font-size:14px; }
.dbqa-kb-meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; color:var(--dsw-alias-text-secondary, #6b7280); font-size:12px; }
.dbqa-kb-meta h3 { margin:0; color:var(--dsw-alias-text, #1f2328); font-size:14px; }
.dbqa-kb-modes { display:flex; gap:2px; margin:4px 0 12px; border-bottom:1px solid var(--dsw-alias-border, #e5e7eb); }
.dbqa-kb-tab {
  appearance:none; margin:0 0 -1px; padding:7px 12px 8px;
  border:0; border-bottom:2px solid transparent; border-radius:6px 6px 0 0;
  background:transparent; color:var(--dsw-alias-text-secondary, #6b7280);
  font:inherit; font-size:13px; font-weight:500; line-height:1.4; cursor:pointer;
}
.dbqa-kb-tab:hover { color:var(--dsw-alias-text, #1f2328); background:var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05)); }
.dbqa-kb-tab--active, .dbqa-kb-tab--active:hover { color:var(--dsw-alias-accent, #2563eb); border-bottom-color:var(--dsw-alias-accent, #2563eb); background:transparent; }
.dbqa-md {
  margin:0; padding:12px 14px;
  border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:10px;
  background:var(--dsw-alias-bg-subtle, #f9fafb);
  font-family:var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size:12px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere;
}
.dbqa-md-rendered {
  padding:14px 16px; border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:10px;
  background:var(--dsw-alias-bg-elevated, #fff); color:var(--dsw-alias-text, #1f2328);
  font-size:13px; line-height:1.75; overflow-wrap:anywhere;
}
.dbqa-md-rendered h1 { margin:4px 0 12px; font-size:22px; line-height:1.35; }
.dbqa-md-rendered h2 { margin:20px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--dsw-alias-border, #e5e7eb); font-size:18px; line-height:1.4; }
.dbqa-md-rendered h3 { margin:16px 0 8px; font-size:15.5px; }
.dbqa-md-rendered h4, .dbqa-md-rendered h5, .dbqa-md-rendered h6 { margin:14px 0 6px; font-size:13.5px; }
.dbqa-md-rendered p { margin:8px 0; }
.dbqa-md-rendered ul, .dbqa-md-rendered ol { margin:8px 0; padding-left:22px; }
.dbqa-md-rendered li { margin:3px 0; }
.dbqa-md-rendered code { padding:1px 5px; border-radius:5px; background:var(--dsw-alias-bg-subtle, #f3f4f6); font-family:var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:12px; }
.dbqa-md-rendered pre.dbqa-md-code { margin:10px 0; padding:12px 14px; border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:8px; background:var(--dsw-alias-bg-subtle, #f9fafb); overflow:auto; }
.dbqa-md-rendered pre.dbqa-md-code code { padding:0; background:none; font-size:12px; line-height:1.6; white-space:pre; }
.dbqa-md-rendered blockquote { margin:10px 0; padding:6px 12px; border-left:3px solid var(--dsw-alias-accent, #2563eb); background:var(--dsw-alias-bg-subtle, #f9fafb); color:var(--dsw-alias-text-secondary, #57606a); }
.dbqa-md-rendered table { width:100%; margin:10px 0; border-collapse:collapse; font-size:12.5px; }
.dbqa-md-rendered th, .dbqa-md-rendered td { padding:6px 9px; border:1px solid var(--dsw-alias-border, #e5e7eb); text-align:left; vertical-align:top; }
.dbqa-md-rendered th { background:var(--dsw-alias-bg-subtle, #f3f4f6); font-weight:600; }
.dbqa-md-rendered tr:nth-child(even) td { background:var(--dsw-alias-bg-subtle, #fafafa); }
.dbqa-md-rendered hr { margin:16px 0; border:0; border-top:1px solid var(--dsw-alias-border, #e5e7eb); }
.dbqa-md-rendered a { color:var(--dsw-alias-accent, #2563eb); text-decoration:none; }
.dbqa-md-rendered a:hover { text-decoration:underline; }

/* ── 会话条（宿主会话头部 / hero） ─────────────────────── */
.dbqa-session-strip { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; font-size:12px; color:var(--dsw-alias-label-tertiary); }
.dbqa-session-agent { display:inline-flex; align-items:center; gap:2px; min-width:0; }
.dbqa-session-agent-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-primary); font-size:13px; font-weight:500; line-height:20px; }
.dbqa-session-pick { position:relative; display:inline-flex; align-items:center; gap:2px; min-width:0; }
.dbqa-session-pick-label { color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:20px; white-space:nowrap; }
.dbqa-session-pick-button { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:220px; height:28px; padding:0 6px; border:0; border-radius:var(--dsw-radius-sm); background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; font-weight:500; line-height:20px; cursor:pointer; }
.dbqa-session-pick-button[aria-expanded="true"] { background:var(--dsw-alias-interactive-bg-hover); }
.dbqa-session-pick-button:disabled { cursor:default; color:var(--dsw-alias-label-quaternary); }
@media (hover:hover) { .dbqa-session-pick-button:not(:disabled):hover { background:var(--dsw-alias-interactive-bg-hover); } }
.dbqa-session-pick-value { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dbqa-session-pick-value.is-empty { color:var(--dsw-alias-label-tertiary); font-weight:400; }
.dbqa-session-pick-chevron { flex:none; color:var(--dsw-alias-label-caption); font-size:12px; line-height:1; }
.dbqa-session-menu { position:fixed; z-index:1000; display:flex; flex-direction:column; box-sizing:border-box; min-width:160px; max-width:320px; max-height:280px; overflow:auto; padding:4px; border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-subtle, var(--dsw-alias-border, #e5e7eb)); background:var(--dsw-alias-bg-base, #fff); box-shadow:var(--dsw-elevation-soft); color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.5; }
.dbqa-session-menu-item { display:flex; align-items:center; gap:8px; width:100%; padding:6px 8px; border:0; border-radius:var(--dsw-radius-sm); background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:20px; text-align:left; cursor:pointer; }
.dbqa-session-menu-item.is-selected { background:var(--dsw-alias-interactive-bg-hover); }
@media (hover:hover) { .dbqa-session-menu-item:hover { background:var(--dsw-alias-interactive-bg-hover); } }
.dbqa-session-menu-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dbqa-session-menu-type { flex:none; margin-left:auto; color:var(--dsw-alias-label-caption); font-size:11px; line-height:16px; }
.dbqa-session-menu-filter { width:100%; box-sizing:border-box; margin:0 0 4px; padding:5px 8px; border:1px solid var(--dsw-alias-border, #d0d7de); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-elevated, #fff); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:20px; }
.dbqa-session-menu-filter::placeholder { color:var(--dsw-alias-label-quaternary); }
.dbqa-session-menu-filter:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-1px; }
.dbqa-session-menu-empty { padding:8px; color:var(--dsw-alias-label-tertiary); font-size:12px; }
.dbqa-session-menu-check { margin-left:auto; color:var(--dsw-alias-state-business-primary); }
.dbqa-session-error { color:var(--dsw-alias-state-error-primary, #b91c1c); max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ── 弹层 ─────────────────────────────────────────────── */
.dbqa-modal-backdrop { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(15, 23, 42, .42); backdrop-filter:blur(2px); }
.dbqa-modal { width:min(560px, 100%); max-height:min(84vh, 760px); overflow:auto; border:1px solid var(--dsw-alias-border, #d0d7de); border-radius:14px; background:var(--dsw-alias-bg-elevated, #fff); color:var(--dsw-alias-text, #1f2328); box-shadow:0 24px 64px rgba(15, 23, 42, .28); }
.dbqa-modal-head { display:flex; align-items:flex-start; gap:12px; padding:20px 20px 0; }
.dbqa-modal-icon { flex:0 0 auto; display:grid; place-items:center; width:36px; height:36px; border-radius:10px; background:var(--dsw-alias-warning-bg, #fffbeb); color:var(--dsw-alias-warning-text, #b45309); }
.dbqa-modal-icon--danger { background:var(--dsw-alias-danger-bg, #fef2f2); color:var(--dsw-alias-danger, #b91c1c); }
.dbqa-modal h2 { margin:0; font-size:16px; line-height:1.45; }
.dbqa-modal-lead { margin:5px 0 0; color:var(--dsw-alias-text-secondary, #57606a); font-size:13px; line-height:1.55; }
.dbqa-modal-body { padding:16px 20px 0; }
.dbqa-modal-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:11px; }
.dbqa-modal-item { display:flex; gap:10px; font-size:13px; line-height:1.6; }
.dbqa-modal-bullet { flex:0 0 auto; width:6px; height:6px; margin-top:7px; border-radius:50%; background:var(--dsw-alias-text-secondary, #9ca3af); }
.dbqa-modal-item--warn .dbqa-modal-bullet { background:var(--dsw-alias-warning-text, #d97706); box-shadow:0 0 0 3px var(--dsw-alias-warning-bg, #fffbeb); }
.dbqa-modal-item--danger .dbqa-modal-bullet { background:var(--dsw-alias-danger, #b91c1c); box-shadow:0 0 0 3px var(--dsw-alias-danger-bg, #fef2f2); }
.dbqa-modal-item--danger { color:var(--dsw-alias-danger, #b91c1c); }
.dbqa-modal-note { margin:16px 0 0; padding:10px 12px; border:1px solid var(--dsw-alias-warning-border, #fde68a); border-radius:10px; background:var(--dsw-alias-warning-bg, #fffbeb); color:var(--dsw-alias-warning-text, #92400e); font-size:12.5px; line-height:1.6; }
.dbqa-modal-foot { display:flex; justify-content:flex-end; gap:8px; padding:18px 20px 20px; }

/* ── 动效 ─────────────────────────────────────────────── */
@keyframes dbqa-shimmer { 0% { background-position:100% 50%; } 100% { background-position:0 50%; } }
@keyframes dbqa-spin { to { transform:rotate(360deg); } }
@keyframes dbqa-pulse { 0%, 100% { opacity:1; } 50% { opacity:.35; } }

/* ── 响应式 ───────────────────────────────────────────── */
@media (max-width: 860px) {
  .dbqa-form-identity, .dbqa-section { grid-template-columns:minmax(0, 1fr); gap:10px; }
  .dbqa-form-identity { padding:12px 14px; }
  .dbqa-section { padding:14px; }
  .dbqa-section-intro p { margin-top:2px; }
  .dbqa-form-footer-hint { display:none; }
}

@media (max-width: 720px) {
  .dbqa-header { padding:14px 14px 10px; }
  .dbqa-body { padding:12px 14px 22px; }
  .dbqa-page-head { flex-direction:column; align-items:stretch; gap:10px; }
  .dbqa-page-head .dbqa-actions { justify-content:flex-start; }
  .dbqa-stats { grid-template-columns:repeat(3, minmax(0, 1fr)); }
  .dbqa-stat { padding:9px 11px; }
  .dbqa-stat-value { font-size:17px; }
  .dbqa-kb { grid-template-columns:1fr; }
  .dbqa-kb-nav { flex-direction:column; max-height:180px; border-right:0; border-bottom:1px solid var(--dsw-alias-border, #e5e7eb); padding:0 0 10px; }
  .dbqa-form { max-width:none; }
  .dbqa-list-row { grid-template-columns:1fr; }
  .dbqa-header-action span { display:none; }
  .dbqa-table-wrap { overflow:visible; border:0; background:transparent; }
  .dbqa-table { display:block; min-width:0; }
  .dbqa-table thead { display:none; }
  .dbqa-table tbody { display:block; }
  .dbqa-table tr {
    display:grid; grid-template-columns:auto minmax(0, 1fr); gap:7px 10px;
    margin:0 0 8px; padding:12px 14px;
    border:1px solid var(--dsw-alias-border, #e5e7eb); border-radius:10px;
    background:var(--dsw-alias-bg-elevated, #fff);
  }
  .dbqa-table td { display:block; padding:0; border:0; }
  .dbqa-table td:nth-child(1) { grid-column:1 / -1; }
  .dbqa-table td:nth-child(2) { grid-column:1; align-self:start; }
  .dbqa-table td:nth-child(3) { grid-column:2; align-self:center; min-width:0; }
  .dbqa-table td:nth-child(4) { grid-column:1 / -1; }
  .dbqa-table td:nth-child(5) { grid-column:1 / -1; }
  .dbqa-table td:nth-child(5) .dbqa-row-actions { justify-content:flex-end; }
  .dbqa-endpoint { max-width:100%; }
}
@media (max-width: 480px) {
  .dbqa-heading { gap:9px; }
  .dbqa-brand-mark { width:30px; height:30px; }
  .dbqa-title { font-size:15px; }
  .dbqa-subtitle { font-size:11.5px; }
  .dbqa-header-action { min-width:32px; padding:0 8px; }
  .dbqa-stats { grid-template-columns:1fr; }
  .dbqa-empty { padding:32px 16px; }
  .dbqa-home-item { padding:10px; }
  .dbqa-home-item-source { max-width:22ch; }
  .dbqa-grid { grid-template-columns:1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .dbqa-root *, .dbqa-root *::before, .dbqa-root *::after {
    animation-duration:.001ms !important;
    animation-iteration-count:1 !important;
    transition-duration:.001ms !important;
    scroll-behavior:auto !important;
  }
}
`
