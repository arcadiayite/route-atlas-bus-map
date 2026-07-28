"use client";

import { FormEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

type Coord = [number, number];
type BaseKey = "paper" | "atlas" | "dark" | "satellite";
type RouteStatus = "searching" | "ready" | "error";
type CustomNode = { id: string; kind: "stop" | "via"; value: string };

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
  custom?: boolean;
  error?: string;
};

type CropRect = { x: number; y: number; width: number; height: number };
type ExportFormat = "png" | "svg";
type MapCamera = { center: Coord; zoom: number; bearing: number; pitch: number };
type ArchivePayload = {
  version: 1;
  savedAt: number;
  city: string;
  routes: TransitRoute[];
  base: BaseKey;
  labels: boolean;
  showStops: boolean;
  stopMode: "all" | "terminals";
  stopEditing: boolean;
  hiddenStopIds: string[];
  maskOpacity: number;
  lineWidth: number;
  camera: MapCamera;
};
type ArchiveSummary = { id: string; kind: "auto" | "manual"; name: string; createdAt: number; updatedAt: number };
type ExportStop = { id: string; name: string; coord: Coord; colors: Set<string>; terminal: boolean };

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

function mapStyle(base: BaseKey, labels: boolean, maskOpacity = 0): StyleSpecification {
  const item = BASES[base];
  const sources: StyleSpecification["sources"] = {
    basemap: { type: "raster", tiles: item.tiles, tileSize: 256, attribution: item.attribution },
    mask: {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]],
        },
      },
    } as any,
  };
  const layers: any[] = [{ id: "basemap", type: "raster", source: "basemap", minzoom: 0, maxzoom: 22 }];
  if (labels) {
    sources.labels = { type: "raster", tiles: item.labels, tileSize: 256 };
    layers.push({ id: "place-labels", type: "raster", source: "labels", minzoom: 0, maxzoom: 22 });
  }
  layers.push({ id: "map-mask", type: "fill", source: "mask", paint: { "fill-color": "#ffffff", "fill-opacity": maskOpacity } });
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

function readGcjLngLat(value: any): Coord | null {
  if (!value) return null;
  const lng = typeof value.getLng === "function" ? value.getLng() : value.lng ?? value[0];
  const lat = typeof value.getLat === "function" ? value.getLat() : value.lat ?? value[1];
  return Number.isFinite(Number(lng)) && Number.isFinite(Number(lat)) ? [Number(lng), Number(lat)] : null;
}

function readLngLat(value: any): Coord | null {
  const coord = readGcjLngLat(value);
  return coord ? gcjToWgs(coord) : null;
}

