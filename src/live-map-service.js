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
const jstOffsetMinutes = 9 * 60;
const upstreamRequestTimeoutMs = 8_000;

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
    hasVehiclePayload() {
      return Boolean(vehicleCache.value);
    },
    isVehiclePayloadFresh(now = new Date()) {
      return isVehicleCacheFresh(now);
    },
    getCachedVehiclePayload({ stale = false, generatedAt } = {}) {
      if (!vehicleCache.value) {
        return null;
      }

      if (!stale) {
        return vehicleCache.value;
      }

      const payload = {
        ...vehicleCache.value,
        stale: true,
      };

      if (generatedAt) {
        payload.generatedAt = generatedAt;
      }

      if (vehicleCache.error) {
        payload.upstreamError = vehicleCache.error;
      }

      return payload;
    },
    async refreshVehiclePayload(now = new Date()) {
      return startVehicleRefresh(now);
    },
    async getVehiclePayload({ preferCache = false } = {}) {
      const now = new Date();

      if (vehicleCache.value && isVehicleCacheFresh(now)) {
        return vehicleCache.value;
      }

      if (preferCache && vehicleCache.value) {
        void startVehicleRefresh(now);
        return this.getCachedVehiclePayload({
          stale: true,
          generatedAt: now.toISOString(),
        });
      }

      return startVehicleRefresh(now);
    },
  };

  function isVehicleCacheFresh(now) {
    if (!vehicleCache.value || !vehicleCache.lastSuccessfulAt) {
      return false;
    }

    const age = now.getTime() - new Date(vehicleCache.lastSuccessfulAt).getTime();
    return age < updateIntervalMs;
  }

  function startVehicleRefresh(now) {
    if (vehicleCache.inFlight) {
      return vehicleCache.inFlight;
    }

    const previousPayload = vehicleCache.value;
    const previousLastSuccessfulAt = vehicleCache.lastSuccessfulAt;
    vehicleCache.inFlight = refreshVehicles(now)
      .then((refreshState) => {
        const payload = mergeVehiclePayload(previousPayload, refreshState, previousLastSuccessfulAt);
        vehicleCache.value = payload;
        vehicleCache.lastSuccessfulAt = payload.lastSuccessfulAt;
        vehicleCache.error = refreshState.upstreamError ?? null;
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
  }

  async function refreshVehicles(now) {
    const routeCandidateState = await fetchRouteCandidates(now);
    const activeCandidates = routeCandidateState.candidates.filter((candidate) => isActiveCandidate(candidate, now));
    const hydrateResults = await Promise.allSettled(activeCandidates.map((candidate) => hydrateVehicle(candidate, now)));
    const vehicles = [];
    let hydrateRejectedCount = 0;
    let hydrateMissingPositionCount = 0;

    for (const result of hydrateResults) {
      if (result.status === "rejected") {
        hydrateRejectedCount += 1;
        continue;
      }

      if (!result.value) {
        hydrateMissingPositionCount += 1;
        continue;
      }

      vehicles.push(result.value);
    }

    const generatedAt = new Date().toISOString();
    const degradationReasons = [];
    if (routeCandidateState.degradedCount > 0) {
      degradationReasons.push(`route_search:${routeCandidateState.degradedCount}`);
    }
    if (hydrateRejectedCount > 0) {
      degradationReasons.push(`hydrate_error:${hydrateRejectedCount}`);
    }
    if (hydrateMissingPositionCount > 0) {
      degradationReasons.push(`position_missing:${hydrateMissingPositionCount}`);
    }

    return {
      generatedAt,
      queryWindowMinutes: queryOffsetsMinutes,
      vehicles: vehicles.sort(compareVehicles),
      isDegraded: degradationReasons.length > 0,
      upstreamError: degradationReasons.length ? degradationReasons.join(", ") : null,
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
    const responses = await Promise.allSettled(
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
    let degradedCount = 0;

    for (const result of responses) {
      if (result.status !== "fulfilled") {
        degradedCount += 1;
        continue;
      }

      const response = result.value;
      if (response._degraded) {
        degradedCount += 1;
      }
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

    return {
      candidates: [...byTrip.values()].map((segments) => mergeTripCandidates(segments, now)),
      degradedCount,
    };
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
      if (message === "/route_search failed with 500" || message.includes("timed out") || message === "This operation was aborted") {
        return {
          datetime: params.dateTime,
          candidate_list: [],
          _degraded: true,
          _degradedReason: message,
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`${pathname} timed out after ${upstreamRequestTimeoutMs}ms`));
    }, upstreamRequestTimeoutMs);

    let response;
    try {
      response = await fetchImpl(`https://navi.kanto-tetsudo.com${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://navi.kanto-tetsudo.com",
          Referer: "https://navi.kanto-tetsudo.com/search_dest",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : null;
      if (reason instanceof Error) {
        throw reason;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`${pathname} failed with ${response.status}`);
    }

    return response.json();
  }
}

function mergeVehiclePayload(previousPayload, refreshState, previousLastSuccessfulAt) {
  if (!previousPayload) {
    return finalizeVehiclePayload({
      generatedAt: refreshState.generatedAt,
      lastSuccessfulAt: refreshState.generatedAt,
      queryWindowMinutes: refreshState.queryWindowMinutes,
      vehicles: refreshState.vehicles,
      stale: false,
      upstreamError: refreshState.upstreamError,
    });
  }

  if (!refreshState.isDegraded) {
    return finalizeVehiclePayload({
      generatedAt: refreshState.generatedAt,
      lastSuccessfulAt: refreshState.generatedAt,
      queryWindowMinutes: refreshState.queryWindowMinutes,
      vehicles: refreshState.vehicles,
      stale: false,
      upstreamError: null,
    });
  }

  const mergedByTrip = new Map(previousPayload.vehicles.map((vehicle) => [vehicle.tripId, vehicle]));
  for (const vehicle of refreshState.vehicles) {
    mergedByTrip.set(vehicle.tripId, vehicle);
  }

  return finalizeVehiclePayload({
    generatedAt: refreshState.generatedAt,
    lastSuccessfulAt: refreshState.generatedAt,
    queryWindowMinutes: refreshState.queryWindowMinutes,
    vehicles: [...mergedByTrip.values()],
    stale: true,
    upstreamError: refreshState.upstreamError,
  });
}

function finalizeVehiclePayload({ generatedAt, lastSuccessfulAt, queryWindowMinutes, vehicles, stale, upstreamError }) {
  const sortedVehicles = [...vehicles].sort(compareVehicles);
  const payload = {
    generatedAt,
    lastSuccessfulAt,
    queryWindowMinutes,
    vehicles: sortedVehicles,
    stats: {
      activeCount: sortedVehicles.length,
      clockwiseCount: sortedVehicles.filter((vehicle) => vehicle.direction === "clockwise").length,
      counterclockwiseCount: sortedVehicles.filter((vehicle) => vehicle.direction === "counterclockwise").length,
    },
  };

  if (stale) {
    payload.stale = true;
  }

  if (upstreamError) {
    payload.upstreamError = upstreamError;
  }

  return payload;
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
  const normalized = text.replace(" ", "T") + ":00+09:00";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeStringToDate(baseDate, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const jst = toJstParts(baseDate);
  return new Date(`${jst.year}-${pad2(jst.month)}-${pad2(jst.day)}T${pad2(hours)}:${pad2(minutes)}:00+09:00`);
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
  const leftJst = toJstParts(left);
  const rightJst = toJstParts(right);
  return leftJst.year === rightJst.year && leftJst.month === rightJst.month && leftJst.day === rightJst.day;
}

function formatApiDateTime(date) {
  const jst = toJstParts(date);
  return `${jst.year}-${pad2(jst.month)}-${pad2(jst.day)} ${pad2(jst.hours)}:${pad2(jst.minutes)}`;
}

function formatShortTime(date) {
  const jst = toJstParts(date);
  return `${pad2(jst.hours)}:${pad2(jst.minutes)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toJstParts(date) {
  const shifted = new Date(date.getTime() + jstOffsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}
