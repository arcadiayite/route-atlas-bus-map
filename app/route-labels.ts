export type LabelCoord = [number, number];
export type RouteAnnotationMode = "legend" | "labels";
export type LabelRoute = { id: string; name: string; color: string; path: LabelCoord[]; labelPosition?: LabelCoord };
type Point = { x: number; y: number };

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

export function routeLabelMetrics(name: string) {
  const characters = Array.from(name);
  const text = characters.length > 18 ? `${characters.slice(0, 17).join("")}…` : name;
  const textWidth = Array.from(text).reduce((width, character) => width + (/[^\x00-\xff]/.test(character) ? 12 : 7.5), 0);
  return { text, width: Math.max(48, Math.min(240, Math.ceil(textWidth + 24))), height: 30 };
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export function drawCanvasRouteLabels(context: CanvasRenderingContext2D, routes: LabelRoute[], project: (coord: LabelCoord) => Point, scale: number) {
  context.save();
  context.font = `700 ${12 * scale}px "Microsoft YaHei", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  routes.forEach((route) => {
    const coord = routeLabelPosition(route);
    if (!coord) return;
    const point = project(coord);
    const metrics = routeLabelMetrics(route.name);
    const width = metrics.width * scale, height = metrics.height * scale;
    context.beginPath();
    context.roundRect(point.x - width / 2, point.y - height / 2, width, height, 6 * scale);
    context.fillStyle = "#ffffff";
    context.fill();
    context.strokeStyle = route.color;
    context.lineWidth = 2 * scale;
    context.stroke();
    context.fillStyle = route.color;
    context.fillText(metrics.text, point.x, point.y + scale, width - 20 * scale);
  });
  context.restore();
}

export function makeSvgRouteLabels(routes: LabelRoute[], project: (coord: LabelCoord) => Point, scale: number) {
  const labels = routes.map((route, index) => {
    const coord = routeLabelPosition(route);
    if (!coord) return "";
    const point = project(coord);
    const metrics = routeLabelMetrics(route.name);
    const width = metrics.width * scale, height = metrics.height * scale;
    return `<g id="route-label-${index + 1}" data-route-id="${escapeXml(route.id)}"><title>${escapeXml(route.name)}</title><rect x="${(point.x - width / 2).toFixed(2)}" y="${(point.y - height / 2).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="${6 * scale}" fill="#ffffff" stroke="${escapeXml(route.color)}" stroke-width="${2 * scale}"/><text x="${point.x.toFixed(2)}" y="${(point.y + scale).toFixed(2)}" text-anchor="middle" dominant-baseline="central" fill="${escapeXml(route.color)}" font-family="Microsoft YaHei, sans-serif" font-size="${12 * scale}" font-weight="700">${escapeXml(metrics.text)}</text></g>`;
  }).join("");
  return `<g id="route-labels">${labels}</g>`;
}
