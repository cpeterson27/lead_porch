import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Papa from "papaparse";
import { FiChevronLeft, FiChevronRight, FiClock, FiEdit2, FiEye, FiMail, FiRefreshCw, FiSearch, FiUserPlus } from "react-icons/fi";
import Button from "../components/Button.jsx";
import DashboardCard from "../components/DashboardCard.jsx";
import Modal from "../components/Modal.jsx";
import {
  approveAllOutreach,
  deletePendingOutreach,
  fetchCampaigns,
  fetchOutreach,
  fetchOutreachPreview,
  generateOutreach,
  replaceBouncedOutreachEmail,
  sendOutreachTestEmail,
  sendEmails,
  syncGmailOutreachReplies,
  updateCampaignDiscoveryLeads,
  updateCampaignScheduledSend,
  updateOutreach,
} from "../services/api.js";
import "./Outreach.css";
import useInitiative from "../context/useInitiative.js";

const labels = {
  active: "Needs attention",
  pending: "Pending review",
  approved: "Approved",
  processing: "Accepted",
  delayed: "Delayed",
  unconfirmed: "Status unavailable",
  delivered: "Delivered",
  bounced: "Bounced",
  replied: "Replied",
  failed: "Failed",
};
const baseViewStatuses = ["active", "pending", "approved", "processing", "delayed", "delivered", "bounced", "replied"];
const matchesView = (item, view) => {
  if (view === "active") return ["pending", "approved", "failed"].includes(item.status);
  if (view === "processing") return item.status === "sent" && item.deliveryStatus === "accepted";
  if (view === "delayed") return item.status === "sent" && item.deliveryStatus === "delayed";
  if (view === "unconfirmed") return item.status === "sent" && !item.deliveryStatus;
  if (view === "delivered") return item.deliveryStatus === "delivered" && item.status !== "replied";
  if (view === "bounced") return ["bounced", "failed", "suppressed", "complained"].includes(item.deliveryStatus);
  return item.status === view;
};
const deliveryLabel = (item) => {
  if (item.status === "replied") return "Replied";
  if (item.deliveryStatus === "delivered") return "Delivered";
  if (item.deliveryStatus === "bounced") return "Bounced";
  if (item.deliveryStatus === "delayed") return "Delayed";
  if (["failed", "suppressed", "complained"].includes(item.deliveryStatus)) return labels[item.deliveryStatus] || item.deliveryStatus;
  if (item.deliveryStatus === "accepted") return "Accepted by Resend";
  if (item.status === "sent") return "Status unavailable";
  return labels[item.status] || item.status;
};
const viewGuidance = {
  processing: { title: "Accepted by Resend", body: "Resend accepted these messages and is waiting for the recipient’s mail server to confirm delivery. Do not send them again." },
  delayed: { title: "Delivery is taking longer", body: "Resend is still retrying these messages. Lead Porch will move each one to Delivered or Bounced when the recipient’s server responds." },
  unconfirmed: { title: "Provider status unavailable", body: "Lead Porch has a sent record but no matching provider result. These are shown separately so they are never mistaken for active delivery." },
  delivered: { title: "Delivered successfully", body: "The recipient’s mail server accepted the email. Wait for a reply; delivery does not guarantee the person opened it." },
  bounced: { title: "Replace the email address", body: "Keep the contact, but do not reuse this address. Open the contact, research a different verified email, and update the record before future outreach." },
};
const htmlToText = (html = "") =>
  String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
const isDailyQuotaError = (message = "") =>
  /daily email(?: sending)? quota|daily (?:email )?(?:sending )?(?:quota|limit)/i.test(
    String(message),
  );
const friendlyDeliveryError = (message = "") =>
  isDailyQuotaError(message)
    ? "Sending paused: Resend's daily account quota is currently exhausted."
    : message;
