"use client";

import { FormEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { drawCanvasRouteLabels, isLabelCoord, makeSvgRouteLabels, routeLabelMetrics, routeLabelPosition, routeLabelText } from "./route-labels";
import type { RouteAnnotationMode, RouteLabelTextMode } from "./route-labels";
import { whenMapStyleReady } from "./map-ready";

type Coord = [number, number];
type BaseKey = "paper" | "atlas" | "dark" | "satellite";
type RouteStatus = "searching" | "ready" | "error";
type CustomNode = { id: string; kind: "stop" | "via"; value: string; coord?: Coord };
type MapPickTarget = { nodeId: string; kind: CustomNode["kind"] };
type CustomPlanFailure = { message: string; timedOut: boolean };
type DrivingPreference = "fastest" | "avoidCongestion" | "avoidHighway" | "highwayFirst" | "avoidTolls";
type StationDisplayMode = "none" | "terminals" | "all";
type LineStyleKey = "solid" | "thin" | "hollow" | "dashShort" | "dashMedium" | "dashLong" | "dashDot";

type TransitRoute = {
  id: string;
  query: string;
  name: string;
  from: string;
  to: string;
  color: string;
  dash: boolean;
  lineStyle?: LineStyleKey;
  labelPosition?: Coord;
  labelText?: string;
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
type NormalizedPoint = { x: number; y: number };
type ArchivePayload = {
  version: 1;
  savedAt: number;
  city: string;
  routes: TransitRoute[];
  base: BaseKey;
  labels: boolean;
  showStops: boolean;
  showCasing?: boolean;
  stopMode: "all" | "terminals";
  stopEditing: boolean;
  hiddenStopIds: string[];
  maskOpacity: number;
  lineWidth: number;
  drivingPreference?: DrivingPreference;
  exportLegend?: boolean;
  annotationMode?: RouteAnnotationMode;
  labelTextMode?: RouteLabelTextMode;
  legendPosition?: NormalizedPoint;
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
const LINE_STYLE_PRESETS: { value: LineStyleKey; label: string; hint: string; widthScale: number; dashArray?: number[]; lineCap: "round" | "butt" }[] = [
  { value: "solid", label: "标准实线", hint: "圆头连续线", widthScale: 1, lineCap: "round" },
  { value: "thin", label: "细实线", hint: "适合线路较多的区域", widthScale: 0.68, lineCap: "round" },
  { value: "hollow", label: "中空实线", hint: "彩色双边与白色线芯", widthScale: 1, lineCap: "round" },
  { value: "dashShort", label: "短虚线", hint: "短划、紧间隔", widthScale: 1, dashArray: [0.75, 0.8], lineCap: "butt" },
  { value: "dashMedium", label: "均衡虚线", hint: "常规虚线节奏", widthScale: 1, dashArray: [1.8, 1.35], lineCap: "butt" },
  { value: "dashLong", label: "长虚线", hint: "长划、疏间隔", widthScale: 1, dashArray: [3.4, 1.45], lineCap: "butt" },
  { value: "dashDot", label: "点划线", hint: "长划与短点交替", widthScale: 1, dashArray: [2.8, 1, 0.35, 1], lineCap: "round" },
];

function getLineStyleKey(route: Pick<TransitRoute, "lineStyle" | "dash">): LineStyleKey {
  if (route.lineStyle && LINE_STYLE_PRESETS.some((item) => item.value === route.lineStyle)) return route.lineStyle;
  return route.dash ? "dashMedium" : "solid";
}

function getLineStylePreset(route: Pick<TransitRoute, "lineStyle" | "dash">) {
  const key = getLineStyleKey(route);
  return LINE_STYLE_PRESETS.find((item) => item.value === key) ?? LINE_STYLE_PRESETS[0];
}
const DRIVING_PREFERENCES: { value: DrivingPreference; label: string; hint: string; policy: number }[] = [
  { value: "fastest", label: "速度优先", hint: "尽量缩短行驶时间", policy: 0 },
  { value: "avoidCongestion", label: "躲避拥堵", hint: "结合实时路况绕开拥堵", policy: 4 },
  { value: "avoidHighway", label: "不走高速", hint: "尽量避开高速道路", policy: 6 },
  { value: "highwayFirst", label: "高速优先", hint: "有条件时优先选择高速", policy: 19 },
  { value: "avoidTolls", label: "避免收费", hint: "优先选择少收费或免费道路", policy: 1 },
];

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
  sources.labels = { type: "raster", tiles: item.labels, tileSize: 256 };
  layers.push({ id: "place-labels", type: "raster", source: "labels", minzoom: 0, maxzoom: 22, layout: { visibility: labels ? "visible" : "none" } });
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

function wgsToGcj([lng, lat]: Coord): Coord {
  if (outOfChina(lng, lat)) return [lng, lat];
  const projected = gcjToWgs([lng, lat]);
  return [lng * 2 - projected[0], lat * 2 - projected[1]];
}

class CustomRouteTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomRouteTimeoutError";
  }
}

function withCustomRouteTimeout<T>(task: Promise<T>, timeoutMs: number, label: string) {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new CustomRouteTimeoutError(`${label}超时`)), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => window.clearTimeout(timer));
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

  // Bridge short matching gaps caused by different sampling around stops and intersections.
  routeSegments.forEach((segments) => {
    for (let index = 1; index < segments.length - 1; index += 1) {
      if (segments[index].members.size > 1) continue;
      const previous = segments[index - 1].members;
      if (previous.size <= 1) continue;
      let gapLength = 0;
      for (let end = index; end < Math.min(segments.length, index + 6); end += 1) {
        gapLength += segments[end].length;
        if (segments[end].members.size <= 1) continue;
        if (gapLength <= 180 && memberKey(previous, routeOrder) === memberKey(segments[end].members, routeOrder)) {
          for (let fill = index; fill < end; fill += 1) segments[fill].members = new Set(previous);
        }
        break;
      }
    }
  });

  // Keep each route's physical lane side continuous around bends. A world-axis sign
  // can flip at diagonal turns and temporarily swap two otherwise identical routes.
  const laneSigns = new Map<string, number[]>();
  routeSegments.forEach((segments, routeId) => {
    let previousNormal: MetricPoint | null = null;
    const signs = segments.map((segment) => {
      if (segment.length <= 0.5) return 1;
      const rawNormal = { x: -segment.dy / segment.length, y: segment.dx / segment.length };
      let sign = Math.abs(segment.dx) >= Math.abs(segment.dy)
        ? (segment.dx >= 0 ? 1 : -1)
        : (segment.dy >= 0 ? 1 : -1);
      let normal = { x: rawNormal.x * sign, y: rawNormal.y * sign };
      if (previousNormal && normal.x * previousNormal.x + normal.y * previousNormal.y < 0) {
        sign *= -1;
        normal = { x: -normal.x, y: -normal.y };
      }
      previousNormal = normal;
      return sign;
    });
    laneSigns.set(routeId, signs);
  });

  const spacing = (width + 2) * scale;
  return new Map(active.map((route) => {
    const segments = routeSegments.get(route.id) ?? [];
    const signs = laneSigns.get(route.id) ?? [];
    const offsets = segments.map((segment, segmentIndex) => {
      if (segment.members.size <= 1 || segment.length <= 0.5) return 0;
      const members = [...segment.members].sort((a, b) => (routeOrder.get(a) ?? 0) - (routeOrder.get(b) ?? 0));
      const rank = members.indexOf(route.id);
      const laneOffset = (rank - (members.length - 1) / 2) * spacing;
      return laneOffset * (signs[segmentIndex] ?? 1);
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

type LegendLayout = { x: number; y: number; width: number; height: number; padding: number; rowHeight: number; titleHeight: number };

function getLegendLayout(width: number, height: number, routeCount: number, position: NormalizedPoint, renderScale: number): LegendLayout {
  const padding = 13 * renderScale;
  const rowHeight = 19 * renderScale;
  const titleHeight = 23 * renderScale;
  const boxWidth = Math.min(width * 0.56, 180 * renderScale);
  const boxHeight = padding * 2 + titleHeight + routeCount * rowHeight;
  const margin = 8 * renderScale;
  return {
    x: Math.max(margin, Math.min(width - boxWidth - margin, position.x * width)),
    y: Math.max(margin, Math.min(height - boxHeight - margin, position.y * height)),
    width: boxWidth,
    height: boxHeight,
    padding,
    rowHeight,
    titleHeight,
  };
}

function drawCanvasLegend(context: CanvasRenderingContext2D, width: number, height: number, routes: TransitRoute[], position: NormalizedPoint, renderScale: number, showCasing: boolean) {
  if (!routes.length) return;
  const layout = getLegendLayout(width, height, routes.length, position, renderScale);
  context.save();
  context.fillStyle = "rgba(251,250,246,.95)";
  context.strokeStyle = "rgba(34,48,53,.2)";
  context.lineWidth = Math.max(1, renderScale);
  context.fillRect(layout.x, layout.y, layout.width, layout.height);
  context.strokeRect(layout.x, layout.y, layout.width, layout.height);
  context.fillStyle = "#707a7c";
  context.font = `800 ${8 * renderScale}px "Microsoft YaHei", sans-serif`;
  context.fillText(`BUS ROUTES · ${String(routes.length).padStart(2, "0")}`, layout.x + layout.padding, layout.y + layout.padding + 8 * renderScale);
  routes.forEach((route, index) => {
    const y = layout.y + layout.padding + layout.titleHeight + index * layout.rowHeight + 7 * renderScale;
    const preset = getLineStylePreset(route);
    const sampleWidth = 3 * renderScale * preset.widthScale;
    context.lineCap = preset.lineCap;
    context.setLineDash(preset.dashArray?.map((value) => value * 3 * renderScale) ?? []);
    if (showCasing) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = sampleWidth + 3 * renderScale;
      context.beginPath(); context.moveTo(layout.x + layout.padding, y); context.lineTo(layout.x + layout.padding + 22 * renderScale, y); context.stroke();
    }
    context.strokeStyle = route.color;
    context.lineWidth = sampleWidth;
    context.beginPath(); context.moveTo(layout.x + layout.padding, y); context.lineTo(layout.x + layout.padding + 22 * renderScale, y); context.stroke();
    if (getLineStyleKey(route) === "hollow") {
      context.setLineDash([]);
      context.strokeStyle = "#ffffff";
      context.lineWidth = Math.max(renderScale, sampleWidth * 0.34);
      context.beginPath(); context.moveTo(layout.x + layout.padding, y); context.lineTo(layout.x + layout.padding + 22 * renderScale, y); context.stroke();
    }
    context.setLineDash([]);
    context.fillStyle = "#17232b";
    context.font = `700 ${9 * renderScale}px "Microsoft YaHei", sans-serif`;
    const label = route.name.length > 18 ? `${route.name.slice(0, 17)}…` : route.name;
    context.fillText(label, layout.x + layout.padding + 31 * renderScale, y + 3 * renderScale);
  });
  context.restore();
}

function makeSvgLegend(width: number, height: number, routes: TransitRoute[], position: NormalizedPoint, renderScale: number, showCasing: boolean) {
  if (!routes.length) return "";
  const layout = getLegendLayout(width, height, routes.length, position, renderScale);
  const rows = routes.map((route, index) => {
    const y = layout.y + layout.padding + layout.titleHeight + index * layout.rowHeight + 7 * renderScale;
    const label = route.name.length > 18 ? `${route.name.slice(0, 17)}…` : route.name;
    const preset = getLineStylePreset(route);
    const sampleWidth = 3 * renderScale * preset.widthScale;
    const cap = preset.lineCap;
    const dash = preset.dashArray ? ` stroke-dasharray="${preset.dashArray.map((value) => (value * 3 * renderScale).toFixed(2)).join(" ")}"` : "";
    const casing = showCasing ? `<line x1="${(layout.x + layout.padding).toFixed(2)}" y1="${y.toFixed(2)}" x2="${(layout.x + layout.padding + 22 * renderScale).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#ffffff" stroke-width="${(sampleWidth + 3 * renderScale).toFixed(2)}" stroke-linecap="${cap}"/>` : "";
    const hollow = getLineStyleKey(route) === "hollow" ? `<line x1="${(layout.x + layout.padding).toFixed(2)}" y1="${y.toFixed(2)}" x2="${(layout.x + layout.padding + 22 * renderScale).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#ffffff" stroke-width="${Math.max(renderScale, sampleWidth * 0.34).toFixed(2)}" stroke-linecap="round"/>` : "";
    return `<g id="legend-route-${index + 1}" data-route-id="${escapeXml(route.id)}">${casing}<line x1="${(layout.x + layout.padding).toFixed(2)}" y1="${y.toFixed(2)}" x2="${(layout.x + layout.padding + 22 * renderScale).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${escapeXml(route.color)}" stroke-width="${sampleWidth.toFixed(2)}" stroke-linecap="${cap}"${dash}/>${hollow}<text x="${(layout.x + layout.padding + 31 * renderScale).toFixed(2)}" y="${(y + 3 * renderScale).toFixed(2)}" fill="#17232b" font-family="Microsoft YaHei, sans-serif" font-size="${(9 * renderScale).toFixed(2)}" font-weight="700">${escapeXml(label)}</text></g>`;
  }).join("");
  return `<g id="legend"><rect x="${layout.x.toFixed(2)}" y="${layout.y.toFixed(2)}" width="${layout.width.toFixed(2)}" height="${layout.height.toFixed(2)}" fill="#fbfaf6" fill-opacity=".95" stroke="#223035" stroke-opacity=".2"/><text x="${(layout.x + layout.padding).toFixed(2)}" y="${(layout.y + layout.padding + 8 * renderScale).toFixed(2)}" fill="#707a7c" font-family="Microsoft YaHei, sans-serif" font-size="${(8 * renderScale).toFixed(2)}" font-weight="800">BUS ROUTES · ${String(routes.length).padStart(2, "0")}</text>${rows}</g>`;
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

function clearCustomDraftLayers(map: MapLibreMap) {
  if (map.getLayer("custom-draft-points-layer")) map.removeLayer("custom-draft-points-layer");
  if (map.getSource("custom-draft-points")) map.removeSource("custom-draft-points");
}

function addCustomDraftLayers(map: MapLibreMap, nodes: CustomNode[]) {
  clearCustomDraftLayers(map);
  const features = nodes.flatMap((node, index) => node.coord ? [{
    type: "Feature",
    properties: { id: node.id, kind: node.kind, index: index + 1 },
    geometry: { type: "Point", coordinates: node.coord },
  }] : []);
  if (!features.length) return;
  map.addSource("custom-draft-points", { type: "geojson", data: { type: "FeatureCollection", features } as any });
  map.addLayer({
    id: "custom-draft-points-layer",
    type: "circle",
    source: "custom-draft-points",
    paint: {
      "circle-radius": ["case", ["==", ["get", "kind"], "stop"], 7, 5],
      "circle-color": ["case", ["==", ["get", "kind"], "stop"], "#f25f4b", "#008e88"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
}

function addRouteLayers(
  map: MapLibreMap,
  routes: TransitRoute[],
  width: number,
  showCasing: boolean,
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
      const lineStyle = getLineStylePreset(route);
      const renderedWidth = width * scale * lineStyle.widthScale;
      if (showCasing) {
        map.addLayer({
          id: `${sourceId}-casing`, type: "line", source: sourceId,
          layout: { "line-cap": lineStyle.lineCap, "line-join": "bevel" },
          paint: { "line-color": "#ffffff", "line-opacity": 0.92, "line-width": renderedWidth + 3 * scale, "line-offset": offset },
        });
      }
      map.addLayer({
        id: sourceId, type: "line", source: sourceId,
        layout: { "line-cap": lineStyle.lineCap, "line-join": "bevel" },
        paint: {
          "line-color": route.color,
          "line-width": renderedWidth,
          "line-opacity": 1,
          "line-offset": offset,
          ...(lineStyle.dashArray ? { "line-dasharray": lineStyle.dashArray } : {}),
        },
      });
      if (getLineStyleKey(route) === "hollow") {
        map.addLayer({
          id: `${sourceId}-hollow`, type: "line", source: sourceId,
          layout: { "line-cap": "round", "line-join": "bevel" },
          paint: { "line-color": "#ffffff", "line-opacity": 0.96, "line-width": Math.max(1, renderedWidth * 0.34), "line-offset": offset },
        });
      }
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

function AnnotationSelector({ mode, onChange, textMode, onTextModeChange }: { mode: RouteAnnotationMode; onChange: (mode: RouteAnnotationMode) => void; textMode: RouteLabelTextMode; onTextModeChange: (mode: RouteLabelTextMode) => void }) {
  return <div className="annotation-setting">
    <strong>线路识别方式</strong>
    <div className="annotation-options" role="group" aria-label="线路识别方式">
      <button type="button" aria-pressed={mode === "legend"} onClick={() => onChange("legend")}><i className="annotation-legend-icon">☰</i><span><b>图例</b><small>集中展示线路</small></span></button>
      <button type="button" aria-pressed={mode === "labels"} onClick={() => onChange("labels")}><i className="annotation-label-icon">K2</i><span><b>线路标签</b><small>在线路上标注</small></span></button>
    </div>
    {mode === "labels" && <label className="label-text-mode">标签内容<select aria-label="线路标签显示内容" value={textMode} onChange={(event) => onTextModeChange(event.target.value as RouteLabelTextMode)}>
      <option value="code">仅线路号 · K2 / 10A</option>
      <option value="digits">仅数字 · 2 / 10</option>
      <option value="full">完整名称 · 含首末站</option>
    </select></label>}
    <p>{mode === "labels" ? "拖动调整位置，双击编辑文字；自定义文字优先，清空后按上方规则显示。" : "在地图上拖动图例，可调整摆放位置。"}</p>
  </div>;
}

export default function Home() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const labelMarkers = useRef(new Map<string, maplibregl.Marker>());
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const legendDrag = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [city, setCity] = useState("珠海市");
  const [query, setQuery] = useState("");
  const [routeEntryMode, setRouteEntryMode] = useState<"existing" | "custom">("existing");
  const [customName, setCustomName] = useState("");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [customNodes, setCustomNodes] = useState<CustomNode[]>([]);
  const [drivingPreference, setDrivingPreference] = useState<DrivingPreference>("fastest");
  const [planningCustom, setPlanningCustom] = useState(false);
  const [customPlanFailure, setCustomPlanFailure] = useState<CustomPlanFailure | null>(null);
  const [mapPickTarget, setMapPickTarget] = useState<MapPickTarget | null>(null);
  const [routes, setRoutes] = useState<TransitRoute[]>([]);
  const [base, setBase] = useState<BaseKey>("paper");
  const [labels, setLabels] = useState(true);
  const [showStops, setShowStops] = useState(true);
  const [showCasing, setShowCasing] = useState(false);
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
  const [exportLegend, setExportLegend] = useState(true);
  const [annotationMode, setAnnotationMode] = useState<RouteAnnotationMode>("legend");
  const [labelTextMode, setLabelTextMode] = useState<RouteLabelTextMode>("code");
  const [legendPosition, setLegendPosition] = useState<NormalizedPoint>({ x: 0.02, y: 0.78 });
  const [notice, setNotice] = useState("输入一条或多条线路开始制图");
  const [exporting, setExporting] = useState(false);
  const [camera, setCamera] = useState<MapCamera>({ center: [113.5767, 22.2707], zoom: 11.7, bearing: 0, pitch: 0 });
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const [archiveName, setArchiveName] = useState("");
  const [archiveReady, setArchiveReady] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [autoSaveStatus, setAutoSaveStatus] = useState("正在读取存档…");
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [routeNameDraft, setRouteNameDraft] = useState("");
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const latestRoutesRef = useRef(routes);
  const latestLineWidthRef = useRef(lineWidth);
  const latestShowCasingRef = useRef(showCasing);
  const latestShowStopsRef = useRef(showStops);
  const latestStopModeRef = useRef(stopMode);
  const latestStopEditingRef = useRef(stopEditing);
  const latestHiddenStopIdsRef = useRef(hiddenStopIds);
  const latestCustomNodesRef = useRef(customNodes);
  const styleKeyRef = useRef(base);
  const fitAfterLoadRef = useRef(false);
  const pendingCameraRef = useRef<MapCamera | null>(null);

  latestRoutesRef.current = routes;
  latestLineWidthRef.current = lineWidth;
  latestShowCasingRef.current = showCasing;
  latestShowStopsRef.current = showStops;
  latestStopModeRef.current = stopMode;
  latestStopEditingRef.current = stopEditing;
  latestHiddenStopIdsRef.current = hiddenStopIds;
  latestCustomNodesRef.current = customNodes;

  const readyRoutes = useMemo(() => routes.filter((route) => route.status === "ready"), [routes]);
  const visibleReadyRoutes = useMemo(() => readyRoutes.filter((route) => route.visible), [readyRoutes]);
  const hiddenReadyRoutes = useMemo(() => readyRoutes.filter((route) => !route.visible), [readyRoutes]);
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
    showCasing,
    stopMode,
    stopEditing,
    hiddenStopIds,
    maskOpacity,
    lineWidth,
    drivingPreference,
    exportLegend,
    annotationMode,
    labelTextMode,
    legendPosition,
    camera,
  }), [city, routes, base, labels, showStops, showCasing, stopMode, stopEditing, hiddenStopIds, maskOpacity, lineWidth, drivingPreference, exportLegend, annotationMode, labelTextMode, legendPosition, camera]);

  const applyArchivePayload = useCallback((payload: ArchivePayload) => {
    if (!payload || payload.version !== 1 || !Array.isArray(payload.routes)) throw new Error("存档格式不受支持");
    setCity(payload.city || "珠海市");
    setRoutes(payload.routes.map((route) => ({ ...route, labelText: typeof route.labelText === "string" ? route.labelText.slice(0, 60) : undefined, labelPosition: isLabelCoord(route.labelPosition) ? route.labelPosition : undefined, lineStyle: getLineStyleKey(route), status: "ready" })));
    if (payload.base && BASES[payload.base]) setBase(payload.base);
    setLabels(Boolean(payload.labels));
    setShowStops(Boolean(payload.showStops));
    setShowCasing(Boolean(payload.showCasing));
    setStopMode(payload.stopMode === "terminals" ? "terminals" : "all");
    setStopEditing(Boolean(payload.stopEditing));
    setHiddenStopIds(Array.isArray(payload.hiddenStopIds) ? payload.hiddenStopIds : []);
    setMaskOpacity(Number.isFinite(payload.maskOpacity) ? payload.maskOpacity : 0);
    setLineWidth(Number.isFinite(payload.lineWidth) ? payload.lineWidth : 6);
    if (payload.drivingPreference && DRIVING_PREFERENCES.some((item) => item.value === payload.drivingPreference)) setDrivingPreference(payload.drivingPreference);
    setExportLegend(payload.exportLegend !== false);
    setAnnotationMode(payload.annotationMode === "labels" ? "labels" : "legend");
    setLabelTextMode(payload.labelTextMode === "digits" || payload.labelTextMode === "full" ? payload.labelTextMode : "code");
    if (payload.legendPosition && Number.isFinite(payload.legendPosition.x) && Number.isFinite(payload.legendPosition.y)) setLegendPosition(payload.legendPosition);
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
    maplibregl.setWorkerUrl(new URL("maplibre-gl-worker.mjs", document.baseURI).href);
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: mapStyle(base, labels, maskOpacity),
      center: camera.center,
      zoom: camera.zoom,
      bearing: camera.bearing,
      pitch: camera.pitch,
      minZoom: 3,
      maxZoom: 19,
      canvasContextAttributes: { preserveDrawingBuffer: true },
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
      addRouteLayers(map, latestRoutesRef.current, latestLineWidthRef.current, latestShowCasingRef.current, latestShowStopsRef.current, 1, latestStopModeRef.current, latestHiddenStopIdsRef.current, latestStopEditingRef.current);
      addCustomDraftLayers(map, latestCustomNodesRef.current);
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
    return () => { observer.disconnect(); map.off("moveend", syncCamera); labelMarkers.current.forEach((marker) => marker.remove()); labelMarkers.current.clear(); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleKeyRef.current === base) return;
    styleKeyRef.current = base;
    const restoreRoutes = () => {
      clearRouteLayers(map);
      addRouteLayers(map, latestRoutesRef.current, latestLineWidthRef.current, latestShowCasingRef.current, latestShowStopsRef.current, 1, latestStopModeRef.current, latestHiddenStopIdsRef.current, latestStopEditingRef.current);
      addCustomDraftLayers(map, latestCustomNodesRef.current);
      map.triggerRepaint();
    };
    map.once("style.load", restoreRoutes);
    map.setStyle(mapStyle(base, labels, maskOpacity));
    return () => { map.off("style.load", restoreRoutes); };
  }, [base]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const applyLabels = () => {
      if (map.getLayer("place-labels")) map.setLayoutProperty("place-labels", "visibility", labels ? "visible" : "none");
      map.triggerRepaint();
    };
    return whenMapStyleReady(map, applyLabels);
  }, [labels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const activeRoutes = annotationMode === "labels" ? visibleReadyRoutes : [];
    const activeIds = new Set(activeRoutes.map((route) => route.id));
    labelMarkers.current.forEach((marker, id) => {
      if (!activeIds.has(id)) { marker.remove(); labelMarkers.current.delete(id); }
    });
    activeRoutes.forEach((route) => {
      const coord = routeLabelPosition(route);
      if (!coord) return;
      const existing = labelMarkers.current.get(route.id);
      const element = (existing?.getElement() ?? document.createElement("button")) as HTMLButtonElement;
      element.type = "button";
      element.className = "route-map-label";
      const text = routeLabelText(route, labelTextMode);
      const metrics = routeLabelMetrics(text);
      element.textContent = metrics.text;
      element.style.color = route.color;
      element.style.width = `${metrics.width}px`;
      element.dataset.routeId = route.id;
      element.setAttribute("aria-label", `${text} 线路标签，可拖动或使用方向键移动，双击编辑`);
      element.title = `${route.name} · 标签：${text} · 拖动调整位置，双击编辑文字`;
      if (existing) { existing.setLngLat(coord); return; }
      const marker = new maplibregl.Marker({ element, draggable: true, anchor: "center" }).setLngLat(coord).addTo(map);
      labelMarkers.current.set(route.id, marker);
      const savePosition = () => {
        const position = marker.getLngLat().wrap();
        setRoutes((current) => current.map((item) => item.id === route.id ? { ...item, labelPosition: [position.lng, position.lat] } : item));
      };
      marker.on("dragstart", () => element.classList.add("dragging"));
      marker.on("dragend", () => {
        element.classList.remove("dragging");
        savePosition();
        setNotice(`${element.textContent} 标签位置已更新，存档与导出会保留此位置`);
      });
      element.addEventListener("click", (event) => event.stopPropagation());
      element.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setPanel("layers");
        setEditingLabelId(route.id);
      });
      element.addEventListener("keydown", (event) => {
        const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const direction = directions[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        const point = map.project(marker.getLngLat());
        const step = event.shiftKey ? 20 : 4;
        marker.setLngLat(map.unproject([point.x + direction[0] * step, point.y + direction[1] * step]));
        savePosition();
      });
    });
  }, [visibleReadyRoutes, annotationMode, labelTextMode]);

  useEffect(() => {
    if (panel !== "layers" || !editingLabelId) return;
    const input = document.getElementById(`route-label-text-${editingLabelId}`) as HTMLInputElement | null;
    input?.focus();
    input?.select();
    setEditingLabelId(null);
  }, [panel, editingLabelId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const applyMask = () => {
      if (map.getLayer("map-mask")) map.setPaintProperty("map-mask", "fill-opacity", maskOpacity);
    };
    return whenMapStyleReady(map, applyMask);
  }, [maskOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const renderRoutes = () => {
      clearRouteLayers(map);
      addRouteLayers(map, routes, lineWidth, showCasing, showStops, 1, stopMode, hiddenStopIds, stopEditing);
      map.triggerRepaint();
    };
    return whenMapStyleReady(map, renderRoutes);
  }, [routes, lineWidth, showCasing, showStops, stopMode, hiddenStopIds, stopEditing]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const renderDraftPoints = () => {
      addCustomDraftLayers(map, customNodes);
      map.triggerRepaint();
    };
    return whenMapStyleReady(map, renderDraftPoints);
  }, [customNodes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapPickTarget) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    const handleMapPick = (event: any) => {
      const coord: Coord = [Number(event.lngLat.lng.toFixed(7)), Number(event.lngLat.lat.toFixed(7))];
      let label = mapPickTarget.kind === "stop" ? "中途停站" : "途经点";
      setCustomNodes((current) => current.map((node, index) => {
        if (node.id !== mapPickTarget.nodeId) return node;
        label = node.kind === "stop" ? "中途停站" : "途经点";
        return { ...node, value: node.value.trim() || `地图${label} ${String(index + 1).padStart(2, "0")}`, coord };
      }));
      setMapPickTarget(null);
      setNotice(`${label}已从地图选定；可填写名称，坐标会继续保留`);
    };
    map.once("click", handleMapPick);
    return () => {
      map.off("click", handleMapPick);
      canvas.style.cursor = "";
    };
  }, [mapPickTarget]);
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
    const pending: TransitRoute = { id, query: term, name: term, from: "", to: "", color: PALETTE[(routes.length + index) % PALETTE.length], dash: false, lineStyle: "solid", visible: true, path: [], stops: [], status: "searching" };
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

  function beginCustomNodeMapPick(node: CustomNode) {
    setCropMode(false);
    setStopEditing(false);
    setMapPickTarget({ nodeId: node.id, kind: node.kind });
    setNotice(`请在地图上点击${node.kind === "stop" ? "中途停站" : "途经点"}的位置`);
  }

  function clearCustomNodeMapPoint(node: CustomNode) {
    updateCustomNode(node.id, { coord: undefined });
    if (mapPickTarget?.nodeId === node.id) setMapPickTarget(null);
    setNotice("已改回文字定位；规划时会按输入的名称搜索");
  }

  function removeCustomNode(id: string) {
    setCustomNodes((current) => current.filter((item) => item.id !== id));
    if (mapPickTarget?.nodeId === id) setMapPickTarget(null);
  }

  async function submitCustomRoute(event: FormEvent) {
    event.preventDefault();
    const start = customStart.trim();
    const end = customEnd.trim();
    const nodes = customNodes.map((node, index) => ({
      ...node,
      value: node.value.trim() || (node.coord ? `地图${node.kind === "stop" ? "中途停站" : "途经点"} ${String(index + 1).padStart(2, "0")}` : ""),
    }));
    if (!start || !end || nodes.some((node) => !node.value)) {
      setNotice("请填写首站、末站以及每一个中途节点");
      return;
    }

    const drivingOption = DRIVING_PREFERENCES.find((item) => item.value === drivingPreference) ?? DRIVING_PREFERENCES[0];
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
      lineStyle: "solid",
      visible: true,
      path: [],
      stops: [],
      status: "searching",
      custom: true,
    };
    setPlanningCustom(true);
    setCustomPlanFailure(null);
    setMapPickTarget(null);
    setRoutes((current) => [...current, pending]);
    setNotice(`正在为 ${routeName} 按“${drivingOption.label}”规划路径…`);

    try {
      const AMap = await withCustomRouteTimeout(loadAmap(), 15000, "高德服务加载");
      const geocoder = new AMap.Geocoder({ city, extensions: "base" });
      const ordered: { kind: CustomNode["kind"]; value: string; coord?: Coord }[] = [
        { kind: "stop", value: start },
        ...nodes,
        { kind: "stop", value: end },
      ];
      const geocoded: { kind: CustomNode["kind"]; name: string; gcj: Coord; coord: Coord }[] = [];

      for (const node of ordered) {
        if (node.coord) {
          geocoded.push({ kind: node.kind, name: node.value, gcj: wgsToGcj(node.coord), coord: node.coord });
          continue;
        }
        const result: any = await withCustomRouteTimeout(new Promise((resolve, reject) => {
          geocoder.getLocation(node.value, (status: string, data: any) => status === "complete" && data?.info === "OK"
            ? resolve(data)
            : reject(new Error(`无法定位“${node.value}”`)));
        }), 15000, `定位“${node.value}”`);
        const gcj = readGcjLngLat(result?.geocodes?.[0]?.location);
        if (!gcj) throw new Error(`“${node.value}”没有返回有效坐标`);
        geocoded.push({ kind: node.kind, name: node.value, gcj, coord: gcjToWgs(gcj) });
      }

      const path: Coord[] = [];
      for (let index = 0; index < geocoded.length - 1; index += 1) {
        const origin = geocoded[index];
        const destination = geocoded[index + 1];
        const result: any = await withCustomRouteTimeout(new Promise((resolve, reject) => {
          const driving = new AMap.Driving({ city, policy: drivingOption.policy, extensions: "all" });
          driving.search(
            new AMap.LngLat(origin.gcj[0], origin.gcj[1]),
            new AMap.LngLat(destination.gcj[0], destination.gcj[1]),
            (status: string, data: any) => status === "complete"
              ? resolve(data)
              : reject(new Error(`${origin.name} → ${destination.name} 规划失败：${data?.info || status}`)),
          );
        }), 30000, `${origin.name} → ${destination.name} 路径规划`);
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
      setCustomPlanFailure(null);
      setNotice(`${routeName} 已按“${drivingOption.label}”加入画布`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "自定义线路规划失败";
      const timedOut = error instanceof CustomRouteTimeoutError;
      if (timedOut && message.startsWith("高德服务加载")) amapPromise = null;
      setRoutes((current) => current.filter((route) => route.id !== id));
      setCustomPlanFailure({ message, timedOut });
      setNotice(`${timedOut ? "规划请求超时" : "自定义线路生成失败"}：输入内容已全部保留，可直接重新生成`);
    } finally {
      setPlanningCustom(false);
    }
  }
  function updateRoute(id: string, patch: Partial<TransitRoute>) {
    setRoutes((current) => current.map((route) => route.id === id ? { ...route, ...patch } : route));
  }

  function setRouteLineStyle(id: string, lineStyle: LineStyleKey) {
    updateRoute(id, { lineStyle, dash: lineStyle.startsWith("dash") });
    const preset = LINE_STYLE_PRESETS.find((item) => item.value === lineStyle);
    setNotice(`线路线型已切换为${preset?.label ?? "所选样式"}`);
  }

  function toggleRouteVisibility(route: TransitRoute) {
    const visible = !route.visible;
    updateRoute(route.id, { visible });
    setNotice(`${route.name} 已${visible ? "恢复显示" : "隐藏"}${visible && showStops ? "，站点同步恢复" : ""}`);
  }

  function showAllRoutes() {
    setRoutes((current) => current.map((route) => route.status === "ready" ? { ...route, visible: true } : route));
    setNotice("已恢复显示全部线路及其站点");
  }

  function changeStationDisplay(mode: StationDisplayMode) {
    if (mode === "none") {
      setShowStops(false);
      setNotice("公交站点已关闭");
      return;
    }
    setShowStops(true);
    setStopMode(mode);
    setNotice(mode === "all" ? "已显示首末站和全部中途站" : "当前仅显示每条线路的首末站");
  }

  function beginRenameRoute(route: TransitRoute) {
    setEditingRouteId(route.id);
    setRouteNameDraft(route.name);
  }

  function saveRouteName(id: string) {
    const name = routeNameDraft.trim();
    if (!name) {
      setNotice("线路名称不能为空");
      return;
    }
    updateRoute(id, { name, query: name });
    setEditingRouteId(null);
    setRouteNameDraft("");
    setNotice(`线路已改名为 ${name}`);
  }

  function removeRoute(id: string) {
    setRoutes((current) => current.filter((route) => route.id !== id));
    if (editingRouteId === id) {
      setEditingRouteId(null);
      setRouteNameDraft("");
    }
    setNotice("线路已移除");
  }

  function changeAnnotationMode(mode: RouteAnnotationMode) {
    setAnnotationMode(mode);
    if (mode === "labels") {
      setRoutes((current) => current.map((route, index) => ({ ...route, labelPosition: route.labelPosition ?? routeLabelPosition(route, 0.35 + (index % 4) * 0.1) ?? undefined })));
    }
    setNotice(mode === "labels" ? "已切换线路标签，可在地图上拖动每条线路的名称" : "已切换集中图例");
  }

  function resetRouteLabel(id: string) {
    setRoutes((current) => current.map((route, index) => route.id === id ? { ...route, labelPosition: routeLabelPosition({ ...route, labelPosition: undefined }, 0.35 + (index % 4) * 0.1) ?? undefined } : route));
    setNotice("标签已移回线路上");
  }

  function startLegendDrag(event: PointerEvent<HTMLDivElement>) {
    const legendRect = event.currentTarget.getBoundingClientRect();
    legendDrag.current = { offsetX: event.clientX - legendRect.left, offsetY: event.clientY - legendRect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("dragging");
    event.stopPropagation();
  }

  function moveLegendDrag(event: PointerEvent<HTMLDivElement>) {
    if (!legendDrag.current) return;
    const stage = event.currentTarget.parentElement;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const legendRect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(stageRect.width - legendRect.width, event.clientX - stageRect.left - legendDrag.current.offsetX));
    const y = Math.max(0, Math.min(stageRect.height - legendRect.height, event.clientY - stageRect.top - legendDrag.current.offsetY));
    setLegendPosition({ x: x / Math.max(1, stageRect.width), y: y / Math.max(1, stageRect.height) });
    event.stopPropagation();
  }

  function endLegendDrag(event: PointerEvent<HTMLDivElement>) {
    legendDrag.current = null;
    event.currentTarget.classList.remove("dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setNotice("图例位置已更新，导出时会保持相同位置");
    event.stopPropagation();
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
      exportMap = new maplibregl.Map({ container: node, style: mapStyle(base, labels, maskOpacity), bounds: [[nw.lng, se.lat], [se.lng, nw.lat]], fitBoundsOptions: { padding: 0 }, interactive: false, attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true }, fadeDuration: 0 });
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("底图加载超时")), 18000);
        exportMap!.once("load", () => {
          addRouteLayers(exportMap!, routes, lineWidth, showCasing, showStops, width / area.width, stopMode, hiddenStopIds, false);
          exportMap!.once("idle", () => { window.clearTimeout(timer); resolve(); });
        });
      });
      const sourceCanvas = exportMap!.getCanvas();
      let outputCanvas = sourceCanvas;
      if (exportLegend && visibleReadyRoutes.length) {
        outputCanvas = document.createElement("canvas");
        outputCanvas.width = width;
        outputCanvas.height = height;
        const context = outputCanvas.getContext("2d");
        if (!context) throw new Error("浏览器未能创建导出画布");
        context.drawImage(sourceCanvas, 0, 0, width, height);
        if (annotationMode === "labels") drawCanvasRouteLabels(context, visibleReadyRoutes, (coord) => exportMap!.project(coord), width / area.width, labelTextMode);
        else drawCanvasLegend(context, width, height, visibleReadyRoutes, legendPosition, width / area.width, showCasing);
      }
      const blob = await new Promise<Blob | null>((resolve) => outputCanvas.toBlob(resolve, "image/png"));
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
        canvasContextAttributes: { preserveDrawingBuffer: true },
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
        const combinedPath = features.map((feature) => {
          const points = (feature.geometry.coordinates as Coord[]).map((coord) => exportMap!.project(coord));
          return offsetSvgPath(points, Number(feature.properties.offset) || 0);
        }).filter(Boolean).join(" ");
        if (!combinedPath) return "";
        const preset = getLineStylePreset(route);
        const styleKey = getLineStyleKey(route);
        const renderedWidth = lineWidth * renderScale * preset.widthScale;
        const dash = preset.dashArray ? ` stroke-dasharray="${preset.dashArray.map((value) => (value * lineWidth * renderScale).toFixed(2)).join(" ")}"` : "";
        const stroke = styleKey === "hollow" ? "#ffffff" : route.color;
        const strokeWidth = styleKey === "hollow" ? Math.max(renderScale, renderedWidth * 0.34) : renderedWidth;
        const filter = styleKey === "hollow" ? ` filter="url(#route-hollow-${routeIndex + 1})"` : showCasing ? ` filter="url(#route-casing)"` : "";
        return `<g id="route-${routeIndex + 1}" data-route-id="${escapeXml(route.id)}" data-route-name="${escapeXml(route.name)}"><title>${escapeXml(route.name)}</title><path id="route-${routeIndex + 1}-path" d="${combinedPath}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linecap="${preset.lineCap}" stroke-linejoin="bevel"${dash}${filter}/></g>`;
      }).join("");

      const stationMarkup = showStops ? collectExportStops(routes, stopMode, hiddenStopIds).map((stop, index) => {
        const point = exportMap!.project(stop.coord);
        const radius = ((stop.terminal ? 4.5 : 3.5) + Math.min(3, stop.colors.size - 1) * 2) * renderScale;
        const stroke = stop.colors.size > 1 ? "#18252d" : [...stop.colors][0];
        return `<g id="station-${index + 1}" data-station-id="${escapeXml(stop.id)}" data-station-name="${escapeXml(stop.name)}"><title>${escapeXml(stop.name)}</title><circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="#ffffff" stroke="${escapeXml(stroke)}" stroke-width="${(2 * renderScale).toFixed(2)}"/></g>`;
      }).join("") : "";
      const legendMarkup = !exportLegend ? "" : annotationMode === "labels"
        ? makeSvgRouteLabels(activeRoutes, (coord) => exportMap!.project(coord), renderScale, labelTextMode)
        : makeSvgLegend(width, height, activeRoutes, legendPosition, renderScale, showCasing);
      const casingFilter = showCasing ? `<filter id="route-casing" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feMorphology in="SourceAlpha" operator="dilate" radius="${(1.5 * renderScale).toFixed(2)}" result="expanded"/><feFlood flood-color="#ffffff" flood-opacity=".92" result="white"/><feComposite in="white" in2="expanded" operator="in" result="casing"/><feMerge><feMergeNode in="casing"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : "";
      const hollowFilters = activeRoutes.map((route, routeIndex) => {
        if (getLineStyleKey(route) !== "hollow") return "";
        const renderedWidth = lineWidth * renderScale * getLineStylePreset(route).widthScale;
        const innerWidth = Math.max(renderScale, renderedWidth * 0.34);
        const edgeRadius = Math.max(renderScale, (renderedWidth - innerWidth) / 2);
        const casing = showCasing ? `<feMorphology in="SourceAlpha" operator="dilate" radius="${(edgeRadius + 1.5 * renderScale).toFixed(2)}" result="casingAlpha"/><feFlood flood-color="#ffffff" flood-opacity=".92" result="casingColor"/><feComposite in="casingColor" in2="casingAlpha" operator="in" result="casing"/>` : "";
        const casingNode = showCasing ? `<feMergeNode in="casing"/>` : "";
        return `<filter id="route-hollow-${routeIndex + 1}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">${casing}<feMorphology in="SourceAlpha" operator="dilate" radius="${edgeRadius.toFixed(2)}" result="edgeAlpha"/><feFlood flood-color="${escapeXml(route.color)}" result="edgeColor"/><feComposite in="edgeColor" in2="edgeAlpha" operator="in" result="edge"/><feMerge>${casingNode}<feMergeNode in="edge"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
      }).join("");
      const routeFilters = casingFilter || hollowFilters ? `<defs>${casingFilter}${hollowFilters}</defs>` : "";

      const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(city)}公交线路图"><title>${escapeXml(city)}公交线路图</title><metadata>由路绘导出；每条线路均为单一路径元素，站点、图例和线路标签为独立矢量分组。</metadata>${routeFilters}<g id="basemap"><image href="${background}" x="0" y="0" width="${width}" height="${height}"/></g><g id="routes">${routeMarkup}</g><g id="stations">${stationMarkup}</g>${legendMarkup}</svg>`;
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
                <label className="full">路径规划偏好<select value={drivingPreference} onChange={(event) => setDrivingPreference(event.target.value as DrivingPreference)} aria-label="自定义线路路径规划偏好">{DRIVING_PREFERENCES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><small>{DRIVING_PREFERENCES.find((item) => item.value === drivingPreference)?.hint}</small></label>
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
                  <input value={node.value} onChange={(event) => updateCustomNode(node.id, { value: event.target.value })} placeholder={node.kind === "stop" ? "输入站名，或在地图选点" : "输入地点，或在地图选点"} aria-label={`第 ${index + 1} 个节点名称`} />
                  <button type="button" className={`node-map-pick ${node.coord ? "selected" : ""}`} onClick={() => beginCustomNodeMapPick(node)} aria-label={`在地图上选择第 ${index + 1} 个节点`} title={node.coord ? "重新选择地图位置" : "在地图上选点"}>{mapPickTarget?.nodeId === node.id ? "点击地图" : node.coord ? "重选" : "选点"}</button>
                  <button type="button" className="node-remove" onClick={() => removeCustomNode(node.id)} aria-label={`删除第 ${index + 1} 个节点`}>×</button>
                  {node.coord && <span className="picked-coordinate">已选地图位置 · {node.coord[0].toFixed(5)}, {node.coord[1].toFixed(5)} <button type="button" onClick={() => clearCustomNodeMapPoint(node)}>改用文字定位</button></span>}
                </div>)}
              </div>}

              <div className="custom-node-actions">
                <button type="button" onClick={() => addCustomNode("stop")}><span>＋</span> 中途停站</button>
                <button type="button" onClick={() => addCustomNode("via")}><span>＋</span> 途经点</button>
              </div>
              <p className="builder-note">节点按列表顺序经过；中途停站显示站标，途经点只控制走向。地图选点会直接使用所选坐标。</p>
              {customPlanFailure && <div className={`custom-retry ${customPlanFailure.timedOut ? "timeout" : ""}`} role="alert">
                <div><strong>{customPlanFailure.timedOut ? "高德规划响应超时" : "本次生成未完成"}</strong><p>{customPlanFailure.message}。首末站、中途节点和规划偏好均已保留。</p></div>
                <button type="submit" disabled={planningCustom}>使用保留内容重新生成</button>
              </div>}
              <button className="primary" type="submit" disabled={planningCustom || !customStart.trim() || !customEnd.trim()}><span>⌁</span>{planningCustom ? "正在规划高德导航…" : customPlanFailure ? "重新生成自定义线路" : "规划并加入画布"}</button>
            </form>}

            <div className="route-stack">
              {hiddenReadyRoutes.length > 0 && <div className="hidden-routes-banner">
                <div><strong>{hiddenReadyRoutes.length} 条线路已隐藏</strong><span>线路仍保留在项目中，可随时恢复。</span></div>
                <button type="button" onClick={showAllRoutes}>全部显示</button>
                <div className="hidden-route-chips" aria-label="恢复单条隐藏线路">
                  {hiddenReadyRoutes.map((route) => <button type="button" key={route.id} onClick={() => toggleRouteVisibility(route)}><i style={{ background: route.color }} />显示 {route.name}</button>)}
                </div>
              </div>}
              {routes.length === 0 && <div className="empty-card"><div className="mini-map"><i /><i /><i /></div><h3>画布还是空的</h3><p>输入本地公交线路名称，高德将返回走向与站点。</p></div>}
              {routes.map((route, index) => <article className={`route-card ${route.status} ${route.visible ? "" : "is-hidden"}`} key={route.id}>
                <div className="route-card-top">
                  <button type="button" className={`eye ${route.visible ? "on" : ""}`} onClick={() => toggleRouteVisibility(route)} aria-label={route.visible ? `隐藏 ${route.name} 及其站点` : `显示 ${route.name} 及其站点`} title={route.visible ? "隐藏线路及其站点" : "显示线路及其站点"}>{route.visible ? "●" : "○"}</button>
                  <div className="route-index">{String(index + 1).padStart(2, "0")}</div>
                  <div className="route-title">
                    {editingRouteId === route.id ? <form className="route-rename" onSubmit={(event) => { event.preventDefault(); saveRouteName(route.id); }}>
                      <input value={routeNameDraft} onChange={(event) => setRouteNameDraft(event.target.value)} aria-label={`${route.name} 的新名称`} autoFocus />
                      <button type="submit" aria-label="保存新名称">✓</button>
                      <button type="button" onClick={() => { setEditingRouteId(null); setRouteNameDraft(""); }} aria-label="取消改名">×</button>
                    </form> : <strong><b>{route.name}</b>{route.custom && <em>自定义</em>}<button type="button" className="rename-route" onClick={() => beginRenameRoute(route)} aria-label={`修改 ${route.name} 的名称`}>改名</button></strong>}
                    <span>{route.status === "searching" ? (route.custom ? "正在规划高德导航…" : "正在查询高德…") : route.status === "error" ? route.error : `${route.from} → ${route.to}`}</span>
                  </div>
                  <button className="remove" onClick={() => removeRoute(route.id)} aria-label={`删除 ${route.name}`}>×</button>
                </div>
                {route.status === "ready" && <div className="route-tools">
                  <button type="button" className={`visibility-control ${route.visible ? "selected" : ""}`} onClick={() => toggleRouteVisibility(route)}>{route.visible ? "隐藏线路" : "显示线路"}</button>
                  <label className="color-control"><input type="color" value={route.color} onChange={(event) => updateRoute(route.id, { color: event.target.value })} /><span style={{ background: route.color }} />颜色</label>
                  <button type="button" onClick={() => setPanel("layers")} title="前往底图菜单选择线型"><i className={`line-style-preview ${getLineStyleKey(route)}`} style={{ color: route.color }} />{getLineStylePreset(route).label}</button>
                  <span>{route.stops.length} 站</span>
                </div>}
              </article>)}
            </div>
          </section>}

          {panel === "layers" && <section className="panel-section">
            <div className="section-heading"><div><p className="eyebrow">MAP STYLE</p><h2>选择地图风格</h2></div></div>
            <AnnotationSelector mode={annotationMode} onChange={changeAnnotationMode} textMode={labelTextMode} onTextModeChange={setLabelTextMode} />
            {readyRoutes.length > 0 && <div className="route-layer-manager">
              <div className="layer-manager-heading"><div><strong>线路图层</strong><span>{visibleReadyRoutes.length}/{readyRoutes.length} 条显示中</span></div>{hiddenReadyRoutes.length > 0 && <button type="button" onClick={showAllRoutes}>全部显示</button>}</div>
              <div className="route-layer-list">
                {readyRoutes.map((route) => <div className={`route-layer-item ${route.visible ? "visible" : "is-hidden"}`} key={route.id}>
                  <button type="button" className="route-layer-toggle" onClick={() => toggleRouteVisibility(route)} aria-pressed={route.visible}>
                    <i style={{ background: route.color }} />
                    <span><strong>{route.name}</strong><small>{route.visible ? `已显示 · ${route.stops.length} 站` : "已隐藏 · 点击恢复"}</small></span>
                    <b>{route.visible ? "显示中" : "已隐藏"}</b>
                  </button>
                  <label className="line-style-select">
                    <i className={`line-style-preview ${getLineStyleKey(route)}`} style={{ color: route.color }} />
                    <span>线型</span>
                    <select value={getLineStyleKey(route)} onChange={(event) => setRouteLineStyle(route.id, event.target.value as LineStyleKey)} aria-label={`${route.name} 的线路样式`}>
                      {LINE_STYLE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label} · {preset.hint}</option>)}
                    </select>
                  </label>
                  {annotationMode === "labels" && <div className="route-label-editor">
                    <label htmlFor={`route-label-text-${route.id}`}>标签文字</label>
                    <div><input id={`route-label-text-${route.id}`} aria-label={`${route.name} 的标签文字`} value={route.labelText ?? ""} placeholder={routeLabelText({ ...route, labelText: undefined }, labelTextMode)} maxLength={60} onChange={(event) => updateRoute(route.id, { labelText: event.target.value })} />
                    <button type="button" disabled={!route.labelText} onClick={() => updateRoute(route.id, { labelText: undefined })} aria-label={`恢复 ${route.name} 的自动标签`}>恢复自动</button></div>
                    <button type="button" className="reset-route-label" onClick={() => resetRouteLabel(route.id)} aria-label={`重置 ${route.name} 的标签位置`}>标签移回线路</button>
                  </div>}
                </div>)}
              </div>
            </div>}
            <div className="base-grid">
              {(Object.keys(BASES) as BaseKey[]).map((key) => <button key={key} className={`base-card ${key} ${base === key ? "active" : ""}`} onClick={() => setBase(key)}>
                <span className="base-preview"><i /><i /><i /></span><strong>{BASES[key].name}</strong><small>{BASES[key].hint}</small><b>{base === key ? "✓" : ""}</b>
              </button>)}
            </div>
            <div className="settings-list">
              <label><div><strong>地名与道路标注</strong><span>可独立于底图显示</span></div><input type="checkbox" checked={labels} onChange={(event) => setLabels(event.target.checked)} /><i /></label>
              <label><div><strong>线路白色描边</strong><span>增强复杂底图上的线路对比，默认关闭</span></div><input type="checkbox" checked={showCasing} onChange={(event) => setShowCasing(event.target.checked)} /><i /></label>
              <label><div><strong>全部公交站点</strong><span>开启时显示首末站和全部中途站</span></div><input type="checkbox" checked={showStops} onChange={(event) => changeStationDisplay(event.target.checked ? "all" : "none")} /><i /></label>
              <label><div><strong>只看首末站</strong><span>开启后收起中途站；关闭恢复全部站点</span></div><input type="checkbox" checked={showStops && stopMode === "terminals"} onChange={(event) => changeStationDisplay(event.target.checked ? "terminals" : "all")} /><i /></label>
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
            <AnnotationSelector mode={annotationMode} onChange={changeAnnotationMode} textMode={labelTextMode} onTextModeChange={setLabelTextMode} />
            <label className="export-legend-option"><div><strong>一同导出{annotationMode === "labels" ? "线路标签" : "图例"}</strong><span>{annotationMode === "labels" ? "保留标签在地图上的位置" : "图例可直接在地图上拖动定位"}</span></div><input type="checkbox" checked={exportLegend} onChange={(event) => setExportLegend(event.target.checked)} /><i /></label>
            <button className={`range-button ${crop ? "has-range" : ""}`} onClick={() => { setCropMode(true); setNotice("在地图上拖动框选导出范围"); }}>
              <span className="crop-icon" />
              <div><strong>{crop ? "重新选择导出范围" : "框选导出范围"}</strong><small>{crop ? `${Math.round(crop.width)} × ${Math.round(crop.height)} 画布像素` : "在地图上自由拖出矩形"}</small></div><b>→</b>
            </button>
            <div className="export-setting"><strong>清晰度倍率</strong><div className="scale-options">{[1, 2, 4].map((item) => <button className={scale === item ? "active" : ""} onClick={() => setScale(item)} key={item}>{item}×<small>{item === 1 ? "屏幕" : item === 2 ? "高清" : "印刷"}</small></button>)}</div></div>
            <div className="export-summary"><div><span>输出格式</span><strong>{exportFormat.toUpperCase()}</strong></div><div><span>底图风格</span><strong>{BASES[base].name}</strong></div><div><span>线路数量</span><strong>{readyRoutes.length}</strong></div><div><span>{exportFormat === "svg" ? "矢量结构" : "最大边长"}</span><strong>{exportFormat === "svg" ? "独立元素" : "8192 px"}</strong></div></div>
            <button className="primary export-button" disabled={exporting} onClick={() => void exportCurrent()}>{exporting ? (exportFormat === "svg" ? "正在生成可编辑 SVG…" : "正在渲染高清地图…") : `导出 ${scale}× ${exportFormat.toUpperCase()}`}</button>
            <p className="privacy-note">{exportFormat === "svg" ? "底图以影像嵌入；线路、站点及所选图例或标签均可独立编辑。" : "导出在本机浏览器内完成，不上传线路图。"}</p>
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
        {mapPickTarget && <div className="map-pick-banner" role="status">
          <div><strong>在地图上选择{mapPickTarget.kind === "stop" ? "中途停站" : "途经点"}</strong><span>单击目标位置；选中后仍可修改显示名称</span></div>
          <button type="button" onClick={() => { setMapPickTarget(null); setNotice("已取消地图选点"); }}>取消</button>
        </div>}
        {annotationMode === "legend" && visibleReadyRoutes.length > 0 && <div className="legend" style={{ left: `${legendPosition.x * 100}%`, top: `${legendPosition.y * 100}%` }} onPointerDown={startLegendDrag} onPointerMove={moveLegendDrag} onPointerUp={endLegendDrag} onPointerCancel={endLegendDrag} role="group" aria-label="可拖动线路图例">
          <p>BUS ROUTES · {String(visibleReadyRoutes.length).padStart(2, "0")}<b>拖动</b></p>
          {visibleReadyRoutes.map((route) => <div key={route.id}><i className={`line-style-preview ${getLineStyleKey(route)}`} style={{ color: route.color }} /><span>{route.name}</span></div>)}
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
