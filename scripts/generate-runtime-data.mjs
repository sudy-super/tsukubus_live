import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const buildDataDir = path.join(rootDir, "build_data");
const campusMapsDir = path.join(rootDir, "client", "public", "campus_maps");
const generatedDir = path.join(rootDir, "src", "generated");

const stopNameAliases = new Map([
  ["つくばセンター(TXつくば駅)", "つくばセンター"],
  ["つくばセンター", "つくばセンター"],
  ["筑波大学病院東", "筑波大学病院入口"],
  ["筑波大学病院入口", "筑波大学病院入口"],
  ["ＴＡＲＡセンター前", "TARAセンター前"],
  ["TARAセンター前", "TARAセンター前"],
]);
const splitStopNamesByGroup = new Set(["つくばセンター"]);

await mkdir(generatedDir, { recursive: true });

const [stopsRaw, stationOrdersRaw, geoJsonRaw, campusMapData, northShuttleRaw] = await Promise.all([
  readJson(path.join(buildDataDir, "eritanbot_bus_stops.json")),
  readJson(path.join(buildDataDir, "eritanbot_station_orders.json")),
  readJson(path.join(buildDataDir, "eritanbot_bus_map.geojson")),
  buildCampusMapData(),
  readJson(path.join(buildDataDir, "busgo_north_shuttle.json")),
]);

const staticData = buildStaticData({ stopsRaw, stationOrdersRaw, geoJsonRaw, northShuttleRaw });

await Promise.all([
  writeGeneratedModule(path.join(generatedDir, "static-data.js"), "staticData", staticData),
  writeGeneratedModule(path.join(generatedDir, "campus-map-data.js"), "campusMapData", campusMapData),
]);

async function writeGeneratedModule(filePath, exportName, payload) {
  const source = `export const ${exportName} = ${JSON.stringify(payload, null, 2)};\n`;
  await writeFile(filePath, source, "utf8");
}

function buildStaticData({ stopsRaw, stationOrdersRaw, geoJsonRaw, northShuttleRaw }) {
  const rawStopSources = stopsRaw
    .filter((stop) => stop.group === "kantetsu" || stop.group === "north_shuttle")
    .map((stop) => ({
      name: normalizeStopName(stop.name),
      lat: stop.lat,
      lon: stop.lng,
      group: stop.group,
      stationKey: stop.stationKey ?? null,
    }));
  const clockwiseOrderBase = stationOrdersRaw.kantetsu_order_Re
    .map(normalizeStopName)
    .filter((name) => name && name !== "東京駅八重洲南口");
  const clockwiseOrder = [
    ...clockwiseOrderBase,
    "筑波メディカルセンター前",
    "筑波大学春日エリア前",
    "吾妻小学校",
    "つくばセンター",
  ];
  const counterclockwiseOrder = [...clockwiseOrder].reverse();

  const clockwiseShape = buildClockwiseShape(geoJsonRaw);
  const counterclockwiseShape = [...clockwiseShape].reverse();
  const northShuttleRoutes = buildNorthShuttleRoutes(northShuttleRaw);
  const routes = [
    {
      id: "clockwise",
      name: "筑波大学循環",
      label: "右回り",
      badge: "右",
      color: "#ff5f8f",
      lineColor: "#ff5f8f",
      stops: clockwiseOrder.map((name, index) => ({
        name,
        sequence: index + 1,
      })),
      path: clockwiseShape,
    },
    {
      id: "counterclockwise",
      name: "筑波大学循環",
      label: "左回り",
      badge: "左",
      color: "#4dc4d8",
      lineColor: "#4dc4d8",
      stops: counterclockwiseOrder.map((name, index) => ({
        name,
        sequence: index + 1,
      })),
      path: counterclockwiseShape,
    },
    ...northShuttleRoutes,
  ];
  const routeStopSources = routes.flatMap((route) =>
    route.stops.map((stop) => ({
      name: stop.name,
      lat: stop.lat ?? null,
      lon: stop.lon ?? null,
      group: routeGroupForRouteId(route.id),
      stationKey: stop.rawName ?? `${route.id}:${stop.code ?? stop.name}`,
    })),
  );
  const stops = dedupeStops([...rawStopSources, ...routeStopSources]);
  const stopLookupByGroup = createStopLookupByGroup(stops);

  const stopsWithRoutes = stops.map((stop) => ({
    ...stop,
    routes: routes
      .map((route) => ({
        id: route.id,
        label: route.label,
        sequence: sequenceForStop(
          route.stops.map((routeStop) => routeStop.name),
          stop.name,
        ),
      }))
      .filter((route) => route.sequence !== null && stopSupportsRoute(stop, route.id)),
  }));

  const routesWithResolvedStops = routes.map((route) => ({
    ...route,
    stops: route.stops.map((routeStop) => stopToRouteStop(stopLookupByGroup, routeStop, route.id)),
  }));

  return {
    stops: stopsWithRoutes,
    stopOrders: Object.fromEntries(routes.map((route) => [route.id, route.stops.map((stop) => stop.name)])),
    routes: routesWithResolvedStops,
    routePathLookup: Object.fromEntries(routes.map((route) => [route.id, route.path])),
    routeStopLookup: Object.fromEntries(
      routesWithResolvedStops.map((route) => [
        route.id,
        Object.fromEntries(route.stops.map((stop) => [stop.name, { lat: stop.lat, lon: stop.lon }])),
      ]),
    ),
  };
}