export default function Outreach() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { selectedId: initiativeId } = useInitiative();
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const [emailCorrection, setEmailCorrection] = useState(null);
  const [emailCorrectionError, setEmailCorrectionError] = useState("");
  const [replacementSendError, setReplacementSendError] = useState("");
  const [deletePendingOpen, setDeletePendingOpen] = useState(false);
  const [issueReview, setIssueReview] = useState(null);
  const [coldSendOpen, setColdSendOpen] = useState(false);
  const [coldAttested, setColdAttested] = useState(false);
  const [selectedOutreachIds, setSelectedOutreachIds] = useState([]);
  const [bulkCorrecting, setBulkCorrecting] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState("");
  const [scheduleAttested, setScheduleAttested] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [discoveryLeadsBusy, setDiscoveryLeadsBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const correctionFileRef = useRef(null);
  const activeCampaignIdRef = useRef("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deliverySyncedAt, setDeliverySyncedAt] = useState(null);
  const refreshItems = useCallback(async (campaign) => {
    if (!campaign?._id) {
      setItems([]);
      return [];
    }
    const result = await fetchOutreach(campaign._id);
    const next = Array.isArray(result) ? result : result.outreach || [];
    setItems(next);
    setDeliverySyncedAt(new Date());
    return next;
  }, []);
  const loadItems = useCallback(async (campaign) => {
    if (!campaign?._id) {
      activeCampaignIdRef.current = "";
      setItems([]);
      return;
    }
    const campaignId = String(campaign._id);
    activeCampaignIdRef.current = campaignId;
    // Render the saved queue first. Gmail synchronization and preparation of
    // newly eligible drafts are maintenance work and must not block the page.
    await refreshItems(campaign);
    void Promise.allSettled([
      syncGmailOutreachReplies(),
      generateOutreach(campaign._id, true),
    ]).then(async (results) => {
      if (activeCampaignIdRef.current !== campaignId) return;
      await refreshItems(campaign);
      const preparation = results[1];
      if (preparation.status === "rejected") {
        setError(
          preparation.reason?.response?.data?.error ||
            "Existing outreach loaded, but new drafts could not be prepared.",
        );
      }
    });
  }, [refreshItems]);
  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const data = (await fetchCampaigns()).filter(Boolean);
      setCampaigns(data);
      const campaign =
        data.find(
          (x) =>
            x._id ===
            (params.get("campaignId") ||
              (initiativeId !== "all" ? initiativeId : "")),
        ) ||
        data[0] ||
        null;
      setSelected(campaign);
      await loadItems(campaign);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to load outreach.");
    } finally {
      setLoading(false);
    }
  }, [params, loadItems, initiativeId]);
  useEffect(() => {
    const initialLoad = window.setTimeout(load, 0);
    return () => window.clearTimeout(initialLoad);
  }, [load]);
  useEffect(() => {
    if (!selected?._id) return undefined;
    let active = true;
    const refreshDelivery = async () => {
      try {
        const result = await fetchOutreach(selected._id);
        if (!active) return;
        setItems(Array.isArray(result) ? result : result.outreach || []);
        setDeliverySyncedAt(new Date());
      } catch {
        // Keep the last known delivery state; the next poll will retry.
      }
    };
    const interval = window.setInterval(refreshDelivery, 20000);
    const onVisible = () => { if (document.visibilityState === "visible") refreshDelivery(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selected?._id]);
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          matchesView(item, filter) &&
          (!search ||
            [
              item.organization,
              item.contactName,
              item.contactEmail,
              item.subject,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [items, filter, search],
  );
  const pageSize = 15;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  const selectableItems = useMemo(
    () => filtered.filter((item) =>
      ["pending", "approved"].includes(item.status) ||
      (item.status === "failed" && !["bounced", "suppressed", "complained"].includes(item.deliveryStatus))),
    [filtered],
  );
  const selectedOutreach = useMemo(
    () => items.filter((item) => selectedOutreachIds.includes(item._id)),
    [items, selectedOutreachIds],
  );
  const selectedPendingCount = selectedOutreach.filter((item) => item.status === "pending").length;
  const selectedApprovedCount = selectedOutreach.filter((item) => item.status === "approved").length;
  const selectedFailedCount = selectedOutreach.filter((item) => item.status === "failed").length;
  useEffect(() => {
    const resetPage = window.setTimeout(() => setPage(1), 0);
    return () => window.clearTimeout(resetPage);
  }, [filter, search, selected?._id]);
  useEffect(() => {
    if (page > pageCount) {
      const clampPage = window.setTimeout(() => setPage(pageCount), 0);
      return () => window.clearTimeout(clampPage);
    }
  }, [page, pageCount]);
  const review = async (item) => {
    try {
      setSaving(true);
      setError("");
      const rendered = await fetchOutreachPreview(item._id);
      setPreview({ ...item, htmlBody: rendered.html, subject: rendered.subject || item.subject });
    } catch (err) {
      setError(err.response?.data?.error || "Unable to prepare the complete email preview.");
    } finally {
      setSaving(false);
    }
  };
  const hasUnconfirmed = items.some((item) => matchesView(item, "unconfirmed"));
  const viewStatuses = hasUnconfirmed
    ? [...baseViewStatuses.slice(0, 5), "unconfirmed", ...baseViewStatuses.slice(5)]
    : baseViewStatuses;
  const counts = {
    ...Object.fromEntries(viewStatuses.map((status) => [status, items.filter((item) => matchesView(item, status)).length])),
  };
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const selectedCampaignSentToday = items.filter((item) => item.sentAt && new Date(item.sentAt) >= todayStart).length;
  const selectedCampaignSentTotal = items.filter((item) => item.sentAt).length;
  const dailyQuotaFailures = items.filter(
    (item) => item.status === "failed" && isDailyQuotaError(item.errorMessage),
  ).length;
  const generate = async () => {
    if (!selected) return setError("Select a campaign first.");
    try {
      setSaving(true);
      setError("");
      const result = await generateOutreach(selected._id);
      await refreshItems(selected);
      const routing = Object.entries(result.routingSummary || {});
      setNotice(routing.length
        ? `Draft routing complete: ${routing.map(([label, count]) => `${count} ${label}`).join(" · ")}. Review is still required before sending.`
        : "Draft refresh complete. Review is still required before sending.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to generate outreach.");
    } finally {
      setSaving(false);
    }
  };
  const approve = async (item) => {
    try {
      setSaving(true);
      const updated = await updateOutreach(item._id, { status: "approved", deliveryStatus: "", failedAt: null, errorMessage: "" });
      setItems((current) =>
        current.map((row) => (row._id === updated._id ? updated : row)),
      );
    } catch {
      setError("Unable to approve outreach.");
    } finally {
      setSaving(false);
    }
  };
  const approveSelected = async () => {
    const ids = selectedOutreach.filter((item) => ["pending", "failed"].includes(item.status)).map((item) => item._id);
    if (!selected || !ids.length) return setError("Select one or more pending or recoverable failed drafts to approve.");
    try {
      setSaving(true);
      setError("");
      const result = await approveAllOutreach(selected._id, ids);
      await refreshItems(selected);
      setNotice(result.message || `${ids.length} selected drafts approved. They remain selected and are ready to send.`);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to approve the selected drafts.");
    } finally {
      setSaving(false);
    }
  };
  const deleteAllPending = async () => {
    if (!selected || !counts.pending) return;
    try {
      setSaving(true);
      setError("");
      const result = await deletePendingOutreach(selected._id);
      setDeletePendingOpen(false);
      setItems((current) => current.filter((item) => item.status !== "pending"));
      setNotice(result.message || "Pending drafts deleted.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to delete pending drafts.");
    } finally {
      setSaving(false);
    }
  };
  const sendTest = async () => {
    if (!preview?._id) return;
    try {
      setTestSending(true);
      setError("");
      setNotice("");
      const result = await sendOutreachTestEmail(preview._id);
      setNotice(result.message || "Test email sent to team@elliescoaching.com.");
    } catch (err) {
      setError(err.response?.data?.error || "Unable to send the test email.");
    } finally {
      setTestSending(false);
    }
  };
  const saveReplacementEmail = async () => {
    if (!emailCorrection?._id) return;
    try {
      setSaving(true);
      setEmailCorrectionError("");
      const result = await replaceBouncedOutreachEmail(
        emailCorrection._id,
        emailCorrection.newEmail,
        emailCorrection.confirmDirectSource,
      );
      setEmailCorrection(null);
      await refreshItems(selected);
      setPreview({
        ...result.draft,
        replacementDraft: true,
        htmlBody: result.draft?.htmlBody || "",
      });
      setReplacementSendError("");
      setNotice("Address updated. Review the replacement below; nothing has been sent yet.");
    } catch (err) {
      setEmailCorrectionError(err.response?.data?.error || "Unable to replace this email address.");
    } finally {
      setSaving(false);
    }
  };
  const sendReplacement = async () => {
    if (!preview?._id || !preview?.replacementDraft) return;
    try {
      setSaving(true);
      setReplacementSendError("");
      const approved = await updateOutreach(preview._id, { status: "approved" });
      const result = await sendEmails([approved._id]);
      if (result.failedCount) {
        throw new Error(result.failures?.[0]?.message || "The replacement email could not be sent.");
      }
      setPreview(null);
      setNotice(`Replacement sent to ${approved.contactEmail}. Lead Porch will update its delivery status automatically.`);
      await refreshItems(selected);
      setFilter("processing");
    } catch (err) {
      setReplacementSendError(err.response?.data?.error || err.message || "Unable to send the replacement email.");
    } finally {
      setSaving(false);
    }
  };
  const performSend = async () => {
    const ids = selectedOutreach.filter((item) => item.status === "approved").map((item) => item._id);
    if (!ids.length)
      return setError("Select approved drafts before sending. Use Select next 25 or Select next 50 below.");
    try {
      setSaving(true);
      setError("");
      const result = await sendEmails(ids, {
        deliveryPurpose: "business_prospecting",
        prospectingAttested: true,
      });
      setSelectedOutreachIds((current) => current.filter((id) => !ids.includes(id)));
      if (!result.failedCount) setNotice(`${result.sentCount} email${result.sentCount === 1 ? "" : "s"} accepted by Resend. Delivery updates will appear automatically; no other approved drafts were touched.`);
      if (result.failedCount) {
        setError(
          result.sentCount +
            " sent. " +
            result.failedCount +
            " could not be sent: " +
            ((result.failures &&
              result.failures[0] &&
              result.failures[0].message) ||
              "Review failed records."),
        );
        setNotice(`${result.sentCount} email${result.sentCount === 1 ? "" : "s"} accepted by Resend; ${result.failedCount} stayed in Needs attention.`);
      }
      // Sending is complete at this point. Release the UI immediately; the
      // lightweight fetch below updates cards without Gmail sync or draft
      // regeneration, and the delivery poll will continue applying webhooks.
      setSaving(false);
      void refreshItems(selected).catch(() => null);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to send approved emails.");
    } finally {
      setSaving(false);
    }
  };
  const send = () => {
    if (!selectedApprovedCount) return setError("Approve and select approved drafts before sending.");
    setColdAttested(false);
    setColdSendOpen(true);
  };
  const confirmColdSend = async () => {
    if (!coldAttested) return;
    setColdSendOpen(false);
    await performSend();
  };

  const toLocalInputValue = (date) => {
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const applyCampaignUpdate = (campaign) => {
    setSelected(campaign);
    setCampaigns((current) => current.map((c) => (c._id === campaign._id ? campaign : c)));
  };
  const openSchedule = () => {
    setScheduleError("");
    setScheduleValue(
      selected?.scheduledSendAt
        ? toLocalInputValue(selected.scheduledSendAt)
        : toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)),
    );
    // Once this campaign has ever had a scheduling attestation on file, later
    // reschedules (e.g. moving tomorrow's 8am send to 9am) don't need to ask
    // again — only a brand-new schedule needs the one-time confirmation.
    setScheduleAttested(Boolean(selected?.scheduledSendProspectingAttestedAt));
    setScheduleOpen(true);
  };
  const submitSchedule = async () => {
    if (!selected?._id || !scheduleValue || !scheduleAttested) return;
    setScheduleBusy(true);
    setScheduleError("");
    try {
      const result = await updateCampaignScheduledSend(selected._id, new Date(scheduleValue).toISOString(), {
        deliveryPurpose: "business_prospecting",
        prospectingAttested: true,
      });
      applyCampaignUpdate(result.campaign);
      setScheduleOpen(false);
      setNotice(
        `Scheduled to auto-send ${result.approvedCount} approved draft${result.approvedCount === 1 ? "" : "s"} on ${new Date(result.campaign.scheduledSendAt).toLocaleString()}.`,
      );
    } catch (err) {
      setScheduleError(err.response?.data?.error || "Unable to schedule this campaign's send.");
    } finally {
      setScheduleBusy(false);
    }
  };
  const cancelSchedule = async () => {
    if (!selected?._id) return;
    setScheduleBusy(true);
    setScheduleError("");
    try {
      const result = await updateCampaignScheduledSend(selected._id, null);
      applyCampaignUpdate(result.campaign);
      setScheduleOpen(false);
      setNotice("Scheduled send canceled.");
    } catch (err) {
      setScheduleError(err.response?.data?.error || "Unable to cancel the scheduled send.");
    } finally {
      setScheduleBusy(false);
    }
  };

  const toggleDiscoveryLeads = async () => {
    if (!selected?._id) return;
    const accepting = !selected?.acceptingDiscoveryLeads;
    setDiscoveryLeadsBusy(true);
    try {
      const result = await updateCampaignDiscoveryLeads(selected._id, accepting);
      applyCampaignUpdate(result.campaign);
      setNotice(
        accepting
          ? "This campaign is now accepting new Discovery leads — Apollo finds will route here until you turn this off or the campaign sends."
          : "This campaign will no longer receive new Discovery leads.",
      );
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update this campaign's Discovery-lead setting.");
    } finally {
      setDiscoveryLeadsBusy(false);
    }
  };

  const downloadBounceCorrectionCsv = () => {
    const rows = items
      .filter((item) => item.deliveryStatus === "bounced" && !item.replacement)
      .map((item) => ({
        "Outreach ID": item._id,
        Name: item.contactName || "",
        Company: item.organization || "",
        "Bounced Email": item.contactEmail || "",
        "Bounce Type": item.bounceType || "",
        "Bounce Reason": item.bounceMessage || "",
        "Replacement Email": "",
        "Official Source Confirmed": "NO",
        "Research Notes": "",
      }));
    const csv = Papa.unparse(rows);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `growth-operator-bounce-corrections-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importBounceCorrections = (file) => {
    if (!file) return;
    setBulkCorrecting(true);
    setError("");
    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: async ({ data, errors }) => {
        if (errors.length) {
          setError("The correction CSV contains malformed rows. Download a fresh template and try again.");
          setBulkCorrecting(false);
          return;
        }
        const ready = data.filter((row) => String(row["Replacement Email"] || "").trim());
        let prepared = 0;
        const failures = [];
        for (const row of ready) {
          const outreachId = String(row["Outreach ID"] || "").trim();
          const email = String(row["Replacement Email"] || "").trim();
          const confirmed = /^(yes|true|confirmed|1)$/i.test(
            String(row["Official Source Confirmed"] || "").trim(),
          );
          if (!outreachId || !confirmed) {
            failures.push(`${row.Name || email}: mark Official Source Confirmed as YES`);
            continue;
          }
          try {
            await replaceBouncedOutreachEmail(outreachId, email, true);
            prepared += 1;
          } catch (err) {
            failures.push(`${row.Name || email}: ${err.response?.data?.error || "could not be updated"}`);
          }
        }
        await refreshItems(selected);
        setBulkCorrecting(false);
        if (correctionFileRef.current) correctionFileRef.current.value = "";
        setNotice(`${prepared} replacement draft${prepared === 1 ? "" : "s"} prepared. ${failures.length} row${failures.length === 1 ? "" : "s"} still need attention.`);
        if (failures.length) setError(failures.slice(0, 8).join(" · "));
      },
      error: () => {
        setError("Lead Porch could not read that correction CSV.");
        setBulkCorrecting(false);
      },
    });
  };
  return (
    <div className="page-dashboard outreach-page">
      <header className="outreach-header">
        <div>
          <button
            type="button"
            className="outreach-header__back"
            onClick={() => navigate("/campaigns")}
          >
            ← All campaigns
          </button>
          <p className="outreach-eyebrow">Campaign delivery</p>
          <h1 className="page-title">Outreach</h1>
          <p>
            New qualified campaign contacts are added here automatically. Review
            and approve each message before anything is sent.
          </p>
        </div>
        <div className="outreach-header__actions">
          <Button variant="outline" loading={saving} onClick={generate}>
            <FiRefreshCw />
            Refresh drafts
          </Button>
          <Button
            variant="outline"
            disabled={!counts.pending || saving}
            onClick={() => setDeletePendingOpen(true)}
          >
            Delete pending · {counts.pending || 0}
          </Button>
          <label className={`discovery-leads-toggle${discoveryLeadsBusy ? " is-busy" : ""}`}>
            <input
              type="checkbox"
              checked={Boolean(selected?.acceptingDiscoveryLeads)}
              disabled={!selected || discoveryLeadsBusy}
              onChange={toggleDiscoveryLeads}
            />
            <span>
              <FiUserPlus /> Accepting Discovery leads
            </span>
          </label>
          <Button
            variant="outline"
            disabled={!selected || saving}
            onClick={openSchedule}
          >
            <FiClock />
            {selected?.scheduledSendAt ? "Scheduled send" : "Schedule send"}
          </Button>
          <Button loading={saving} onClick={send}>
            <FiMail />
            Send selected · {selectedApprovedCount}
          </Button>
        </div>
      </header>
      {selected?.acceptingDiscoveryLeads ? (
        <p className="outreach-notice">
          New people a Discovery schedule finds and qualifies will be added straight to this campaign. Turn "Accepting
          Discovery leads" off any time to stop — it also turns off automatically the moment this campaign's scheduled
          send completes.
        </p>
      ) : null}
      {selected?.scheduledSendAt && !selected?.scheduledSendCompletedAt ? (
        <p className="outreach-notice">
          Every currently approved draft in this campaign will auto-send on{" "}
          {new Date(selected.scheduledSendAt).toLocaleString()}. Approving more drafts before then adds them to the send.
        </p>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="outreach-notice">{notice}</p> : null}
      {dailyQuotaFailures ? (
        <aside className="outreach-provider-alert" role="status">
          <div>
            <strong>{dailyQuotaFailures} draft{dailyQuotaFailures === 1 ? "" : "s"} need to be retried</strong>
            <p>
              Resend previously rejected {dailyQuotaFailures} message{dailyQuotaFailures === 1 ? "" : "s"} when the account had exhausted its former daily allowance. This is saved failure history, not a live claim that your upgraded account is paused. The drafts are safe in Lead Porch; select them, prepare them again, and send when ready.
            </p>
          </div>
          <div className="outreach-provider-alert__actions">
            <button type="button" onClick={() => { setFilter("failed"); setPage(1); }}>Show failed drafts</button>
            <a href="https://resend.com/settings/usage" target="_blank" rel="noreferrer">Check Resend usage</a>
          </div>
        </aside>
      ) : null}
      <section className="outreach-controls">
        <label>
          Campaign
          <select
            className="select-input"
            value={selected?._id || ""}
            onChange={async (e) => {
              const next =
                campaigns.find((c) => c._id === e.target.value) || null;
              setSelected(next);
              setSelectedOutreachIds([]);
              await loadItems(next);
            }}
          >
            {campaigns.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <p><strong>{selected?.name || "Choose a campaign"}</strong><span>{counts.active || 0} messages need attention</span></p>
      </section>
      <section className="outreach-summary">
        {viewStatuses.map(
          (status) => (
            <button
              key={status}
              className={filter === status ? "is-active" : ""}
              onClick={() => setFilter(status)}
            >
              <span>{status === "delivered" ? "Delivered · campaign total" : labels[status]}</span>
              <strong>{counts[status] || 0}</strong>
            </button>
          ),
        )}
      </section>
      <aside className="outreach-usage-explainer">
        <div><span>Submitted today from this campaign</span><strong>{selectedCampaignSentToday}</strong></div>
        <div><span>Submitted over this campaign’s lifetime</span><strong>{selectedCampaignSentTotal}</strong></div>
        <p>Lead Porch accepts up to 100 selected drafts per send request as a safe batch size; that is not a daily limit. “Delivered” is a cumulative campaign result—not today’s usage.</p>
      </aside>
      <DashboardCard
        title={selected ? `Messages for ${selected.name}` : "Outreach messages"}
      >
        <div className="outreach-list-tools">
          <div><strong>{labels[filter] || "Outreach"}</strong><span>{filtered.length} message{filtered.length === 1 ? "" : "s"} in this view · Delivery updates automatically{deliverySyncedAt ? ` · Checked ${deliverySyncedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span></div>
          {filter === "bounced" ? (
            <div className="outreach-bulk-corrections">
              <Button variant="outline" size="sm" onClick={downloadBounceCorrectionCsv}>
                Download correction CSV
              </Button>
              <Button variant="outline" size="sm" loading={bulkCorrecting} onClick={() => correctionFileRef.current?.click()}>
                Import corrected CSV
              </Button>
              <input
                ref={correctionFileRef}
                type="file"
                hidden
                accept=".csv,text/csv"
                onChange={(event) => importBounceCorrections(event.target.files?.[0])}
              />
            </div>
          ) : null}
          <label className="outreach-search">
            <span><FiSearch aria-hidden="true" /><input className="select-input" aria-label={`Search ${labels[filter] || "outreach"}`} placeholder={filter === "sent" ? "Search sent mail" : `Search ${String(labels[filter] || "outreach").toLowerCase()}`} value={search} onChange={(e) => setSearch(e.target.value)} /></span>
          </label>
        </div>
        {selectableItems.length ? (
          <div className="outreach-batch-tools" aria-label="Batch selection controls">
            <div>
              <strong>{selectedOutreach.length} selected</strong>
              <span>{selectedPendingCount} pending · {selectedApprovedCount} approved · {selectedFailedCount} retryable</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSelectedOutreachIds(selectableItems.slice(0, 25).map((item) => item._id))}>
              Select next {Math.min(25, selectableItems.length)}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelectedOutreachIds(selectableItems.slice(0, 50).map((item) => item._id))}>
              Select next {Math.min(50, selectableItems.length)}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelectedOutreachIds(visibleItems.filter((item) => selectableItems.some((selectable) => selectable._id === item._id)).map((item) => item._id))}>
              Select this page
            </Button>
            <Button variant="outline" size="sm" disabled={!selectedOutreach.length} onClick={() => setSelectedOutreachIds([])}>
              Clear
            </Button>
            <Button size="sm" loading={saving} disabled={!(selectedPendingCount + selectedFailedCount)} onClick={approveSelected}>
              Approve selected · {selectedPendingCount + selectedFailedCount}
            </Button>
            <Button size="sm" loading={saving} disabled={!selectedApprovedCount} onClick={send}>
              <FiMail /> Send selected · {selectedApprovedCount}
            </Button>
          </div>
        ) : null}
        {viewGuidance[filter] ? <aside className={`outreach-guidance outreach-guidance--${filter}`}><strong>{viewGuidance[filter].title}</strong><span>{viewGuidance[filter].body}</span></aside> : null}
        {loading ? (
          <p>Loading outreach…</p>
        ) : filtered.length ? (
          <div className="outreach-mailbox">
            <div className="outreach-mailbox__head" aria-hidden="true">
              <span>Recipient and message</span><span>Status</span><span>Action</span>
            </div>
            <div className="outreach-list">
            {visibleItems.map((item) => (
              <article key={item._id} className={`outreach-item ${selectableItems.some((selectable) => selectable._id === item._id) && selectedOutreachIds.includes(item._id) ? "is-selected" : ""}`}>
                {selectableItems.some((selectable) => selectable._id === item._id) ? (
                  <label className="outreach-item__select">
                    <input
                      type="checkbox"
                      checked={selectedOutreachIds.includes(item._id)}
                      onChange={() => setSelectedOutreachIds((current) => current.includes(item._id) ? current.filter((id) => id !== item._id) : [...current, item._id])}
                      aria-label={`Select ${item.contactName || item.contactEmail || "recipient"}`}
                    />
                    <span>Select recipient</span>
                  </label>
                ) : null}
                <div className="outreach-item__main">
                  <div className="outreach-item__recipient">
                    <strong>{item.contactName || item.contactEmail || "Contact"}</strong>
                    <span>{item.contactEmail || "No email"}{item.organization && item.organization.toLowerCase() !== String(item.contactName || "").toLowerCase() ? ` · ${item.organization}` : ""}</span>
                  </div>
                  <div className="outreach-item__message">
                    <strong>{item.subject || "No subject"}</strong>
                    {item.sentAt ? <span>Sent {new Date(item.sentAt).toLocaleString()}</span> : null}
                  </div>
                </div>
                <div className="outreach-item__state">
                  <span className={`outreach-status outreach-status--${item.deliveryStatus || item.status}`}>
                    {deliveryLabel(item)}
                  </span>
                  {item.deliveryStatus === "bounced" ? (
                    <small>
                      {item.replacement
                        ? `Replacement ${deliveryLabel(item.replacement).toLowerCase()}`
                        : "Needs a verified replacement"}
                    </small>
                  ) : null}
                </div>
                <div className="outreach-item__actions">
                  <Button
                    variant={item.status === "pending" ? "primary" : "outline"}
                    size="sm"
                    onClick={() => {
                      if (item.deliveryStatus === "bounced") {
                        if (item.replacement) {
                          review(item.replacement);
                          return;
                        }
                        setEmailCorrectionError("");
                        const correctedEmail =
                          item.contactId?.email &&
                          item.contactId.email !== item.contactEmail
                            ? item.contactId.email
                            : "";
                        setEmailCorrection({ ...item, newEmail: correctedEmail, confirmDirectSource: false });
                      } else if (item.status === "failed") {
                        setIssueReview(item);
                      } else review(item);
                    }}
                  >
                    {item.deliveryStatus === "bounced" ? <FiEdit2 /> : <FiEye />}
                    <span>{item.deliveryStatus === "bounced" ? (item.replacement ? "View replacement" : "Replace email") : item.status === "pending" ? "Review" : item.status === "failed" ? "Review issue" : "View email"}</span>
                  </Button>
                  {item.contactEmail && ["sent", "replied"].includes(item.status) && item.deliveryStatus !== "bounced" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      title="Open this contact’s inbox conversation"
                      aria-label={`Open conversation with ${item.contactName || item.contactEmail}`}
                      onClick={() =>
                        navigate(
                          "/inbox?contact=" +
                            encodeURIComponent(item.contactEmail),
                        )
                      }
                    >
                      <FiMail />
                      <span>Open inbox</span>
                    </Button>
                  ) : null}
                  {item.status === "failed" && item.errorMessage ? (
                    <span className="outreach-item__error" title={item.errorMessage}>
                      {friendlyDeliveryError(item.errorMessage)}
                    </span>
                  ) : null}
                </div>
              </article>
            ))}
            </div>
            <footer className="outreach-pagination">
              <span>{filtered.length} message{filtered.length === 1 ? "" : "s"} · Page {page} of {pageCount}</span>
              <div>
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous outreach page"><FiChevronLeft /> Previous</Button>
                <Button variant="outline" size="sm" disabled={page === pageCount} onClick={() => setPage((value) => value + 1)} aria-label="Next outreach page">Next <FiChevronRight /></Button>
              </div>
            </footer>
          </div>
        ) : (
          <div className="table-state table-state--empty">
            No outreach items match this view. Add a qualified contact to the
            campaign, then return here.
          </div>
        )}
      </DashboardCard>
      <Modal
        isOpen={Boolean(emailCorrection)}
        onClose={() => setEmailCorrection(null)}
        title="Replace undeliverable email"
        footer={
          <>
            <Button variant="outline" onClick={() => setEmailCorrection(null)}>Cancel</Button>
            <Button
              loading={saving}
              disabled={
                !emailCorrection?.newEmail ||
                (!(emailCorrection.contactId?.emailStatus === "verified" && emailCorrection.newEmail === emailCorrection.contactId?.email) && !emailCorrection?.confirmDirectSource)
              }
              onClick={saveReplacementEmail}
            >Save &amp; prepare draft</Button>
          </>
        }
      >
        {emailCorrection ? (
          <form className="outreach-email-correction" onSubmit={(event) => { event.preventDefault(); saveReplacementEmail(); }}>
            <div className="outreach-email-correction__audit">
              <span>Original bounced address</span>
              <strong>{emailCorrection.contactEmail}</strong>
              {emailCorrection.bounceMessage ? <p>{emailCorrection.bounceMessage}</p> : <p>Resend reported that this address could not receive the message.</p>}
            </div>
            <label>
              Replacement email address
              <input type="email" autoFocus autoComplete="off" placeholder="name@company.com" value={emailCorrection.newEmail} onChange={(event) => setEmailCorrection((current) => ({ ...current, newEmail: event.target.value }))} />
            </label>
            {emailCorrection.contactId?.emailStatus === "verified" && emailCorrection.newEmail === emailCorrection.contactId?.email ? (
              <p className="outreach-email-correction__note"><strong>Verified correction found:</strong> This contact already has a different verified address in the CRM. Saving will prepare the replacement draft.</p>
            ) : (
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(emailCorrection.confirmDirectSource)}
                  onChange={(event) => setEmailCorrection((current) => ({ ...current, confirmDirectSource: event.target.checked }))}
                />
                I found this exact address on an official company source or received it directly from this person. I did not guess the address pattern.
              </label>
            )}
            {emailCorrectionError ? <p className="form-error">{emailCorrectionError}</p> : null}
            <p className="outreach-email-correction__note"><strong>What happens next:</strong> Lead Porch updates the contact and creates a new draft for your review. Confirm this address is correct before approving it. The bounced record stays unchanged for an accurate audit trail, and nothing is sent automatically.</p>
          </form>
        ) : null}
      </Modal>
      <Modal
        isOpen={Boolean(issueReview)}
        onClose={() => setIssueReview(null)}
        title="Why this message did not send"
        footer={
          <>
            <Button variant="outline" onClick={() => setIssueReview(null)}>Close</Button>
            {issueReview && !isDailyQuotaError(issueReview.errorMessage) && !["bounced", "suppressed", "complained"].includes(issueReview.deliveryStatus) ? (
              <Button loading={saving} onClick={async () => {
                await approve(issueReview);
                setIssueReview(null);
                setNotice("Draft approved. Select it and send when ready.");
              }}>Approve this draft to retry</Button>
            ) : null}
          </>
        }
      >
        {issueReview ? (
          <div className="outreach-issue-review">
            <p><strong>{issueReview.contactName || issueReview.contactEmail}</strong></p>
            <p className="form-error">{friendlyDeliveryError(issueReview.errorMessage) || "The provider could not send this message."}</p>
            {isDailyQuotaError(issueReview.errorMessage) ? (
              <p><strong>This draft is safe.</strong> Do not retry it yet. Resend is currently over the account's free daily allowance, even if this is your first attempt during your local calendar day. Retry only after Resend's Usage page shows that the daily counter has reset, or after the Resend plan is upgraded.</p>
            ) : String(issueReview.errorMessage || "").includes("no recorded marketing opt-in") ? (
              <p>This address may be retried only through <strong>Cold business prospecting</strong>. That route does not mark the person as subscribed and still enforces verification, unsubscribe, suppression, bounce, mailing-address, and one-click opt-out safeguards.</p>
            ) : (
              <p>Correct the issue shown above before retrying. Delivery failures and opt-outs are never overridden.</p>
            )}
            <Button variant="outline" onClick={() => { const item = issueReview; setIssueReview(null); review(item); }}>Preview email copy</Button>
          </div>
        ) : null}
      </Modal>
      <Modal
        isOpen={coldSendOpen}
        onClose={() => !saving && setColdSendOpen(false)}
        title={`Send ${selectedApprovedCount} cold business email${selectedApprovedCount === 1 ? "" : "s"}?`}
        footer={
          <>
            <Button variant="outline" disabled={saving} onClick={() => setColdSendOpen(false)}>Cancel</Button>
            <Button loading={saving} disabled={!coldAttested} onClick={confirmColdSend}><FiMail /> Send selected</Button>
          </>
        }
      >
        <div className="outreach-cold-confirmation">
          <p>This is a separate prospecting route. It does <strong>not</strong> claim that these people subscribed.</p>
          <p>Lead Porch will still block every unsubscribed, suppressed, bounced, complained, invalid, archived, or unverified address. Every message includes the configured business identity, mailing address, and one-click unsubscribe.</p>
          <label>
            <input type="checkbox" checked={coldAttested} onChange={(event) => setColdAttested(event.target.checked)} />
            <span>I confirm these are relevant business contacts, this message accurately identifies the sender and purpose, and I am authorized to conduct this outreach under the rules that apply to this campaign and its recipients.</span>
          </label>
        </div>
      </Modal>
      <Modal
        isOpen={scheduleOpen}
        onClose={() => !scheduleBusy && setScheduleOpen(false)}
        title="Schedule automatic send"
        footer={
          <>
            {selected?.scheduledSendAt ? (
              <Button variant="outline" disabled={scheduleBusy} onClick={cancelSchedule}>
                Cancel scheduled send
              </Button>
            ) : null}
            <Button variant="outline" disabled={scheduleBusy} onClick={() => setScheduleOpen(false)}>
              Close
            </Button>
            <Button loading={scheduleBusy} disabled={!scheduleValue || !scheduleAttested} onClick={submitSchedule}>
              <FiClock /> Save schedule
            </Button>
          </>
        }
      >
        <div className="outreach-schedule-form">
          <p>
            Every draft that is <strong>approved</strong> for this campaign at the scheduled time will be sent
            automatically as cold business prospecting — no one needs to click Send. New Discovery leads added and
            approved before then (their draft is auto-approved once the template they use is approved) are included
            automatically. Lead Porch still blocks every unsubscribed, suppressed, bounced, complained, invalid,
            archived, or unverified address — that's enforced regardless of this attestation.
          </p>
          <label>
            <span>Send at</span>
            <input
              className="select-input"
              type="datetime-local"
              value={scheduleValue}
              onChange={(event) => setScheduleValue(event.target.value)}
            />
          </label>
          <label className="outreach-schedule-attestation">
            <input type="checkbox" checked={scheduleAttested} onChange={(event) => setScheduleAttested(event.target.checked)} />
            <span>I confirm these are relevant business contacts, this message accurately identifies the sender and purpose, and I am authorized to conduct this outreach under the rules that apply to this campaign and its recipients. This covers every send this schedule triggers, not just the next one.</span>
          </label>
          {scheduleError ? <p className="form-error">{scheduleError}</p> : null}
        </div>
      </Modal>
      <Modal
        isOpen={Boolean(preview)}
        onClose={() => setPreview(null)}
        title="Review outreach email"
        footer={
          <>
            <Button
              variant="outline"
              loading={testSending}
              onClick={sendTest}
            >
              Send test to team@elliescoaching.com
            </Button>
            {preview?.replacementDraft ? (
              <Button loading={saving} onClick={sendReplacement}>
                <FiMail />
                Send replacement now
              </Button>
            ) : preview?.status === "pending" ? (
              <Button
                onClick={() => {
                  approve(preview);
                  setPreview(null);
                }}
              >
                Approve draft
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setPreview(null)}>
                Close
              </Button>
            )}
          </>
        }
      >
        {preview ? (
          <div className="outreach-preview">
            {preview.replacementDraft ? (
              <div className="outreach-preview__replacement">
                <strong>Replacement ready</strong>
                <span>This sends only this corrected message. The original bounce remains in delivery history.</span>
              </div>
            ) : null}
            {replacementSendError ? <p className="form-error">{replacementSendError}</p> : null}
            <p>
              <strong>To</strong> {preview.contactName || "Contact"}{" "}
              {preview.contactEmail ? `<${preview.contactEmail}>` : ""}
            </p>
            <p>
              <strong>Subject</strong> {preview.subject || "No subject"}
            </p>
            <p>
              <strong>Audience template</strong>{" "}
              {preview.templateAudienceLabel || "All Deal to Close contacts"}
            </p>
            {preview.htmlBody ? (
              <>
                <iframe
                  className="outreach-preview__frame"
                  title={`Email preview for ${preview.contactName || "contact"}`}
                  srcDoc={preview.htmlBody}
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                />
              </>
            ) : (
              <div className="outreach-preview__body">
                {preview.emailDraft ||
                  htmlToText(preview.htmlBody) ||
                  "No email body has been stored."}
              </div>
            )}
          </div>
        ) : null}
      </Modal>
      <Modal
        isOpen={deletePendingOpen}
        onClose={() => !saving && setDeletePendingOpen(false)}
        title="Delete all pending drafts?"
        footer={
          <>
            <Button variant="outline" disabled={saving} onClick={() => setDeletePendingOpen(false)}>Keep drafts</Button>
            <Button variant="danger" loading={saving} onClick={deleteAllPending}>Delete {counts.pending || 0} drafts</Button>
          </>
        }
      >
        <p>This permanently deletes only the unsent drafts waiting for review in <strong>{selected?.name || "this campaign"}</strong>.</p>
        <p>Approved, sent, delivered, and replied-to emails are not touched.</p>
      </Modal>
    </div>
  );
}
