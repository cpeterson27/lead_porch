import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FiChevronRight, FiCpu } from "react-icons/fi";
import Sidebar from "../components/Sidebar.jsx";
import "./DashboardLayout.css";

export default function DashboardLayout({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("ellie-sidebar-collapsed") === "true");

  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 900px)").matches) return setSidebarOpen((value) => !value);
    setSidebarCollapsed((value) => {
      localStorage.setItem("ellie-sidebar-collapsed", String(!value));
      return !value;
    });
  };
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className={isSidebarCollapsed ? "dashboard-shell dashboard-shell--collapsed" : "dashboard-shell"}>
      <Sidebar isOpen={isSidebarOpen} isCollapsed={isSidebarCollapsed} onClose={closeSidebar} onToggleCollapse={toggleSidebar} />
      {isSidebarOpen ? (
        <div className="dashboard-overlay" onClick={closeSidebar} />
      ) : null}
      <div className="dashboard-view">
        <button className="dashboard-mobile-menu" type="button" onClick={toggleSidebar} aria-label="Open navigation"><FiChevronRight /></button>
        <main className="dashboard-content" onClick={closeSidebar}>
          {children}
        </main>
        {!['/operators/jarvis', '/jarvis'].includes(location.pathname) ? <button className="dashboard-ask-jarvis" type="button" onClick={() => navigate('/operators/jarvis')}><FiCpu /><span>Ask Jarvis</span><i /></button> : null}
      </div>
    </div>
  );
}