let amapPromise: Promise<any> | null = null;
function loadAmap() {
  if (typeof window === "undefined") return Promise.reject(new Error("仅支持浏览器调用"));
  if (window.AMap?.LineSearch && window.AMap?.Geocoder && window.AMap?.Driving) return Promise.resolve(window.AMap);
  if (amapPromise) return amapPromise;
  const key = document.body.dataset.amapKey;
  const securityJsCode = document.body.dataset.amapSecurityCode;
  if (!key || !securityJsCode) return Promise.reject(new Error("尚未配置高德 Web API"));
  window._AMapSecurityConfig = { securityJsCode };
  amapPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.LineSearch,AMap.Geocoder,AMap.Driving`;
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

type MetricPoint = { x: number; y: number };
type RouteSegment = {
  routeId: string;
  index: number;
  a: MetricPoint;
  b: MetricPoint;
  dx: number;
  dy: number;
  length: number;
  members: Set<string>;
};

function pointSegmentDistance(point: MetricPoint, a: MetricPoint, b: MetricPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function memberKey(members: Set<string>, order: Map<string, number>) {
  return [...members].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).join("|");
}

function segmentCollections(routes: TransitRoute[], width: number, scale = 1) {
  const active = routes.filter((route) => route.visible && route.status === "ready");
  if (!active.length) return new Map<string, any[]>();

  const routeOrder = new Map(active.map((route, index) => [route.id, index]));
  const latitudes = active.flatMap((route) => route.path.map((coord) => coord[1]));
  const referenceLatitude = (latitudes.reduce((sum, latitude) => sum + latitude, 0) / Math.max(1, latitudes.length)) * Math.PI / 180;
  const toMetric = ([lng, lat]: Coord): MetricPoint => ({
    x: lng * 111320 * Math.cos(referenceLatitude),
    y: lat * 110540,
  });

  const routeSegments = new Map<string, RouteSegment[]>();
  const allSegments: RouteSegment[] = [];
  active.forEach((route) => {
    const metricPath = route.path.map(toMetric);
    const segments = route.path.slice(0, -1).map((_, index) => {
      const a = metricPath[index];
      const b = metricPath[index + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segment: RouteSegment = {
        routeId: route.id,
        index,
        a,
        b,
        dx,
        dy,
        length: Math.hypot(dx, dy),
        members: new Set([route.id]),
      };
      allSegments.push(segment);
      return segment;
    });
    routeSegments.set(route.id, segments);
  });

  const proximity = 38;
  const cellSize = 64;
  const grid = new Map<string, RouteSegment[]>();
  const gridKey = (x: number, y: number) => `${x}:${y}`;
  allSegments.filter((segment) => segment.length > 0.5).forEach((segment) => {
    const minX = Math.floor((Math.min(segment.a.x, segment.b.x) - proximity) / cellSize);
    const maxX = Math.floor((Math.max(segment.a.x, segment.b.x) + proximity) / cellSize);
    const minY = Math.floor((Math.min(segment.a.y, segment.b.y) - proximity) / cellSize);
    const maxY = Math.floor((Math.max(segment.a.y, segment.b.y) + proximity) / cellSize);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = gridKey(x, y);
        grid.set(key, [...(grid.get(key) ?? []), segment]);
      }
    }
  });

  allSegments.filter((segment) => segment.length > 0.5).forEach((segment) => {
    const midpoint = { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
    const candidates = grid.get(gridKey(Math.floor(midpoint.x / cellSize), Math.floor(midpoint.y / cellSize))) ?? [];
    candidates.forEach((candidate) => {
      if (candidate.routeId === segment.routeId || candidate.length <= 0.5) return;
      const parallel = Math.abs((segment.dx * candidate.dx + segment.dy * candidate.dy) / (segment.length * candidate.length));
      if (parallel < 0.72) return;
      const candidateMidpoint = { x: (candidate.a.x + candidate.b.x) / 2, y: (candidate.a.y + candidate.b.y) / 2 };
      const separation = Math.min(
        pointSegmentDistance(midpoint, candidate.a, candidate.b),
        pointSegmentDistance(candidateMidpoint, segment.a, segment.b),
      );
      if (separation > proximity) return;
      segment.members.add(candidate.routeId);
      candidate.members.add(segment.routeId);
    });
  });

  routeSegments.forEach((segments) => {
    for (let pass = 0; pass < 2; pass += 1) {
      for (let index = 1; index < segments.length - 1; index += 1) {
        if (segments[index].members.size > 1) continue;
        const previous = segments[index - 1].members;
        const next = segments[index + 1].members;
        if (previous.size > 1 && memberKey(previous, routeOrder) === memberKey(next, routeOrder)) {
          segments[index].members = new Set(previous);
        }
      }
    }
  });

  const spacing = (width + 2) * scale;
  return new Map(active.map((route) => {
    const segments = routeSegments.get(route.id) ?? [];
    const offsets = segments.map((segment) => {
      if (segment.members.size <= 1 || segment.length <= 0.5) return 0;
      const members = [...segment.members].sort((a, b) => (routeOrder.get(a) ?? 0) - (routeOrder.get(b) ?? 0));
      const rank = members.indexOf(route.id);
      const laneOffset = (rank - (members.length - 1) / 2) * spacing;
      const directionSign = Math.abs(segment.dx) >= Math.abs(segment.dy)
        ? (segment.dx >= 0 ? 1 : -1)
        : (segment.dy >= 0 ? 1 : -1);
      return laneOffset * directionSign;
    });
    const features: any[] = [];
    if (!segments.length) return [route.id, features];
    let currentOffset = offsets[0];
    let coordinates: Coord[] = [route.path[0], route.path[1]];
    for (let index = 1; index < segments.length; index += 1) {
      if (Math.abs(offsets[index] - currentOffset) < 0.01) {
        coordinates.push(route.path[index + 1]);
        continue;
      }
      features.push({
        type: "Feature",
        properties: { offset: currentOffset },
        geometry: { type: "LineString", coordinates },
      });
      currentOffset = offsets[index];
      coordinates = [route.path[index], route.path[index + 1]];
    }
    features.push({
      type: "Feature",
      properties: { offset: currentOffset },
      geometry: { type: "LineString", coordinates },
    });
    return [route.id, features];
  }));
}

function stopDistanceMetres(a: Coord, b: Coord) {
  const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const dx = (a[0] - b[0]) * 111320 * Math.cos(latitude);
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

function stopKey(name: string) {
  return name.trim().replace(/\s+/g, "").replace(/[（(][^）)]*[）)]/g, "");
}

function collectExportStops(routes: TransitRoute[], stopMode: "all" | "terminals", hiddenStopIds: string[]) {
  const hiddenSet = new Set(hiddenStopIds);
  const merged: (ExportStop & { key: string; coords: Coord[] })[] = [];
  routes.filter((route) => route.visible && route.status === "ready").forEach((route) => {
    const routeStops = stopMode === "terminals"
      ? route.stops.filter((_, index) => index === 0 || index === route.stops.length - 1)
      : route.stops;
    routeStops.forEach((stop, index) => {
      const key = stopKey(stop.name);
      const terminal = stopMode === "terminals" || index === 0 || index === routeStops.length - 1;
      const existing = merged.find((item) => item.key === key && stopDistanceMetres(item.coord, stop.coord) <= 80);
      if (existing) {
        existing.colors.add(route.color);
        existing.coords.push(stop.coord);
        existing.terminal ||= terminal;
        existing.coord = [
          existing.coords.reduce((sum, coord) => sum + coord[0], 0) / existing.coords.length,
          existing.coords.reduce((sum, coord) => sum + coord[1], 0) / existing.coords.length,
        ];
      } else {
        const id = `${key}:${Math.round(stop.coord[0] * 100)}:${Math.round(stop.coord[1] * 100)}`;
        merged.push({ id, name: stop.name, key, coord: stop.coord, coords: [stop.coord], colors: new Set([route.color]), terminal });
      }
    });
  });
  return merged.filter((stop) => !hiddenSet.has(stop.id));
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character);
}

function offsetSvgPath(points: { x: number; y: number }[], offset: number) {
  if (points.length < 2) return "";
  const shifted = points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + (-dy / length) * offset, y: point.y + (dx / length) * offset };
  });
  return shifted.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
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

function addRouteLayers(
  map: MapLibreMap,
  routes: TransitRoute[],
  width: number,
  showStops: boolean,
  scale = 1,
  stopMode: "all" | "terminals" = "all",
  hiddenStopIds: string[] = [],
  revealHiddenStops = false,
) {
  const activeRoutes = routes.filter((route) => route.visible && route.status === "ready");
  const collections = segmentCollections(routes, width, scale);
  activeRoutes.forEach((route) => {
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
        layout: { "line-cap": "round", "line-join": "bevel" },
        paint: { "line-color": "#ffffff", "line-opacity": 0.92, "line-width": width * scale + 3 * scale, "line-offset": offset },
      });
      map.addLayer({
        id: sourceId, type: "line", source: sourceId,
        layout: { "line-cap": "round", "line-join": "bevel" },
        paint: {
          "line-color": route.color,
          "line-width": width * scale,
          "line-opacity": 1,
          "line-offset": offset,
          ...(route.dash ? { "line-dasharray": [1.8, 1.35] } : {}),
        },
      });
    });
  });

  if (showStops) {
    const hiddenSet = new Set(hiddenStopIds);
    const mergedStops: { id: string; name: string; key: string; coord: Coord; coords: Coord[]; colors: Set<string>; terminal: boolean }[] = [];
    activeRoutes.forEach((route) => {
      const routeStops = stopMode === "terminals"
        ? route.stops.filter((_, index) => index === 0 || index === route.stops.length - 1)
        : route.stops;
      routeStops.forEach((stop, index) => {
        const key = stopKey(stop.name);
        const terminal = stopMode === "terminals" || index === 0 || index === routeStops.length - 1;
        const existing = mergedStops.find((item) => item.key === key && stopDistanceMetres(item.coord, stop.coord) <= 80);
        if (existing) {
          existing.colors.add(route.color);
          existing.coords.push(stop.coord);
          existing.terminal ||= terminal;
          existing.coord = [
            existing.coords.reduce((sum, coord) => sum + coord[0], 0) / existing.coords.length,
            existing.coords.reduce((sum, coord) => sum + coord[1], 0) / existing.coords.length,
          ];
        } else {
          const id = `${key}:${Math.round(stop.coord[0] * 100)}:${Math.round(stop.coord[1] * 100)}`;
          mergedStops.push({ id, name: stop.name, key, coord: stop.coord, coords: [stop.coord], colors: new Set([route.color]), terminal });
        }
      });
    });
    const drawableStops = mergedStops.filter((stop) => revealHiddenStops || !hiddenSet.has(stop.id));
    if (drawableStops.length) {
      const stopId = "stops-all";
      map.addSource(stopId, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: drawableStops.map((stop) => ({
            type: "Feature",
            properties: {
              id: stop.id,
              name: stop.name,
              stroke: stop.colors.size > 1 ? "#18252d" : [...stop.colors][0],
              hidden: hiddenSet.has(stop.id),
              terminal: stop.terminal,
              radius: ((stop.terminal ? 4.5 : 3.5) + Math.min(3, stop.colors.size - 1) * 2) * scale,
            },
            geometry: { type: "Point", coordinates: stop.coord },
          })),
        } as any,
      });
      map.addLayer({
        id: stopId,
        type: "circle",
        source: stopId,
        paint: {
          "circle-radius": ["case", ["get", "hidden"], 4 * scale, ["get", "radius"]],
          "circle-color": ["case", ["get", "hidden"], "#c9cdcb", "#fff"],
          "circle-stroke-width": 2 * scale,
          "circle-stroke-color": ["case", ["get", "hidden"], "#7c8582", ["get", "stroke"]],
          "circle-opacity": ["case", ["get", "hidden"], 0.35, 1],
          "circle-stroke-opacity": ["case", ["get", "hidden"], 0.65, 1],
        },
      });      map.addLayer({
        id: "stops-hit",
        type: "circle",
        source: stopId,
        paint: {
          "circle-radius": 11 * scale,
          "circle-color": "#000",
          "circle-opacity": 0.01,
        },
      });
    }
  }
}

export default function Home() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [city, setCity] = useState("珠海市");
  const [query, setQuery] = useState("");
  const [routeEntryMode, setRouteEntryMode] = useState<"existing" | "custom">("existing");
  const [customName, setCustomName] = useState("");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [customNodes, setCustomNodes] = useState<CustomNode[]>([]);
  const [planningCustom, setPlanningCustom] = useState(false);
  const [routes, setRoutes] = useState<TransitRoute[]>([]);
  const [base, setBase] = useState<BaseKey>("paper");
  const [labels, setLabels] = useState(true);
  const [showStops, setShowStops] = useState(true);
  const [stopMode, setStopMode] = useState<"all" | "terminals">("all");
  const [stopEditing, setStopEditing] = useState(false);
  const [hiddenStopIds, setHiddenStopIds] = useState<string[]>([]);
  const [maskOpacity, setMaskOpacity] = useState(0);
  const [lineWidth, setLineWidth] = useState(6);
  const [panel, setPanel] = useState<"routes" | "layers" | "export" | "archive">("routes");
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [scale, setScale] = useState(2);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [notice, setNotice] = useState("输入一条或多条线路开始制图");
  const [exporting, setExporting] = useState(false);
  const [camera, setCamera] = useState<MapCamera>({ center: [113.5767, 22.2707], zoom: 11.7, bearing: 0, pitch: 0 });
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const [archiveName, setArchiveName] = useState("");
  const [archiveReady, setArchiveReady] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [autoSaveStatus, setAutoSaveStatus] = useState("正在读取存档…");
  const latestRoutesRef = useRef(routes);
  const latestLineWidthRef = useRef(lineWidth);
  const latestShowStopsRef = useRef(showStops);
  const latestStopModeRef = useRef(stopMode);
  const latestStopEditingRef = useRef(stopEditing);
  const latestHiddenStopIdsRef = useRef(hiddenStopIds);
  const styleKeyRef = useRef(`${base}:${labels}`);
  const fitAfterLoadRef = useRef(false);
  const pendingCameraRef = useRef<MapCamera | null>(null);

  latestRoutesRef.current = routes;
  latestLineWidthRef.current = lineWidth;
  latestShowStopsRef.current = showStops;
  latestStopModeRef.current = stopMode;
  latestStopEditingRef.current = stopEditing;
  latestHiddenStopIdsRef.current = hiddenStopIds;

  const readyRoutes = useMemo(() => routes.filter((route) => route.status === "ready"), [routes]);
  const manualArchives = useMemo(() => archives.filter((archive) => archive.kind === "manual"), [archives]);
  const autoArchive = useMemo(() => archives.find((archive) => archive.kind === "auto"), [archives]);

  const buildArchivePayload = useCallback((): ArchivePayload => ({
    version: 1,
    savedAt: Date.now(),
    city,
    routes: routes.filter((route) => route.status === "ready"),
    base,
    labels,
    showStops,
    stopMode,
    stopEditing,
    hiddenStopIds,
    maskOpacity,
    lineWidth,
    camera,
  }), [city, routes, base, labels, showStops, stopMode, stopEditing, hiddenStopIds, maskOpacity, lineWidth, camera]);

  const applyArchivePayload = useCallback((payload: ArchivePayload) => {
    if (!payload || payload.version !== 1 || !Array.isArray(payload.routes)) throw new Error("存档格式不受支持");
    setCity(payload.city || "珠海市");
    setRoutes(payload.routes.map((route) => ({ ...route, status: "ready" })));
    if (payload.base && BASES[payload.base]) setBase(payload.base);
    setLabels(Boolean(payload.labels));
    setShowStops(Boolean(payload.showStops));
    setStopMode(payload.stopMode === "terminals" ? "terminals" : "all");
    setStopEditing(Boolean(payload.stopEditing));
    setHiddenStopIds(Array.isArray(payload.hiddenStopIds) ? payload.hiddenStopIds : []);
    setMaskOpacity(Number.isFinite(payload.maskOpacity) ? payload.maskOpacity : 0);
    setLineWidth(Number.isFinite(payload.lineWidth) ? payload.lineWidth : 6);
    setCrop(null);
    if (payload.camera) {
      setCamera(payload.camera);
      pendingCameraRef.current = payload.camera;
      mapRef.current?.jumpTo({ center: payload.camera.center, zoom: payload.camera.zoom, bearing: payload.camera.bearing, pitch: payload.camera.pitch });
    }
  }, []);

  const refreshArchives = useCallback(async () => {
    const response = await fetch("/api/archives", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取存档列表");
    setArchives(data.archives ?? []);
    return data.archives as ArchiveSummary[];
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await refreshArchives();
        const automatic = rows.find((archive) => archive.kind === "auto");
        if (automatic) {
          const response = await fetch(`/api/archives?id=${encodeURIComponent(automatic.id)}`, { cache: "no-store" });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "无法读取自动存档");
          if (!cancelled) {
            applyArchivePayload(JSON.parse(data.archive.payload));
            setNotice("已恢复上次自动存档");
            setAutoSaveStatus(`已恢复 · ${new Date(automatic.updatedAt).toLocaleString("zh-CN", { hour12: false })}`);
          }
        } else if (!cancelled) {
          setAutoSaveStatus("尚无自动存档");
        }
      } catch (error) {
        if (!cancelled) setAutoSaveStatus(error instanceof Error ? `存档读取失败：${error.message}` : "存档读取失败");
      } finally {
        if (!cancelled) setArchiveReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [applyArchivePayload, refreshArchives]);

  useEffect(() => {
    if (!archiveReady || !autoSaveEnabled) return;
    const timer = window.setTimeout(() => {
      setAutoSaveStatus("正在自动保存…");
      void fetch("/api/archives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "auto", payload: buildArchivePayload() }),
      }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "自动保存失败");
        const saved = data.archive as ArchiveSummary;
        setArchives((current) => [saved, ...current.filter((archive) => archive.kind !== "auto")]);
        setAutoSaveStatus(`已自动保存 · ${new Date(saved.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`);
      }).catch((error) => setAutoSaveStatus(error instanceof Error ? `自动保存失败：${error.message}` : "自动保存失败"));
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [archiveReady, autoSaveEnabled, buildArchivePayload]);

  async function saveAutoArchive() {
    setArchiveBusy(true);
    setAutoSaveStatus("正在保存…");
    try {
      const response = await fetch("/api/archives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "auto", payload: buildArchivePayload() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      await refreshArchives();
      setAutoSaveStatus(`已保存 · ${new Date(data.archive.updatedAt).toLocaleString("zh-CN", { hour12: false })}`);
      setNotice("当前画布已写入自动存档");
    } catch (error) {
      setAutoSaveStatus(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
    } finally {
      setArchiveBusy(false);
    }
  }

  async function saveManualArchive() {
    setArchiveBusy(true);
    try {
      const fallbackName = `线路图 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
      const response = await fetch("/api/archives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "manual", name: archiveName.trim() || fallbackName, payload: buildArchivePayload() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "手动存档失败");
      setArchiveName("");
      await refreshArchives();
      setNotice(`${data.archive.name} 已保存`);
    } catch (error) {
      setNotice(error instanceof Error ? `存档失败：${error.message}` : "存档失败");
    } finally {
      setArchiveBusy(false);
    }
  }

  async function restoreArchive(id: string, name: string) {
    if (!window.confirm(`载入“${name}”会替换当前画布，是否继续？`)) return;
    setArchiveBusy(true);
    try {
      const response = await fetch(`/api/archives?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "载入存档失败");
      applyArchivePayload(JSON.parse(data.archive.payload));
      setNotice(`${name} 已载入画布`);
    } catch (error) {
      setNotice(error instanceof Error ? `载入失败：${error.message}` : "载入失败");
    } finally {
      setArchiveBusy(false);
    }
  }

  async function deleteArchive(id: string, name: string) {
    if (!window.confirm(`确认删除手动存档“${name}”？此操作无法撤销。`)) return;
    setArchiveBusy(true);
    try {
      const response = await fetch(`/api/archives?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除失败");
      await refreshArchives();
      setNotice(`${name} 已删除`);
    } catch (error) {
      setNotice(error instanceof Error ? `删除失败：${error.message}` : "删除失败");
    } finally {
      setArchiveBusy(false);
    }
  }

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: mapStyle(base, labels, maskOpacity),
      center: camera.center,
      zoom: camera.zoom,
      bearing: camera.bearing,
      pitch: camera.pitch,
      minZoom: 3,
      maxZoom: 19,
      preserveDrawingBuffer: true,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    mapRef.current = map;
    const syncCamera = () => {
      const center = map.getCenter();
      setCamera({ center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
    };
    map.on("moveend", syncCamera);
    map.on("error", (event) => console.error("MAP_RENDER_ERROR", event.error?.message ?? event));
    map.once("style.load", () => {
      clearRouteLayers(map);
      addRouteLayers(map, latestRoutesRef.current, latestLineWidthRef.current, latestShowStopsRef.current, 1, latestStopModeRef.current, latestHiddenStopIdsRef.current, latestStopEditingRef.current);
    });
    map.once("load", () => {
      if (pendingCameraRef.current) {
        const saved = pendingCameraRef.current;
        map.jumpTo({ center: saved.center, zoom: saved.zoom, bearing: saved.bearing, pitch: saved.pitch });
        pendingCameraRef.current = null;
      }
      syncCamera();
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(mapNode.current);
    return () => { observer.disconnect(); map.off("moveend", syncCamera); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const styleKey = `${base}:${labels}`;
    if (styleKeyRef.current === styleKey) return;
    styleKeyRef.current = styleKey;
    map.setStyle(mapStyle(base, labels, maskOpacity));
    const restoreRoutes = () => {
      clearRouteLayers(map);
      addRouteLayers(map, latestRoutesRef.current, latestLineWidthRef.current, latestShowStopsRef.current, 1, latestStopModeRef.current, latestHiddenStopIdsRef.current, latestStopEditingRef.current);
      map.triggerRepaint();
    };
    map.once("style.load", restoreRoutes);
    return () => { map.off("style.load", restoreRoutes); };
  }, [base, labels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const applyMask = () => {
      if (map.getLayer("map-mask")) map.setPaintProperty("map-mask", "fill-opacity", maskOpacity);
    };
    if (map.isStyleLoaded()) applyMask();
    else map.once("style.load", applyMask);
    return () => { map.off("style.load", applyMask); };
  }, [maskOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const renderRoutes = () => {
      clearRouteLayers(map);
      addRouteLayers(map, routes, lineWidth, showStops, 1, stopMode, hiddenStopIds, stopEditing);
      map.triggerRepaint();
    };
    if (map.isStyleLoaded()) renderRoutes();
    else map.once("style.load", renderRoutes);
    return () => { map.off("style.load", renderRoutes); };
  }, [routes, lineWidth, showStops, stopMode, hiddenStopIds, stopEditing]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !stopEditing || !showStops || !map.getLayer("stops-hit")) return;
    const handleClick = (event: any) => {
      const feature = event.features?.[0];
      const id = String(feature?.properties?.id ?? "");
      if (!id) return;
      const name = String(feature.properties?.name ?? "该站点");
      const isHidden = latestHiddenStopIdsRef.current.includes(id);
      setHiddenStopIds((current) => isHidden ? current.filter((item) => item !== id) : [...current, id]);
      setNotice(isHidden ? `${name} 已恢复显示` : `${name} 已隐藏；再次点击淡色站点可恢复`);
    };
    const handleEnter = () => { map.getCanvas().style.cursor = "pointer"; };
    const handleLeave = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", "stops-hit", handleClick);
    map.on("mouseenter", "stops-hit", handleEnter);
    map.on("mouseleave", "stops-hit", handleLeave);
    return () => {
      map.off("click", "stops-hit", handleClick);
      map.off("mouseenter", "stops-hit", handleEnter);
      map.off("mouseleave", "stops-hit", handleLeave);
      map.getCanvas().style.cursor = "";
    };
  }, [stopEditing, showStops, stopMode, routes]);

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

  function addCustomNode(kind: CustomNode["kind"]) {
    setCustomNodes((current) => [...current, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, value: "" }]);
  }

  function updateCustomNode(id: string, patch: Partial<CustomNode>) {
    setCustomNodes((current) => current.map((node) => node.id === id ? { ...node, ...patch } : node));
  }

  async function submitCustomRoute(event: FormEvent) {
    event.preventDefault();
    const start = customStart.trim();
    const end = customEnd.trim();
    const nodes = customNodes.map((node) => ({ ...node, value: node.value.trim() }));
    if (!start || !end || nodes.some((node) => !node.value)) {
      setNotice("请填写首站、末站以及每一个中途节点");
      return;
    }

    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const routeName = customName.trim() || `${start}—${end}`;
    const pending: TransitRoute = {
      id,
      query: routeName,
      name: routeName,
      from: start,
      to: end,
      color: PALETTE[routes.length % PALETTE.length],
      dash: false,
      visible: true,
      path: [],
      stops: [],
      status: "searching",
      custom: true,
    };
    setPlanningCustom(true);
    setRoutes((current) => [...current, pending]);
    setNotice(`正在为 ${routeName} 规划路径…`);

    try {
      const AMap = await loadAmap();
      const geocoder = new AMap.Geocoder({ city, extensions: "base" });
      const ordered = [
        { kind: "stop" as const, value: start },
        ...nodes,
        { kind: "stop" as const, value: end },
      ];
      const geocoded: { kind: CustomNode["kind"]; name: string; gcj: Coord; coord: Coord }[] = [];

      for (const node of ordered) {
        const result: any = await new Promise((resolve, reject) => {
          geocoder.getLocation(node.value, (status: string, data: any) => status === "complete" && data?.info === "OK"
            ? resolve(data)
            : reject(new Error(`无法定位“${node.value}”`)));
        });
        const gcj = readGcjLngLat(result?.geocodes?.[0]?.location);
        if (!gcj) throw new Error(`“${node.value}”没有返回有效坐标`);
        geocoded.push({ kind: node.kind, name: node.value, gcj, coord: gcjToWgs(gcj) });
      }

      const path: Coord[] = [];
      for (let index = 0; index < geocoded.length - 1; index += 1) {
        const origin = geocoded[index];
        const destination = geocoded[index + 1];
        const result: any = await new Promise((resolve, reject) => {
          const driving = new AMap.Driving({ city, policy: 0, extensions: "all" });
          driving.search(
            new AMap.LngLat(origin.gcj[0], origin.gcj[1]),
            new AMap.LngLat(destination.gcj[0], destination.gcj[1]),
            (status: string, data: any) => status === "complete"
              ? resolve(data)
              : reject(new Error(`${origin.name} → ${destination.name} 规划失败：${data?.info || status}`)),
          );
        });
        const route = result?.routes?.[0];
        const rawLeg = (route?.steps ?? []).flatMap((step: any) => step?.path ?? []);
        const leg = (rawLeg.length ? rawLeg : route?.path ?? []).map(readLngLat).filter(Boolean) as Coord[];
        if (leg.length < 2) throw new Error(`${origin.name} → ${destination.name} 未返回可绘制路径`);
        if (path.length && Math.hypot(path.at(-1)![0] - leg[0][0], path.at(-1)![1] - leg[0][1]) < 1e-7) leg.shift();
        path.push(...leg);
      }

      const stops = geocoded.filter((node) => node.kind === "stop").map((node) => ({ name: node.name, coord: node.coord }));
      const ready: TransitRoute = { ...pending, path, stops, status: "ready" };
      fitAfterLoadRef.current = true;
      setRoutes((current) => current.map((route) => route.id === id ? ready : route));
      setCustomName("");
      setCustomStart("");
      setCustomEnd("");
      setCustomNodes([]);
      setNotice(`${routeName} 已按高德导航加入画布`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "自定义线路规划失败";
      setRoutes((current) => current.map((route) => route.id === id ? { ...route, status: "error", error: message } : route));
      setNotice(message);
    } finally {
      setPlanningCustom(false);
    }
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
      exportMap = new maplibregl.Map({ container: node, style: mapStyle(base, labels, maskOpacity), bounds: [[nw.lng, se.lat], [se.lng, nw.lat]], fitBoundsOptions: { padding: 0 }, interactive: false, attributionControl: false, preserveDrawingBuffer: true, fadeDuration: 0 });
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("底图加载超时")), 18000);
        exportMap!.once("load", () => {
          addRouteLayers(exportMap!, routes, lineWidth, showStops, scale, stopMode, hiddenStopIds, false);
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

  async function exportSvg() {
    const map = mapRef.current;
    if (!map || exporting) return;
    setExporting(true);
    setNotice("正在生成可编辑 SVG…");
    const canvas = map.getCanvas();
    const area = crop && crop.width > 20 && crop.height > 20 ? crop : { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight };
    const nw = map.unproject([area.x, area.y]);
    const se = map.unproject([area.x + area.width, area.y + area.height]);
    const width = Math.min(8192, Math.max(640, Math.round(area.width * scale)));
    const height = Math.min(8192, Math.max(480, Math.round(area.height * scale)));
    const renderScale = width / area.width;
    const node = document.createElement("div");
    node.style.cssText = `position:fixed;left:-12000px;top:0;width:${width}px;height:${height}px;`;
    document.body.appendChild(node);
    let exportMap: MapLibreMap | null = null;
    try {
      exportMap = new maplibregl.Map({
        container: node,
        style: mapStyle(base, labels, maskOpacity),
        bounds: [[nw.lng, se.lat], [se.lng, nw.lat]],
        fitBoundsOptions: { padding: 0 },
        interactive: false,
        attributionControl: false,
        preserveDrawingBuffer: true,
        fadeDuration: 0,
      });
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("底图加载超时")), 18000);
        exportMap!.once("load", () => exportMap!.once("idle", () => { window.clearTimeout(timer); resolve(); }));
      });

      const background = exportMap.getCanvas().toDataURL("image/png");
      const collections = segmentCollections(routes, lineWidth, renderScale);
      const activeRoutes = routes.filter((route) => route.visible && route.status === "ready");
      const routeMarkup = activeRoutes.map((route, routeIndex) => {
        const features = collections.get(route.id) ?? [];
        const paths = features.map((feature, featureIndex) => {
          const points = (feature.geometry.coordinates as Coord[]).map((coord) => exportMap!.project(coord));
          const d = offsetSvgPath(points, Number(feature.properties.offset) || 0);
          if (!d) return "";
          const dash = route.dash ? ` stroke-dasharray="${(lineWidth * renderScale * 1.8).toFixed(2)} ${(lineWidth * renderScale * 1.35).toFixed(2)}"` : "";
          return `<g id="route-${routeIndex + 1}-part-${featureIndex + 1}"><path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="0.92" stroke-width="${(lineWidth * renderScale + 3 * renderScale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="bevel"/><path d="${d}" fill="none" stroke="${escapeXml(route.color)}" stroke-width="${(lineWidth * renderScale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="bevel"${dash}/></g>`;
        }).join("");
        return `<g id="route-${routeIndex + 1}" data-route-id="${escapeXml(route.id)}" data-route-name="${escapeXml(route.name)}"><title>${escapeXml(route.name)}</title>${paths}</g>`;
      }).join("");

      const stationMarkup = showStops ? collectExportStops(routes, stopMode, hiddenStopIds).map((stop, index) => {
        const point = exportMap!.project(stop.coord);
        const radius = ((stop.terminal ? 4.5 : 3.5) + Math.min(3, stop.colors.size - 1) * 2) * renderScale;
        const stroke = stop.colors.size > 1 ? "#18252d" : [...stop.colors][0];
        return `<g id="station-${index + 1}" data-station-id="${escapeXml(stop.id)}" data-station-name="${escapeXml(stop.name)}"><title>${escapeXml(stop.name)}</title><circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="#ffffff" stroke="${escapeXml(stroke)}" stroke-width="${(2 * renderScale).toFixed(2)}"/></g>`;
      }).join("") : "";

      const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(city)}公交线路图"><title>${escapeXml(city)}公交线路图</title><metadata>由路绘导出；线路和站点均为独立矢量分组。</metadata><g id="basemap"><image href="${background}" x="0" y="0" width="${width}" height="${height}"/></g><g id="routes">${routeMarkup}</g><g id="stations">${stationMarkup}</g></svg>`;
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `公交线路图-${city}-${new Date().toISOString().slice(0, 10)}-${scale}x.svg`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出 ${width} × ${height} SVG；线路与站点可独立编辑`);
    } catch (error) {
      setNotice(error instanceof Error ? `SVG 导出失败：${error.message}` : "SVG 导出失败");
    } finally {
      exportMap?.remove();
      node.remove();
      setExporting(false);
    }
  }

  function exportCurrent() {
    return exportFormat === "svg" ? exportSvg() : exportPng();
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
          <button className={panel === "archive" ? "active" : ""} onClick={() => setPanel("archive")}><span>04</span>存档</button>
        </nav>

        <div className="panel-scroll">
          {panel === "routes" && <section className="panel-section">
            <div className="section-heading"><div><p className="eyebrow">LINE INPUT</p><h2>添加线路</h2></div><span>{readyRoutes.length} 条</span></div>
            <div className="route-mode-tabs" role="tablist" aria-label="线路添加方式">
              <button type="button" className={routeEntryMode === "existing" ? "active" : ""} onClick={() => setRouteEntryMode("existing")}>既有公交</button>
              <button type="button" className={routeEntryMode === "custom" ? "active" : ""} onClick={() => setRouteEntryMode("custom")}>自定义线路</button>
            </div>

            {routeEntryMode === "existing" && <form className="route-form" onSubmit={submitRoutes}>
              <label>查询城市<input value={city} onChange={(event) => setCity(event.target.value)} placeholder="如：珠海市" aria-label="查询城市" /></label>
              <label>线路名称<textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入 10A、K2、B9，可一次添加多条" rows={3} aria-label="公交线路名称" /></label>
              <button className="primary" type="submit" disabled={!query.trim()}><span>＋</span> 从高德加入画布</button>
            </form>}

            {routeEntryMode === "custom" && <form className="custom-route-form" onSubmit={submitCustomRoute}>
              <div className="custom-grid">
                <label className="full">查询城市<input value={city} onChange={(event) => setCity(event.target.value)} placeholder="如：珠海市" aria-label="自定义线路查询城市" /></label>
                <label className="full">线路名称（可选）<input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="如：环城观光线" aria-label="自定义线路名称" /></label>
                <label><span className="node-label"><i className="terminal">起</i>首站</span><input value={customStart} onChange={(event) => setCustomStart(event.target.value)} placeholder="输入地点或站名" aria-label="自定义线路首站" /></label>
                <label><span className="node-label"><i className="terminal">终</i>末站</span><input value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} placeholder="输入地点或站名" aria-label="自定义线路末站" /></label>
              </div>

              {customNodes.length > 0 && <div className="custom-node-list" aria-label="按顺序排列的中途节点">
                {customNodes.map((node, index) => <div className="custom-node-row" key={node.id}>
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <select value={node.kind} onChange={(event) => updateCustomNode(node.id, { kind: event.target.value as CustomNode["kind"] })} aria-label={`第 ${index + 1} 个节点类型`}>
                    <option value="stop">中途停站</option>
                    <option value="via">途经点</option>
                  </select>
                  <input value={node.value} onChange={(event) => updateCustomNode(node.id, { value: event.target.value })} placeholder={node.kind === "stop" ? "显示站点标记" : "只约束路径"} aria-label={`第 ${index + 1} 个节点名称`} />
                  <button type="button" onClick={() => setCustomNodes((current) => current.filter((item) => item.id !== node.id))} aria-label={`删除第 ${index + 1} 个节点`}>×</button>
                </div>)}
              </div>}

              <div className="custom-node-actions">
                <button type="button" onClick={() => addCustomNode("stop")}><span>＋</span> 中途停站</button>
                <button type="button" onClick={() => addCustomNode("via")}><span>＋</span> 途经点</button>
              </div>
              <p className="builder-note">节点按列表顺序经过；中途停站显示站标，途经点只控制走向。</p>
              <button className="primary" type="submit" disabled={planningCustom || !customStart.trim() || !customEnd.trim()}><span>⌁</span>{planningCustom ? "正在规划高德导航…" : "规划并加入画布"}</button>
            </form>}

            <div className="route-stack">
              {routes.length === 0 && <div className="empty-card"><div className="mini-map"><i /><i /><i /></div><h3>画布还是空的</h3><p>输入本地公交线路名称，高德将返回走向与站点。</p></div>}
              {routes.map((route, index) => <article className={`route-card ${route.status}`} key={route.id}>
                <div className="route-card-top">
                  <button className={`eye ${route.visible ? "on" : ""}`} onClick={() => updateRoute(route.id, { visible: !route.visible })} aria-label={route.visible ? "隐藏线路" : "显示线路"}>●</button>
                  <div className="route-index">{String(index + 1).padStart(2, "0")}</div>
                  <div className="route-title"><strong>{route.name}{route.custom && <em>自定义</em>}</strong><span>{route.status === "searching" ? (route.custom ? "正在规划高德导航…" : "正在查询高德…") : route.status === "error" ? route.error : `${route.from} → ${route.to}`}</span></div>
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
              <label><div><strong>仅显示首末站</strong><span>每条线路只保留起点和终点</span></div><input type="checkbox" checked={stopMode === "terminals"} onChange={(event) => setStopMode(event.target.checked ? "terminals" : "all")} /><i /></label>
              <label><div><strong>站点隐藏编辑</strong><span>点击地图站点可隐藏或恢复</span></div><input type="checkbox" checked={stopEditing} onChange={(event) => setStopEditing(event.target.checked)} /><i /></label>
            </div>
            {hiddenStopIds.length > 0 && <button className="restore-stops" onClick={() => { setHiddenStopIds([]); setNotice("已恢复全部隐藏站点"); }}>恢复全部隐藏站点 <span>{hiddenStopIds.length}</span></button>}
            <div className="width-setting"><div><strong>底图淡化蒙版</strong><output>{maskOpacity === 0 ? "透明" : `${Math.round(maskOpacity * 100)}%`}</output></div><input aria-label="底图淡化蒙版不透明度" type="range" min="0" max="85" step="5" value={Math.round(maskOpacity * 100)} onChange={(event) => setMaskOpacity(Number(event.target.value) / 100)} /></div>
            <div className="width-setting"><div><strong>线路宽度</strong><output>{lineWidth} px</output></div><input type="range" min="3" max="12" value={lineWidth} onChange={(event) => setLineWidth(Number(event.target.value))} /></div>
            <div className="info-note"><b>自动并行排线</b><p>多线路以相同线宽、等间距居中排列，走向重合时仍可清晰辨认。</p></div>
          </section>}

          {panel === "export" && <section className="panel-section">
            <div className="section-heading"><div><p className="eyebrow">HIGH-RES EXPORT</p><h2>导出高清线路图</h2></div></div>
            <div className="format-options" role="group" aria-label="导出格式">
              <button className={exportFormat === "png" ? "active" : ""} onClick={() => setExportFormat("png")}><strong>PNG</strong><span>通用高清图片</span></button>
              <button className={exportFormat === "svg" ? "active" : ""} onClick={() => setExportFormat("svg")}><strong>SVG</strong><span>线路与站点可编辑</span></button>
            </div>
            <button className={`range-button ${crop ? "has-range" : ""}`} onClick={() => { setCropMode(true); setNotice("在地图上拖动框选导出范围"); }}>
              <span className="crop-icon" />
              <div><strong>{crop ? "重新选择导出范围" : "框选导出范围"}</strong><small>{crop ? `${Math.round(crop.width)} × ${Math.round(crop.height)} 画布像素` : "在地图上自由拖出矩形"}</small></div><b>→</b>
            </button>
            <div className="export-setting"><strong>清晰度倍率</strong><div className="scale-options">{[1, 2, 4].map((item) => <button className={scale === item ? "active" : ""} onClick={() => setScale(item)} key={item}>{item}×<small>{item === 1 ? "屏幕" : item === 2 ? "高清" : "印刷"}</small></button>)}</div></div>
            <div className="export-summary"><div><span>输出格式</span><strong>{exportFormat.toUpperCase()}</strong></div><div><span>底图风格</span><strong>{BASES[base].name}</strong></div><div><span>线路数量</span><strong>{readyRoutes.length}</strong></div><div><span>{exportFormat === "svg" ? "矢量结构" : "最大边长"}</span><strong>{exportFormat === "svg" ? "独立元素" : "8192 px"}</strong></div></div>
            <button className="primary export-button" disabled={exporting} onClick={() => void exportCurrent()}>{exporting ? (exportFormat === "svg" ? "正在生成可编辑 SVG…" : "正在渲染高清地图…") : `导出 ${scale}× ${exportFormat.toUpperCase()}`}</button>
            <p className="privacy-note">{exportFormat === "svg" ? "底图以影像嵌入；每条线路和每个站点均为独立矢量分组。" : "导出在本机浏览器内完成，不上传线路图。"}</p>
          </section>}

          {panel === "archive" && <section className="panel-section">
            <div className="section-heading"><div><p className="eyebrow">SAVE & RESTORE</p><h2>画布存档</h2></div><span>{manualArchives.length} 个</span></div>
            <div className="archive-auto">
              <div className="archive-auto-head"><div><strong>自动存档</strong><span>画布修改后约 1.4 秒自动保存</span></div><label className="mini-switch"><input type="checkbox" checked={autoSaveEnabled} onChange={(event) => setAutoSaveEnabled(event.target.checked)} /><i /></label></div>
              <p>{autoSaveEnabled ? autoSaveStatus : "自动存档已暂停"}</p>
              <button type="button" disabled={archiveBusy} onClick={() => void saveAutoArchive()}>立即保存当前画布</button>
            </div>

            <div className="manual-save">
              <label>新建手动存档<input value={archiveName} onChange={(event) => setArchiveName(event.target.value)} placeholder="输入存档名称（可留空）" aria-label="手动存档名称" /></label>
              <button className="primary" type="button" disabled={archiveBusy} onClick={() => void saveManualArchive()}>保存为新版本</button>
            </div>

            <div className="archive-list">
              <div className="archive-list-title"><strong>手动存档</strong><span>载入会替换当前画布</span></div>
              {manualArchives.length === 0 && <div className="archive-empty">尚无手动存档。保存重要节点后，可随时回到该版本。</div>}
              {manualArchives.map((archive) => <article className="archive-card" key={archive.id}>
                <div><strong>{archive.name}</strong><span>{new Date(archive.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span></div>
                <button type="button" disabled={archiveBusy} onClick={() => void restoreArchive(archive.id, archive.name)}>载入</button>
                <button className="danger" type="button" disabled={archiveBusy} onClick={() => void deleteArchive(archive.id, archive.name)}>删除</button>
              </article>)}
            </div>
            {autoArchive && <p className="archive-footnote">最近自动存档：{new Date(autoArchive.updatedAt).toLocaleString("zh-CN", { hour12: false })}</p>}
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