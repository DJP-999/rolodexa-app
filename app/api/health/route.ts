import { NextResponse } from "next/server";
import { env, isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "rolodexa-web",
    db: Boolean(env.DATABASE_URL),
    redis: Boolean(env.REDIS_URL),
    integrations: {
      nylas: isConfigured("nylas"),
      telegram: isConfigured("telegram"),
      exa: isConfigured("exa"),
      llm: isConfigured("llm"),
    },
  });
}
