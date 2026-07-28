import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { routeArchives } from "../../../db/schema";

function ownerId(request: Request) {
  return request.headers.get("oai-authenticated-user-email") ?? "local-preview";
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "存档服务暂时不可用";
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const owner = ownerId(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      const [archive] = await db.select().from(routeArchives)
        .where(and(eq(routeArchives.id, id), eq(routeArchives.ownerId, owner))).limit(1);
      if (!archive) return Response.json({ error: "未找到该存档" }, { status: 404 });
      return Response.json({ archive });
    }

    const rows = await db.select({
      id: routeArchives.id,
      kind: routeArchives.kind,
      name: routeArchives.name,
      createdAt: routeArchives.createdAt,
      updatedAt: routeArchives.updatedAt,
    }).from(routeArchives)
      .where(eq(routeArchives.ownerId, owner))
      .orderBy(desc(routeArchives.updatedAt));
    return Response.json({ archives: rows });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { kind?: "auto" | "manual"; name?: string; payload?: unknown };
    if (body.kind !== "auto" && body.kind !== "manual") {
      return Response.json({ error: "存档类型无效" }, { status: 400 });
    }
    if (!body.payload) return Response.json({ error: "存档内容为空" }, { status: 400 });

    const owner = ownerId(request);
    const now = Date.now();
    const id = body.kind === "auto" ? `${owner}:auto` : crypto.randomUUID();
    const name = body.kind === "auto" ? "自动存档" : body.name?.trim() || "未命名存档";
    const payload = JSON.stringify(body.payload);
    const db = getDb();
    await db.insert(routeArchives).values({
      id, ownerId: owner, kind: body.kind, name, payload, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: routeArchives.id,
      set: { name, payload, updatedAt: now },
    });
    return Response.json({ archive: { id, kind: body.kind, name, updatedAt: now } }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const owner = ownerId(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "缺少存档编号" }, { status: 400 });
    const db = getDb();
    await db.delete(routeArchives).where(and(
      eq(routeArchives.id, id),
      eq(routeArchives.ownerId, owner),
      eq(routeArchives.kind, "manual"),
    ));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}