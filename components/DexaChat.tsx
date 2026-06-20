"use client";

import { useRef, useState } from "react";
import { Plus, ArrowUp, Loader2 } from "lucide-react";

type Msg = { role: "user" | "assistant"; content: string };

export function DexaChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next: Msg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setInput("");
    setLoading(true);
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const j = await r.json();
      setMsgs((m) => [...m, { role: "assistant", content: j.reply ?? "(no response)" }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "Something went wrong." }]);
    } finally {
      setLoading(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  return (
    <div>
      {msgs.length > 0 && (
        <div className="mb-3 max-h-[42vh] space-y-3 overflow-y-auto rounded-2xl border border-hairline bg-white p-4">
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[80%] rounded-2xl bg-black px-3.5 py-2 text-sm text-white"
                    : "max-w-[85%] whitespace-pre-wrap rounded-2xl bg-black/[0.04] px-3.5 py-2 text-sm text-ink"
                }
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Dexa is thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="flex min-h-[150px] flex-col rounded-[24px] border border-white/70 bg-[#e9eef0]/55 p-5 shadow-sm">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          className="w-full flex-1 resize-none bg-transparent text-[15px] outline-none placeholder:text-muted"
          placeholder="Assign a task or ask anything — e.g. who should I reach out to this week?"
        />
        <div className="mt-auto flex items-center justify-between">
          <button className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-black/[0.04]">
            <Plus className="h-5 w-5" strokeWidth={1.75} />
          </button>
          <button
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#cfe0fb] text-[#2d6cf6] transition-colors hover:bg-[#bcd4fa] disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" />
            ) : (
              <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
