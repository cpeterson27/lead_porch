import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  FiActivity,
  FiBriefcase,
  FiCalendar,
  FiFolder,
  FiUsers,
  FiMessageSquare,
  FiZap,
  FiBarChart2,
  FiTrendingUp,
  FiSettings,
  FiLink,
  FiCpu,
  FiFileText,
  FiBookOpen,
  FiShield,
  FiList,
  FiLogOut,
  FiDollarSign,
  FiClock,
  FiUserCheck,
  FiUser,
  FiChevronLeft,
  FiChevronRight,
} from "react-icons/fi";
import useAuth from "../context/useAuth.js";
import useWorkspaceTheme from "../context/useWorkspaceTheme.js";
import { fetchWorkspaceConfig } from "../services/api.js";
import {
  canManageCoaching,
  canUseCoachPortal,
  hasAnyPermission,
  hasPermission,
  isAmbassadorOnly,
  isCoachOnly,
  isSocialConnectionOnly,
} from "../utils/roleAccess.js";
import "./Sidebar.css";

const navGroups = [
  {
    label: "Platform",
    items: [
      {
        label: "Businesses",
        path: "/businesses",
        icon: <FiBriefcase />,
        platformOnly: true,
      },
    ],
  },
  {
    label: "Operate",
    items: [
      {
        label: "Command Center",
        path: "/command-center",
        icon: <FiActivity />,
        permissions: ["crm.view", "analytics.view"],
      },
      {
        label: "CRM",
        path: "/crm/contacts",
        icon: <FiUsers />,
        permissions: ["crm.view"],
      },
      {
        label: "Sales Pipeline",
        path: "/opportunities",
        icon: <FiBriefcase />,
        permissions: [
          "sales.opportunities.view",
          "sales.opportunities.view_assigned",
        ],
      },
      {
        label: "Conversations",
        path: "/conversations",
        icon: <FiMessageSquare />,
        permissions: ["communications.view"],
      },
      {
        label: "Outreach",
        path: "/outreach",
        icon: <FiZap />,
        permissions: ["outreach.manage"],
      },
      {
        label: "Tasks",
        path: "/tasks",
        icon: <FiList />,
        permissions: ["crm.manage", "crm.manage_assigned"],
      },
    ],
  },
  {
    label: "Grow",
    items: [
      {
        label: "Campaigns",
        path: "/campaigns",
        icon: <FiZap />,
        permissions: ["campaigns.manage"],
      },
      {
        label: "Social Leads",
        path: "/social-leads",
        icon: <FiMessageSquare />,
        permissions: ["social.manage"],
      },
      {
        label: "Automations",
        path: "/automations",
        icon: <FiZap />,
        permissions: ["automations.manage"],
      },
      {
        label: "Discovery",
        path: "/discovery",
        icon: <FiTrendingUp />,
        permissions: ["discovery.manage"],
      },
      {
        label: "Events",
        path: "/events",
        icon: <FiCalendar />,
        permissions: ["campaigns.manage"],
      },
      {
        label: "Content",
        path: "/content",
        icon: <FiFileText />,
        permissions: ["campaigns.manage"],
      },
      {
        label: "Partners",
        path: "/partners",
        icon: <FiFolder />,
        permissions: ["campaigns.manage"],
      },
    ],
  },
  {
    label: "Understand",
    items: [
      {
        label: "Analytics",
        path: "/analytics",
        icon: <FiBarChart2 />,
        permissions: ["analytics.view"],
      },
      {
        label: "Jarvis",
        path: "/operators/jarvis",
        icon: <FiCpu />,
        permissions: ["jarvis.manage"],
      },
      {
        label: "Pipeline Health",
        path: "/system-health",
        icon: <FiActivity />,
        permissions: ["system.monitor"],
      },
    ],
  },
  {
    label: "Configure",
    items: [
      {
        label: "Brand Ambassadors",
        path: "/ambassadors/manage",
        icon: <FiLink />,
        permissions: ["ambassadors.view", "ambassadors.manage"],
      },
      {
        label: "Social",
        path: "/social",
        icon: <FiUserCheck />,
        permissions: ["social.manage"],
      },
      {
        label: "Integrations",
        path: "/integrations",
        icon: <FiLink />,
        permissions: ["integrations.manage"],
      },
      {
        label: "Settings",
        path: "/settings/workspace",
        icon: <FiSettings />,
        permissions: [
          "workspace.manage",
          "team.view",
          "payments.view",
          "payments.manage",
        ],
      },
      {
        label: "AI & Acquisition",
        path: "/settings/ai-acquisition",
        icon: <FiCpu />,
        permissions: ["workspace.manage"],
      },
      {
        label: "Knowledge Center",
        path: "/settings/knowledge-center",
        icon: <FiBookOpen />,
        permissions: ["workspace.manage"],
      },
      {
        label: "Audit Log",
        path: "/settings/audit-log",
        icon: <FiShield />,
        permissions: ["workspace.manage"],
      },
    ],
  },
];