function buildNorthShuttleRoutes(northShuttleRaw) {
  const routeMetaById = {
    north_shuttle_outbound: {
      label: "筑波山口方面",
      badge: "山",
      color: "#67a9ff",
      lineColor: "#67a9ff",
    },
    north_shuttle_inbound: {
      label: "つくばセンター方面",
      badge: "セ",
      color: "#57c79b",
      lineColor: "#57c79b",
    },
  };

  return (northShuttleRaw.routes ?? [])
    .map((route) => {
      const meta = routeMetaById[route.id];
      if (!meta) {
        return null;
      }

      return {
        id: route.id,
        name: route.name ?? "北部シャトル",
        label: meta.label,
        badge: meta.badge,
        color: meta.color,
        lineColor: meta.lineColor,
        stops: (route.stops ?? []).map((stop, index) => ({
          code: stop.code ?? String(index + 1).padStart(3, "0"),
          name: normalizeStopName(stop.name),
          rawName: stop.rawName ?? stop.name,
          lat: stop.lat ?? null,
          lon: stop.lon ?? null,
          minuteFromOrigin: Number.isFinite(stop.minuteFromOrigin) ? stop.minuteFromOrigin : null,
          sequence: Number.isFinite(stop.sequence) ? stop.sequence : index + 1,
        })),
        path: Array.isArray(route.path) ? route.path : [],
      };
    })
    .filter(Boolean);
}

async function buildCampusMapData() {
  try {
    const files = await readdir(campusMapsDir);
    const bundleName = files.find((file) => /^main\..+\.js$/.test(file));
    if (!bundleName) {
      return emptyCampusMapData("bundle_not_found");
    }

    const localImages = new Set(files.filter((file) => file.endsWith(".webp")));
    const bundleText = await readFile(path.join(campusMapsDir, bundleName), "utf8");
    const moduleToFile = new Map(
      [...bundleText.matchAll(/(\d+):\(e,t,n\)=>\{"use strict";e\.exports=n\.p\+"static\/media\/([^"]+)"\}/g)].map(
        (match) => [Number(match[1]), match[2]],
      ),
    );
    const manifestStart = bundleText.indexOf("uc={basename:");
    if (manifestStart < 0) {
      return emptyCampusMapData("asset_manifest_not_found");
    }

    const manifestEnd = findMatchingBrace(bundleText, manifestStart);
    if (manifestEnd < 0) {
      return emptyCampusMapData("asset_manifest_parse_failed");
    }

    const assetManifest = bundleText.slice(manifestStart, manifestEnd + 1);
    const assets = [...assetManifest.matchAll(/module:\[__webpack_require__\((\d+)\),__webpack_require__\((\d+)\)\],x:(\d+),y:(\d+),z:(\d+)/g)].map(
      (match) => ({
        lightFile: moduleToFile.get(Number(match[1])) ?? null,
        darkFile: moduleToFile.get(Number(match[2])) ?? null,
        x: Number(match[3]),
        y: Number(match[4]),
        z: Number(match[5]),
      }),
    );
    const tiles = assets
      .map((asset) => {
        if (asset.darkFile && localImages.has(asset.darkFile)) {
          return {
            url: `/campus_maps/${asset.darkFile}`,
            file: asset.darkFile,
            theme: "dark",
            x: asset.x,
            y: asset.y,
            z: asset.z,
          };
        }

        if (asset.lightFile && localImages.has(asset.lightFile)) {
          return {
            url: `/campus_maps/${asset.lightFile}`,
            file: asset.lightFile,
            theme: "light",
            x: asset.x,
            y: asset.y,
            z: asset.z,
          };
        }

        return null;
      })
      .filter(Boolean)
      .sort((left, right) => left.z - right.z || left.x - right.x || left.y - right.y);

    return {
      sourceBundle: bundleName,
      tileSize: 256,
      tiles,
      coverage: {
        totalAssets: assets.length,
        availableAssets: tiles.length,
        availableByZoom: countByZoom(tiles),
        missingByZoom: countByZoom(
          assets.filter((asset) => {
            return !(
              (asset.darkFile && localImages.has(asset.darkFile)) ||
              (asset.lightFile && localImages.has(asset.lightFile))
            );
          }),
        ),
        minZoom: tiles.length ? Math.min(...tiles.map((tile) => tile.z)) : null,
        maxZoom: tiles.length ? Math.max(...tiles.map((tile) => tile.z)) : null,
      },
    };
  } catch (error) {
    return emptyCampusMapData(error instanceof Error ? error.message : "unknown_error");
  }
}

