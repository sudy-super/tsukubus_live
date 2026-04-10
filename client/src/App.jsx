import { useEffect, useMemo, useRef, useState } from "react";

const googleMapsApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
const stopIconUrl = "/bus_icon.png";
const campusOverlayMaxZoom = 17;
const mobileSheetBreakpoint = 980;
const mobileSheetCollapsedHeight = 68;
const mobileSheetDefaultRatio = 0.4;
const mobileSheetExpandedRatio = 0.92;

const googleMapsStyles = [
  { elementType: "geometry", stylers: [{ color: "#334458" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#2f6b5f" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#2f6b5f" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6b9a76" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#61718b" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#334458" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1f2835" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f3d19c" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f3948" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#515c6d" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#17263c" }] },
];

export default function App() {
  const [stops, setStops] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [campusTileManifest, setCampusTileManifest] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedVehicleId, setSelectedVehicleId] = useState(null);
  const [selectedStopId, setSelectedStopId] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [mobileSheetHeight, setMobileSheetHeight] = useState(() =>
    getDefaultMobileSheetHeight(window.innerHeight),
  );
  const [dragSheetHeight, setDragSheetHeight] = useState(null);
  const mapRef = useRef(null);
  const sheetContentRef = useRef(null);
  const detailSectionRef = useRef(null);
  const mobileSheetHeightRef = useRef(mobileSheetHeight);
  const sheetDragStateRef = useRef(null);
  const ignoreSheetHandleClickRef = useRef(false);
  const sheetTouchStartYRef = useRef(null);
  const sheetTouchStartScrollTopRef = useRef(0);
  const pendingDetailScrollRef = useRef(false);

  const isMobileSheet = viewportWidth <= mobileSheetBreakpoint;

  const setMobileSheetHeightWithScrollReset = (nextHeight) => {
    if (!isMobileSheet) {
      return;
    }

    const maxHeight = getExpandedMobileSheetHeight(viewportHeight);
    const currentHeight = dragSheetHeight ?? mobileSheetHeightRef.current;
    const isShrinkingFromExpanded = currentHeight >= maxHeight - 2 && nextHeight < maxHeight - 2;
    const applyHeight = () => {
      setDragSheetHeight(null);
      setMobileSheetHeight(nextHeight);
    };

    if (isShrinkingFromExpanded && sheetContentRef.current) {
      sheetContentRef.current.scrollTo({ top: 0, behavior: "auto" });
      window.requestAnimationFrame(applyHeight);
      return;
    }

    applyHeight();
  };

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      const [stopsPayload, campusTilesPayload] = await Promise.all([
        fetchJson("/api/stops"),
        fetchJson("/api/campus-map-tiles").catch(() => ({ tiles: [], coverage: null })),
      ]);

      if (cancelled) {
        return;
      }

      setStops(stopsPayload.stops);
      setCampusTileManifest(campusTilesPayload);
    }

    initialize().catch((error) => {
      console.error(error);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    mobileSheetHeightRef.current = mobileSheetHeight;
  }, [mobileSheetHeight]);

  useEffect(() => {
    if (!isMobileSheet) {
      setDragSheetHeight(null);
      return;
    }

    const minHeight = getMobileSheetCollapsedHeight(viewportHeight);
    const maxHeight = getExpandedMobileSheetHeight(viewportHeight);
    const defaultHeight = getDefaultMobileSheetHeight(viewportHeight);
    const clampedHeight = clampSheetHeight(mobileSheetHeightRef.current ?? defaultHeight, minHeight, maxHeight);
    setMobileSheetHeight(clampedHeight);
  }, [isMobileSheet, viewportHeight]);

  useEffect(() => {
    if (!isMobileSheet) {
      return;
    }

    const handlePointerMove = (event) => {
      const dragState = sheetDragStateRef.current;
      if (!dragState) {
        return;
      }

      const nextHeight = clampSheetHeight(
        dragState.startHeight + (dragState.startY - event.clientY),
        dragState.minHeight,
        dragState.maxHeight,
      );
      dragState.currentHeight = nextHeight;
      if (Math.abs(event.clientY - dragState.startY) > 6) {
        ignoreSheetHandleClickRef.current = true;
      }
      setDragSheetHeight(nextHeight);
    };

    const handlePointerUp = () => {
      const dragState = sheetDragStateRef.current;
      if (!dragState) {
        return;
      }

      const currentHeight = dragState.currentHeight ?? dragState.startHeight;
      const snapHeight = snapMobileSheetHeight(currentHeight, dragState.minHeight, dragState.defaultHeight, dragState.maxHeight);
      sheetDragStateRef.current = null;
      setMobileSheetHeightWithScrollReset(snapHeight);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dragSheetHeight, isMobileSheet, viewportHeight]);

  useEffect(() => {
    let cancelled = false;
    let intervalId;

    async function loadVehicles() {
      try {
        const payload = await fetchJson("/api/vehicles");
        if (cancelled) {
          return;
        }

        setVehicles(payload.vehicles ?? []);
        setLastUpdatedAt(payload.lastSuccessfulAt || payload.generatedAt || null);
      } catch (error) {
        console.error(error);
      }
    }

    loadVehicles();
    intervalId = window.setInterval(loadVehicles, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.tripId === selectedVehicleId) ?? null,
    [vehicles, selectedVehicleId],
  );

  const selectedStop = useMemo(
    () => stops.find((stop) => stop.id === selectedStopId) ?? null,
    [stops, selectedStopId],
  );
  const selectedDetailKey = selectedStopId ?? selectedVehicleId;

  const stopArrivals = useMemo(() => {
    if (!selectedStop) {
      return [];
    }

    return vehicles
      .map((vehicle) => {
        const prediction = vehicle.pathPredictions?.find((entry) => entry.stopName === selectedStop.name);
        return prediction ? { vehicle, prediction } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.prediction.estimatedAt.localeCompare(right.prediction.estimatedAt));
  }, [vehicles, selectedStop]);

  const resolvedMobileSheetVisibleHeight = isMobileSheet
    ? dragSheetHeight ?? mobileSheetHeight
    : null;
  const mobileSheetMaxHeight = isMobileSheet ? getExpandedMobileSheetHeight(viewportHeight) : null;
  const mobileSheetMinHeight = isMobileSheet ? getMobileSheetCollapsedHeight(viewportHeight) : null;
  const isMobileSheetExpanded = isMobileSheet && mobileSheetMaxHeight
    ? resolvedMobileSheetVisibleHeight >= mobileSheetMaxHeight - 2
    : false;
  const isMobileSheetCollapsed = isMobileSheet && mobileSheetMinHeight
    ? resolvedMobileSheetVisibleHeight <= mobileSheetMinHeight + 2
    : false;

  const expandMobileSheet = () => {
    if (!isMobileSheet) {
      return;
    }

    setDragSheetHeight(null);
    setMobileSheetHeight(getExpandedMobileSheetHeight(viewportHeight));
  };

  const collapseMobileSheetToCollapsed = () => {
    if (!isMobileSheet) {
      return;
    }

    setMobileSheetHeightWithScrollReset(getMobileSheetCollapsedHeight(viewportHeight));
  };

  const collapseMobileSheetToDefault = () => {
    if (!isMobileSheet) {
      return;
    }

    setMobileSheetHeightWithScrollReset(getDefaultMobileSheetHeight(viewportHeight));
  };

  const isMobileSheetAtDefault = isMobileSheet && resolvedMobileSheetVisibleHeight != null
    ? Math.abs(resolvedMobileSheetVisibleHeight - getDefaultMobileSheetHeight(viewportHeight)) <= 2
    : false;

  const handleMapClearSelection = () => {
    setSelectedVehicleId(null);
    setSelectedStopId(null);
    pendingDetailScrollRef.current = false;
    if (isMobileSheetExpanded) {
      collapseMobileSheetToDefault();
    }
  };

  useEffect(() => {
    if (!isMobileSheet || !isMobileSheetExpanded || !selectedDetailKey || !pendingDetailScrollRef.current) {
      return;
    }

    const sheetElement = sheetContentRef.current;
    const detailElement = detailSectionRef.current;
    if (!sheetElement || !detailElement) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      sheetElement.scrollTo({
        top: Math.max(0, detailElement.offsetTop - 8),
        behavior: "smooth",
      });
      pendingDetailScrollRef.current = false;
    }, 220);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isMobileSheet, isMobileSheetExpanded, selectedDetailKey]);

  return (
    <div className="app">
      <MapCanvas
        mapRef={mapRef}
        stops={stops}
        vehicles={vehicles}
        campusTileManifest={campusTileManifest}
        selectedVehicleId={selectedVehicleId}
        selectedStopId={selectedStopId}
        onClearSelection={handleMapClearSelection}
        onMapInteract={() => {
          if (isMobileSheetAtDefault) {
            collapseMobileSheetToCollapsed();
          }
        }}
        onSelectVehicle={(vehicle) => {
          pendingDetailScrollRef.current = isMobileSheet;
          setSelectedVehicleId(vehicle.tripId);
          setSelectedStopId(null);
          if (isMobileSheet) {
            expandMobileSheet();
          }
        }}
        onSelectStop={(stop) => {
          pendingDetailScrollRef.current = isMobileSheet;
          setSelectedStopId(stop.id);
          setSelectedVehicleId(null);
          if (isMobileSheet) {
            expandMobileSheet();
          }
        }}
      />

      <section className="floating-status">
        <div className="update-row">
          <span>最終更新</span>
          <strong>{formatRelativeTime(lastUpdatedAt, nowMs)}</strong>
        </div>
      </section>

      <section
        className={`control-sheet ${isMobileSheet ? "is-mobile-sheet" : ""} ${isMobileSheetExpanded ? "is-mobile-expanded" : ""} ${isMobileSheetCollapsed ? "is-mobile-collapsed" : ""}`}
        style={
          isMobileSheet && resolvedMobileSheetVisibleHeight && mobileSheetMaxHeight
            ? {
              "--mobile-sheet-height": `${mobileSheetMaxHeight}px`,
              "--mobile-sheet-offset": `${Math.max(0, mobileSheetMaxHeight - resolvedMobileSheetVisibleHeight)}px`,
            }
            : undefined
        }
      >
        <button
          className="sheet-handle"
          type="button"
          onClick={() => {
            if (!isMobileSheet) {
              return;
            }

            if (ignoreSheetHandleClickRef.current) {
              ignoreSheetHandleClickRef.current = false;
              return;
            }

            const minHeight = getMobileSheetCollapsedHeight(viewportHeight);
            const defaultHeight = getDefaultMobileSheetHeight(viewportHeight);
            const maxHeight = getExpandedMobileSheetHeight(viewportHeight);
            const currentHeight = resolvedMobileSheetVisibleHeight ?? defaultHeight;
            const nextHeight = currentHeight <= minHeight + 2
              ? defaultHeight
              : currentHeight >= maxHeight - 2
                ? defaultHeight
                : maxHeight;
            if (nextHeight < currentHeight) {
              setMobileSheetHeightWithScrollReset(nextHeight);
              return;
            }
            setMobileSheetHeight(nextHeight);
          }}
          onPointerDown={(event) => {
            if (!isMobileSheet) {
              return;
            }

            event.preventDefault();
            const minHeight = getMobileSheetCollapsedHeight(viewportHeight);
            const defaultHeight = getDefaultMobileSheetHeight(viewportHeight);
            const maxHeight = getExpandedMobileSheetHeight(viewportHeight);
            sheetDragStateRef.current = {
              startY: event.clientY,
              startHeight: resolvedMobileSheetVisibleHeight ?? mobileSheetHeightRef.current,
              currentHeight: resolvedMobileSheetVisibleHeight ?? mobileSheetHeightRef.current,
              minHeight,
              defaultHeight,
              maxHeight,
            };
            setDragSheetHeight(resolvedMobileSheetVisibleHeight ?? mobileSheetHeightRef.current);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
        >
          <span></span>
        </button>

        <div
          ref={sheetContentRef}
          className="sheet-content"
          onWheel={(event) => {
            if (!isMobileSheet) {
              return;
            }

            const sheetElement = sheetContentRef.current;
            if (isMobileSheetExpanded) {
              if (sheetElement && sheetElement.scrollTop <= 0 && event.deltaY < -12) {
                event.preventDefault();
                collapseMobileSheetToDefault();
              }
              return;
            }

            event.preventDefault();
            expandMobileSheet();
          }}
          onTouchStart={(event) => {
            if (!isMobileSheet) {
              return;
            }

            sheetTouchStartScrollTopRef.current = sheetContentRef.current?.scrollTop ?? 0;
            sheetTouchStartYRef.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchMove={(event) => {
            if (!isMobileSheet) {
              return;
            }

            const startY = sheetTouchStartYRef.current;
            const currentY = event.touches[0]?.clientY;
            if (startY == null || currentY == null) {
              return;
            }

            if (Math.abs(startY - currentY) < 6) {
              return;
            }

            if (isMobileSheetExpanded) {
              const sheetElement = sheetContentRef.current;
              const isPullingDown = currentY > startY;
              const startedAtTop = sheetTouchStartScrollTopRef.current <= 0;
              const isStillAtTop = (sheetElement?.scrollTop ?? 0) <= 0;

              if (isPullingDown && startedAtTop && isStillAtTop && currentY - startY > 18) {
                event.preventDefault();
                sheetTouchStartYRef.current = null;
                collapseMobileSheetToDefault();
              }
              return;
            }

            event.preventDefault();
            sheetTouchStartYRef.current = null;
            expandMobileSheet();
          }}
          onTouchEnd={() => {
            sheetTouchStartYRef.current = null;
            sheetTouchStartScrollTopRef.current = 0;
          }}
        >
          <div className="section-block">
            <div className="section-title-row">
              <h2>運行中の車両</h2>
            </div>
            <div className="vehicle-chip-list">
              {vehicles.length ? (
                vehicles.map((vehicle) => (
                  <VehicleChip
                    key={vehicle.tripId}
                    vehicle={vehicle}
                    isActive={selectedVehicleId === vehicle.tripId}
                    onClick={() => {
                      setSelectedVehicleId(vehicle.tripId);
                      setSelectedStopId(null);
                      mapRef.current?.focusVehicle(vehicle);
                    }}
                  />
                ))
              ) : (
                <div className="empty-line">表示対象の車両はありません。</div>
              )}
            </div>
          </div>

          <div ref={detailSectionRef} className="section-block">
            {selectedVehicle ? (
              <VehicleDetail vehicle={selectedVehicle} />
            ) : selectedStop ? (
              <StopDetail stop={selectedStop} arrivals={stopArrivals} />
            ) : (
              <div className="detail-card detail-card--empty">
                <div className="detail-empty">地図上の停留所ラベルか車両マーカーを選択してください。</div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function getMobileSheetCollapsedHeight(viewportHeight) {
  return mobileSheetCollapsedHeight;
}

function getDefaultMobileSheetHeight(viewportHeight) {
  return Math.round(viewportHeight * mobileSheetDefaultRatio);
}

function getExpandedMobileSheetHeight(viewportHeight) {
  return Math.round(viewportHeight * mobileSheetExpandedRatio);
}

function clampSheetHeight(value, minHeight, maxHeight) {
  return Math.min(Math.max(value, minHeight), maxHeight);
}

function snapMobileSheetHeight(value, minHeight, defaultHeight, maxHeight) {
  const snapPoints = [minHeight, defaultHeight, maxHeight];
  let nearest = snapPoints[0];
  let nearestDistance = Math.abs(value - nearest);

  for (const point of snapPoints.slice(1)) {
    const distance = Math.abs(value - point);
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function VehicleChip({ vehicle, isActive, onClick }) {
  const routeLabelRef = useRef(null);
  const routeMeasureRef = useRef(null);
  const [routeFontPx, setRouteFontPx] = useState(null);
  const routeLabel = `${displayStopName(vehicle.currentStopName) || "走行中"} → ${displayStopName(vehicle.nextStopName) || "終点"}`;

  useEffect(() => {
    const labelElement = routeLabelRef.current;
    const measureElement = routeMeasureRef.current;
    if (!labelElement || !measureElement) {
      return;
    }

    const update = () => {
      const rootFontPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const baseFontPx = window.matchMedia("(max-width: 420px)").matches ? rootFontPx * 0.9 : rootFontPx * 0.95;
      measureElement.style.fontSize = `${baseFontPx}px`;

      const availableWidth = labelElement.clientWidth;
      const measuredWidth = measureElement.getBoundingClientRect().width;
      if (!availableWidth || !measuredWidth) {
        setRouteFontPx(baseFontPx);
        return;
      }

      const nextFontPx = measuredWidth > availableWidth
        ? Math.max(1, (baseFontPx * availableWidth) / measuredWidth - 0.2)
        : baseFontPx;

      setRouteFontPx(nextFontPx);
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(labelElement);

    return () => {
      observer.disconnect();
    };
  }, [routeLabel]);

  return (
    <button
      type="button"
      className={`vehicle-chip ${vehicle.direction} ${isActive ? "is-active" : ""}`}
      onClick={onClick}
    >
      <span className="vehicle-chip-direction">{vehicle.directionLabel}</span>
      <strong
        ref={routeLabelRef}
        className="vehicle-chip__route"
        style={routeFontPx ? { fontSize: `${routeFontPx}px` } : undefined}
      >
        {routeLabel}
      </strong>
      <span ref={routeMeasureRef} className="vehicle-chip__route vehicle-chip__route--measure" aria-hidden="true">
        {routeLabel}
      </span>
      <span>{vehicle.delayLabel || "定刻"}</span>
    </button>
  );
}

function MapCanvas({
  mapRef,
  stops,
  vehicles,
  campusTileManifest,
  selectedVehicleId,
  selectedStopId,
  onClearSelection,
  onMapInteract,
  onSelectVehicle,
  onSelectStop,
}) {
  const containerRef = useRef(null);
  const [mapError, setMapError] = useState(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const mapInstanceRef = useRef(null);
  const mapListenersRef = useRef([]);
  const googleMapsRef = useRef(null);
  const campusTileLayerRef = useRef(null);
  const stopLayerRef = useRef([]);
  const vehicleLayerRef = useRef([]);
  const hasFittedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapInstanceRef.current) {
      return;
    }

    if (!googleMapsApiKey) {
      setMapError("GOOGLE_MAPS_API_KEY が見つかりません。");
      return;
    }

    let cancelled = false;

    loadGoogleMapsApi(googleMapsApiKey)
      .then((googleMaps) => {
        if (cancelled || mapInstanceRef.current) {
          return;
        }

        googleMapsRef.current = googleMaps;
        const map = new googleMaps.Map(containerRef.current, {
          center: { lat: 36.108, lng: 140.103 },
          zoom: 15,
          maxZoom: campusOverlayMaxZoom,
          styles: googleMapsStyles,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          rotateControl: false,
          clickableIcons: false,
          gestureHandling: "greedy",
          isFractionalZoomEnabled: false,
          tilt: 0,
          zoomControl: true,
        });
        mapListenersRef.current = [map.addListener("idle", () => snapMapZoomToInteger(map))];

        mapInstanceRef.current = map;
        setIsMapReady(true);
        mapRef.current = {
          focusVehicle(vehicle) {
            map.panTo({ lat: vehicle.lat, lng: vehicle.lon });
            if ((map.getZoom() ?? 0) < 16) {
              map.setZoom(16);
            }
          },
        };
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) {
          setMapError("Google Maps の初期化に失敗しました。");
        }
      });

    return () => {
      cancelled = true;
      setIsMapReady(false);
      removeOverlayMapType(mapInstanceRef.current, campusTileLayerRef.current);
      clearGoogleOverlays(stopLayerRef.current);
      clearGoogleOverlays(vehicleLayerRef.current);
      clearGoogleListeners(mapListenersRef.current);
      mapListenersRef.current = [];
      campusTileLayerRef.current = null;
      mapInstanceRef.current = null;
      mapRef.current = null;
    };
  }, [mapRef]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) {
      return;
    }

    const listener = map.addListener("click", () => {
      onClearSelection();
    });

    return () => {
      listener.remove();
    };
  }, [isMapReady, onClearSelection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const shouldIgnoreTarget = (target) =>
      target instanceof Element &&
      !!target.closest(".stop-label, .vehicle-marker");

    const handlePointerLikeInteraction = (event) => {
      if (shouldIgnoreTarget(event.target)) {
        return;
      }
      onMapInteract?.();
    };

    container.addEventListener("pointerdown", handlePointerLikeInteraction, { passive: true });
    container.addEventListener("touchstart", handlePointerLikeInteraction, { passive: true });
    container.addEventListener("wheel", handlePointerLikeInteraction, { passive: true });

    return () => {
      container.removeEventListener("pointerdown", handlePointerLikeInteraction);
      container.removeEventListener("touchstart", handlePointerLikeInteraction);
      container.removeEventListener("wheel", handlePointerLikeInteraction);
    };
  }, [onMapInteract]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const googleMaps = googleMapsRef.current;
    if (!map || !googleMaps) {
      return;
    }

    removeOverlayMapType(map, campusTileLayerRef.current);
    campusTileLayerRef.current = null;

    if (!campusTileManifest?.tiles?.length) {
      return;
    }

    const tileLookup = new Map(
      campusTileManifest.tiles.map((tile) => [`${tile.z}/${tile.x}/${tile.y}`, tile.url]),
    );
    const tileSize = campusTileManifest.tileSize || 256;
    const maxOverlayZoom = Math.min(campusOverlayMaxZoom, campusTileManifest.coverage?.maxZoom ?? campusOverlayMaxZoom);
    const tileLayer = {
      getTile(coordinate, zoom, ownerDocument) {
        const resolved = resolveOverlayTile({ coordinate, zoom, maxZoom: maxOverlayZoom, tileLookup });
        return createOverlayTileElement({ coordinate, zoom, ownerDocument, tileSize, resolved });
      },
      releaseTile() {},
      tileSize: new googleMaps.Size(tileSize, tileSize),
      name: "campus-map",
      minZoom: campusTileManifest.coverage?.minZoom ?? undefined,
      maxZoom: maxOverlayZoom,
    };

    map.overlayMapTypes.insertAt(0, tileLayer);
    campusTileLayerRef.current = tileLayer;

    return () => {
      removeOverlayMapType(map, tileLayer);
      if (campusTileLayerRef.current === tileLayer) {
        campusTileLayerRef.current = null;
      }
    };
  }, [campusTileManifest, isMapReady]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const googleMaps = googleMapsRef.current;
    if (!map || !googleMaps) {
      return;
    }

    clearGoogleOverlays(stopLayerRef.current);

    stopLayerRef.current = stops.map(
      (stop) =>
        new HtmlOverlayMarker(googleMaps, {
          map,
          position: { lat: stop.lat, lng: stop.lon },
          anchorX: 14,
          anchorY: 18,
          zIndex: stop.id === selectedStopId ? 2000 : 1000,
          html: createStopMarkerHtml(stop, stop.id === selectedStopId),
          onClick: () => onSelectStop(stop),
        }),
    );

    if (stops.length && !hasFittedRef.current) {
      const bounds = new googleMaps.LatLngBounds();
      for (const stop of stops) {
        bounds.extend({ lat: stop.lat, lng: stop.lon });
      }
      map.fitBounds(bounds, 64);
      googleMaps.event.addListenerOnce(map, "idle", () => snapMapZoomToInteger(map));
      hasFittedRef.current = true;
    }
  }, [stops, selectedStopId, onSelectStop]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const googleMaps = googleMapsRef.current;
    if (!map || !googleMaps) {
      return;
    }

    clearGoogleOverlays(vehicleLayerRef.current);

    vehicleLayerRef.current = vehicles.map(
      (vehicle) =>
        new HtmlOverlayMarker(googleMaps, {
          map,
          position: { lat: vehicle.lat, lng: vehicle.lon },
          anchorX: 28,
          anchorY: 23,
          zIndex: vehicle.tripId === selectedVehicleId ? 3000 : 2200,
          html: createVehicleMarkerHtml(vehicle, vehicle.tripId === selectedVehicleId),
          onClick: () => onSelectVehicle(vehicle),
        }),
    );
  }, [vehicles, selectedVehicleId, onSelectVehicle]);

  return (
    <div className="map-canvas-wrap">
      <div ref={containerRef} className="map-canvas"></div>
      {mapError ? <div className="map-error">{mapError}</div> : null}
    </div>
  );
}

function VehicleDetail({ vehicle }) {
  const predictions = vehicle.pathPredictions ?? [];

  return (
    <div className="vehicle-detail">
      <div className="detail-subtitle">この先の停留所</div>
      <div className="detail-card">
        <ul className="prediction-list">
          {predictions.map((prediction) => (
            <li key={`${vehicle.tripId}-${prediction.seq}`}>
              <span>{displayStopName(prediction.stopName)}</span>
              <strong>{prediction.estimatedLabel}</strong>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StopArrivalRow({ vehicle, prediction }) {
  const currentStopRef = useRef(null);
  const currentStopMeasureRef = useRef(null);
  const [currentStopFontPx, setCurrentStopFontPx] = useState(null);
  const currentStopLabel = displayStopName(vehicle.currentStopName) || "走行中";

  useEffect(() => {
    const currentStopElement = currentStopRef.current;
    const measureElement = currentStopMeasureRef.current;
    if (!currentStopElement || !measureElement) {
      return;
    }

    const update = () => {
      const baseFontPx = Number.parseFloat(getComputedStyle(currentStopElement).fontSize) || 16;
      measureElement.style.fontSize = `${baseFontPx}px`;

      const availableWidth = currentStopElement.clientWidth;
      const measuredWidth = measureElement.getBoundingClientRect().width;
      if (!availableWidth || !measuredWidth) {
        setCurrentStopFontPx(baseFontPx);
        return;
      }

      const nextFontPx = measuredWidth > availableWidth
        ? Math.max(1, (baseFontPx * availableWidth) / measuredWidth - 0.2)
        : baseFontPx;

      setCurrentStopFontPx(nextFontPx);
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(currentStopElement);

    return () => {
      observer.disconnect();
    };
  }, [currentStopLabel]);

  return (
    <div className="stop-arrival-table__row">
      <strong>{vehicle.directionLabel}</strong>
      <strong
        ref={currentStopRef}
        className="stop-arrival-table__current-stop"
        style={currentStopFontPx ? { fontSize: `${currentStopFontPx}px` } : undefined}
      >
        {currentStopLabel}
      </strong>
      <span
        ref={currentStopMeasureRef}
        className="stop-arrival-table__current-stop stop-arrival-table__current-stop--measure"
        aria-hidden="true"
      >
        {currentStopLabel}
      </span>
      <strong>{prediction.estimatedLabel}</strong>
    </div>
  );
}

function StopDetail({ stop, arrivals }) {
  return (
    <div className="stop-detail">
      <div className="detail-subtitle">{displayStopName(stop.name)}へ向かう車両</div>
      <div className="detail-card">
        {arrivals.length ? (
          <div className="stop-arrival-table">
            <div className="stop-arrival-table__row stop-arrival-table__row--header">
              <span>回り方</span>
              <span>現在地</span>
              <span>到着時間</span>
            </div>
            {arrivals.map(({ vehicle, prediction }) => (
              <StopArrivalRow
                key={`${vehicle.tripId}-${prediction.seq}`}
                vehicle={vehicle}
                prediction={prediction}
              />
            ))}
          </div>
        ) : (
          <div className="empty-line">N/A</div>
        )}
      </div>
    </div>
  );
}

function createStopMarkerHtml(stop, selected) {
  return `
    <div class="stop-label ${selected ? "is-selected" : ""}">
      <img class="stop-label__icon" src="${stopIconUrl}" alt="" aria-hidden="true" />
      <span class="stop-label__text">${escapeHtml(displayStopName(stop.name))}</span>
    </div>
  `;
}

function createVehicleMarkerHtml(vehicle, selected) {
  const directionLabel = vehicle.direction === "clockwise" ? "右" : "左";
  const delayMinutes = Number.isFinite(vehicle.delayMinutes) ? vehicle.delayMinutes : 0;
  const delayClassName = delayMinutes === 0 ? "vehicle-marker__delay is-on-time" : "vehicle-marker__delay";
  const delay = `<span class="${delayClassName}">${delayMinutes}</span>`;
  const headingDeg = Number.isFinite(vehicle.headingDeg) ? vehicle.headingDeg : 0;

  return `
    <div class="vehicle-marker ${vehicle.direction} ${selected ? "is-selected" : ""}" style="--heading-deg: ${headingDeg}deg">
      <span class="vehicle-marker__pointer" aria-hidden="true"></span>
      <span class="vehicle-marker__badge">${directionLabel}</span>
      ${delay}
    </div>
  `;
}

function clearGoogleOverlays(overlays) {
  for (const overlay of overlays) {
    overlay.setMap(null);
  }
}

function clearGoogleListeners(listeners) {
  for (const listener of listeners) {
    listener?.remove?.();
  }
}

function removeOverlayMapType(map, overlay) {
  if (!map || !overlay) {
    return;
  }

  for (let index = map.overlayMapTypes.getLength() - 1; index >= 0; index -= 1) {
    if (map.overlayMapTypes.getAt(index) === overlay) {
      map.overlayMapTypes.removeAt(index);
    }
  }
}

function snapMapZoomToInteger(map) {
  const zoom = map?.getZoom?.();
  if (!Number.isFinite(zoom)) {
    return;
  }

  const snappedZoom = Math.round(zoom);
  if (Math.abs(zoom - snappedZoom) > 0.001) {
    map.setZoom(snappedZoom);
  }
}

function resolveOverlayTile({ coordinate, zoom, maxZoom, tileLookup }) {
  let currentZoom = zoom;
  let currentX = coordinate.x;
  let currentY = coordinate.y;

  if (currentZoom > maxZoom) {
    const zoomDelta = currentZoom - maxZoom;
    currentZoom = maxZoom;
    currentX = Math.floor(currentX / (2 ** zoomDelta));
    currentY = Math.floor(currentY / (2 ** zoomDelta));
  }

  while (currentZoom >= 0) {
    const url = tileLookup.get(`${currentZoom}/${currentX}/${currentY}`);
    if (url) {
      return { url, z: currentZoom, x: currentX, y: currentY };
    }
    currentZoom -= 1;
    currentX = Math.floor(currentX / 2);
    currentY = Math.floor(currentY / 2);
  }

  return null;
}

function createOverlayTileElement({ coordinate, zoom, ownerDocument, tileSize, resolved }) {
  const tile = ownerDocument.createElement("div");
  tile.style.width = `${tileSize}px`;
  tile.style.height = `${tileSize}px`;
  tile.style.overflow = "hidden";
  tile.style.position = "relative";

  if (!resolved?.url) {
    return tile;
  }

  const zoomDelta = zoom - resolved.z;
  const scale = 2 ** zoomDelta;
  const img = ownerDocument.createElement("img");
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.draggable = false;
  img.src = resolved.url;
  img.style.position = "absolute";
  img.style.width = `${tileSize * scale}px`;
  img.style.height = `${tileSize * scale}px`;
  img.style.maxWidth = "none";
  img.style.userSelect = "none";
  img.style.pointerEvents = "none";
  img.style.left = `${-positiveModulo(coordinate.x, scale) * tileSize}px`;
  img.style.top = `${-positiveModulo(coordinate.y, scale) * tileSize}px`;
  tile.appendChild(img);
  return tile;
}

function positiveModulo(value, base) {
  return ((value % base) + base) % base;
}

class HtmlOverlayMarker {
  constructor(googleMaps, { map, position, html, anchorX, anchorY, zIndex, onClick }) {
    this.googleMaps = googleMaps;
    this.position = new googleMaps.LatLng(position);
    this.html = html;
    this.anchorX = anchorX;
    this.anchorY = anchorY;
    this.zIndex = zIndex;
    this.onClick = onClick;
    this.div = null;
    this.overlayView = new googleMaps.OverlayView();
    this.overlayView.onAdd = () => this.onAdd();
    this.overlayView.draw = () => this.draw();
    this.overlayView.onRemove = () => this.onRemove();
    this.overlayView.setMap(map);
  }

  setMap(map) {
    this.overlayView.setMap(map);
  }

  onAdd() {
    const panes = this.overlayView.getPanes();
    if (!panes) {
      return;
    }

    const div = document.createElement("div");
    div.className = "map-html-overlay";
    div.innerHTML = this.html;
    if (this.onClick) {
      div.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onClick();
      });
    }

    if (typeof this.googleMaps.OverlayView.preventMapHitsFrom === "function") {
      this.googleMaps.OverlayView.preventMapHitsFrom(div);
    }

    this.div = div;
    panes.overlayMouseTarget.appendChild(div);
  }

  draw() {
    const projection = this.overlayView.getProjection();
    if (!projection || !this.div) {
      return;
    }

    const point = projection.fromLatLngToDivPixel(this.position);
    if (!point) {
      return;
    }

    this.div.style.left = `${point.x - this.anchorX}px`;
    this.div.style.top = `${point.y - this.anchorY}px`;
    this.div.style.zIndex = String(this.zIndex);
  }

  onRemove() {
    if (!this.div) {
      return;
    }

    this.div.remove();
    this.div = null;
  }
}

let googleMapsApiPromise = null;

function loadGoogleMapsApi(apiKey) {
  if (window.google?.maps) {
    return Promise.resolve(window.google.maps);
  }

  if (googleMapsApiPromise) {
    return googleMapsApiPromise;
  }

  googleMapsApiPromise = new Promise((resolve, reject) => {
    const callbackName = `__initGoogleMaps${Date.now()}`;
    window[callbackName] = () => {
      resolve(window.google.maps);
      delete window[callbackName];
    };

    const script = document.createElement("script");
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&callback=${callbackName}&v=weekly&loading=async&language=ja&region=US`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      reject(new Error("Failed to load Google Maps API"));
      delete window[callbackName];
    };
    document.head.appendChild(script);
  });

  return googleMapsApiPromise;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}`);
  }
  return response.json();
}

function formatRelativeTime(value, nowMs) {
  if (!value) {
    return "--";
  }

  const updatedMs = new Date(value).getTime();
  if (Number.isNaN(updatedMs)) {
    return "--";
  }

  const diffSeconds = Math.max(0, Math.floor((nowMs - updatedMs) / 1_000));
  if (diffSeconds < 60) {
    return `${diffSeconds}秒前`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}分前`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours}時間前`;
}

function displayStopName(value) {
  if (!value) {
    return value;
  }

  return value === "筑波大学病院入口" ? "筑波大学病院東" : value;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
