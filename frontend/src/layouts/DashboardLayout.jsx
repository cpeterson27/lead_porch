import { useState } from "react";
import Sidebar from "../components/Sidebar.jsx";
import Navbar from "../components/Navbar.jsx";
import "./DashboardLayout.css";

export default function DashboardLayout({ children }) {
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
        <Navbar onMenuClick={toggleSidebar} />
        <main className="dashboard-content" onClick={closeSidebar}>
          {children}
        </main>
      </div>
    </div>
  );
}
