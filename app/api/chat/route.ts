import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userContext } from "@/db/schema";
import { getPrimaryUser } from "@/lib/user";
import { buildAgentContext } from "@/lib/agent/context";
import { complete, type ChatMessage } from "@/lib/llm";
import { TONE_GUIDE, stripEmDashes } from "@/lib/agent/tone";

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
      `Use ONLY the CONTEXT below for facts about specific people. If someone is not in it, say you do not see them in the loaded set rather than inventing details. ` +
      `Be concise, specific, and direct. Never use em-dashes or en-dashes anywhere in your replies; use periods or commas. ` +
      `When you draft outreach, use this voice: ${TONE_GUIDE} ` +
      `Current focus: ${ctx?.currentFocus ?? "n/a"}.\n\n=== CONTEXT ===\n${context}`;

    const reply = await complete({
      tier: "strong",
      system,
      messages: messages.slice(-10),
      maxTokens: 900,
    });

    return NextResponse.json({ reply: stripEmDashes(reply) });
  } catch (e) {
    console.error("[chat]", e);
    return NextResponse.json({ reply: "Something went wrong handling that." }, { status: 200 });
  }
}
