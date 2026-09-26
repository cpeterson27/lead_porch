import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FiArchive, FiArrowLeft, FiEye, FiEyeOff, FiInbox, FiMail, FiRefreshCw, FiSearch, FiSend, FiTrash2 } from "react-icons/fi";
import Button from "../components/Button.jsx";
import Modal from "../components/Modal.jsx";
import {
  beginGmailConnection,
  disconnectGmail,
  deleteSelectedGmailTrash,
  emptyGmailTrash,
  fetchContactEmailHistory,
  fetchGmailConnection,
  fetchGmailThread,
  fetchGmailThreads,
  fetchOutreachEmailHistory,
  sendGmailMessage,
  saveConversationDraft,
  syncGmailConversations,
  updateGmailThread,
} from "../services/api.js";
import "./Integrations.css";

const mailboxQueries = {
  inbox: "in:inbox",
  sent: "in:sent",
  unread: "in:inbox is:unread",
  trash: "in:trash",
};

const emailAddress = (value = "") => String(value).match(/<([^>]+)>/)?.[1] || String(value).match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || "";

export default function GmailIntegration() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [threads, setThreads] = useState([]);
  const [outreachHistory, setOutreachHistory] = useState([]);
  const [campaignSends, setCampaignSends] = useState([]);
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignPagination, setCampaignPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [selectedThread, setSelectedThread] = useState(null);
  const [selectedOutreach, setSelectedOutreach] = useState(null);
  const [mailbox, setMailbox] = useState(params.get("view") || "inbox");
  const [search, setSearch] = useState(params.get("contact") || "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reply, setReply] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [draftState, setDraftState] = useState("");
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState([]);
  const [bulkActionRunning, setBulkActionRunning] = useState(false);
  const loadRef = useRef(null);

  const query = search.trim() ? search.trim() : mailboxQueries[mailbox] || mailboxQueries.inbox;
  const needsModifyPermission = status?.connected && !status.scopes?.includes("https://www.googleapis.com/auth/gmail.modify");
  const needsDeletePermission = status?.connected && !status.scopes?.includes("https://mail.google.com/");
  const reconnect = async () => window.location.assign((await beginGmailConnection()).authorizationUrl);
  const load = async () => {
    try {
      setLoading(true);
      const connection = await fetchGmailConnection();
      setStatus(connection);
      if (mailbox === "campaign") {
        setThreads([]);
        const history = await fetchOutreachEmailHistory(campaignPage, 50);
        setCampaignSends(history.outreach || []);
        setCampaignPagination(history.pagination || { page: campaignPage, pages: 1, total: history.outreach?.length || 0 });
      } else {
        setThreads(connection.connected ? (await fetchGmailThreads(query)).threads || [] : []);
        setCampaignSends([]);
      }
      const searchedEmail = emailAddress(search);
      setOutreachHistory(searchedEmail ? (await fetchContactEmailHistory(searchedEmail)).outreach || [] : []);
      setError("");
      setSelectedThreadIds([]);
    } catch (err) {
      const message = err.response?.data?.error || "Unable to load Gmail.";
      setError(message.toLowerCase().includes("insufficient authentication scopes") ? "" : message);
    }
    finally { setLoading(false); }
  };
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    const refreshMailbox = window.setTimeout(() => loadRef.current?.(), 0);
    return () => window.clearTimeout(refreshMailbox);
  }, [mailbox, campaignPage]);

  const openThread = async (thread) => {
    try {
      setLoading(true);
      const detail = await fetchGmailThread(thread.id);
      setSelectedThread(detail);
      setReply(detail.workspace?.draft?.body || "");
      setDraftState(detail.workspace?.draft?.body ? "Saved workspace draft" : "");
      if (thread.labels?.includes("UNREAD")) await updateGmailThread(thread.id, "read");
    } catch (err) { setError(err.response?.data?.error || "Unable to open this conversation."); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const canonicalThreadId = selectedThread?.canonicalThreadId;
    if (!canonicalThreadId) return undefined;
    const timer = window.setTimeout(async () => {
      try {
        setDraftState("Saving draft…");
        await saveConversationDraft(canonicalThreadId, { subject: selectedThread.messages?.[0]?.subject || "", body: reply, attachments: [] });
        setDraftState("Draft saved");
      } catch { setDraftState("Draft could not be saved"); }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [reply, selectedThread?.canonicalThreadId, selectedThread?.messages]);

  const syncMailbox = async () => {
    try {
      setSyncing(true);
      const result = await syncGmailConversations(query, 20);
      setNotice(`${result.synced || 0} Gmail conversation${result.synced === 1 ? "" : "s"} synchronized with the CRM.${result.failed ? ` ${result.failed} will retry on the next sync.` : ""}`);
      await load();
    } catch (err) { setError(err.response?.data?.error || "Unable to synchronize Gmail conversations."); }
    finally { setSyncing(false); }
  };

  const actOnThread = async (action) => {
    if (!selectedThread) return;
    await updateGmailThread(selectedThread.id, action);
    setSelectedThread(null);
    await load();
  };

  const emptyTrash = async () => {
    try {
      setEmptyingTrash(true);
      const result = await emptyGmailTrash();
      setThreads([]);
      setError("");
      setNotice(`${result.deleted || 0} trash thread${result.deleted === 1 ? "" : "s"} permanently deleted.`);
      setTrashConfirmOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || "Unable to empty Gmail Trash.");
    } finally {
      setEmptyingTrash(false);
    }
  };

  const toggleThread = (threadId) => setSelectedThreadIds((items) =>
    items.includes(threadId) ? items.filter((id) => id !== threadId) : [...items, threadId]
  );

  const runBulkAction = async (action) => {
    if (!selectedThreadIds.length) return;
    try {
      setBulkActionRunning(true);
      if (action === "delete") {
        if (!window.confirm(`Permanently delete ${selectedThreadIds.length} selected conversation${selectedThreadIds.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
        await deleteSelectedGmailTrash(selectedThreadIds);
      } else {
        await Promise.all(selectedThreadIds.map((threadId) => updateGmailThread(threadId, action)));
      }
      setNotice(`${selectedThreadIds.length} conversation${selectedThreadIds.length === 1 ? "" : "s"} updated.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || "Unable to update the selected conversations.");
    } finally {
      setBulkActionRunning(false);
    }
  };

  const sendReply = async () => {
    const messages = selectedThread?.messages || [];
    const latest = messages[messages.length - 1];
    const recipient = emailAddress(latest?.from);
    try {
      setSending(true);
      const result = await sendGmailMessage({
        to: recipient,
        subject: /^re:/i.test(latest?.subject || "") ? latest.subject : `Re: ${latest?.subject || ""}`,
        body: reply,
        threadId: selectedThread.id,
        inReplyTo: latest?.messageId || "",
      });
      if (result.syncWarning) setNotice(result.syncWarning);
      setReply("");
      setSelectedThread(await fetchGmailThread(selectedThread.id));
    } catch (err) { setError(err.response?.data?.error || "Unable to send this reply."); }
    finally { setSending(false); }
  };

  const sendFollowUp = async () => {
    const recipient = emailAddress(search) || selectedOutreach?.contactEmail;
    try {
      setSending(true);
      const result = await sendGmailMessage({
        to: recipient,
        subject: /^re:/i.test(selectedOutreach?.subject || "") ? selectedOutreach.subject : `Re: ${selectedOutreach?.subject || "Following up"}`,
        body: followUp,
      });
      if (result.syncWarning) setNotice(result.syncWarning);
      setFollowUp("");
      setSelectedOutreach(null);
      await load();
    } catch (err) { setError(err.response?.data?.error || "Unable to send this follow-up."); }
    finally { setSending(false); }
  };

  if (!status?.connected && !loading) return <div className="page-dashboard inbox-page">
    <div className="page-header"><div><p className="page-eyebrow">Client communication</p><h1 className="page-title">Conversations</h1><p className="page-subtitle">Connect Gmail once, then manage campaign replies and personal follow-up here.</p></div></div>
    <section className="gmail-status-card"><div><h2>Connect a Google account</h2><p>The client signs into Google and grants access themselves. Passwords are never shared with Lead Porch.</p></div><Button disabled={!status?.configured} onClick={async () => window.location.assign((await beginGmailConnection()).authorizationUrl)}>Connect Gmail</Button></section>
  </div>;

  return <div className="page-dashboard inbox-page inbox-page--compact">
    <div className="page-header">
      <div><p className="page-eyebrow">Correspondence desk</p><h1 className="page-title">Conversations</h1><p className="page-subtitle">One place to see what was sent, what came back, and what needs your response.</p></div>
      <div className="crm-header-actions"><Button variant="outline" loading={syncing} onClick={syncMailbox}><FiRefreshCw /> Sync to CRM</Button><Button variant="outline" onClick={() => navigate("/integrations")}>Connection settings</Button></div>
    </div>
    {error ? <p className="form-error">{error}</p> : null}
    {notice ? <p className="inbox-success-notice">{notice}</p> : null}
    <section className="conversation-signal-rail">
      <div><span className="conversation-signal-dot" /><p><small>Mailbox ready</small><strong>{status?.email || "Google account connected"}</strong></p></div>
      <div><small>Campaign messages</small><strong>Delivered by Resend</strong><span>Delivery history appears under Campaign history.</span></div>
      <div><small>Replies and direct email</small><strong>Handled through Gmail</strong><span>Inbox, replies, sent mail, and Trash stay synchronized.</span></div>
    </section>
    {needsModifyPermission ? <section className="inbox-permission-notice"><div><strong>Approve conversation management</strong><p>Reconnect once to let Lead Porch archive, mark, and move Gmail conversations to Trash. Google will show the updated permission request.</p></div><Button onClick={reconnect}>Approve Gmail access</Button></section> : null}
    <section className="inbox-shell">
      <aside className="inbox-folders">
        <p className="inbox-folders__label">Mailboxes</p>
        <button className={mailbox === "inbox" ? "is-active" : ""} onClick={() => { setMailbox("inbox"); setSearch(""); setSelectedThread(null); }}><FiMail /><span><strong>Inbox</strong><small>All incoming mail</small></span></button>
        <button className={mailbox === "unread" ? "is-active" : ""} onClick={() => { setMailbox("unread"); setSearch(""); setSelectedThread(null); }}><FiEyeOff /><span><strong>Needs attention</strong><small>Unread messages</small></span></button>
        <button className={mailbox === "sent" ? "is-active" : ""} onClick={() => { setMailbox("sent"); setSearch(""); setSelectedThread(null); }}><FiSend /><span><strong>Sent by you</strong><small>Direct Gmail mail</small></span></button>
        <button className={mailbox === "campaign" ? "is-active" : ""} onClick={() => { setMailbox("campaign"); setSearch(""); setSelectedThread(null); }}><FiArchive /><span><strong>Campaign history</strong><small>Messages via Resend</small></span></button>
        <button className={mailbox === "trash" ? "is-active" : ""} onClick={() => { setMailbox("trash"); setSearch(""); setSelectedThread(null); }}><FiTrash2 /><span><strong>Trash</strong><small>Deleted Gmail mail</small></span></button>
        <hr />
        <button onClick={async () => { await disconnectGmail(); setStatus({ configured: true, connected: false }); }}>Disconnect Gmail</button>
      </aside>
      <div className="inbox-main">
        <form className="inbox-search" onSubmit={(event) => { event.preventDefault(); load(); }}><FiSearch /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a person, company, subject, or message" /><Button size="sm" type="submit">Search mail</Button></form>
        {selectedOutreach ? <div className="correspondence-detail">
          <header><Button variant="ghost" size="sm" onClick={() => setSelectedOutreach(null)}><FiArrowLeft /> Back to correspondence</Button><span className={`outreach-status outreach-status--${selectedOutreach.status}`}>{selectedOutreach.status}</span></header>
          <p className="correspondence-detail__eyebrow">{selectedOutreach.campaignName}</p>
          <h2>{selectedOutreach.subject}</h2>
          <dl><div><dt>Recipient</dt><dd>{emailAddress(search) || selectedOutreach.contactEmail}</dd></div><div><dt>Delivery</dt><dd>{selectedOutreach.deliveryStatus || "accepted"}{selectedOutreach.deliveredAt ? ` · ${new Date(selectedOutreach.deliveredAt).toLocaleString()}` : ""}</dd></div><div><dt>Reply intent</dt><dd>{selectedOutreach.replyCategory ? selectedOutreach.replyCategory.replaceAll("_", " ") : "Awaiting reply"}</dd></div>{selectedOutreach.aiReplySentAt ? <div><dt>Auto-reply</dt><dd>Sent automatically {new Date(selectedOutreach.aiReplySentAt).toLocaleString()}</dd></div> : null}</dl>
          <article className="correspondence-letter"><div className="correspondence-letter__mark">G</div><pre>{selectedOutreach.body || "The original message body is unavailable."}</pre></article>
          {selectedOutreach.replyText ? <section className="correspondence-received"><p>Latest response · {selectedOutreach.replyUrgency || "review"} priority</p><blockquote>{selectedOutreach.replyText}</blockquote></section> : <section className="awaiting-reply"><strong>Awaiting a response</strong><p>No Gmail reply has been received from this contact yet. The original campaign message remains part of this correspondence record.</p></section>}
          {selectedOutreach.aiReplySentAt ? <section className="correspondence-received"><p>Auto-reply sent · no action needed</p><blockquote>{selectedOutreach.aiReplyDraft}</blockquote></section> : <section className="conversation-reply"><p className="correspondence-detail__eyebrow">{selectedOutreach.aiReplyDraft ? "Jarvis reply draft — held for your review" : "Personal follow-up"}</p><textarea rows="7" value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="Write a thoughtful follow-up from the connected Gmail account…" /><small>{selectedOutreach.aiReplyDraft ? "Jarvis flagged this one for a human before sending." : "Nothing is sent until you approve this draft."}</small><Button loading={sending} disabled={!followUp.trim()} onClick={sendFollowUp}><FiSend /> Approve and send follow-up</Button></section>}
        </div> : selectedThread ? <div className="conversation-view">
          <header><Button variant="ghost" size="sm" onClick={() => setSelectedThread(null)}><FiArrowLeft /> Back</Button><div><Button variant="outline" size="sm" onClick={() => actOnThread("archive")}><FiArchive /> Archive</Button><Button variant="outline" size="sm" onClick={() => actOnThread("trash")}><FiTrash2 /> Move to trash</Button></div></header>
          <h2>{selectedThread.messages?.[0]?.subject || "Conversation"}</h2>
          <div className="conversation-messages">{selectedThread.messages?.map((message) => <article key={message.id} className={message.labels?.includes("SENT") ? "is-sent" : ""}><div><strong>{message.labels?.includes("SENT") ? "You" : message.from}</strong><time>{message.date ? new Date(message.date).toLocaleString() : ""}</time></div><small>To: {message.to}</small><pre>{message.body || message.snippet}</pre></article>)}</div>
          <section className="conversation-reply"><h3>Reply</h3><textarea rows="7" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Write a reply…" /><small>{selectedThread.canonicalThreadId ? draftState || "Drafts save to the shared CRM workspace." : "Sync this mailbox to enable shared drafts."} Nothing is sent until you approve.</small><Button loading={sending} disabled={!reply.trim()} onClick={sendReply}><FiSend /> Approve and send reply</Button></section>
        </div> : <>
          <div className="inbox-list-heading"><div><h2>{search ? `Correspondence with ${search}` : mailbox === "campaign" ? "Campaign sends" : mailbox[0].toUpperCase() + mailbox.slice(1)}</h2><p>{mailbox === "campaign" ? `${campaignPagination.total} campaign message${campaignPagination.total === 1 ? "" : "s"} · page ${campaignPagination.page} of ${campaignPagination.pages}` : search ? `${outreachHistory.length} campaign message${outreachHistory.length === 1 ? "" : "s"} · ${threads.length} Gmail repl${threads.length === 1 ? "y" : "ies"}` : `${threads.length} email thread${threads.length === 1 ? "" : "s"}`}</p></div>{mailbox === "trash" && !search && threads.length ? <Button className="empty-trash-button" variant="outline" size="sm" onClick={needsDeletePermission ? reconnect : () => setTrashConfirmOpen(true)}><FiTrash2 /> {needsDeletePermission ? "Approve empty trash" : "Empty trash"}</Button> : null}</div>
          {mailbox !== "campaign" && threads.length ? <div className="mailbox-toolbar">
            <label><input type="checkbox" checked={selectedThreadIds.length === threads.length} onChange={() => setSelectedThreadIds(selectedThreadIds.length === threads.length ? [] : threads.map((thread) => thread.id))} /><span>{selectedThreadIds.length ? `${selectedThreadIds.length} selected` : "Select all"}</span></label>
            <div>
              {mailbox === "trash" ? <><Button variant="ghost" size="sm" disabled={!selectedThreadIds.length || bulkActionRunning} onClick={() => runBulkAction("untrash")}><FiInbox /> Move to inbox</Button><Button variant="ghost" size="sm" disabled={!selectedThreadIds.length || bulkActionRunning || needsDeletePermission} onClick={() => runBulkAction("delete")}><FiTrash2 /> Delete permanently</Button></> : <><Button variant="ghost" size="sm" disabled={!selectedThreadIds.length || bulkActionRunning} onClick={() => runBulkAction("archive")}><FiArchive /> Archive</Button><Button variant="ghost" size="sm" disabled={!selectedThreadIds.length || bulkActionRunning} onClick={() => runBulkAction("read")}><FiEye /> Mark read</Button><Button variant="ghost" size="sm" disabled={!selectedThreadIds.length || bulkActionRunning} onClick={() => runBulkAction("unread")}><FiEyeOff /> Mark unread</Button><Button variant="ghost" size="sm" disabled={!selectedThreadIds.length || bulkActionRunning} onClick={() => runBulkAction("trash")}><FiTrash2 /> Trash</Button></>}
            </div>
          </div> : null}
          {mailbox === "campaign" ? <><div className="campaign-send-list">{campaignSends.map((item) => <button key={item.id} onClick={() => { setSelectedOutreach(item); setFollowUp(item.aiReplyDraft || ""); }}><div><strong>{item.contactName || item.contactEmail}</strong><span className={`outreach-status outreach-status--${item.status}`}>{item.aiReplySentAt ? "auto-replied" : item.replyCategory ? item.replyCategory.replaceAll("_", " ") : item.deliveryStatus || item.status}</span></div><h3>{item.subject}</h3><p>{item.campaignName}</p><small>{item.sentAt ? new Date(item.sentAt).toLocaleString() : ""}</small></button>)}</div><nav className="campaign-history-pagination"><Button variant="outline" size="sm" disabled={campaignPage <= 1} onClick={() => setCampaignPage((page) => page - 1)}>Previous</Button><span>Page {campaignPagination.page} of {campaignPagination.pages}</span><Button variant="outline" size="sm" disabled={campaignPage >= campaignPagination.pages} onClick={() => setCampaignPage((page) => page + 1)}>Next</Button></nav></> : null}
          {outreachHistory.length ? <section className="outreach-conversation-history"><header><h3>Campaign correspondence</h3><span>Sent through Resend</span></header>{outreachHistory.map((item) => <button type="button" key={item.id} onClick={() => { setSelectedOutreach({ ...item, contactEmail: emailAddress(search) }); setFollowUp(item.aiReplyDraft || ""); }}><div><strong>{item.campaignName}</strong><span className={`outreach-status outreach-status--${item.status}`}>{item.replyCategory ? item.replyCategory.replaceAll("_", " ") : item.deliveryStatus || item.status}</span></div><h4>{item.subject}</h4><p>{item.body}</p><footer><small>{item.sentAt ? new Date(item.sentAt).toLocaleString() : "Not sent yet"}</small><span>Read full message →</span></footer>{item.replyText ? <blockquote><strong>Latest response</strong>{item.replyText}</blockquote> : null}</button>)}</section> : null}
          {mailbox !== "campaign" ? loading ? <p className="table-state">Loading correspondence…</p> : threads.length ? <div className="gmail-thread-list">{threads.map((thread) => <div key={thread.id} className={`${thread.labels?.includes("UNREAD") ? "gmail-thread is-unread" : "gmail-thread"} ${selectedThreadIds.includes(thread.id) ? "is-selected" : ""}`}><label className="gmail-thread__select"><input type="checkbox" checked={selectedThreadIds.includes(thread.id)} onChange={() => toggleThread(thread.id)} aria-label={`Select ${thread.subject}`} /></label><button type="button" onClick={() => openThread(thread)}><strong>{mailbox === "sent" ? thread.to : thread.from || "Unknown sender"}</strong><span><b>{thread.subject}</b><small>{thread.snippet}</small></span><em>{thread.messageCount}</em><time>{thread.date ? new Date(thread.date).toLocaleDateString() : ""}</time></button></div>)}</div> : search && outreachHistory.length ? <section className="correspondence-empty"><span>Awaiting reply</span><h3>No Gmail response yet</h3><p>The campaign message above was delivered successfully. When this contact replies, their response will appear here and Outreach will change to Replied.</p></section> : <section className="correspondence-empty"><span>{mailbox === "sent" ? "No personal follow-up" : "Inbox clear"}</span><h3>{mailbox === "sent" ? "No Gmail messages have been sent from this view" : "There is nothing requiring attention here"}</h3><p>{mailbox === "sent" ? "Campaign delivery lives under Campaign sends. Personal replies sent from Lead Porch appear here." : "New client replies will appear here automatically when you refresh Conversations."}</p></section> : null}
        </>}
      </div>
    </section>
    <Modal
      isOpen={trashConfirmOpen}
      onClose={() => !emptyingTrash && setTrashConfirmOpen(false)}
      title="Permanently empty trash?"
      footer={<><Button variant="outline" disabled={emptyingTrash} onClick={() => setTrashConfirmOpen(false)}>Cancel</Button><Button className="empty-trash-confirm" loading={emptyingTrash} onClick={emptyTrash}><FiTrash2 /> Delete everything</Button></>}
    >
      <div className="empty-trash-confirmation"><span><FiTrash2 /></span><div><strong>This cannot be undone</strong><p>Every conversation currently in the connected Gmail account’s Trash will be permanently deleted, including items beyond the {threads.length} shown here.</p></div></div>
    </Modal>
  </div>;
}
