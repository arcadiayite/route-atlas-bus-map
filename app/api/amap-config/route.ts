export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.NEXT_PUBLIC_AMAP_KEY;
  const securityJsCode = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;

  if (!key || !securityJsCode) {
    return Response.json({ error: "尚未配置高德 Web API" }, { status: 503 });
  }

  return Response.json(
    { key, securityJsCode },
    { headers: { "Cache-Control": "no-store, private" } },
  );
}