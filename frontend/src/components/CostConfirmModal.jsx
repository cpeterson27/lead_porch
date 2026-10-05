import { useEffect, useState } from "react";
import Modal from "./Modal.jsx";
import Button from "./Button.jsx";
import { fetchAiCostEstimate } from "../services/api.js";

function money(value) {
  if (value == null) return "—";
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * The owner's own explicit request: before any button that actually spends
 * real AI money runs, show what it's expected to cost and make her confirm.
 * There is no way to know a call's exact token cost before the provider
 * responds, so this is always an ESTIMATE from this workspace's own recent
 * real history for that exact action (see aiUsageService.estimateFeatureCost)
 * — never a guess and never presented as an exact price.
 */
export default function CostConfirmModal({ open, feature, calls = 1, title = "Confirm estimated cost", actionLabel = "Run it", itemNoun = "", note = "", onConfirm, onCancel, busy = false }) {
  // No separate loading flag: `estimate` starts (and is reset to) null on
  // every open/feature/calls change, and null-while-open IS the loading
  // state — one less piece of state that could ever disagree with itself.
  const [estimate, setEstimate] = useState(null);

  useEffect(() => {
    if (!open || !feature) return undefined;
    let cancelled = false;
    fetchAiCostEstimate(feature, calls)
      .then((res) => { if (!cancelled) setEstimate(res.data); })
      .catch(() => { if (!cancelled) setEstimate({ hasHistory: false }); });
    return () => { cancelled = true; setEstimate(null); };
  }, [open, feature, calls]);

  if (!open) return null;
  const loading = estimate === null;

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      title={title}
      footer={<>
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={onConfirm} loading={busy}>{actionLabel}</Button>
      </>}
    >
      {loading ? <p>Checking the estimated cost…</p> : estimate?.hasHistory ? (
        <p>
          Based on the last {estimate.basedOnCalls} time{estimate.basedOnCalls === 1 ? "" : "s"} this ran, this is estimated to cost about{" "}
          <strong>{money(estimate.estimatedCostUsd)}</strong>
          {calls > 1 ? ` (${calls} ${itemNoun || "request"}${calls === 1 ? "" : "s"} at roughly ${money(estimate.averageCostPerCallUsd)} each)` : ""}.
          This is an estimate from your own recent usage, not an exact price — the real cost depends on how much text is involved this time, and will show on the Usage &amp; Agents page afterward.
        </p>
      ) : (
        <p>No cost history yet for this specific action, so an estimate isn't available. This will be the first time it runs for this workspace — its real cost will appear on the Usage &amp; Agents page right after.</p>
      )}
      {note ? <p className="cost-confirm-modal__note">{note}</p> : null}
    </Modal>
  );
}
