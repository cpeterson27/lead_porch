import { useEffect, useId, useRef } from "react";
import Button from "./Button.jsx";
import { ModalPortal, useModalLayer } from "./ModalLayer.jsx";
import "./WorkspaceUI.css";

export function PageHeader({ eyebrow, title, description, actions, children, className = "" }) {
  return (
    <header className={`workspace-header ${className}`.trim()}>
      <div className="workspace-header__copy">
        {eyebrow ? <p className="workspace-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="workspace-header__actions">{actions}</div> : null}
    </header>
  );
}
const statusLabels = {
  neutral: "Status",
  success: "Ready",
  warning: "Needs attention",
  danger: "Blocked",
  info: "In progress",
  draft: "Draft",
};

export function StatusBadge({ tone = "neutral", children }) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {children || statusLabels[tone] || statusLabels.neutral}
    </span>
  );
}

export function Tabs({ items, activeId, onChange, label = "Workspace sections" }) {
  return (
    <div className="workspace-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === activeId}
          className={item.id === activeId ? "workspace-tab is-active" : "workspace-tab"}
          onClick={() => onChange?.(item.id)}
        >
          {item.label}
          {item.count !== undefined ? <span>{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Toolbar({ search, filters, actions, results, className = "" }) {
  return (
    <div className={`workspace-toolbar ${className}`.trim()}>
      <div className="workspace-toolbar__primary">{search}{filters}</div>
      <div className="workspace-toolbar__secondary">
        {results ? <span className="workspace-toolbar__results">{results}</span> : null}
        {actions}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, description, action, secondaryAction }) {
  return (
    <section className="empty-state">
      {icon ? <div className="empty-state__icon" aria-hidden="true">{icon}</div> : null}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action || secondaryAction ? <div className="empty-state__actions">{action}{secondaryAction}</div> : null}
    </section>
  );
}

export function Drawer({ isOpen, onClose, title, description, children, footer, size = "default" }) {
  const titleId = useId();
  const panelRef = useRef(null);
  useModalLayer(isOpen);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousFocus = document.activeElement;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return <ModalPortal>
    <div className="drawer-root">
      <button className="drawer-backdrop" type="button" onClick={onClose} aria-label="Close details" />
      <aside
        ref={panelRef}
        className={`drawer-panel drawer-panel--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="drawer-header">
          <div><h2 id={titleId}>{title}</h2>{description ? <p>{description}</p> : null}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close details">×</Button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-footer">{footer}</footer> : null}
      </aside>
    </div>
  </ModalPortal>;
}
