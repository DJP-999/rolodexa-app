import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, interactions, claims, suggestions } from "@/db/schema";
import { complete } from "@/lib/llm";

type Contact = typeof contacts.$inferSelect;

export type ProfileStats = {
  total: number;
  emailIn: number;
  emailOut: number;
  msgIn: number;
  msgOut: number;
  meetings: number;
  lastInteraction: {
    when: string;
    channel: string;
    direction: string | null;
    about: string | null;
  } | null;
  lastMeeting: string | null;
};

function about(metadata: unknown): string | null {
  const m = metadata as { subject?: string; text?: string } | null;
  return m?.subject ?? m?.text ?? null;
}

async function generateBio(c: Contact, recentNews: string[]): Promise<string> {
  const facts = [
    c.role && c.company ? `${c.role} at ${c.company}` : c.company ? `works at ${c.company}` : "",
    c.industry ? `industry: ${c.industry}` : "",
    c.location ? `based in ${c.location}` : "",
    (c.otherSignals ?? []).length ? `LinkedIn headline: ${(c.otherSignals ?? []).join("; ")}` : "",
    recentNews.length ? `recent: ${recentNews.slice(0, 3).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  const bio = await complete({
    tier: "cheap",
    system:
      "Write a 2-3 sentence factual professional bio of a contact for a dealmaker's CRM. " +
      "Use ONLY the facts given; never invent details or use placeholders. Plain prose, no preamble.",
    messages: [
      { role: "user", content: `Contact: ${c.name}.\nFacts: ${facts || "limited information"}.\nWrite the bio.` },
    ],
    maxTokens: 200,
    temperature: 0.3,
  });
  return bio && !bio.startsWith("[llm-stub") ? bio : "";
}

/** Everything the contact profile + the list dropdown need. Generates the bio lazily and caches it. */
export async function getContactProfile(id: string) {
  const c = (await db.select().from(contacts).where(eq(contacts.id, id)).limit(1))[0];
  if (!c) return null;

  const ix = await db
    .select()
    .from(interactions)
    .where(eq(interactions.contactId, id))
    .orderBy(desc(interactions.occurredAt))
    .limit(60);
  const cls = await db
    .select()
    .from(claims)
    .where(eq(claims.contactId, id))
    .orderBy(desc(claims.observedAt))
    .limit(20);
  const sug = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.contactId, id), eq(suggestions.status, "pending")))
    .orderBy(desc(suggestions.score))
    .limit(5);

  const meeting = ix.find((i) => i.eventType === "meeting");
  const stats: ProfileStats = {
    total: ix.length,
    emailIn: ix.filter((i) => i.eventType === "email_in").length,
    emailOut: ix.filter((i) => i.eventType === "email_out").length,
    msgIn: ix.filter((i) => i.eventType === "message_in").length,
    msgOut: ix.filter((i) => i.eventType === "message_out").length,
    meetings: ix.filter((i) => i.eventType === "meeting").length,
    lastInteraction: ix[0]
      ? {
          when: new Date(ix[0].occurredAt).toISOString(),
          channel: ix[0].channel,
          direction: ix[0].direction,
          about: about(ix[0].metadata),
        }
      : null,
    lastMeeting: meeting ? new Date(meeting.occurredAt).toISOString() : null,
  };

  let bio = c.summary;
  if (!bio) {
    bio = await generateBio(
      c,
      cls.filter((x) => x.field === "news").map((x) => x.value),
    );
    if (bio) await db.update(contacts).set({ summary: bio }).where(eq(contacts.id, id));
  }

  let related: { id: string; name: string; role: string | null }[] = [];
  if (c.company) {
    const sameCo = await db
      .select({ id: contacts.id, name: contacts.name, role: contacts.role })
      .from(contacts)
      .where(and(eq(contacts.userId, c.userId), eq(contacts.company, c.company)))
      .limit(12);
    related = sameCo.filter((r) => r.id !== c.id).slice(0, 8);
  }

  return { contact: c, interactions: ix, claims: cls, suggestions: sug, stats, bio: bio || null, related };
}
