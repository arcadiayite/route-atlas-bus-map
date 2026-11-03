import type { Map as MapLibreMap } from "maplibre-gl";

// getStyle() becomes available once the style can accept layers. isStyleLoaded()
// also waits for remote sources, which must not delay drawing routes or labels.
export function whenMapStyleReady(map: MapLibreMap, update: () => void) {
  const cancel = () => {
    map.off("style.load", apply);
    map.off("idle", apply);
  };
  const apply = () => { cancel(); update(); };
  if (map.getStyle()) apply();
  else {
    map.once("style.load", apply);
    map.once("idle", apply);
  }
  return cancel;
}
