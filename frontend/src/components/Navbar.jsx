import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  FiSearch,
  FiCpu,
  FiPlus,
  FiCheckCircle,
  FiBell,
  FiChevronDown,
  FiChevronLeft,
  FiChevronRight,
} from "react-icons/fi";
import { getWorkspaceSettings } from "../utils/workspaceSettings.js";
import useInitiative from "../context/useInitiative.js";
import useAuth from "../context/useAuth.js";
import { fetchWorkspaceConfig } from "../services/api.js";
import { isCoachOnly, isSocialConnectionOnly } from "../utils/roleAccess.js";
import UserAvatar from "./UserAvatar.jsx";
import "./Navbar.css";

export default function Navbar({ onMenuClick, isSidebarCollapsed = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [workspaceName, setWorkspaceName] = useState(
    () => getWorkspaceSettings().workspaceName,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const createRef = useRef(null);
  const { campaigns, selected, selectedId, setSelectedId } = useInitiative();
  const { session, workspaces, switchWorkspace } = useAuth();
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const isCoach = isCoachOnly(session);
  const socialConnectionOnly = isSocialConnectionOnly(session);
  const displayedWorkspaceName = socialConnectionOnly
    ? session?.workspace?.name || "Lead Porch"
    : workspaceName;
  const pageKey = location.pathname.split("/")[1] || "command-center";
  const pageMeta = {
    "command-center": [
      "Command Center",
      "Today’s priorities and next best actions.",
    ],
    dashboard: [
      "Command center",
      "Today’s priorities, pipeline, and next best actions.",
    ],
    events: ["Events", "Plan, promote, and measure every event."],
    campaigns: ["Campaigns", "Build focused campaigns that move prospects."],
    discovery: ["Discovery", "Find and qualify the right organizations."],
    crm: ["CRM", "Keep every relationship organized and actionable."],
    opportunities: [
      "Opportunities",
      "Move qualified relationships through the revenue pipeline.",
    ],
    tasks: ["Tasks", "Work the next actions that move relationships forward."],
    contacts: ["CRM", "Keep every relationship organized and actionable."],
    outreach: [
      "Outreach",
      "Turn approved prospects into thoughtful conversations.",
    ],
    conversations: [
      "Conversations",
      "Keep campaign replies and personal follow-up in one place.",
    ],
    inbox: [
      "Conversations",
      "Keep campaign replies and personal follow-up in one place.",
    ],
    marketing: ["Marketing", "Coordinate channels, content, and performance."],
    partners: ["Partners", "Grow through aligned operators and affiliates."],
    content: ["AI Content", "Create polished campaign assets with confidence."],
    operators: [
      "Jarvis",
      "Prepare, review, and monitor AI-supported growth work.",
    ],
    jarvis: [
      "Jarvis",
      "Prepare, review, and monitor AI-supported growth work.",
    ],
    "development-requests": [
      "Development requests",
      "Approve and hand software changes to Codex safely.",
    ],
    analytics: ["Analytics", "See what is working and where to focus next."],
    integrations: [
      "Integrations",
      "Connect the systems behind Lead Porch’s growth engine.",
    ],
    settings: ["Settings", "Personalize the workspace and operating rules."],
    coach: [
      "Coach Portal",
      "Your students, assignments, and upcoming coaching work.",
    ],
  }[pageKey] || [
    "Growth workspace",
    "Operate Lead Porch’s growth engine from one place.",
  ];
  const changeInitiative = (value) => {
    setSelectedId(value);
    if (value !== "all") navigate(`/campaigns/${value}`);
  };
  const changeWorkspace = async (workspaceId) => {
    if (!workspaceId || workspaceId === String(session?.workspace?.id)) return;
    setSwitchingWorkspace(true);
    try {
      await switchWorkspace(workspaceId);
      window.location.assign("/command-center");
    } finally {
      setSwitchingWorkspace(false);
    }
  };

  useEffect(() => {
    if (isCoach || socialConnectionOnly) return undefined;
    const refresh = () =>
      setWorkspaceName(getWorkspaceSettings().workspaceName);
    window.addEventListener("ellie-settings-changed", refresh);
    fetchWorkspaceConfig()
      .then((config) => setWorkspaceName(config.workspaceName))
      .catch(() => {});
    return () => window.removeEventListener("ellie-settings-changed", refresh);
  }, [isCoach, socialConnectionOnly]);

  useEffect(() => {
    const handleShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigate("/crm/contacts?focus=search");
      }
      if (event.key === "Escape") setCreateOpen(false);
    };
    const closeOutside = (event) => {
      if (!createRef.current?.contains(event.target)) setCreateOpen(false);
    };
    document.addEventListener("keydown", handleShortcut);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", handleShortcut);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [navigate]);

  const createItems = [
    ["Contact", "/crm/contacts?create=contact"],
    ["Opportunity", "/opportunities?create=opportunity"],
    ["Campaign", "/campaigns/new"],
    ["Event", "/events?create=event"],
    ["Audience", "/discovery?create=audience"],
    ["Program campaign", "/campaigns?create=program"],
  ];

  return (
    <header className="navbar">
      <div className="navbar__left">
        <button
          className="navbar__menu"
          type="button"
          onClick={onMenuClick}
          aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isSidebarCollapsed}
        >
          {isSidebarCollapsed ? <FiChevronRight /> : <FiChevronLeft />}
        </button>
        <div className="navbar__context">
          <p className="navbar__eyebrow">
            <span>{displayedWorkspaceName}</span>
            <i />
            {pageMeta[0]}
          </p>
          <h1 className="navbar__title">{pageMeta[1]}</h1>
        </div>
        <div className="navbar__mobile-brand">
          <strong>{session?.workspace?.name || "Lead Porch"}</strong>
          <span>{pageMeta[1]}</span>
        </div>
        {!isCoach ? (
          <label className="initiative-switcher">
            <span>Current campaign</span>
            <select
              value={selectedId}
              onChange={(event) => changeInitiative(event.target.value)}
            >
              <option value="all">All business activity</option>
              <optgroup label="Events">
                {campaigns
                  .filter((campaign) => campaign.campaignKind !== "program")
                  .map((campaign) => (
                    <option key={campaign._id} value={campaign._id}>
                      {campaign.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Programs & offers">
                {campaigns
                  .filter((campaign) => campaign.campaignKind === "program")
                  .map((campaign) => (
                    <option key={campaign._id} value={campaign._id}>
                      {campaign.programName || campaign.name}
                    </option>
                  ))}
              </optgroup>
            </select>
            {selected ? (
              <i
                className={
                  selected.campaignKind === "program" ? "is-offer" : "is-event"
                }
              />
            ) : null}
          </label>
        ) : null}
      </div>

      <label className="workspace-switcher">
        <span>Current workspace</span>
        {workspaces.length > 1 ? (
          <select
            aria-label="Current workspace"
            disabled={switchingWorkspace}
            value={session?.workspace?.id || ""}
            onChange={(event) => changeWorkspace(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        ) : (
          <strong>{session?.workspace?.name || "Workspace"}</strong>
        )}
      </label>
      {!isCoach ? (
        <div className="navbar__actions">
          <button
            className="navbar__search"
            type="button"
            aria-label="Search workspace"
            onClick={() => navigate("/crm/contacts?focus=search")}
          >
            <FiSearch />
            <span>Search workspace</span>
            <kbd>⌘ K</kbd>
          </button>
          <button
            className="navbar__icon-action"
            type="button"
            aria-label="Open approvals"
            onClick={() => navigate("/campaigns/outreach")}
          >
            <FiCheckCircle />
          </button>
          <button
            className="navbar__icon-action"
            type="button"
            aria-label="Open notifications"
            onClick={() => navigate("/discovery?tab=monitoring")}
          >
            <FiBell />
          </button>
          <div className="navbar__create" ref={createRef}>
            <button
              className="navbar__create-button"
              type="button"
              aria-expanded={createOpen}
              aria-haspopup="menu"
              onClick={() => setCreateOpen((value) => !value)}
            >
              <FiPlus />
              <span>Create</span>
              <FiChevronDown />
            </button>
            {createOpen ? (
              <div className="navbar__create-menu" role="menu">
                {createItems.map(([label, path]) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={label}
                    onClick={() => {
                      setCreateOpen(false);
                      navigate(path);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            className="navbar__jarvis"
            type="button"
            onClick={() => navigate("/operators/jarvis")}
          >
            <FiCpu />
            <span>Ask Jarvis</span>
            <i />
          </button>
          <button
            className="navbar__profile"
            type="button"
            onClick={() => navigate("/profile")}
            aria-label="Open my profile"
          >
            <UserAvatar user={session?.user} size="sm" />
          </button>
        </div>
      ) : (
        <div className="navbar__actions">
          <span className="navbar__coach-context">
            Restricted coach workspace
          </span>
          <button
            className="navbar__profile"
            type="button"
            onClick={() => navigate("/profile")}
            aria-label="Open my profile"
          >
            <UserAvatar user={session?.user} size="sm" />
          </button>
        </div>
      )}
    </header>
  );
}
