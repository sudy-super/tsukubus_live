const targetRoutes = {
  "筑波大学循環(右回り)": {
    id: "clockwise",
    label: "右回り",
    accent: "#ff5f8f",
  },
  "筑波大学循環(左回り)": {
    id: "counterclockwise",
    label: "左回り",
    accent: "#4dc4d8",
  },
};

const stopNameAliases = new Map([
  ["つくばセンター(TXつくば駅)", "つくばセンター"],
  ["つくばセンター", "つくばセンター"],
  ["筑波大学病院東", "筑波大学病院入口"],
  ["筑波大学病院入口", "筑波大学病院入口"],
  ["ＴＡＲＡセンター前", "TARAセンター前"],
  ["TARAセンター前", "TARAセンター前"],
]);

const anchorQueries = [
  {
    dept: "つくばセンター(TXつくば駅)",
    dest: "松美池",
  },
  {
    dept: "松美池",
    dest: "つくばセンター(TXつくば駅)",
  },
];

const queryOffsetsMinutes = [-60, -45, -30, -15, 0, 15, 30];

export function createLiveMapService({
  staticData,
  campusMapData,
  fetchImpl = fetch,
  updateIntervalMs = 5_000,
}) {
  const indexedStaticData = createIndexedStaticData(staticData);
  const vehicleCache = {
    value: null,
    lastSuccessfulAt: null,
    inFlight: null,
    error: null,
  };

  return {
    getStopsPayload() {
      return {
        generatedAt: new Date().toISOString(),
        stops: indexedStaticData.stops,
      };
    },
    getRoutesPayload() {
      return {
        generatedAt: new Date().toISOString(),
        routes: indexedStaticData.routes,
      };
    },
    getCampusMapPayload() {
      return {
        generatedAt: new Date().toISOString(),
        ...campusMapData,
      };
    },
    getHealthPayload() {
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        lastSuccessfulAt: vehicleCache.lastSuccessfulAt,
      };
    },
    async getVehiclePayload() {
      const now = new Date();
      if (vehicleCache.value && vehicleCache.lastSuccessfulAt) {
        const age = now.getTime() - new Date(vehicleCache.lastSuccessfulAt).getTime();
        if (age < updateIntervalMs) {
          return vehicleCache.value;
        }
      }

      if (vehicleCache.inFlight) {
        return vehicleCache.inFlight;
      }

      vehicleCache.inFlight = refreshVehicles(now)
        .then((payload) => {
          vehicleCache.value = payload;
          vehicleCache.lastSuccessfulAt = payload.lastSuccessfulAt;
          vehicleCache.error = null;
          return payload;
        })
        .catch((error) => {
          vehicleCache.error = error instanceof Error ? error.message : "unknown_error";
          if (vehicleCache.value) {
            return {
              ...vehicleCache.value,
              stale: true,
              upstreamError: vehicleCache.error,
            };
          }
          throw error;
        })
        .finally(() => {
          vehicleCache.inFlight = null;
        });

      return vehicleCache.inFlight;
    },
  };

  async function refreshVehicles(now) {
    const routeCandidates = await fetchRouteCandidates(now);
    const activeCandidates = routeCandidates.filter((candidate) => isActiveCandidate(candidate, now));
    const vehicles = (
      await Promise.all(activeCandidates.map((candidate) => hydrateVehicle(candidate, now)))
    ).filter(Boolean);

    const generatedAt = new Date().toISOString();

    return {
      generatedAt,
      lastSuccessfulAt: generatedAt,
      queryWindowMinutes: queryOffsetsMinutes,
      vehicles: vehicles.sort(compareVehicles),
      stats: {
        activeCount: vehicles.length,
        clockwiseCount: vehicles.filter((vehicle) => vehicle.direction === "clockwise").length,
        counterclockwiseCount: vehicles.filter((vehicle) => vehicle.direction === "counterclockwise").length,
      },
    };
  }

  async function fetchRouteCandidates(now) {
    const queryTimes = queryOffsetsMinutes
      .map((offsetMinutes) => addMinutes(now, offsetMinutes))
      .filter((queryTime) => isSameLocalDate(queryTime, now));
    const responses = await Promise.all(
      anchorQueries.flatMap((anchor) =>
        queryTimes.map((queryTime) =>
          queryRouteSearchSafe({
            dept: anchor.dept,
            dest: anchor.dest,
            dateTime: formatApiDateTime(queryTime),
          }),
        ),
      ),
    );

    const byTrip = new Map();

    for (const response of responses) {
      for (const candidate of response.candidate_list ?? []) {
        const routeName = candidate.routeList?.[0]?.routeShortName;
        if (!routeName || !targetRoutes[routeName] || !candidate.trip1) {
          continue;
        }

        const normalized = normalizeCandidate(candidate, response.datetime, routeName, now);
        if (!byTrip.has(normalized.tripId)) {
          byTrip.set(normalized.tripId, []);
        }
        byTrip.get(normalized.tripId).push(normalized);
      }
    }

    return [...byTrip.values()].map((segments) => mergeTripCandidates(segments, now));
  }

  async function hydrateVehicle(candidate, now) {
    const [mapLocation, location] = await Promise.all([
      queryMapLocation(candidate, now),
      queryLocation(candidate, now),
    ]);

    const mapItem = Array.isArray(mapLocation) ? mapLocation[0] : null;
    const locationItem = location?.locationList?.[0] ?? null;

    const lat = mapItem?.vehicleLat ? Number(mapItem.vehicleLat) : null;
    const lon = mapItem?.vehicleLon ? Number(mapItem.vehicleLon) : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }

    const stopOrder = indexedStaticData.stopOrders[candidate.direction];
    const currentSeq = numberOrNull(locationItem?.busSeq) ?? candidate.sSeq;
    const currentStopName = stopNameForSeq(stopOrder, currentSeq);
    const nextSeq = currentSeq && currentSeq < stopOrder.length ? currentSeq + 1 : null;
    const nextStopName = stopNameForSeq(stopOrder, nextSeq);
    const delayLabel = firstNonEmpty(locationItem?.icon1, mapItem?.icon1, candidate.delayLabel);
    const delayMinutes = parseDelayMinutes(delayLabel);
    const estimatedSegmentStart = arrivalTextToDate(candidate.segmentStart, locationItem?.stDelayTime);
    const estimatedSegmentEnd = arrivalTextToDate(candidate.segmentEnd, locationItem?.edDelayTime);
    const headingDeg = computeVehicleHeading({
      lat,
      lon,
      direction: candidate.direction,
      stopOrder,
      currentSeq,
      currentStopName,
      nextStopName,
      indexedStaticData,
    });
    const pathPredictions = buildPredictions({
      candidate,
      stopOrder,
      startSeq: currentSeq ?? candidate.sSeq,
      delayMinutes,
      estimatedSegmentStart,
      estimatedSegmentEnd,
      tripSegments: candidate.segments,
    });

    return {
      tripId: candidate.tripId,
      routeName: candidate.routeName,
      direction: candidate.direction,
      directionLabel: candidate.directionLabel,
      accent: candidate.accent,
      lat,
      lon,
      currentSeq,
      currentStopName,
      nextSeq,
      nextStopName,
      headingDeg,
      delayMinutes,
      delayLabel,
      arrivalLabelAtSegmentStart: compactArrivalLabel(locationItem?.stDelayTime),
      arrivalLabelAtSegmentEnd: compactArrivalLabel(locationItem?.edDelayTime),
      scheduledSegmentStartAt: candidate.segmentStart.toISOString(),
      scheduledSegmentEndAt: candidate.segmentEnd.toISOString(),
      scheduledSegmentStartLabel: candidate.scheduledStartLabel,
      scheduledSegmentEndLabel: candidate.scheduledEndLabel,
      watchedSegmentStartStop: candidate.deptStopName,
      watchedSegmentEndStop: candidate.destStopName,
      lastUpdatedAt: now.toISOString(),
      pathPredictions,
    };
  }

  async function queryRouteSearch(params) {
    return postJson("/route_search", {
      dept: params.dept,
      dest: params.dest,
      date_time: params.dateTime,
      radio1: "1",
      radio2: "1",
    });
  }

  async function queryRouteSearchSafe(params) {
    try {
      return await queryRouteSearch(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "/route_search failed with 500") {
        return {
          datetime: params.dateTime,
          candidate_list: [],
        };
      }
      throw error;
    }
  }

  async function queryMapLocation(candidate, now) {
    return postJson("/map_location", {
      trip_id1: candidate.tripId,
      trip_id2: "",
      s_seq: String(candidate.sSeq ?? ""),
      get_on_seq: "",
      date_time: formatApiDateTime(now),
    });
  }

  async function queryLocation(candidate, now) {
    return postJson("/location", {
      trip1: candidate.tripId,
      trip2: "",
      seq1: String(candidate.sSeq ?? ""),
      seq2: "",
      st_time: candidate.scheduledStartLabel,
      ed_time: candidate.scheduledEndLabel,
      get_on_time: "",
      get_off_time: "",
      date_time: formatApiDateTime(now),
    });
  }

  async function postJson(pathname, form) {
    const body = new URLSearchParams(form).toString();
    const response = await fetchImpl(`https://navi.kanto-tetsudo.com${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: "https://navi.kanto-tetsudo.com",
        Referer: "https://navi.kanto-tetsudo.com/search_dest",
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`${pathname} failed with ${response.status}`);
    }

    return response.json();
  }
}

function createIndexedStaticData(staticData) {
  return {
    ...staticData,
    stopLookup: new Map((staticData.stops ?? []).map((stop) => [stop.name, stop])),
    routePathLookup: new Map(Object.entries(staticData.routePathLookup ?? {})),
  };
}

function mergeTripCandidates(segments, now) {
  const deduped = new Map();

  for (const segment of segments) {
    const key = [
      segment.tripId,
      segment.direction,
      segment.sSeq,
      segment.eSeq,
      segment.scheduledStartLabel,
      segment.scheduledEndLabel,
    ].join(":");
    const existing = deduped.get(key);
    if (!existing || candidateScore(segment, now) < candidateScore(existing, now)) {
      deduped.set(key, segment);
    }
  }

  const mergedSegments = [...deduped.values()].sort(
    (left, right) =>
      (left.sSeq ?? 999) - (right.sSeq ?? 999) ||
      (left.eSeq ?? 999) - (right.eSeq ?? 999) ||
      left.segmentStart.getTime() - right.segmentStart.getTime(),
  );
  const primarySegment = mergedSegments.reduce((best, segment) =>
    !best || candidateScore(segment, now) < candidateScore(best, now) ? segment : best,
  );

  return {
    ...primarySegment,
    segments: mergedSegments,
    coverageStartSeq: Math.min(...mergedSegments.map((segment) => segment.sSeq ?? Infinity)),
    coverageEndSeq: Math.max(...mergedSegments.map((segment) => segment.eSeq ?? -Infinity)),
  };
}

function normalizeCandidate(candidate, responseDateTime, routeName, now) {
  const direction = targetRoutes[routeName];
  const responseBase = parseApiDateTime(responseDateTime) ?? now;
  const segmentStart = timeStringToDate(responseBase, candidate.deptTime);
  const segmentEnd = rollOverIfNeeded(segmentStart, timeStringToDate(responseBase, candidate.destTime));

  return {
    tripId: candidate.trip1,
    routeName,
    direction: direction.id,
    directionLabel: direction.label,
    accent: direction.accent,
    sSeq: numberOrNull(candidate.sSeq),
    eSeq: numberOrNull(candidate.eSeq),
    deptStopName: normalizeStopName(candidate.deptStopName),
    destStopName: normalizeStopName(candidate.destStopName),
    segmentStart,
    segmentEnd,
    scheduledStartLabel: candidate.deptTime,
    scheduledEndLabel: candidate.destTime,
    delayMinutes: parseDelayMinutes(candidate.delaySum),
    delayLabel: candidate.delaySum || null,
  };
}

function candidateScore(candidate, now) {
  const intervalStart = addMinutes(candidate.segmentStart, -2).getTime();
  const intervalEnd = addMinutes(
    candidate.segmentEnd,
    Math.max(18, (candidate.delayMinutes ?? 0) + 8),
  ).getTime();
  const nowMs = now.getTime();

  if (nowMs >= intervalStart && nowMs <= intervalEnd) {
    return Math.abs(nowMs - candidate.segmentStart.getTime());
  }

  if (nowMs < intervalStart) {
    return 1_000_000_000 + (intervalStart - nowMs);
  }

  return 2_000_000_000 + (nowMs - intervalEnd);
}

function isActiveCandidate(candidate, now) {
  if (Array.isArray(candidate.segments) && candidate.segments.length > 0) {
    return candidate.segments.some((segment) => isActiveCandidate(segment, now));
  }

  const start = addMinutes(candidate.segmentStart, -1).getTime();
  const end = addMinutes(candidate.segmentEnd, Math.max(20, (candidate.delayMinutes ?? 0) + 10)).getTime();
  const nowMs = now.getTime();
  return nowMs >= start && nowMs <= end;
}

function buildPredictions({
  candidate,
  stopOrder,
  startSeq,
  delayMinutes,
  estimatedSegmentStart,
  estimatedSegmentEnd,
  tripSegments,
}) {
  if (!candidate.sSeq || !candidate.eSeq || !startSeq || !Array.isArray(stopOrder) || stopOrder.length === 0) {
    return [];
  }

  const routeEndSeq = stopOrder.length;
  const fromSeq = clampSequence(startSeq, routeEndSeq);
  const segmentModels = buildPredictionSegments({
    candidate,
    tripSegments,
    routeEndSeq,
    delayMinutes,
    estimatedSegmentStart,
    estimatedSegmentEnd,
  });
  if (!fromSeq || segmentModels.length === 0) {
    return [];
  }

  const predictions = [];

  for (let seq = fromSeq; seq <= routeEndSeq; seq += 1) {
    const stopName = stopNameForSeq(stopOrder, seq);
    if (!stopName) {
      continue;
    }
    const times = predictionTimesForSeq(seq, segmentModels);
    if (!times) {
      continue;
    }
    const { scheduledAt, estimatedAt } = times;

    predictions.push({
      seq,
      stopName,
      scheduledAt: scheduledAt.toISOString(),
      estimatedAt: estimatedAt.toISOString(),
      scheduledLabel: formatShortTime(scheduledAt),
      estimatedLabel: formatShortTime(estimatedAt),
    });
  }

  return predictions;
}

function buildPredictionSegments({
  candidate,
  tripSegments,
  routeEndSeq,
  delayMinutes,
  estimatedSegmentStart,
  estimatedSegmentEnd,
}) {
  const segments = Array.isArray(tripSegments) && tripSegments.length > 0 ? tripSegments : [candidate];

  return segments
    .map((segment) => {
      const sSeq = clampSequence(segment.sSeq, routeEndSeq);
      const eSeq = clampSequence(segment.eSeq, routeEndSeq);
      if (!sSeq || !eSeq) {
        return null;
      }

      const scheduledStart = segment.segmentStart;
      const scheduledEnd = segment.segmentEnd;
      const span = Math.max(1, eSeq - sSeq);
      const scheduledDurationMs = Math.max(0, scheduledEnd.getTime() - scheduledStart.getTime());
      const scheduledStepMs = scheduledDurationMs > 0 ? scheduledDurationMs / span : 60_000;
      const isPrimarySegment =
        segment.tripId === candidate.tripId &&
        segment.direction === candidate.direction &&
        segment.sSeq === candidate.sSeq &&
        segment.eSeq === candidate.eSeq &&
        segment.scheduledStartLabel === candidate.scheduledStartLabel &&
        segment.scheduledEndLabel === candidate.scheduledEndLabel;
      const { estimatedStart, estimatedEnd } = resolveEstimatedSegmentTimes({
        candidate: segment,
        delayMinutes: segment.delayMinutes ?? delayMinutes,
        estimatedSegmentStart: isPrimarySegment ? estimatedSegmentStart : null,
        estimatedSegmentEnd: isPrimarySegment ? estimatedSegmentEnd : null,
      });
      const estimatedDurationMs = Math.max(0, estimatedEnd.getTime() - estimatedStart.getTime());
      const estimatedStepMs = estimatedDurationMs > 0 ? estimatedDurationMs / span : scheduledStepMs;

      return {
        sSeq,
        eSeq,
        scheduledStart,
        scheduledEnd,
        estimatedStart,
        estimatedEnd,
        scheduledStepMs,
        estimatedStepMs,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sSeq - right.sSeq || left.eSeq - right.eSeq);
}

function predictionTimesForSeq(seq, segmentModels) {
  const containing = segmentModels.filter((segment) => seq >= segment.sSeq && seq <= segment.eSeq);
  if (containing.length > 0) {
    const directSegment = containing.find((segment) => seq === segment.sSeq) ?? containing[containing.length - 1];
    return predictionTimesWithinSegment(seq, directSegment);
  }

  const previousSegment = findPreviousSegment(seq, segmentModels);
  const nextSegment = segmentModels.find((segment) => segment.sSeq > seq) ?? null;

  if (previousSegment && nextSegment) {
    return interpolatePredictionTimes(seq, previousSegment, nextSegment);
  }

  if (previousSegment) {
    return extrapolatePredictionTimes(seq, previousSegment, "forward");
  }

  if (nextSegment) {
    return extrapolatePredictionTimes(seq, nextSegment, "backward");
  }

  return null;
}

function predictionTimesWithinSegment(seq, segment) {
  const offset = seq - segment.sSeq;
  return {
    scheduledAt: new Date(segment.scheduledStart.getTime() + segment.scheduledStepMs * offset),
    estimatedAt: new Date(segment.estimatedStart.getTime() + segment.estimatedStepMs * offset),
  };
}

function findPreviousSegment(seq, segmentModels) {
  let previousSegment = null;

  for (const segment of segmentModels) {
    if (segment.eSeq < seq) {
      previousSegment = segment;
      continue;
    }
    break;
  }

  return previousSegment;
}

function interpolatePredictionTimes(seq, previousSegment, nextSegment) {
  const gapSpan = nextSegment.sSeq - previousSegment.eSeq;
  if (gapSpan <= 0) {
    return predictionTimesWithinSegment(seq, nextSegment);
  }

  const ratio = (seq - previousSegment.eSeq) / gapSpan;
  return {
    scheduledAt: new Date(
      previousSegment.scheduledEnd.getTime() +
        (nextSegment.scheduledStart.getTime() - previousSegment.scheduledEnd.getTime()) * ratio,
    ),
    estimatedAt: new Date(
      previousSegment.estimatedEnd.getTime() +
        (nextSegment.estimatedStart.getTime() - previousSegment.estimatedEnd.getTime()) * ratio,
    ),
  };
}

function extrapolatePredictionTimes(seq, segment, direction) {
  if (direction === "forward") {
    const offset = seq - segment.eSeq;
    return {
      scheduledAt: new Date(segment.scheduledEnd.getTime() + segment.scheduledStepMs * offset),
      estimatedAt: new Date(segment.estimatedEnd.getTime() + segment.estimatedStepMs * offset),
    };
  }

  const offset = segment.sSeq - seq;
  return {
    scheduledAt: new Date(segment.scheduledStart.getTime() - segment.scheduledStepMs * offset),
    estimatedAt: new Date(segment.estimatedStart.getTime() - segment.estimatedStepMs * offset),
  };
}

function resolveEstimatedSegmentTimes({
  candidate,
  delayMinutes,
  estimatedSegmentStart,
  estimatedSegmentEnd,
}) {
  const delayMs = (delayMinutes ?? 0) * 60_000;
  const scheduledDurationMs = Math.max(0, candidate.segmentEnd.getTime() - candidate.segmentStart.getTime());
  const fallbackStart = new Date(candidate.segmentStart.getTime() + delayMs);
  const fallbackEnd = new Date(candidate.segmentEnd.getTime() + delayMs);

  const estimatedStart =
    estimatedSegmentStart ??
    (estimatedSegmentEnd ? new Date(estimatedSegmentEnd.getTime() - scheduledDurationMs) : fallbackStart);
  const estimatedEnd =
    estimatedSegmentEnd ??
    (estimatedSegmentStart ? new Date(estimatedSegmentStart.getTime() + scheduledDurationMs) : fallbackEnd);

  if (estimatedEnd.getTime() >= estimatedStart.getTime()) {
    return { estimatedStart, estimatedEnd };
  }

  return {
    estimatedStart,
    estimatedEnd: addMinutes(estimatedEnd, 24 * 60),
  };
}

function computeVehicleHeading({
  lat,
  lon,
  direction,
  stopOrder,
  currentSeq,
  currentStopName,
  nextStopName,
  indexedStaticData,
}) {
  const routeHeading = headingForNearestRouteSegment({
    lat,
    lon,
    path: indexedStaticData.routePathLookup.get(direction),
  });
  if (routeHeading !== null) {
    return routeHeading;
  }

  const vehiclePoint = { lat, lon };
  const nextStopPoint = coordinatesForStop(indexedStaticData, nextStopName);
  const directHeading = bearingBetweenPoints(vehiclePoint, nextStopPoint);
  if (directHeading !== null) {
    return directHeading;
  }

  const currentStopPoint = coordinatesForStop(indexedStaticData, currentStopName);
  const followingStopPoint = coordinatesForStop(
    indexedStaticData,
    nextStopName ?? stopNameForSeq(stopOrder, currentSeq ? currentSeq + 1 : null),
  );
  const forwardHeading = bearingBetweenPoints(currentStopPoint, followingStopPoint);
  if (forwardHeading !== null) {
    return forwardHeading;
  }

  const previousStopPoint = coordinatesForStop(
    indexedStaticData,
    stopNameForSeq(stopOrder, currentSeq ? currentSeq - 1 : null),
  );
  return bearingBetweenPoints(previousStopPoint, currentStopPoint);
}

function headingForNearestRouteSegment({ lat, lon, path }) {
  if (!Array.isArray(path) || path.length < 2) {
    return null;
  }

  const originLatRad = degreesToRadians(lat);
  const lonScale = Math.cos(originLatRad);
  let nearestDistanceSquared = Infinity;
  let nearestHeading = null;

  for (let index = 0; index < path.length - 1; index += 1) {
    const start = pointFromPathCoordinate(path[index]);
    const end = pointFromPathCoordinate(path[index + 1]);
    if (!start || !end) {
      continue;
    }

    const projectedStart = projectLatLon(start, lonScale);
    const projectedEnd = projectLatLon(end, lonScale);
    const projectedVehicle = projectLatLon({ lat, lon }, lonScale);
    const distanceSquared = distanceSquaredToSegment(projectedVehicle, projectedStart, projectedEnd);

    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestHeading = bearingBetweenPoints(start, end);
    }
  }

  return nearestHeading;
}

function coordinatesForStop(indexedStaticData, stopName) {
  if (!stopName) {
    return null;
  }

  const stop = indexedStaticData.stopLookup.get(stopName);
  if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
    return null;
  }

  return {
    lat: stop.lat,
    lon: stop.lon,
  };
}

function pointFromPathCoordinate(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const [lat, lon] = value;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return { lat, lon };
}

function projectLatLon(point, lonScale) {
  return {
    x: point.lon * lonScale,
    y: point.lat,
  };
}

function distanceSquaredToSegment(point, segmentStart, segmentEnd) {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;
  if (dx === 0 && dy === 0) {
    return distanceSquared(point, segmentStart);
  }

  const t = clamp01(
    ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / (dx * dx + dy * dy),
  );
  const projectedPoint = {
    x: segmentStart.x + dx * t,
    y: segmentStart.y + dy * t,
  };
  return distanceSquared(point, projectedPoint);
}

function distanceSquared(left, right) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function clamp01(value) {
  return Math.min(Math.max(value, 0), 1);
}

function bearingBetweenPoints(from, to) {
  if (!from || !to) {
    return null;
  }

  const latDelta = to.lat - from.lat;
  const lonDelta = to.lon - from.lon;
  if (Math.hypot(latDelta, lonDelta) < 0.00001) {
    return null;
  }

  const fromLatRad = degreesToRadians(from.lat);
  const toLatRad = degreesToRadians(to.lat);
  const deltaLonRad = degreesToRadians(lonDelta);
  const y = Math.sin(deltaLonRad) * Math.cos(toLatRad);
  const x =
    Math.cos(fromLatRad) * Math.sin(toLatRad) -
    Math.sin(fromLatRad) * Math.cos(toLatRad) * Math.cos(deltaLonRad);

  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function stopNameForSeq(stopOrder, seq) {
  if (!seq || seq < 1 || seq > stopOrder.length) {
    return null;
  }
  return stopOrder[seq - 1] ?? null;
}

function clampSequence(seq, maxSeq) {
  if (!Number.isFinite(seq)) {
    return null;
  }
  return Math.min(Math.max(Math.trunc(seq), 1), maxSeq);
}

function normalizeStopName(name) {
  if (!name) {
    return null;
  }
  return stopNameAliases.get(name.trim()) ?? name.trim();
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDelayMinutes(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/(\d+)分/);
  return match ? Number(match[1]) : 0;
}

function compactArrivalLabel(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/(\d{2}:\d{2})/);
  return match ? match[1] : text;
}

function arrivalTextToDate(referenceDate, text) {
  const hhmm = compactArrivalLabel(text);
  if (!hhmm || !referenceDate) {
    return null;
  }
  return rollOverIfNeeded(referenceDate, timeStringToDate(referenceDate, hhmm));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return null;
}

function compareVehicles(left, right) {
  if (left.direction !== right.direction) {
    return left.direction.localeCompare(right.direction);
  }
  return (left.currentSeq ?? 999) - (right.currentSeq ?? 999);
}

function parseApiDateTime(text) {
  if (!text) {
    return null;
  }
  const normalized = text.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeStringToDate(baseDate, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const date = new Date(baseDate);
  date.setSeconds(0, 0);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function rollOverIfNeeded(start, end) {
  if (end.getTime() >= start.getTime()) {
    return end;
  }
  return addMinutes(end, 24 * 60);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function isSameLocalDate(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatApiDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

function formatShortTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
