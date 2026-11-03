export type LabelCoord = [number, number];
export type RouteAnnotationMode = "legend" | "labels";
export type RouteLabelTextMode = "code" | "digits" | "full";
export type LabelRoute = { id: string; name: string; color: string; path: LabelCoord[]; labelPosition?: LabelCoord; labelText?: string };
type Point = { x: number; y: number };
let labelMeasureContext: CanvasRenderingContext2D | null = null;

export function routeLabelText(route: Pick<LabelRoute, "name" | "labelText">, mode: RouteLabelTextMode = "code") {
  if (route.labelText?.trim()) return route.labelText.trim();
  if (mode === "full") return route.name;
  // Ignore the direction suffix, including station names that contain digits.
  const name = route.name.split(/[（(]/)[0].trim().replace(/[０-９Ａ-Ｚａ-ｚ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0));
  const code = name.match(/[A-Za-z]*\s*\d+(?:[-－]\d+)?\s*[A-Za-z]*/)?.[0].replace(/\s/g, "") ?? name;
  return mode === "digits" ? code.match(/\d+/g)?.join("-") ?? code : code;
}

export function isLabelCoord(value: unknown): value is LabelCoord {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && value[0] >= -180 && value[0] <= 180 && value[1] >= -85 && value[1] <= 85;
}

// Interpolate by distance, so dense vertices near a stop do not bias placement.
export function routeLabelPosition(route: LabelRoute, fraction = 0.5): LabelCoord | null {
  if (isLabelCoord(route.labelPosition)) return route.labelPosition;
  if (!route.path.length) return null;
  const lengths = route.path.slice(1).map((coord, index) => {
    const previous = route.path[index];
    const latitude = (coord[1] + previous[1]) * Math.PI / 360;
    return Math.hypot((coord[0] - previous[0]) * Math.cos(latitude), coord[1] - previous[1]);
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = total * Math.max(0, Math.min(1, fraction));
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index];
    if (length > 0 && remaining <= length) {
      const ratio = remaining / length;
      const start = route.path[index], end = route.path[index + 1];
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    remaining -= length;
  }
  return route.path[route.path.length - 1];
}

export function closestRouteLabelPosition(route: LabelRoute, position: LabelCoord): LabelCoord | null {
  if (!route.path.length) return null;
  const longitudeScale = Math.cos(position[1] * Math.PI / 180);
  let closest = route.path[0], closestDistance = Infinity;
  route.path.forEach((end, index) => {
    const start = route.path[Math.max(0, index - 1)];
    const dx = (end[0] - start[0]) * longitudeScale, dy = end[1] - start[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((position[0] - start[0]) * longitudeScale * dx + (position[1] - start[1]) * dy) / lengthSquared)) : 0;
    const point: LabelCoord = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
    const distance = Math.hypot((point[0] - position[0]) * longitudeScale, point[1] - position[1]);
    if (distance < closestDistance) { closest = point; closestDistance = distance; }
  });
  return closest;
}

export function routeLabelMetrics(text: string, measureText?: (text: string) => number) {
  if (!measureText && typeof document !== "undefined") {
    labelMeasureContext ??= document.createElement("canvas").getContext("2d");
    if (labelMeasureContext) {
      labelMeasureContext.font = '700 12px "Microsoft YaHei", sans-serif';
      measureText = (value) => labelMeasureContext!.measureText(value).width;
    }
  }
  const textWidth = measureText ? measureText(text) : Array.from(text).reduce((width, character) => width + (/[^\x00-\xff]/.test(character) ? 12 : 7.5), 0);
  return { text, width: Math.max(48, Math.ceil(textWidth + 24)), height: 30 };
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export function drawCanvasRouteLabels(context: CanvasRenderingContext2D, routes: LabelRoute[], project: (coord: LabelCoord) => Point, scale: number, textMode: RouteLabelTextMode = "code") {
  context.save();
  context.font = `700 ${12 * scale}px "Microsoft YaHei", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  routes.forEach((route) => {
    const coord = routeLabelPosition(route);
    if (!coord) return;
    const point = project(coord);
    const metrics = routeLabelMetrics(routeLabelText(route, textMode), (text) => context.measureText(text).width / scale);
    const width = metrics.width * scale, height = metrics.height * scale;
    context.beginPath();
    context.roundRect(point.x - width / 2, point.y - height / 2, width, height, 6 * scale);
    context.fillStyle = "#ffffff";
    context.fill();
    context.strokeStyle = route.color;
    context.lineWidth = 2 * scale;
    context.stroke();
    context.fillStyle = route.color;
    context.fillText(metrics.text, point.x, point.y + scale);
  });
  context.restore();
}

export function makeSvgRouteLabels(routes: LabelRoute[], project: (coord: LabelCoord) => Point, scale: number, textMode: RouteLabelTextMode = "code") {
  const labels = routes.map((route, index) => {
    const coord = routeLabelPosition(route);
    if (!coord) return "";
    const point = project(coord);
    const metrics = routeLabelMetrics(routeLabelText(route, textMode));
    const width = metrics.width * scale, height = metrics.height * scale;
    return `<g id="route-label-${index + 1}" data-route-id="${escapeXml(route.id)}"><title>${escapeXml(route.name)}</title><rect x="${(point.x - width / 2).toFixed(2)}" y="${(point.y - height / 2).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="${6 * scale}" fill="#ffffff" stroke="${escapeXml(route.color)}" stroke-width="${2 * scale}"/><text x="${point.x.toFixed(2)}" y="${(point.y + scale).toFixed(2)}" text-anchor="middle" dominant-baseline="central" fill="${escapeXml(route.color)}" font-family="Microsoft YaHei, sans-serif" font-size="${12 * scale}" font-weight="700">${escapeXml(metrics.text)}</text></g>`;
  }).join("");
  return `<g id="route-labels">${labels}</g>`;
}
