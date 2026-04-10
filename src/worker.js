import { campusMapData } from "./generated/campus-map-data.js";
import { staticData } from "./generated/static-data.js";
import { createLiveMapService } from "./live-map-service.js";

const liveMapService = createLiveMapService({ staticData, campusMapData });
const vehicleRequestTimeoutMs = 4_500;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/stops") {
      return json(liveMapService.getStopsPayload());
    }

    if (request.method === "GET" && url.pathname === "/api/routes") {
      return json(liveMapService.getRoutesPayload());
    }

    if (request.method === "GET" && url.pathname === "/api/campus-map-tiles") {
      return json(liveMapService.getCampusMapPayload());
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(liveMapService.getHealthPayload());
    }

    if (request.method === "GET" && url.pathname === "/api/vehicles") {
      const now = new Date();

      if (liveMapService.hasVehiclePayload() && !liveMapService.isVehiclePayloadFresh(now)) {
        ctx.waitUntil(liveMapService.refreshVehiclePayload(now));
        return json(
          liveMapService.getCachedVehiclePayload({
            stale: true,
            generatedAt: now.toISOString(),
          }),
        );
      }

      try {
        return json(await withTimeout(liveMapService.getVehiclePayload(), vehicleRequestTimeoutMs));
      } catch (error) {
        const cachedPayload = liveMapService.getCachedVehiclePayload({
          stale: true,
          generatedAt: new Date().toISOString(),
        });
        if (cachedPayload) {
          return json(cachedPayload);
        }

        return json(
          {
            error: error instanceof Error ? error.message : "unknown_error",
            lastSuccessfulAt: liveMapService.getHealthPayload().lastSuccessfulAt,
            vehicles: [],
          },
          { status: 502 },
        );
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("ASSETS binding is not configured.", { status: 500 });
  },
};

function json(payload, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

async function withTimeout(promise, timeoutMs) {
  let timeoutId = null;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`vehicle payload timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
