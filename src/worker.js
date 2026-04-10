import { campusMapData } from "./generated/campus-map-data.js";
import { staticData } from "./generated/static-data.js";
import { createLiveMapService } from "./live-map-service.js";

const liveMapService = createLiveMapService({ staticData, campusMapData });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/stops") {
      return json(liveMapService.getStopsPayload());
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return json({
        googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || null,
      });
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
      try {
        return json(await liveMapService.getVehiclePayload());
      } catch (error) {
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
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}
