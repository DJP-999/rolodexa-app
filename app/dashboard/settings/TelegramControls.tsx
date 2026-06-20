"use client";

import { useState, useTransition } from "react";
import { Loader2, Check } from "lucide-react";
import { telegramTestAction, telegramDisconnectAction } from "./actions";

export function TelegramControls({ connected }: { connected: boolean }) {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);

  if (!connected) {
    return (
      <p className="text-sm text-muted">
        Not linked yet. Message your bot once and it will connect this chat automatically.
      </p>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {sent && !pending && (
        <span className="flex items-center gap-1 text-xs font-medium text-good">
          <Check className="h-3.5 w-3.5" /> Sent
        </span>
      )}
      <button
        onClick={() =>
          start(async () => {
            setSent(false);
            await telegramTestAction();
            setSent(true);
            setTimeout(() => setSent(false), 6000);
          })
        }
        disabled={pending}
        className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-sm hover:bg-black/[0.03] disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Send Test Message
      </button>
      <form action={telegramDisconnectAction}>
        <button className="rounded-lg border border-hairline px-3 py-1.5 text-sm text-rose-500 hover:bg-rose-50">
          Disconnect
        </button>
      </form>
    </div>
  );
}
