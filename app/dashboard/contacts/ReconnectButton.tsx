"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2, Send, Pencil, X, Check, AlertTriangle } from "lucide-react";
import { reconnectDraftAction, reconnectSendAction } from "./reconnect";

type Phase = "idle" | "loading" | "review" | "sending" | "sent" | "error";
type Channel = "linkedin" | "email";
type DraftMeta = { why: string; channel: Channel | null; channelLabel: string; availableChannels: Channel[] };

/**
 * One-tap reconnection. Pulls the contact's full history (notes, meeting notes, past
 * interactions, news) into a voiced outreach draft + the channel it would send on, then
 * an Approve / Edit / Dismiss workflow. Works on any contact — including imported ones
 * the automated proactive engine skips.
 */
export default function ReconnectButton({ id, name }: { id: string; name: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [draft, setDraft] = useState("");
  const [meta, setMeta] = useState<DraftMeta>({
    why: "",
    channel: null,
    channelLabel: "",
    availableChannels: [],
  });
  const [chosen, setChosen] = useState<Channel | null>(null);
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string; channel: string | null } | null>(null);
  const [pending, start] = useTransition();

  const first = name.split(/\s+/)[0] || "them";

  function generate() {
    setPhase("loading");
    setResult(null);
    setEditing(false);
    start(async () => {
      const r = await reconnectDraftAction(id);
      if (!r.ok) {
        setPhase("error");
        setResult({ ok: false, detail: "Couldn't draft a message. Try again.", channel: null });
        return;
      }
      setDraft(r.draft);
      setMeta({ why: r.why, channel: r.channel, channelLabel: r.channelLabel, availableChannels: r.availableChannels });
      // Default to the auto-resolved channel, else the first available one.
      setChosen(r.channel ?? r.availableChannels[0] ?? null);
      setPhase("review");
    });
  }

  function send() {
    setPhase("sending");
    start(async () => {
      const r = await reconnectSendAction(id, draft, chosen ?? undefined);
      setResult({ ok: r.ok, detail: r.detail, channel: r.channel });
      setPhase(r.ok ? "sent" : "error");
    });
  }

  function dismiss() {
    setPhase("idle");
    setEditing(false);
    setResult(null);
  }

  if (phase === "idle") {
    return (
      <button
        type="button"
        onClick={generate}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[#2d6cf6]/30 bg-[#2d6cf6]/[0.06] px-3 py-1.5 text-xs font-medium text-[#2d6cf6] hover:bg-[#2d6cf6]/[0.12]"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Reconnect
      </button>
    );
  }

  if (phase === "loading") {
    return (
      <div className="inline-flex items-center gap-2 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading your history with {first}…
      </div>
    );
  }

  if (phase === "sent") {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        <div className="flex items-center gap-1.5 font-medium">
          <Check className="h-4 w-4" />
          Sent to {first}
          {result?.channel ? ` via ${result.channel}` : ""}.
        </div>
      </div>
    );
  }

  // review / sending / error all show the draft card
  return (
    <div className="w-full rounded-xl border border-[#2d6cf6]/25 bg-[#2d6cf6]/[0.03] p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[#2d6cf6]">
        <Sparkles className="h-3.5 w-3.5" />
        Reconnect with {first}
      </div>
      {meta.why && <p className="mt-1.5 text-xs text-muted">{meta.why}</p>}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={!editing}
        rows={Math.min(8, Math.max(3, Math.ceil(draft.length / 60)))}
        className={`mt-2 w-full resize-y rounded-lg border p-2.5 text-sm text-ink ${
          editing ? "border-[#2d6cf6]/40 bg-white" : "border-hairline bg-white/60"
        }`}
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted">Send via</span>
        {meta.availableChannels.length === 0 ? (
          <span className="text-[11px] text-muted">no channel on file — copy &amp; send manually</span>
        ) : (
          meta.availableChannels.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setChosen(ch)}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                chosen === ch
                  ? "bg-[#2d6cf6] text-white"
                  : "border border-hairline text-muted hover:bg-black/[0.03]"
              }`}
            >
              {ch === "linkedin" ? "LinkedIn DM" : "Email"}
            </button>
          ))
        )}
      </div>

      {phase === "error" && result && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{result.detail === "no channel available" ? "No send channel on file — copy the text and send it manually." : result.detail}</span>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={pending || phase === "sending" || !chosen}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#2d6cf6] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1f5ae0] disabled:opacity-50"
        >
          {phase === "sending" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {phase === "sending" ? "Sending…" : "Approve & send"}
        </button>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${
            editing
              ? "border-[#2d6cf6]/40 bg-[#2d6cf6]/[0.08] text-[#2d6cf6]"
              : "border-hairline text-muted hover:bg-black/[0.03]"
          }`}
        >
          <Pencil className="h-3.5 w-3.5" />
          {editing ? "Done editing" : "Edit"}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-black/[0.03]"
        >
          <X className="h-3.5 w-3.5" />
          Dismiss
        </button>
      </div>
    </div>
  );
}
