import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userContext } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { buildAgentContext } from "@/lib/agent/context";
import { complete, type ChatMessage } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Dexa chat — context-aware over the user's real network. Read/answer/draft (no side effects). */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) return NextResponse.json({ reply: "Ask me anything about your network." });

    const user = await getPrimaryUser();
    if (!user) return NextResponse.json({ reply: "No user found." });

    const ctx = (
      await db.select().from(userContext).where(eq(userContext.userId, user.id)).limit(1)
    )[0];
    const last = messages[messages.length - 1]?.content ?? "";
    const context = await buildAgentContext(user.id, last);

    const system =
      `You are Dexa, the relationship and deal-flow co-pilot for ${ctx?.role ?? "a dealmaker"}. ` +
      `You help them stay close to their network at scale: who to reach out to, why now, and what to say. ` +
      `Use ONLY the CONTEXT below for facts about specific people — if someone isn't in it, say you don't see them in the loaded set rather than inventing details. ` +
      `Be concise, specific, and direct. When asked to draft outreach, write it ready-to-send, warm, and reference something concrete about the recipient — never lead with an ask. ` +
      `Current focus: ${ctx?.currentFocus ?? "n/a"}.\n\n=== CONTEXT ===\n${context}`;

    const reply = await complete({
      tier: "strong",
      system,
      messages: messages.slice(-10),
      maxTokens: 900,
    });

    return NextResponse.json({ reply });
  } catch (e) {
    console.error("[chat]", e);
    return NextResponse.json({ reply: "Something went wrong handling that." }, { status: 200 });
  }
}