function dedupeStops(stops) {
  const seen = new Set();
  const normalized = [];

  for (const stop of stops) {
    const name = normalizeStopName(stop.name);
    const dedupeKey = stopDedupeKey({ ...stop, name });
    if (!name || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push({
      id: `stop-${normalized.length + 1}`,
      name,
      lat: stop.lat,
      lon: stop.lon ?? stop.lng ?? null,
      group: stop.group ?? null,
      stationKey: stop.stationKey ?? null,
    });
  }

  return normalized;
}

function createStopLookupByGroup(stops) {
  const lookup = new Map();
  for (const stop of stops) {
    lookup.set(`${stop.group ?? "unknown"}:${stop.name}`, stop);
  }
  return lookup;
}

function emptyCampusMapData(reason) {
  return {
    sourceBundle: null,
    tileSize: 256,
    tiles: [],
    coverage: {
      totalAssets: 0,
      availableAssets: 0,
      availableByZoom: {},
      missingByZoom: {},
      minZoom: null,
      maxZoom: null,
    },
    error: reason,
  };
}

function findMatchingBrace(text, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function countByZoom(items) {
  const counts = {};
  for (const item of items) {
    counts[item.z] = (counts[item.z] ?? 0) + 1;
  }
  return counts;
}

function buildClockwiseShape(geoJson) {
  const features = geoJson.features.filter((feature) => feature.properties.kind === "segment");
  const downSegments = features.filter(
    (feature) => feature.properties.group === "kantetsu" && feature.properties.direction === "down",
  );
  const connector = features.find(
    (feature) =>
      feature.properties.group === "kantetsu" &&
      feature.properties.direction === "connector_to_medical_center_front",
  );
  const returnSegments = downSegments.slice(0, 3).reverse().map(reverseSegmentCoordinates);

  return flattenSegments([
    ...downSegments.map((feature) => feature.geometry.coordinates),
    connector?.geometry.coordinates ?? [],
    ...returnSegments,
  ]);
}

function reverseSegmentCoordinates(segment) {
  return [...segment.geometry.coordinates].reverse();
}

function flattenSegments(segments) {
  const flattened = [];

  for (const segment of segments) {
    if (!Array.isArray(segment) || segment.length === 0) {
      continue;
    }

    for (const coordinate of segment) {
      if (!flattened.length) {
        flattened.push([coordinate[1], coordinate[0]]);
        continue;
      }

      const [lastLat, lastLon] = flattened[flattened.length - 1];
      if (lastLat === coordinate[1] && lastLon === coordinate[0]) {
        continue;
      }
      flattened.push([coordinate[1], coordinate[0]]);
    }
  }

  return flattened;
}

function sequenceForStop(stopOrder, stopName) {
  const matches = [];
  for (let index = 0; index < stopOrder.length; index += 1) {
    if (stopOrder[index] === stopName) {
      matches.push(index + 1);
    }
  }
  return matches.length ? matches : null;
}

function stopToRouteStop(stopLookupByGroup, stopName, routeId) {
  const routeStop =
    typeof stopName === "object" && stopName !== null
      ? stopName
      : {
          name: stopName,
          sequence: null,
        };
  const stop = stopLookupByGroup.get(`${routeGroupForRouteId(routeId)}:${routeStop.name}`);
  return {
    name: routeStop.name,
    sequence: routeStop.sequence,
    lat: stop?.lat ?? routeStop.lat ?? null,
    lon: stop?.lon ?? routeStop.lon ?? null,
    code: routeStop.code ?? null,
    minuteFromOrigin: routeStop.minuteFromOrigin ?? null,
    rawName: routeStop.rawName ?? null,
  };
}

function stopDedupeKey(stop) {
  const name = normalizeStopName(stop.name);
  if (!name) {
    return "";
  }
  if (splitStopNamesByGroup.has(name)) {
    return `${stop.group ?? "unknown"}:${name}`;
  }
  return name;
}

function stopSupportsRoute(stop, routeId) {
  const routeGroup = routeGroupForRouteId(routeId);
  if (splitStopNamesByGroup.has(stop.name)) {
    return stop.group === routeGroup;
  }
  return true;
}

function routeGroupForRouteId(routeId) {
  return routeId.startsWith("north_shuttle") ? "north_shuttle" : "kantetsu";
}

function normalizeStopName(name) {
  if (!name) {
    return null;
  }
  return stopNameAliases.get(name.trim()) ?? name.trim();
}

async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}
