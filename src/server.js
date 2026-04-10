import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { campusMapData } from "./generated/campus-map-data.js";
import { staticData } from "./generated/static-data.js";
import { createLiveMapService } from "./live-map-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const distIndexPath = path.join(distDir, "index.html");

const app = express();
const port = Number(process.env.PORT || 3000);
const liveMapService = createLiveMapService({ staticData, campusMapData });
const vehicleRequestTimeoutMs = 4_500;

app.use(express.static(distDir, { index: false }));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  next();
});

app.get("/api/stops", (_req, res) => {
  res.json(liveMapService.getStopsPayload());
});

app.get("/api/routes", (_req, res) => {
  res.json(liveMapService.getRoutesPayload());
});

app.get("/api/campus-map-tiles", (_req, res) => {
  res.json(liveMapService.getCampusMapPayload());
});

app.get("/api/health", (_req, res) => {
  res.json(liveMapService.getHealthPayload());
});

app.get("/api/vehicles", async (_req, res) => {
  const now = new Date();

  if (liveMapService.hasVehiclePayload() && !liveMapService.isVehiclePayloadFresh(now)) {
    void liveMapService.refreshVehiclePayload(now).catch((error) => {
      console.error("vehicle refresh failed", error);
    });
    res.json(
      liveMapService.getCachedVehiclePayload({
        stale: true,
        generatedAt: now.toISOString(),
      }),
    );
    return;
  }

  try {
    res.json(await withTimeout(liveMapService.getVehiclePayload(), vehicleRequestTimeoutMs));
  } catch (error) {
    const cachedPayload = liveMapService.getCachedVehiclePayload({
      stale: true,
      generatedAt: new Date().toISOString(),
    });
    if (cachedPayload) {
      res.json(cachedPayload);
      return;
    }

    res.status(502).json({
      error: error instanceof Error ? error.message : "unknown_error",
      lastSuccessfulAt: liveMapService.getHealthPayload().lastSuccessfulAt,
      vehicles: [],
    });
  }
});

app.get(/.*/, (_req, res) => {
  if (!existsSync(distIndexPath)) {
    res
      .status(503)
      .type("text/plain")
      .send("frontend is not built. run `npm run build` for production or `npm run dev` for development.");
    return;
  }

  res.sendFile(distIndexPath);
});

app.listen(port, () => {
  console.log(`live map server listening on http://localhost:${port}`);
});

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
