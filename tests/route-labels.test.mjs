import assert from "node:assert/strict";
import test from "node:test";
import { closestRouteLabelPosition, drawCanvasRouteLabels, isLabelCoord, makeSvgRouteLabels, routeLabelPosition, routeLabelMetrics, routeLabelText } from "../app/route-labels.ts";
import { whenMapStyleReady } from "../app/map-ready.ts";
import { EventEmitter } from "node:events";

const route = { id: "test", name: "K2", color: "#008e88", path: [[110, 20], [110.1, 20], [112, 20]] };

test("route updates do not wait for remote basemap tiles after the style is ready", () => {
  const map = Object.assign(new EventEmitter(), { getStyle: () => ({ version: 8, sources: {}, layers: [] }), isStyleLoaded: () => false });
  let updates = 0;
  whenMapStyleReady(map, () => updates++);
  assert.equal(updates, 1);
  map.emit("idle");
  map.emit("style.load");
  assert.equal(updates, 1);
});

test("superseded route updates are cancelled while waiting for map readiness", () => {
  const map = Object.assign(new EventEmitter(), { getStyle: () => undefined });
  let updates = 0;
  const cancel = whenMapStyleReady(map, () => updates++);
  cancel();
  map.emit("idle");
  assert.equal(updates, 0);
});

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
  const svg = makeSvgRouteLabels([{ ...route, id: 'a"b', name: '<K2 & "支线">', labelPosition: [113, 22] }], ([lng, lat]) => ({ x: lng - 100, y: lat - 10 }), 2, "full");
  assert.match(svg, /id="route-labels"/);
  assert.match(svg, /data-route-id="a&quot;b"/);
  assert.match(svg, /&lt;K2 &amp; &quot;支线&quot;&gt;/);
  assert.doesNotMatch(svg, /<K2/);
  assert.match(svg, /<text x="13.00" y="14.00"/);
  assert.match(svg, /height="60.00"/);
  assert.match(svg, /font-size="24"/);
  assert.doesNotMatch(svg, /id="legend"/);
});

test("long labels keep all text and expand to measured font width", () => {
  const text = "公交🚌".repeat(12);
  const metrics = routeLabelMetrics(text, () => 520.4);
  assert.equal(metrics.text, text);
  assert.equal(metrics.width, 545);
  assert.ok(routeLabelMetrics(text).width > 240);
});

test("moving a label back snaps to the nearest route segment rather than a distant default", () => {
  const line = { ...route, path: [[110, 20], [112, 20], [112, 22]] };
  assert.deepEqual(closestRouteLabelPosition(line, [110.5, 20.2]), [110.5, 20]);
  assert.deepEqual(closestRouteLabelPosition(line, [112.2, 21.5]), [112, 21.5]);
  assert.deepEqual(closestRouteLabelPosition(line, [109, 19]), [110, 20]);
  assert.equal(closestRouteLabelPosition({ ...line, path: [] }, [110, 20]), null);
});

test("label modes distinguish line codes, digits and full names without including endpoint numbers", () => {
  for (const [name, code, digits] of [
    ["K2路(前山总站--金鼎总站)", "K2", "2"],
    ["10A路（1号口岸--2号站）", "10A", "10"],
    ["公交 Ｋ２ 路", "K2", "2"],
    ["2-1路(首站--末站)", "2-1", "2-1"],
    ["环城观光线(1号门--2号门)", "环城观光线", "环城观光线"],
  ]) {
    assert.equal(routeLabelText({ name }, "code"), code);
    assert.equal(routeLabelText({ name }, "digits"), digits);
    assert.equal(routeLabelText({ name }, "full"), name);
  }
});

test("custom text survives archive JSON, overrides all modes and can return to automatic text", () => {
  const original = { ...route, name: "K2路(首站--末站)", labelText: "  机场快线  ", labelPosition: [113, 22] };
  const restored = JSON.parse(JSON.stringify(original));
  for (const mode of ["code", "digits", "full"]) assert.equal(routeLabelText(restored, mode), "机场快线");
  assert.equal(routeLabelText({ ...restored, labelText: "" }, "digits"), "2");
  assert.deepEqual(restored.labelPosition, original.labelPosition);
  assert.equal(restored.name, original.name);
});

test("PNG and SVG both use the selected text mode and safely render custom text", () => {
  const texts = [];
  const context = { save() {}, restore() {}, beginPath() {}, roundRect() {}, fill() {}, stroke() {}, measureText(text) { return { width: text.length * 14 }; }, fillText(text) { texts.push(text); } };
  const routes = [{ ...route, name: "10A路(首站--末站)" }, { ...route, id: "custom", labelText: '<快线 & "东">' }];
  const project = () => ({ x: 100, y: 100 });
  drawCanvasRouteLabels(context, routes, project, 2, "digits");
  assert.deepEqual(texts, ["10", '<快线 & "东">']);
  const svg = makeSvgRouteLabels(routes, project, 2, "digits");
  assert.match(svg, />10<\/text>/);
  assert.match(svg, /&lt;快线 &amp; &quot;东&quot;&gt;<\/text>/);
  assert.doesNotMatch(svg, /<快线/);
});
