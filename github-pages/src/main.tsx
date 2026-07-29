import { FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import Home from "../../app/page";
import "../../app/globals.css";
import "./pages.css";

type StoredArchive = {
  id: string;
  kind: "auto" | "manual";
  name: string;
  payload: string;
  createdAt: number;
  updatedAt: number;
};

const ARCHIVE_STORAGE_KEY = "route-atlas-public-archives-v1";
const AMAP_KEY_STORAGE_KEY = "route-atlas-amap-key";
const AMAP_SECURITY_STORAGE_KEY = "route-atlas-amap-security-code";

function readStoredArchives(): StoredArchive[] {
  try {
    const value = JSON.parse(localStorage.getItem(ARCHIVE_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeStoredArchives(archives: StoredArchive[]) {
  localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(archives));
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function installLocalArchiveApi() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), window.location.href);
    if (!url.pathname.endsWith("/api/archives")) return nativeFetch(input, init);

    try {
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const archives = readStoredArchives();
      if (method === "GET") {
        const id = url.searchParams.get("id");
        if (id) {
          const archive = archives.find((item) => item.id === id);
          return archive ? jsonResponse({ archive }) : jsonResponse({ error: "未找到该存档" }, 404);
        }
        const summaries = archives
          .map(({ id: archiveId, kind, name, createdAt, updatedAt }) => ({ id: archiveId, kind, name, createdAt, updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return jsonResponse({ archives: summaries });
      }

      if (method === "POST") {
        const bodyText = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "{}";
        const body = JSON.parse(bodyText) as { kind?: "auto" | "manual"; name?: string; payload?: unknown };
        if ((body.kind !== "auto" && body.kind !== "manual") || !body.payload) return jsonResponse({ error: "存档内容无效" }, 400);
        const now = Date.now();
        const id = body.kind === "auto" ? "public-browser:auto" : crypto.randomUUID();
        const name = body.kind === "auto" ? "自动存档" : body.name?.trim() || "未命名存档";
        const next: StoredArchive = { id, kind: body.kind, name, payload: JSON.stringify(body.payload), createdAt: now, updatedAt: now };
        const existing = archives.find((item) => item.id === id);
        if (existing) next.createdAt = existing.createdAt;
        writeStoredArchives([next, ...archives.filter((item) => item.id !== id)]);
        return jsonResponse({ archive: { id, kind: body.kind, name, updatedAt: now } }, 201);
      }

      if (method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return jsonResponse({ error: "缺少存档编号" }, 400);
        writeStoredArchives(archives.filter((item) => item.id !== id || item.kind === "auto"));
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "不支持的请求" }, 405);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "浏览器存档不可用" }, 500);
    }
  };
}

function applyStoredAmapConfig() {
  document.body.dataset.amapKey = localStorage.getItem(AMAP_KEY_STORAGE_KEY) ?? "";
  document.body.dataset.amapSecurityCode = localStorage.getItem(AMAP_SECURITY_STORAGE_KEY) ?? "";
}

function PublicApiSettings() {
  const storedKey = localStorage.getItem(AMAP_KEY_STORAGE_KEY) ?? "";
  const storedSecurity = localStorage.getItem(AMAP_SECURITY_STORAGE_KEY) ?? "";
  const [open, setOpen] = useState(!storedKey || !storedSecurity);
  const [key, setKey] = useState(storedKey);
  const [securityCode, setSecurityCode] = useState(storedSecurity);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!key.trim() || !securityCode.trim()) return;
    localStorage.setItem(AMAP_KEY_STORAGE_KEY, key.trim());
    localStorage.setItem(AMAP_SECURITY_STORAGE_KEY, securityCode.trim());
    window.location.reload();
  }

  function clear() {
    localStorage.removeItem(AMAP_KEY_STORAGE_KEY);
    localStorage.removeItem(AMAP_SECURITY_STORAGE_KEY);
    window.location.reload();
  }

  return <>
    <button className={`public-api-trigger ${storedKey && storedSecurity ? "configured" : ""}`} type="button" onClick={() => setOpen(true)}>
      <i />{storedKey && storedSecurity ? "高德 API 已配置" : "配置高德 API"}
    </button>
    {open && <div className="public-api-backdrop" role="presentation">
      <form className="public-api-dialog" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="public-api-title">
        <div className="public-api-heading"><span>PUBLIC EDITION</span><button type="button" onClick={() => setOpen(false)} aria-label="关闭">×</button></div>
        <h2 id="public-api-title">配置高德 Web API</h2>
        <p>公开版不会携带项目密钥。请填写你自己的 Web 端 Key 与安全密钥，它们只保存在当前浏览器，不会上传到 GitHub 或服务器。</p>
        <label>Web 端 Key<input value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写高德 Web 端 Key" /></label>
        <label>安全密钥<input type="password" value={securityCode} onChange={(event) => setSecurityCode(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写 securityJsCode" /></label>
        <small>画布自动存档和手动存档同样保存在此浏览器中。清理浏览器数据会删除这些内容。</small>
        <div className="public-api-actions">
          {storedKey && storedSecurity && <button className="clear" type="button" onClick={clear}>清除配置</button>}
          <button type="button" onClick={() => setOpen(false)}>稍后设置</button>
          <button className="save" type="submit" disabled={!key.trim() || !securityCode.trim()}>保存并重新载入</button>
        </div>
      </form>
    </div>}
  </>;
}

installLocalArchiveApi();
applyStoredAmapConfig();

createRoot(document.getElementById("root")!).render(<><Home /><PublicApiSettings /></>);