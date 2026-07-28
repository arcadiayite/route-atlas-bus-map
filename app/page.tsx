"use client";

import { FormEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

type Coord = [number, number];
type BaseKey = "paper" | "atlas" | "dark" | "satellite";
type RouteStatus = "searching" | "ready" | "error";

type TransitRoute = {
  id: string;
  query: string;
  name: string;
  from: string;
  to: string;
  color: string;
  dash: boolean;
  visible: boolean;
  path: Coord[];
  stops: { name: string; coord: Coord }[];
  status: RouteStatus;
  error?: string;
};

type CropRect = { x: number; y: number; width: number; height: number };

declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

const PALETTE = ["#f25f4b", "#008e88", "#efb72f", "#3867d6", "#9c5de8", "#d94786", "#4f772d"];

const BASES: Record<BaseKey, { name: string; hint: string; dark: boolean; tiles: string[]; labels: string[]; attribution: string }> = {
  paper: {
    name: "纸感浅色",
    hint: "印刷与汇报",
    dark: false,
    tiles: ["https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png"],
    labels: ["https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors © CARTO",
  },
  atlas: {
    name: "城市街图",
    hint: "清晰路网",
    dark: false,
    tiles: ["https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png"],
    labels: ["https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors © CARTO",
  },
  dark: {
    name: "夜间深色",
    hint: "高对比展示",
    dark: true,
    tiles: ["https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png"],
    labels: ["https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap contributors © CARTO",
  },
  satellite: {
    name: "卫星影像",
    hint: "真实地表",
    dark: true,
    tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    labels: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Tiles © Esri",
  },
};

function mapStyle(base: BaseKey, labels: boolean): StyleSpecification {
  const item = BASES[base];
  const sources: StyleSpecification["sources"] = {
    basemap: { type: "raster", tiles: item.tiles, tileSize: 256, attribution: item.attribution },
  };
  const layers: any[] = [{ id: "basemap", type: "raster", source: "basemap", minzoom: 0, maxzoom: 22 }];
  if (labels) {
    sources.labels = { type: "raster", tiles: item.labels, tileSize: 256 };
    layers.push({ id: "place-labels", type: "raster", source: "labels", minzoom: 0, maxzoom: 22 });
  }
  return { version: 8, sources, layers };
}

function outOfChina(lng: number, lat: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function transformLat(x: number, y: number) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}
function transformLng(x: number, y: number) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}
function gcjToWgs([lng, lat]: Coord): Coord {
  if (outOfChina(lng, lat)) return [lng, lat];
  const a = 6378245;
  const ee = 0.006693421622965943;
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng * 2 - (lng + dLng), lat * 2 - (lat + dLat)];
}

function readLngLat(value: any): Coord | null {
  if (!value) return null;
  const lng = typeof value.getLng === "function" ? value.getLng() : value.lng ?? value[0];
  const lat = typeof value.getLat === "function" ? value.getLat() : value.lat ?? value[1];
  return Number.isFinite(Number(lng)) && Number.isFinite(Number(lat)) ? gcjToWgs([Number(lng), Number(lat)]) : null;
}

let amapPromise: Promise<any> | null = null;
function loadAmap() {
  if (typeof window === "undefined") return Promise.reject(new Error("仅支持浏览器调用"));
  if (window.AMap?.LineSearch) return Promise.resolve(window.AMap);
  if (amapPromise) return amapPromise;
  const key = document.body.dataset.amapKey;
  const securityJsCode = document.body.dataset.amapSecurityCode;
  if (!key || !securityJsCode) return Promise.reject(new Error("尚未配置高德 Web API"));
  window._AMapSecurityConfig = { securityJsCode };
  amapPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.LineSearch`;
    script.async = true;
    script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error("高德服务未能加载"));
    script.onerror = () => reject(new Error("无法连接高德服务"));
    document.head.appendChild(script);
  }).catch((error) => {
    amapPromise = null;
    throw error;
  });
  return amapPromise;
}

function segmentCollections(routes: TransitRoute[], width: number) {
  const active = routes.filter((route) => route.visible && route.status === "ready");
  const center = (active.length - 1) / 2;
  return new Map(active.map((route, index) => {
    const start = route.path[0];
    const end = route.path[route.path.length - 1];
    const deltaLng = end[0] - start[0];
    const deltaLat = end[1] - start[1];
    const reverse = Math.abs(deltaLng) >= Math.abs(deltaLat) ? deltaLng < 0 : deltaLat < 0;
    const coordinates = reverse ? [...route.path].reverse() : route.path;
    return [route.id, [{
      type: "Feature",
      properties: { offset: (index - center) * (width + 4) },
      geometry: { type: "LineString", coordinates },
    }]];
  }));
}

function clearRouteLayers(map: MapLibreMap) {
  const style = map.getStyle();
  [...(style.layers ?? [])].reverse().forEach((layer) => {
    if (layer.id.startsWith("route-") || layer.id.startsWith("stops-")) map.removeLayer(layer.id);
  });
  Object.keys(style.sources ?? {}).forEach((id) => {
    if ((id.startsWith("route-") || id.startsWith("stops-")) && map.getSource(id)) map.removeSource(id);
  });
}

function addRouteLayers(map: MapLibreMap, routes: TransitRoute[], width: number, showStops: boolean, scale = 1) {
  const collections = segmentCollections(routes, width * scale);
  routes.filter((route) => route.visible && route.status === "ready").forEach((route) => {
    const features = collections.get(route.id) ?? [];
    const offsetGroups = new Map<number, any[]>();
    features.forEach((feature) => {
      const offset = Number(feature.properties.offset) || 0;
      offsetGroups.set(offset, [...(offsetGroups.get(offset) ?? []), feature]);
    });
    [...offsetGroups.entries()].forEach(([offset, groupFeatures], groupIndex) => {
      const sourceId = `route-${route.id}-${groupIndex}`;
      map.addSource(sourceId, { type: "geojson", data: { type: "FeatureCollection", features: groupFeatures } as any });
      map.addLayer({
        id: `${sourceId}-casing`, type: "line", source: sourceId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-opacity": 0.92, "line-width": width * scale + 3 * scale, "line-offset": offset },
      });
      map.addLayer({
        id: sourceId, type: "line", source: sourceId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": route.color,
          "line-width": width * scale,
          "line-opacity": 1,
          "line-offset": offset,
          ...(route.dash ? { "line-dasharray": [1.8, 1.35] } : {}),
        },
      });
    });
    if (showStops && route.stops.length) {
      const stopId = `stops-${route.id}`;
      map.addSource(stopId, { type: "geojson", data: { type: "FeatureCollection", features: route.stops.map((stop) => ({ type: "Feature", properties: { name: stop.name }, geometry: { type: "Point", coordinates: stop.coord } })) } as any });
      map.addLayer({ id: stopId, type: "circle", source: stopId, paint: { "circle-radius": 3.5 * scale, "circle-color": "#fff", "circle-stroke-width": 2 * scale, "circle-stroke-color": route.color } });
    }
  });
}

export default function Home() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [city, setCity] = useState("珠海市");
  const [query, setQuery] = useState("");
  const [routes, setRoutes] = useState<TransitRoute[]>([]);
  const [base, setBase] = useState<BaseKey>("paper");
  const [labels, setLabels] = useState(true);
  const [showStops, setShowStops] = useState(true);
  const [lineWidth, setLineWidth] = useState(6);
  const [panel, setPanel] = useState<"routes" | "layers" | "export">("routes");
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [scale, setScale] = useState(2);
  const [notice, setNotice] = useState("输入一条或多条线路开始制图");
  const [exporting, setExporting] = useState(false);
  const latestRoutesRef = useRef(routes);
  const latestLineWidthRef = useRef(lineWidth);
  const latestShowStopsRef = useRef(showStops);
  const styleKeyRef = useRef(`${base}:${labels}`);
  const fitAfterLoadRef = useRef(false);

  latestRoutesRef.current = routes;
  latestLineWidthRef.current = lineWidth;
  latestShowStopsRef.current = showStops;

  const readyRoutes = useMemo(() => routes.filter((route) => route.status === "ready"), [routes]);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: mapStyle(base, labels),
      center: [113.5767, 22.2707],
      zoom: 11.7,
      minZoom: 3,
      maxZoom: 19,
      preserveDrawingBuffer: true,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    mapRef.current = map;
    map.on("error", (event) => console.error("MAP_RENDER_ERROR", event.error?.message ?? event));
    map.once("style.load", () => {
      clearRouteLayers(map);
      addRouteLayers(map, latestRoutesRef.current, latestLineWidthRef.current, latestShowStopsRef.current);
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(mapNode.current);
    return () => { observer.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const styleKey = `${base}:${labels}`;
    if (styleKeyRef.current === styleKey) return;
    styleKeyRef.current = styleKey;
    map.setStyle(mapStyle(base, labels));
    const restoreRoutes = () => {
      clearRouteLayers(map);
      addRouteLayers(map, latestRoutesRef.current, latestLineWidthRef.current, latestShowStopsRef.current);
      map.triggerRepaint();
    };
    map.once("style.load", restoreRoutes);
    return () => { map.off("style.load", restoreRoutes); };
  }, [base, labels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const renderRoutes = () => {
      clearRouteLayers(map);
      addRouteLayers(map, routes, lineWidth, showStops);
      map.triggerRepaint();
    };
    if (map.isStyleLoaded()) renderRoutes();
    else map.once("style.load", renderRoutes);
    return () => { map.off("style.load", renderRoutes); };
  }, [routes, lineWidth, showStops]);

  const fitRoutes = useCallback((nextRoutes: TransitRoute[]) => {
    const coords = nextRoutes.filter((route) => route.status === "ready").flatMap((route) => route.path);
    if (!coords.length || !mapRef.current) return;
    const bounds = coords.reduce((box, coord) => box.extend(coord), new maplibregl.LngLatBounds(coords[0], coords[0]));
    mapRef.current.fitBounds(bounds, { padding: 74, maxZoom: 15, duration: 900 });
  }, []);

  useEffect(() => {
    if (!fitAfterLoadRef.current || !routes.some((route) => route.status === "ready")) return;
    fitAfterLoadRef.current = false;
    fitRoutes(routes);
  }, [routes, fitRoutes]);

  async function searchOne(term: string, index: number) {
    const id = `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`;
    const pending: TransitRoute = { id, query: term, name: term, from: "", to: "", color: PALETTE[(routes.length + index) % PALETTE.length], dash: false, visible: true, path: [], stops: [], status: "searching" };
    setRoutes((current) => [...current, pending]);
    try {
      const AMap = await loadAmap();
      const result: any = await new Promise((resolve, reject) => {
        const searcher = new AMap.LineSearch({ pageIndex: 1, pageSize: 20, city, extensions: "all" });
        searcher.search(term, (status: string, data: any) => status === "complete" ? resolve(data) : reject(new Error(status === "no_data" ? "未找到该线路" : data?.info || "查询失败")));
      });
      const candidates = result?.lineInfo ?? result?.buslines ?? result?.lines ?? [];
      const line = candidates.find((item: any) => String(item.name ?? "").toLowerCase().includes(term.toLowerCase())) ?? candidates[0];
      const path = (line?.path ?? []).map(readLngLat).filter(Boolean) as Coord[];
      if (path.length < 2) throw new Error("线路存在，但未返回可绘制轨迹");
      const rawStops = line?.via_stops ?? line?.busStops ?? line?.stops ?? [];
      const stops = rawStops.map((stop: any) => ({ name: stop.name ?? "公交站", coord: readLngLat(stop.location) })).filter((stop: any) => stop.coord);
      const ready: TransitRoute = {
        ...pending,
        name: line.name ?? term,
        from: line.start_stop ?? line.startStop ?? stops[0]?.name ?? "起点",
        to: line.end_stop ?? line.endStop ?? stops.at(-1)?.name ?? "终点",
        path,
        stops,
        status: "ready",
      };
      fitAfterLoadRef.current = true;
      setRoutes((current) => current.map((route) => route.id === id ? ready : route));
      setNotice(`${ready.name} 已加入画布`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "查询失败";
      setRoutes((current) => current.map((route) => route.id === id ? { ...route, status: "error", error: message } : route));
      setNotice(`${term}：${message}`);
    }
  }

  function submitRoutes(event: FormEvent) {
    event.preventDefault();
    const terms = query.split(/[，,、\n]+/).map((item) => item.trim()).filter(Boolean);
    if (!terms.length) return;
    setQuery("");
    setNotice(`正在从高德查询 ${terms.length} 条线路…`);
    terms.forEach((term, index) => void searchOne(term, index));
  }

  function updateRoute(id: string, patch: Partial<TransitRoute>) {
    setRoutes((current) => current.map((route) => route.id === id ? { ...route, ...patch } : route));
  }

  function removeRoute(id: string) {
    setRoutes((current) => current.filter((route) => route.id !== id));
    setNotice("线路已移除");
  }

  function startCrop(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    dragStart.current = { x, y };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCrop({ x, y, width: 1, height: 1 });
  }
  function moveCrop(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    setCrop({ x: Math.min(x, dragStart.current.x), y: Math.min(y, dragStart.current.y), width: Math.abs(x - dragStart.current.x), height: Math.abs(y - dragStart.current.y) });
  }
  function endCrop() {
    dragStart.current = null;
    setCropMode(false);
    setNotice("导出范围已选定，可调整倍率后导出");
    setPanel("export");
  }

  async function exportPng() {
    const map = mapRef.current;
    if (!map || exporting) return;
    setExporting(true);
    setNotice("正在渲染高清地图…");
    const canvas = map.getCanvas();
    const area = crop && crop.width > 20 && crop.height > 20 ? crop : { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight };
    const nw = map.unproject([area.x, area.y]);
    const se = map.unproject([area.x + area.width, area.y + area.height]);
    const width = Math.min(8192, Math.max(640, Math.round(area.width * scale)));
    const height = Math.min(8192, Math.max(480, Math.round(area.height * scale)));
    const node = document.createElement("div");
    node.style.cssText = `position:fixed;left:-12000px;top:0;width:${width}px;height:${height}px;`;
    document.body.appendChild(node);
    let exportMap: MapLibreMap | null = null;
    try {
      exportMap = new maplibregl.Map({ container: node, style: mapStyle(base, labels), bounds: [[nw.lng, se.lat], [se.lng, nw.lat]], fitBoundsOptions: { padding: 0 }, interactive: false, attributionControl: false, preserveDrawingBuffer: true, fadeDuration: 0 });
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("底图加载超时")), 18000);
        exportMap!.once("load", () => {
          addRouteLayers(exportMap!, routes, lineWidth, showStops, scale);
          exportMap!.once("idle", () => { window.clearTimeout(timer); resolve(); });
        });
      });
      const blob = await new Promise<Blob | null>((resolve) => exportMap!.getCanvas().toBlob(resolve, "image/png"));
      if (!blob) throw new Error("浏览器未能生成图片");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `公交线路图-${city}-${new Date().toISOString().slice(0, 10)}-${scale}x.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出 ${width} × ${height} PNG`);
    } catch (error) {
      setNotice(error instanceof Error ? `导出失败：${error.message}` : "导出失败");
    } finally {
      exportMap?.remove();
      node.remove();
      setExporting(false);
    }
  }

  return (
    <main className={`studio ${BASES[base].dark ? "map-is-dark" : ""}`}>
      <aside className="sidebar">
        <header className="brand">
          <div className="brand-mark">路</div>
          <div><h1>路绘</h1><p>ROUTE ATLAS · 公交线路制图台</p></div>
          <span className="data-badge"><i /> 高德数据</span>
        </header>

        <nav className="tabs" aria-label="工具面板">
          <button className={panel === "routes" ? "active" : ""} onClick={() => setPanel("routes")}><span>01</span>线路</button>
          <button className={panel === "layers" ? "active" : ""} onClick={() => setPanel("layers")}><span>02</span>底图</button>
          <button className={panel === "export" ? "active" : ""} onClick={() => setPanel("export")}><span>03</span>导出</button>
        </nav>

        <div className="panel-scroll">
          {panel === "routes" && <section className="panel-section">
            <div className="section-heading"><div><p className="eyebrow">LINE INPUT</p><h2>添加既有线路</h2></div><span>{readyRoutes.length} 条</span></div>
            <form className="route-form" onSubmit={submitRoutes}>
              <label>查询城市<input value={city} onChange={(event) => setCity(event.target.value)} placeholder="如：珠海市" aria-label="查询城市" /></label>
              <label>线路名称<textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入 10A、K2、B9，可一次添加多条" rows={3} aria-label="公交线路名称" /></label>
              <button className="primary" type="submit" disabled={!query.trim()}><span>＋</span> 从高德加入画布</button>
            </form>

            <div className="route-stack">
              {routes.length === 0 && <div className="empty-card"><div className="mini-map"><i /><i /><i /></div><h3>画布还是空的</h3><p>输入本地公交线路名称，高德将返回走向与站点。</p></div>}
              {routes.map((route, index) => <article className={`route-card ${route.status}`} key={route.id}>
                <div className="route-card-top">
                  <button className={`eye ${route.visible ? "on" : ""}`} onClick={() => updateRoute(route.id, { visible: !route.visible })} aria-label={route.visible ? "隐藏线路" : "显示线路"}>●</button>
                  <div className="route-index">{String(index + 1).padStart(2, "0")}</div>
                  <div className="route-title"><strong>{route.name}</strong><span>{route.status === "searching" ? "正在查询高德…" : route.status === "error" ? route.error : `${route.from} → ${route.to}`}</span></div>
                  <button className="remove" onClick={() => removeRoute(route.id)} aria-label={`删除 ${route.name}`}>×</button>
                </div>
                {route.status === "ready" && <div className="route-tools">
                  <label className="color-control"><input type="color" value={route.color} onChange={(event) => updateRoute(route.id, { color: event.target.value })} /><span style={{ background: route.color }} />颜色</label>
                  <button className={route.dash ? "selected" : ""} onClick={() => updateRoute(route.id, { dash: !route.dash })}><i className={route.dash ? "dash" : "solid"} />{route.dash ? "虚线" : "实线"}</button>
                  <span>{route.path.length} 节点</span>
                </div>}
              </article>)}
            </div>
          </section>}

          {panel === "layers" && <section className="panel-section">
            <div className="section-heading"><div><p className="eyebrow">MAP STYLE</p><h2>选择地图风格</h2></div></div>
            <div className="base-grid">
              {(Object.keys(BASES) as BaseKey[]).map((key) => <button key={key} className={`base-card ${key} ${base === key ? "active" : ""}`} onClick={() => setBase(key)}>
                <span className="base-preview"><i /><i /><i /></span><strong>{BASES[key].name}</strong><small>{BASES[key].hint}</small><b>{base === key ? "✓" : ""}</b>
              </button>)}
            </div>
            <div className="settings-list">
              <label><div><strong>地名与道路标注</strong><span>可独立于底图显示</span></div><input type="checkbox" checked={labels} onChange={(event) => setLabels(event.target.checked)} /><i /></label>
              <label><div><strong>公交站点</strong><span>按线路颜色描边</span></div><input type="checkbox" checked={showStops} onChange={(event) => setShowStops(event.target.checked)} /><i /></label>
            </div>
            <div className="width-setting"><div><strong>线路宽度</strong><output>{lineWidth} px</output></div><input type="range" min="3" max="12" value={lineWidth} onChange={(event) => setLineWidth(Number(event.target.value))} /></div>
            <div className="info-note"><b>自动并行排线</b><p>多线路以相同线宽、等间距居中排列，走向重合时仍可清晰辨认。</p></div>
          </section>}

          {panel === "export" && <section className="panel-section">
            <div className="section-heading"><div><p className="eyebrow">HIGH-RES EXPORT</p><h2>导出高清 PNG</h2></div></div>
            <button className={`range-button ${crop ? "has-range" : ""}`} onClick={() => { setCropMode(true); setNotice("在地图上拖动框选导出范围"); }}>
              <span className="crop-icon" />
              <div><strong>{crop ? "重新选择导出范围" : "框选导出范围"}</strong><small>{crop ? `${Math.round(crop.width)} × ${Math.round(crop.height)} 画布像素` : "在地图上自由拖出矩形"}</small></div><b>→</b>
            </button>
            <div className="export-setting"><strong>清晰度倍率</strong><div className="scale-options">{[1, 2, 4].map((item) => <button className={scale === item ? "active" : ""} onClick={() => setScale(item)} key={item}>{item}×<small>{item === 1 ? "屏幕" : item === 2 ? "高清" : "印刷"}</small></button>)}</div></div>
            <div className="export-summary"><div><span>输出格式</span><strong>PNG</strong></div><div><span>底图风格</span><strong>{BASES[base].name}</strong></div><div><span>线路数量</span><strong>{readyRoutes.length}</strong></div><div><span>最大边长</span><strong>8192 px</strong></div></div>
            <button className="primary export-button" disabled={exporting} onClick={() => void exportPng()}>{exporting ? "正在渲染高清地图…" : `导出 ${scale}× PNG`}</button>
            <p className="privacy-note">导出在本机浏览器内完成，不上传线路图。</p>
          </section>}
        </div>

        <footer className="status"><i className={routes.some((route) => route.status === "searching") ? "pulse" : ""} /><span>{notice}</span></footer>
      </aside>

      <section className="map-stage" aria-label="公交线路地图画布">
        <div ref={mapNode} className="map-canvas" />
        <div className="map-topbar">
          <div className="location-chip"><span>制图城市</span><strong>{city || "未指定"}</strong></div>
          <div className="map-actions"><button onClick={() => fitRoutes(routes)} disabled={!readyRoutes.length}>适配线路</button><button onClick={() => setPanel("layers")}>{BASES[base].name}</button><button onClick={() => setLabels(!labels)} className={labels ? "active" : ""}>标注</button></div>
        </div>
        {readyRoutes.length > 0 && <div className="legend">
          <p>BUS ROUTES · {String(readyRoutes.length).padStart(2, "0")}</p>
          {readyRoutes.slice(0, 7).map((route) => <div key={route.id}><i style={{ background: route.color }} /><span>{route.name}</span></div>)}
        </div>}
        {readyRoutes.length === 0 && <div className="map-onboarding"><span>01</span><div><strong>输入线路，开始绘制</strong><p>支持多线路自动并行、卫星底图与高清框选导出</p></div></div>}
        <div className="scale-note">数据：高德开放平台 · 底图：{BASES[base].name}</div>
        {cropMode && <div className="range-capture" onPointerDown={startCrop} onPointerMove={moveCrop} onPointerUp={endCrop} onPointerCancel={endCrop}>
          <div className="range-hint">拖动鼠标框选导出范围 · 松开完成</div>
        </div>}
        {crop && <div className="crop-rect" style={{ left: crop.x, top: crop.y, width: crop.width, height: crop.height }}><span>{Math.round(crop.width * scale)} × {Math.round(crop.height * scale)} px</span></div>}
      </section>
    </main>
  );
}