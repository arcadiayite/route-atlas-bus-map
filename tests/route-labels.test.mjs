import assert from "node:assert/strict";
import test from "node:test";
import { isLabelCoord, makeSvgRouteLabels, routeLabelPosition, routeLabelMetrics } from "../app/route-labels.ts";

const route = { id: "test", name: "K2", color: "#008e88", path: [[110, 20], [110.1, 20], [112, 20]] };

test("default label uses distance along the route, independent of vertex density", () => {
  assert.deepEqual(routeLabelPosition(route), [111, 20]);
  assert.deepEqual(routeLabelPosition({ ...route, path: [] }), null);
  assert.deepEqual(routeLabelPosition({ ...route, path: [[110, 20], [110, 20]] }), [110, 20]);
});

test("dragged geographic position survives archive JSON and takes priority over automatic placement", () => {
  const restored = JSON.parse(JSON.stringify({ ...route, labelPosition: [113.5, 22.3] }));
  assert.deepEqual(routeLabelPosition(restored), [113.5, 22.3]);
  for (const invalid of [null, [NaN, 22], [113, Infinity], [181, 20], [110, 90], [110]]) assert.equal(isLabelCoord(invalid), false);
  assert.deepEqual(routeLabelPosition({ ...route, labelPosition: [181, 20] }), [111, 20]);
});

test("SVG projects saved position in export coordinates, scales labels, and escapes user names", () => {
  const svg = makeSvgRouteLabels([{ ...route, id: 'a"b', name: '<K2 & "支线">', labelPosition: [113, 22] }], ([lng, lat]) => ({ x: lng - 100, y: lat - 10 }), 2);
  assert.match(svg, /id="route-labels"/);
  assert.match(svg, /data-route-id="a&quot;b"/);
  assert.match(svg, /&lt;K2 &amp; &quot;支线&quot;&gt;/);
  assert.doesNotMatch(svg, /<K2/);
  assert.match(svg, /<text x="13.00" y="14.00"/);
  assert.match(svg, /height="60.00"/);
  assert.match(svg, /font-size="24"/);
  assert.doesNotMatch(svg, /id="legend"/);
});

test("long route names remain bounded without splitting Unicode characters", () => {
  const metrics = routeLabelMetrics("公交🚌".repeat(12));
  assert.ok(metrics.width <= 240);
  assert.ok(metrics.text.endsWith("…"));
  assert.equal(Array.from(metrics.text).length, 18);
});