const coachingGroup = {
  label: "Coach",
  items: [
    {
      label: "Coaching",
      path: "/coaching",
      icon: <FiUserCheck />,
      permissions: ["coaching.view"],
    },
  ],
};

const coachGroups = [
  {
    label: "Coach Portal",
    items: [
      { label: "My Dashboard", path: "/coach", icon: <FiActivity /> },
      { label: "My Students", path: "/coach/students", icon: <FiUsers /> },
      { label: "Upcoming", path: "/coach/upcoming", icon: <FiClock /> },
      { label: "My Schedule", path: "/coach/schedule", icon: <FiCalendar /> },
      { label: "My Referrals", path: "/coach/referrals", icon: <FiLink /> },
      {
        label: "My Commissions",
        path: "/coach/commissions",
        icon: <FiDollarSign />,
      },
      {
        label: "My Public Profile",
        path: "/coach/profile",
        icon: <FiUserCheck />,
      },
      { label: "My Account", path: "/profile", icon: <FiUser /> },
    ],
  },
];
const ambassadorGroups = [
  {
    label: "Ambassador Portal",
    items: [
      { label: "My Dashboard", path: "/ambassador", icon: <FiLink /> },
      { label: "My Profile", path: "/profile", icon: <FiUser /> },
    ],
  },
];

