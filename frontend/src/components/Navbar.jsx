import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FiChevronRight, FiCpu } from "react-icons/fi";
import useAuth from "../context/useAuth.js";
import { isCoachOnly } from "../utils/roleAccess.js";
import "./Navbar.css";

export default function Navbar({ onMenuClick }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, workspaces, switchWorkspace } = useAuth();
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const isCoach = isCoachOnly(session);
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

  return (
    <header className="navbar">
      <div className="navbar__left">
        {/*
          On small screens this uses the same circular arrow treatment as
          the desktop sidebar rail. Once open, the matching left arrow on
          the drawer edge closes it.
        */}
        <button
          className="navbar__menu"
          type="button"
          onClick={onMenuClick}
          aria-label="Open menu"
        >
          <FiChevronRight />
        </button>
        <div className="navbar__mobile-brand">
          <strong>{session?.workspace?.name || "Lead Porch"}</strong>
        </div>
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
      {!isCoach && !["/operators/jarvis", "/jarvis"].includes(location.pathname) ? (
          <button
            className="navbar__jarvis"
            type="button"
            onClick={() => navigate("/operators/jarvis")}
          >
            <FiCpu />
            <span>Ask Jarvis</span>
            <i />
          </button>
      ) : null}
    </header>
  );
}