export default function Sidebar({ isOpen, isCollapsed, onClose, onToggleCollapse }) {
  const { logout, session } = useAuth();
  const { site } = useWorkspaceTheme();
  const socialConnectionOnly = isSocialConnectionOnly(session);
  const [organization, setOrganization] = useState(null);
  useEffect(() => {
    if (socialConnectionOnly) return undefined;
    let active = true;
    const load = () =>
      fetchWorkspaceConfig()
        .then((config) => {
          if (active) setOrganization(config);
        })
        .catch(() => {});
    const update = (event) =>
      setOrganization((current) => ({ ...current, ...(event.detail || {}) }));
    load();
    window.addEventListener("workspace-organization-updated", update);
    return () => {
      active = false;
      window.removeEventListener("workspace-organization-updated", update);
    };
  }, [session?.workspace?.name, socialConnectionOnly]);
  const coachOnly = isCoachOnly(session);
  const ambassadorOnly = isAmbassadorOnly(session);
  const coachingEnabled = organization?.moduleAccess?.coaching === true;
  const ambassadorsEnabled = organization?.moduleAccess?.ambassadors === true;
  const displayedOrganization = socialConnectionOnly
    ? {
        workspaceName: session?.workspace?.name || "Lead Porch",
        appBranding: {},
      }
    : organization;
  let groups = socialConnectionOnly
    ? [
        {
          label: "Meta App Review",
          items: navGroups
            .flatMap((group) => group.items)
            .filter((item) => item.path === "/social"),
        },
      ]
    : ambassadorOnly
      ? ambassadorGroups
      : coachOnly
        ? coachGroups
        : canManageCoaching(session)
          ? [
              navGroups[0],
              ...(coachingEnabled ? [coachingGroup] : []),
              ...navGroups
                .map((group) => ({
                  ...group,
                  items: group.items.filter(
                    (item) =>
                      item.path !== "/ambassadors/manage" || ambassadorsEnabled,
                  ),
                }))
                .slice(1),
            ]
          : navGroups;
  if (!coachOnly && canUseCoachPortal(session))
    groups = [...groups, ...coachGroups];
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!item.platformOnly || session?.isPlatformOwner) &&
          (!item.permissions || hasAnyPermission(session, item.permissions)),
      ),
    }))
    .filter((group) => group.items.length);
  // The dashboard sidebar is always a dark surface, so it prefers the
  // dark-backgrounds logo — the same single light/dark logo pair used
  // everywhere else (public website, application page).
  const brand = socialConnectionOnly
    ? {}
    : displayedOrganization?.branding || site?.branding || {};
  const appLogo = brand.publicSiteLogoDarkUrl || brand.publicSiteLogoUrl || "";
  return (
    <aside
      className={`${isOpen ? "sidebar sidebar--open" : "sidebar"} ${isCollapsed ? "sidebar--collapsed" : ""}`}
    >
      {/* Attached directly to the sidebar's own edge (desktop only — on
          mobile the sidebar is an off-canvas drawer with nothing to attach
          an edge arrow to; Navbar's hamburger opens it there instead). */}
      {onToggleCollapse ? (
        <button
          type="button"
          className="sidebar__collapse-toggle"
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isCollapsed ? <FiChevronRight /> : <FiChevronLeft />}
        </button>
      ) : null}
      <div className="sidebar__brand">
        <div className="sidebar__logo">
          {appLogo ? (
            <img
              src={appLogo}
              alt={`${displayedOrganization?.workspaceName || "Workspace"} dashboard logo`}
            />
          ) : (
            <span aria-hidden="true">
              {(
                displayedOrganization?.workspaceName ||
                (socialConnectionOnly ? "Lead Porch" : site?.workspace?.name) ||
                "Lead Porch"
              ).slice(0, 1)}
            </span>
          )}
        </div>
        <div>
          <p>
            {session?.workspace?.name ||
              displayedOrganization?.workspaceName ||
              site?.workspace?.name ||
              "Lead Porch"}
          </p>
          <small>Powered by Lead Porch</small>
        </div>
      </div>
      <nav className="sidebar__nav" aria-label="Primary">
        {visibleGroups.map((group) => (
          <section
            className="sidebar__group"
            key={group.label}
            aria-label={group.label}
          >
            <p className="sidebar__group-label">{group.label}</p>
            {group.items.map((item) =>
              item.planned ? (
                <div
                  className="sidebar__link sidebar__link--planned"
                  key={item.label}
                  aria-label={`${item.label}, planned`}
                >
                  <span className="sidebar__icon">{item.icon}</span>
                  <span>{item.label}</span>
                  <small>Planned</small>
                </div>
              ) : (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === "/coach"}
                  className={({ isActive }) =>
                    `sidebar__link ${isActive ? "sidebar__link--active" : ""}`
                  }
                  onClick={onClose}
                >
                  <span className="sidebar__icon">{item.icon}</span>
                  <span>{item.label}</span>
                </NavLink>
              ),
            )}
          </section>
        ))}
      </nav>
      <div className="sidebar__footer">
        <button
          className="sidebar__logout"
          type="button"
          onClick={async () => {
            await logout();
            window.location.assign("/");
          }}
          title={`Sign out ${session?.user?.email || ""}`}
        >
          <FiLogOut />
          <span>Sign out</span>
        </button>
        <p>
          {ambassadorOnly
            ? "Restricted ambassador workspace."
            : coachOnly
              ? "Restricted coaching workspace."
              : hasPermission(session, "team.manage")
                ? "Workspace administration enabled."
                : "Private assigned workspace."}
        </p>
      </div>
    </aside>
  );
}
