import React, { useReducer, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import filterReducer, { initialState, ChainEntry, type FilterReducerAction, type FilterReducerState } from "reducers/filters";
import * as optionTypes from "constants/optionTypes";
import { filterList, grayscale } from "filters";
import { THEMES } from "palettes/user";
import { serializePalette } from "palettes";
import { decodeShareState } from "utils/shareState";
import { syncRandomCycleSeconds } from "utils/randomCycleBridge";
import { getActiveAudioVizChannel, getActiveAudioVizSnapshot, getGlobalAudioVizModulation, setGlobalAudioVizModulation, subscribeGlobalAudioVizModulation, type AudioVizMetric, type EntryAudioModulation } from "utils/audioVizBridge";
import { applyAudioModulationToOptions as applyAudioModulationToOptionsPure } from "utils/autoViz";
import { createReadbackCanvas, getReadbackContext, getWorkerPrevOutputFrame, WorkerPrevOutputPayload, logFilterDispatched, getFilterWasmStatuses, releasePooledCanvas, logFilterBackend } from "utils";
import { recordFilterStepMs } from "utils/slowFilterRegistry";
import { releasePooledTextures, glAvailable, glUnavailableStub } from "gl";
import { releaseFloatTextures } from "gl/fft2d";
import { USE_WORKER, workerRPC } from "workers/workerRPC";
import { clearMotionVectorsState } from "filters/motionVectors";
import { initMediaPipe, processFrame, drawMediaPipeResults } from "utils/mediapipe";
import { threeManager } from "utils/threeManager";
import { FilterContext } from "./filterContextValue";

import type { AnimatedVideoElement, ExportFrameOptions, FilterActions, FilterOptionValue } from "./filterContextValue";
import { getAutoScale, roundScale } from "./autoScale";
import { getShareHash, getShareUrl } from "./shareUrl";
import { type SerializedAudioVizModulation, type SerializedChainEntry, type SerializedFilterState, type ShareStateV1, type ShareStateV2 } from "./shareStateTypes";

type SerializableOptions = Record<string, unknown>;
type SerializedPaletteOption = { name?: string; options?: SerializableOptions };
type SerializablePalette = SerializedPaletteOption & {
  getColor?: (...args: unknown[]) => unknown;
};
const serializeAudioModulation = (audioMod: EntryAudioModulation | null | undefined): SerializedAudioVizModulation | undefined => {
  if (
    !audioMod
    || (
      (!Array.isArray(audioMod.connections) || audioMod.connections.length === 0)
      && (!Array.isArray(audioMod.normalizedMetrics) || audioMod.normalizedMetrics.length === 0)
    )
  ) {
    return undefined;
  }
  return {
    c: audioMod.connections.map((connection) => ({ k: connection.metric, o: connection.target, w: connection.weight })),
    ...(audioMod.normalizedMetrics?.length ? { z: [...audioMod.normalizedMetrics] } : {}),
  };
};

const applyAudioModulationToOptions = (
  options: Record<string, unknown>,
  optionTypes: NonNullable<ChainEntry["filter"]["optionTypes"]>,
  audioMod: EntryAudioModulation,
  entryId?: string,
) => applyAudioModulationToOptionsPure(
  options,
  optionTypes as never,
  audioMod,
  getActiveAudioVizSnapshot(),
  entryId,
);

const withAudioModulatedOptions = (entry: ChainEntry) => {
  if (!entry.filter.optionTypes || !entry.filter.options) return entry.filter.options;
  const snapshot = getActiveAudioVizSnapshot();
  if (!snapshot.enabled || snapshot.status !== "live") return entry.filter.options;
  let nextOptions: Record<string, unknown> = { ...entry.filter.options };
  if (entry.audioMod) {
    nextOptions = applyAudioModulationToOptions(
      nextOptions,
      entry.filter.optionTypes,
      entry.audioMod,
      entry.id,
    );
  }
  const globalMod = getGlobalAudioVizModulation(getActiveAudioVizChannel());
  if (globalMod) {
    nextOptions = applyAudioModulationToOptions(
      nextOptions,
      entry.filter.optionTypes,
      globalMod,
      entry.id,
    );
  }
  return nextOptions;
};
type FilterRunner = (input: HTMLCanvasElement | OffscreenCanvas | null) => void;
type AnimationParams = { inputCanvas: HTMLCanvasElement | null; fps: number };

const serializeState = (state: typeof initialState): SerializedFilterState => {
  const chain = state.chain;
  if (chain.length === 1) {
    const v1State: ShareStateV1 = {
      selected: state.selected,
      convertGrayscale: state.convertGrayscale,
      linearize: state.linearize,
      wasmAcceleration: state.wasmAcceleration,
      ...(state.randomCycleSeconds != null ? { r: state.randomCycleSeconds } : {}),
    };
    return v1State;
  }

  const serializedChain: SerializedChainEntry[] = chain.map((entry: ChainEntry) => {
    const result: SerializedChainEntry = { n: entry.filter.name };
    if (entry.displayName !== entry.filter.name) {
      result.d = entry.displayName;
    }
    const opts = entry.filter.options;
    const defaults = entry.filter.defaults;
    if (opts && defaults) {
      const delta: SerializableOptions = {};
      for (const [k, v] of Object.entries(opts)) {
        if (typeof v === "function") continue;
        if (k === "palette") {
          const paletteOption = v as SerializedPaletteOption | undefined;
          const pOpts = paletteOption?.options;
          const defaultPalette = defaults.palette as SerializedPaletteOption | undefined;
          const pDefaults = defaultPalette?.options;
          if (pOpts && JSON.stringify(pOpts) !== JSON.stringify(pDefaults)) {
            delta.palette = { name: paletteOption?.name, options: pOpts };
          }
        } else if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
          delta[k] = v;
        }
      }
      if (Object.keys(delta).length > 0) result.o = delta;
    } else if (opts) {
      const cleaned: SerializableOptions = {};
      for (const [k, v] of Object.entries(opts)) {
        if (typeof v !== "function") cleaned[k] = v;
      }
      result.o = cleaned;
    }
    if (!entry.enabled) result.e = false;
    const audioMod = serializeAudioModulation(entry.audioMod);
    if (audioMod) result.m = audioMod;
    return result;
  });

  const v2State: ShareStateV2 = {
    v: 2,
    chain: serializedChain,
    g: state.convertGrayscale,
    l: state.linearize,
    w: state.wasmAcceleration,
    ...(state.randomCycleSeconds != null ? { r: state.randomCycleSeconds } : {}),
  };
  const av: ShareStateV2["av"] = {};
  const chainGlobal = serializeAudioModulation(getGlobalAudioVizModulation("chain"));
  if (chainGlobal) av.chain = { m: chainGlobal };
  const screensaverGlobal = serializeAudioModulation(getGlobalAudioVizModulation("screensaver"));
  if (screensaverGlobal) av.screensaver = { m: screensaverGlobal };
  if (av.chain || av.screensaver) v2State.av = av;
  return v2State;
};

const deserializeAudioModulation = (data: SerializedAudioVizModulation | undefined): EntryAudioModulation | null => {
  if (!data || !Array.isArray(data.c) || data.c.length === 0) return null;
  return {
    connections: data.c.map((connection) => ({
      metric: connection.k as AudioVizMetric,
      target: connection.o,
      weight: connection.w,
    })),
    normalizedMetrics: Array.isArray(data.z) ? (data.z as AudioVizMetric[]) : [],
  };
};

const restoreAudioVizFromShareState = (data: SerializedFilterState) => {
  const av = "av" in data ? data.av : undefined;
  setGlobalAudioVizModulation("chain", deserializeAudioModulation(av?.chain?.m));
  setGlobalAudioVizModulation("screensaver", deserializeAudioModulation(av?.screensaver?.m));
};

const serializeStateJson = (state: typeof initialState, pretty = false) => {
  const data = serializeState(state);
  const replacer = (k: string, v: unknown) => {
    if (k === "defaults" || k === "optionTypes" || typeof v === "function") return undefined;
    return v;
  };
  return pretty ? JSON.stringify(data, replacer, 2) : JSON.stringify(data, replacer);
};

const DEFAULT_SHARE_STATE_JSON = serializeStateJson(initialState);

export const FilterProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(
    filterReducer as React.Reducer<FilterReducerState, FilterReducerAction>,
    initialState
  );
  const mainThreadPrevOutputMap = useRef<Map<string, Uint8ClampedArray>>(new Map());
  const mainThreadPrevInputMap = useRef<Map<string, Uint8ClampedArray>>(new Map());
  const mainThreadEmaMap = useRef<Map<string, Float32Array>>(new Map());
  const cachedOutputsRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const cachedChainOrderRef = useRef<string>("");
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameCountRef = useRef(0);
  const degaussFrameRef = useRef(-Infinity);
  const degaussAnimRef = useRef<number | null>(null);
  const animLoopRef = useRef<number | null>(null);
  const animLastTimeRef = useRef(0);
  const animParamsRef = useRef<AnimationParams | null>(null);
  const animLoopAutoStartedRef = useRef(false);
  const filteringRef = useRef(false);
  const pendingFilterRef = useRef(false);
  const videoFrameTokenRef = useRef(0);
  const exportSessionsRef = useRef<Map<string, {
    prevOutputMap: Map<string, Uint8ClampedArray>;
    prevInputMap: Map<string, Uint8ClampedArray>;
    emaMap: Map<string, Float32Array>;
    frameIndex: number;
  }>>(new Map());
  const stateRef = useRef<FilterReducerState>(state);
  stateRef.current = state;
  const filterImageAsyncRef = useRef<FilterRunner | null>(null);
  const filterWorkerRef = useRef<Worker | null>(null);

  const resetProcessingState = useCallback(() => {
    filteringRef.current = false;
    pendingFilterRef.current = false;
    videoFrameTokenRef.current = 0;
    clearCachedOutputs();
    cachedChainOrderRef.current = "";
    clearMotionVectorsState();

    if (filterWorkerRef.current) {
        filterWorkerRef.current.postMessage({ id: "clear", type: "CLEAR_STATE" });
    }

    releasePooledTextures();
    releaseFloatTextures();
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#!")) return;
    try {
      const json = decodeShareState(hash.slice(2));
      const data = JSON.parse(json) as SerializedFilterState;
      dispatch({ type: "LOAD_STATE", data });
      restoreAudioVizFromShareState(data);
    } catch (e) {
      console.warn("Failed to restore state from URL hash:", e);
    }
  }, []);

  const [audioVizSyncKey, setAudioVizSyncKey] = useState(0);
  useEffect(() => subscribeGlobalAudioVizModulation(() => setAudioVizSyncKey((value) => value + 1)), []);
  useEffect(() => {
    if (!state.chain || state.chain.length === 0) return;
    try {
      const json = serializeStateJson(state);
      const hash = getShareHash(json, DEFAULT_SHARE_STATE_JSON);
      const url = getShareUrl(window.location.pathname, window.location.search, hash);
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== url) {
        history.replaceState(null, "", url);
      }
    } catch (e) {
      console.warn("Failed to sync state to URL hash:", e);
    }
  }, [state.chain, state.activeIndex, state.convertGrayscale, state.linearize, state.wasmAcceleration, state.randomCycleSeconds, audioVizSyncKey]);

  useEffect(() => {
    syncRandomCycleSeconds(state.randomCycleSeconds);
  }, [state.randomCycleSeconds]);

  const loadImageAsync = useCallback((file: File, options?: { preserveScale?: boolean }) => new Promise<void>((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    const loadStartedScale = stateRef.current.scale;
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to decode image"));
    };
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resetProcessingState();
      dispatch({ type: "LOAD_IMAGE", image, time: null, frameToken: 0, video: null, dispatch });
      if (!options?.preserveScale && Math.abs(stateRef.current.scale - loadStartedScale) < 0.0001) {
        const scale = roundScale(getAutoScale(image.width, image.height));
        dispatch({ type: "SET_SCALE", scale });
      }
      resolve();
    };
    image.src = objectUrl;
  }), [resetProcessingState]);

  const loadVideoSourceAsync = useCallback((
    src: string,
    volume = 1,
    playbackRate = 1,
    perfMeta: Record<string, string> = {},
    objectUrlForCleanup?: string,
    options?: { preserveScale?: boolean },
    stream?: MediaStream
  ) => new Promise<void>((resolve, reject) => {
    resetProcessingState();

    const previousVideo = stateRef.current.video as (AnimatedVideoElement | null);
    if (previousVideo) {
      previousVideo.__manualPause = true;
      previousVideo.onplaying = null;
      previousVideo.onpause = null;
      previousVideo.onloadeddata = null;
      previousVideo.onseeked = null;
      previousVideo.onerror = null;
      previousVideo.onloadedmetadata = null;
      try { previousVideo.pause(); } catch { /* ignore */ }
      try {
        previousVideo.removeAttribute("src");
        if ("srcObject" in previousVideo) {
          const s = (previousVideo as any).srcObject as MediaStream | null;
          if (s) s.getTracks().forEach(t => t.stop());
          (previousVideo as any).srcObject = null;
        }
        previousVideo.load();
      } catch { /* ignore */ }
      if (previousVideo.__objectUrl) {
        URL.revokeObjectURL(previousVideo.__objectUrl);
        delete previousVideo.__objectUrl;
      }
    }

    const loadStartedScale = stateRef.current.scale;
    const video = document.createElement("video") as AnimatedVideoElement & { __isWebcam?: boolean };
    if (stream) video.__isWebcam = true;
    const perfStart = performance.now();
    const logPerf = (stage: string) => {
      const elapsedMs = Math.round(performance.now() - perfStart);
      console.info(
        `[perf][video-load] ${stage} +${elapsedMs}ms`,
        perfMeta
      );
    };
    logPerf("start");
    let settled = false;
    const settleResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const settleReject = (error: Error) => {
      if (!settled) {
        settled = true;
        if (objectUrlForCleanup) {
          URL.revokeObjectURL(objectUrlForCleanup);
        }
        reject(error);
      }
    };

    const canvas = createReadbackCanvas();
    const ctx = getReadbackContext(canvas);
    if (!ctx) {
      settleReject(new Error("Failed to initialize video canvas"));
      return;
    }

    let rafId: number | null = null;
    const dispatchCurrentFrame = async () => {
      try {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          ctx.drawImage(video, 0, 0);

          if (stateRef.current.mediapipeEnabled) {
            const mpResult = await processFrame(video);
            if (mpResult) {
              drawMediaPipeResults(ctx, mpResult, stateRef.current.mediapipeOptions);
            }
          }

          const frameToken = ++videoFrameTokenRef.current;
          dispatch({ type: "LOAD_IMAGE", image: canvas, time: video.currentTime, frameToken, video, dispatch });
        }
      } catch (error) {
        if (!video.__drawErrorLogged) {
          video.__drawErrorLogged = true;
          console.warn("[video-load] drawImage failed; continuing frame loop", error);
        }
      }
    };

    const loadFrame = () => {
      if (!video.paused && video.src !== "") {
        if (!hasLoggedFirstFrame) {
          hasLoggedFirstFrame = true;
          logPerf("first-frame-dispatched");
        }
        dispatchCurrentFrame();
        rafId = requestAnimationFrame(loadFrame);
      } else {
        rafId = null;
      }
    };

    let hasLoggedFirstFrame = false;
    video.onerror = () => settleReject(new Error("Failed to decode video"));
    video.onloadedmetadata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (!options?.preserveScale && Math.abs(stateRef.current.scale - loadStartedScale) < 0.0001) {
        const scale = roundScale(getAutoScale(video.videoWidth, video.videoHeight));
        dispatch({ type: "SET_SCALE", scale });
      }
      logPerf("loadedmetadata");
      settleResolve();
    };
    video.onseeked = () => {
      dispatchCurrentFrame();
    };
    video.onloadeddata = () => {
      dispatchCurrentFrame();
    };
    video.onplaying = () => {
      logPerf("playing");
      video.__manualPause = false;
      if (rafId == null) {
        rafId = requestAnimationFrame(loadFrame);
      }
    };
    video.onpause = () => {
      rafId = null;
      if (!video.__manualPause && video.src !== "" && !video.ended) {
        video.play().catch(() => {});
      }
    };

    video.volume = volume;
    video.muted = volume === 0;
    video.playbackRate = playbackRate;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    if (objectUrlForCleanup) {
      video.__objectUrl = objectUrlForCleanup;
    }
    video.__manualPause = false;
    video.__drawErrorLogged = false;
    if (stream) {
      (video as any).srcObject = stream;
    } else {
      video.src = src;
    }
    video.play().catch(() => {
      if (video.src === "") return;
      if (video.muted || volume === 0) return;
      video.muted = true;
      video.volume = 0;
      dispatch({ type: "SET_INPUT_VOLUME", volume: 0 });
      video.play().catch(() => {});
    });
  }), [resetProcessingState]);

  const loadVideoAsync = useCallback((file: File, volume = 1, playbackRate = 1, options?: { preserveScale?: boolean }) => {
    const objectUrl = URL.createObjectURL(file);
    return loadVideoSourceAsync(
      objectUrl,
      volume,
      playbackRate,
      {
        file: file.name,
        sizeMiB: (file.size / (1024 * 1024)).toFixed(2),
        type: file.type || "unknown",
      },
      objectUrl,
      options
    );
  }, [loadVideoSourceAsync]);

  const loadVideoFromUrlAsync = useCallback((src: string, volume = 1, playbackRate = 1, options?: { preserveScale?: boolean }) =>
    loadVideoSourceAsync(
      src,
      volume,
      playbackRate,
      { src, type: "url" },
      undefined,
      options
    ),
  [loadVideoSourceAsync]);

  const loadMediaAsync = useCallback((file: File, volume = 1, playbackRate = 1, options?: { preserveScale?: boolean }) => {
    if (file.type.startsWith("video/")) {
      return loadVideoAsync(file, volume, playbackRate, options);
    } else {
      return loadImageAsync(file, options);
    }
  }, [loadImageAsync, loadVideoAsync]);

  const loadWebcamAsync = useCallback(async () => {
    try {
      const [width, height] = stateRef.current.webcamResolution;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height } },
        audio: false
      });
      return loadVideoSourceAsync(
        "", 
        0, 1, { type: "webcam" }, undefined, { preserveScale: false },
        stream
      );
    } catch (error) {
      console.error("Failed to access webcam:", error);
      throw error;
    }
  }, [loadVideoSourceAsync]);

  const serializeOptions = (options?: Record<string, unknown>) => {
    const opts = { ...options } as SerializableOptions & { palette?: SerializablePalette };
    if (
      opts.palette
      && typeof opts.palette === "object"
      && typeof (opts.palette as { name?: unknown }).name === "string"
      && typeof (opts.palette as { getColor?: unknown }).getColor === "function"
    ) {
      opts.palette = serializePalette(opts.palette as never);
    }
    return opts;
  };

  const filterOnMainThread = async (
    canvas: HTMLCanvasElement | OffscreenCanvas,
    enabledEntries: ChainEntry[],
    startIdx: number,
    isAnimating: boolean,
    curState: FilterReducerState,
    temporalState = {
      prevOutputMap: mainThreadPrevOutputMap.current,
      prevInputMap: mainThreadPrevInputMap.current,
      emaMap: mainThreadEmaMap.current,
      frameIndex: frameCountRef.current,
    },
    dispatchOverride = dispatch,
    cacheOutputs = true,
  ) => {
    const stepTimes: { name: string; ms: number; backend?: string }[] = [];
    let totalTime = 0;

    for (let i = startIdx; i < enabledEntries.length; i++) {
      const entry = enabledEntries[i];
      let inputData: Uint8ClampedArray | null = null;
      const inputCtx = (
        canvas instanceof HTMLCanvasElement
          ? canvas.getContext("2d", { willReadFrequently: true })
          : canvas.getContext("2d", { willReadFrequently: true })
      ) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (inputCtx) {
        inputData = inputCtx.getImageData(0, 0, canvas.width, canvas.height).data;
      }

      const filterOpts: Record<string, unknown> & { palette?: SerializablePalette } = {
        ...withAudioModulatedOptions(entry),
        _chainIndex: i,
        _linearize: curState.linearize,
        _wasmAcceleration: curState.wasmAcceleration,
        _webglAcceleration: curState.webglAcceleration,
        _hasVideoInput: !!curState.video,
        _prevOutput: temporalState.prevOutputMap.get(entry.id) || null,
        _prevInput: temporalState.prevInputMap.get(entry.id) || null,
        _ema: temporalState.emaMap.get(entry.id) || null,
        _frameIndex: temporalState.frameIndex,
        _degaussFrame: degaussFrameRef.current,
        _isAnimating: isAnimating,
      };
      if (filterOpts.palette?.options) {
        filterOpts.palette = {
          ...filterOpts.palette,
          options: { ...filterOpts.palette.options, _wasmAcceleration: curState.wasmAcceleration },
        };
      }

      const t0 = performance.now();
      let output: unknown;
      if (entry.filter.requiresGL && !glAvailable()) {
        output = glUnavailableStub(canvas.width, canvas.height);
        logFilterBackend(entry.filter.name, "GL-unavailable", "WebGL2 required but unavailable");
      } else {
        try {
          const raw: unknown = entry.filter.func(canvas, filterOpts, dispatchOverride);
          output = (raw && typeof (raw as { then?: unknown }).then === "function")
            ? await (raw as Promise<unknown>)
            : raw;
        } catch (e) {
          console.error(`Filter "${entry.displayName}" threw:`, e);
          continue;
        }
      }
      logFilterDispatched(entry.filter.name, { noGL: entry.filter.noGL, noWASM: entry.filter.noWASM });
      const stepMs = performance.now() - t0;
      recordFilterStepMs(entry.filter.name, stepMs);
      const backend = getFilterWasmStatuses().get(entry.filter.name)?.label;
      stepTimes.push(backend
        ? { name: entry.displayName, ms: stepMs, backend }
        : { name: entry.displayName, ms: stepMs });
      totalTime += stepMs;

      if (inputData) {
        temporalState.prevInputMap.set(entry.id, inputData);
        const EMA_ALPHA = 0.1;
        let ema = temporalState.emaMap.get(entry.id);
        if (!ema || ema.length !== inputData.length) {
          ema = new Float32Array(inputData);
        } else {
          const oneMinusAlpha = 1 - EMA_ALPHA;
          for (let j = 0; j < ema.length; j++) {
            ema[j] = ema[j] * oneMinusAlpha + inputData[j] * EMA_ALPHA;
          }
        }
        temporalState.emaMap.set(entry.id, ema);
      }

      if (output instanceof HTMLCanvasElement) {
        const outCtx = output.getContext("2d", { willReadFrequently: true });
        if (outCtx) {
          temporalState.prevOutputMap.set(
            entry.id,
            outCtx.getImageData(0, 0, output.width, output.height).data
          );
        }
        if (cacheOutputs) {
          const prev = cachedOutputsRef.current.get(entry.id);
          if (prev && prev !== output) releasePooledCanvas(prev);
          cachedOutputsRef.current.set(entry.id, output);
        }
        canvas = output;
      }
    }

    return { canvas, stepTimes, totalTime };
  };

  const emitOutput = (
    canvas: HTMLCanvasElement | OffscreenCanvas,
    totalTime: number,
    stepTimes: { name: string; ms: number; backend?: string }[],
    frameToken: number,
    sourceTime: number,
  ) => {
    frameCountRef.current += 1;
    filteringRef.current = false;

    const outCanvas = outputCanvasRef.current;
    if (outCanvas) {
        const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
        if (outCtx) {
            outCtx.imageSmoothingEnabled = stateRef.current.scalingAlgorithm === optionTypes.SCALING_ALGORITHM.AUTO;
            const targetScale = stateRef.current.outputScale || 1;
            const finalWidth = canvas.width * targetScale;
            const finalHeight = canvas.height * targetScale;
            if (outCanvas.width !== finalWidth || outCanvas.height !== finalHeight) {
                outCanvas.width = finalWidth;
                outCanvas.height = finalHeight;
            }
            outCtx.drawImage(canvas, 0, 0, finalWidth, finalHeight);
        }
    }

    dispatch({ type: "FILTER_IMAGE", image: null as any, frameToken, time: sourceTime, frameTime: totalTime, stepTimes });
    if (pendingFilterRef.current) {
      pendingFilterRef.current = false;
      requestAnimationFrame(() => {
        const latestCanvas = stateRef.current.inputCanvas;
        if (latestCanvas) {
          filterImageAsyncRef.current?.(latestCanvas);
        }
      });
    }
  };

  const filterImageAsync: FilterRunner = (input) => {
    if (!input) return;
    if (filteringRef.current) {
      pendingFilterRef.current = true;
      return;
    }
    filteringRef.current = true;
    const curState = stateRef.current;
    const sourceFrameToken = curState.inputFrameToken ?? 0;
    const sourceTime = curState.time ?? 0;
    const chain = curState.chain;
    const isAnimating = Boolean(
      animLoopRef.current != null ||
      degaussAnimRef.current != null ||
      (curState.video && !curState.video.paused) ||
      (curState.glbEnabled)
    );

    const chainKey = chain.map((e) => e.id + (e.enabled ? "1" : "0")).join(",");
    if (chainKey !== cachedChainOrderRef.current) {
      clearCachedOutputs();
      cachedChainOrderRef.current = chainKey;
    }

    let canvas = input;
    
    // Update and render 3D scene if input is 3D tagged
    if (canvas && (canvas as any).__is3d) {
        threeManager.update(0.016); // ~60fps step
        canvas = threeManager.render();
    }
    if (curState.convertGrayscale) {
      const maybeGrayscale = grayscale.func(canvas);
      if (maybeGrayscale instanceof HTMLCanvasElement) {
        canvas = maybeGrayscale;
      }
    }

    const stepTimes: { name: string; ms: number; backend?: string }[] = [];
    const enabledEntries = chain.filter((e) => e.enabled && typeof e.filter?.func === "function");

    let startIdx = 0;
    if (!isAnimating && enabledEntries.length > 1) {
      for (let i = enabledEntries.length - 1; i >= 0; i--) {
        const cached = cachedOutputsRef.current.get(enabledEntries[i].id);
        if (cached) {
          canvas = cached;
          startIdx = i + 1;
          for (let j = 0; j <= i; j++) {
            stepTimes.push({ name: enabledEntries[j].displayName, ms: 0 });
          }
          break;
        }
      }
    }

    const entriesToRun = enabledEntries.slice(startIdx);
    const useWorker = USE_WORKER;

    if (useWorker && entriesToRun.length > 0) {
      const ctx = (canvas instanceof HTMLCanvasElement
        ? canvas.getContext("2d", { willReadFrequently: true })
        : canvas.getContext("2d", { willReadFrequently: true })
      ) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) { filteringRef.current = false; return; }
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const chainConfig = entriesToRun.map(e => ({
        id: e.id,
        filterName: e.filter.name,
        displayName: e.displayName,
        options: serializeOptions(withAudioModulatedOptions(e)),
      }));

      const transfers: ArrayBuffer[] = [imageData.data.buffer];

      workerRPC({
        imageData: imageData.data.buffer,
        width: canvas.width,
        height: canvas.height,
        chain: chainConfig,
        frameIndex: frameCountRef.current,
        isAnimating,
        linearize: curState.linearize,
        wasmAcceleration: curState.wasmAcceleration,
        webglAcceleration: curState.webglAcceleration,
        convertGrayscale: false,
        degaussFrame: Number.isFinite(degaussFrameRef.current) ? degaussFrameRef.current : -2147483648,
      }, transfers, (worker) => { filterWorkerRef.current = worker; }).then((result) => {
        const outData = new ImageData(
          new Uint8ClampedArray(result.imageData), result.width, result.height
        );
        const outCanvas = document.createElement("canvas");
        outCanvas.width = result.width;
        outCanvas.height = result.height;
        outCanvas.getContext("2d", { willReadFrequently: true })!.putImageData(outData, 0, 0);

        const workerStepTimes = [...stepTimes, ...result.stepTimes];
        const workerTotalTime = result.stepTimes.reduce((a, s) => a + s.ms, 0);
        for (const step of result.stepTimes) {
          recordFilterStepMs(step.filterName ?? step.name, step.ms);
        }
        emitOutput(outCanvas, workerTotalTime, workerStepTimes, sourceFrameToken, sourceTime);
      }).catch(async (err) => {
        console.error("Worker failed, falling back to main thread:", err);
        const fallback = await filterOnMainThread(canvas, enabledEntries, startIdx, Boolean(isAnimating), curState);
        emitOutput(fallback.canvas, fallback.totalTime, [...stepTimes, ...fallback.stepTimes], sourceFrameToken, sourceTime);
      });
    } else {
      void (async () => {
        const result = await filterOnMainThread(canvas, enabledEntries, startIdx, Boolean(isAnimating), curState);
        stepTimes.push(...result.stepTimes);
        emitOutput(result.canvas, result.totalTime, stepTimes, sourceFrameToken, sourceTime);
      })();
    }
  };
  filterImageAsyncRef.current = filterImageAsync;

  const playDegaussSound = () => {
    try {
      const ctx = new AudioContext();
      const duration = 2.2;
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, now);
      master.gain.linearRampToValueAtTime(0.35, now + 0.02);
      master.gain.setValueAtTime(0.3, now + 0.1);
      master.gain.exponentialRampToValueAtTime(0.15, now + 0.5);
      master.gain.exponentialRampToValueAtTime(0.03, now + 1.5);
      master.gain.exponentialRampToValueAtTime(0.001, now + duration);
      master.connect(ctx.destination);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(300, now);
      filter.frequency.exponentialRampToValueAtTime(120, now + duration);
      filter.Q.setValueAtTime(3, now);
      filter.connect(master);

      const hum = ctx.createOscillator();
      hum.type = "sawtooth";
      hum.frequency.setValueAtTime(55, now);
      hum.frequency.linearRampToValueAtTime(48, now + duration);
      const lfo = ctx.createOscillator();
      lfo.frequency.setValueAtTime(8, now);
      lfo.frequency.linearRampToValueAtTime(3, now + duration);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(4, now);
      lfoGain.gain.linearRampToValueAtTime(1, now + duration);
      lfo.connect(lfoGain).connect(hum.frequency);
      lfo.start(now);
      lfo.stop(now + duration);
      const humGain = ctx.createGain();
      humGain.gain.setValueAtTime(0.7, now);
      hum.connect(humGain).connect(filter);
      hum.start(now);
      hum.stop(now + duration);

      const harm2 = ctx.createOscillator();
      harm2.type = "sawtooth";
      harm2.frequency.setValueAtTime(110, now);
      harm2.frequency.linearRampToValueAtTime(96, now + duration);
      const harm2Gain = ctx.createGain();
      harm2Gain.gain.setValueAtTime(0.35, now);
      harm2.connect(harm2Gain).connect(filter);
      harm2.start(now);
      harm2.stop(now + duration);

      const harm3 = ctx.createOscillator();
      harm3.type = "square";
      harm3.frequency.setValueAtTime(165, now);
      harm3.frequency.linearRampToValueAtTime(144, now + duration);
      const harm3Gain = ctx.createGain();
      harm3Gain.gain.setValueAtTime(0.12, now);
      harm3.connect(harm3Gain).connect(filter);
      harm3.start(now);
      harm3.stop(now + duration);

      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(30, now);
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.25, now);
      subGain.gain.exponentialRampToValueAtTime(0.01, now + 1.0);
      sub.connect(subGain).connect(master);
      sub.start(now);
      sub.stop(now + duration);

      const thunkLen = Math.round(ctx.sampleRate * 0.06);
      const thunkBuf = ctx.createBuffer(1, thunkLen, ctx.sampleRate);
      const thunkData = thunkBuf.getChannelData(0);
      for (let i = 0; i < thunkLen; i++) {
        const env = Math.exp(-i / (ctx.sampleRate * 0.012));
        thunkData[i] = (Math.random() * 2 - 1) * env;
      }
      const thunk = ctx.createBufferSource();
      thunk.buffer = thunkBuf;
      const thunkGain = ctx.createGain();
      thunkGain.gain.setValueAtTime(0.5, now);
      const thunkFilter = ctx.createBiquadFilter();
      thunkFilter.type = "bandpass";
      thunkFilter.frequency.setValueAtTime(800, now);
      thunkFilter.Q.setValueAtTime(1.5, now);
      thunk.connect(thunkFilter).connect(thunkGain).connect(master);
      thunk.start(now);

      setTimeout(() => ctx.close(), (duration + 0.2) * 1000);
    } catch { }
  };

  const triggerDegauss = (inputCanvas: HTMLCanvasElement | null) => {
    if (degaussAnimRef.current != null) return;
    degaussFrameRef.current = frameCountRef.current;
    playDegaussSound();
    const DEGAUSS_FRAMES = 45;
    let frame = 0;
    const animate = () => {
      if (frame >= DEGAUSS_FRAMES || !inputCanvas) {
        degaussAnimRef.current = null;
        return;
      }
      filterImageAsync(inputCanvas);
      frame += 1;
      degaussAnimRef.current = requestAnimationFrame(animate);
    };
    degaussAnimRef.current = requestAnimationFrame(animate);
  };

  const triggerBurst = (inputCanvas: HTMLCanvasElement | null, frames: number, fps = 6) => {
    if (animLoopRef.current != null) return;
    const interval = 1000 / fps;
    let frame = 0;
    let lastTime = 0;
    const animate = (timestamp: number) => {
      if (frame >= frames || !inputCanvas) {
        animLoopRef.current = null;
        requestAnimationFrame(() => {
          filterImageAsync(inputCanvas);
        });
        return;
      }
      if (timestamp - lastTime >= interval) {
        lastTime = timestamp;
        filterImageAsync(inputCanvas);
        frame += 1;
      }
      animLoopRef.current = requestAnimationFrame(animate);
    };
    animLoopRef.current = requestAnimationFrame(animate);
  };

  const startAnimLoop = (inputCanvas: HTMLCanvasElement | null, fps = 15) => {
    if (animLoopRef.current != null) return;
    animParamsRef.current = { inputCanvas, fps };
    animLastTimeRef.current = 0;
    const animate = (timestamp: number) => {
      const params = animParamsRef.current;
      if (!params || !params.inputCanvas) {
        animLoopRef.current = null;
        return;
      }
      const curState = stateRef.current;
      const animSpeed = curState.selected?.filter?.options?.animSpeed;
      const curFps = typeof animSpeed === "number" ? animSpeed : params.fps;
      const interval = 1000 / curFps;
      if (timestamp - animLastTimeRef.current >= interval) {
        animLastTimeRef.current = timestamp;
        const filterFn = filterImageAsyncRef.current;
        if (filterFn) {
          filterFn(params.inputCanvas);
        }
      }
      animLoopRef.current = requestAnimationFrame(animate);
    };
    animLoopRef.current = requestAnimationFrame(animate);
  };

  const stopAnimLoop = () => {
    if (animLoopRef.current != null) {
      cancelAnimationFrame(animLoopRef.current);
      animLoopRef.current = null;
    }
    animLoopAutoStartedRef.current = false;
  };

  const isAnimating = () => animLoopRef.current != null;

  const maybeStopAutoAnimLoop = () => {
    if (!animLoopAutoStartedRef.current) return;
    const chain = stateRef.current.chain;
    const stillWantsAuto = chain.some((e) => e.enabled && e.filter?.autoAnimate);
    if (!stillWantsAuto) stopAnimLoop();
  };

  const evictCachedOutput = (id: string) => {
    const c = cachedOutputsRef.current.get(id);
    if (c) releasePooledCanvas(c);
    cachedOutputsRef.current.delete(id);
  };

  const clearCachedOutputs = () => {
    for (const c of cachedOutputsRef.current.values()) releasePooledCanvas(c);
    cachedOutputsRef.current.clear();
  };

  const renderFrameForExport = async (inputCanvas: HTMLCanvasElement | null, {
    sessionId,
    time = 0,
    video = null,
  }: ExportFrameOptions) => {
    if (!inputCanvas) return null;

    let session = exportSessionsRef.current.get(sessionId);
    if (!session) {
      session = {
        prevOutputMap: new Map(),
        prevInputMap: new Map(),
        emaMap: new Map(),
        frameIndex: 0,
      };
      exportSessionsRef.current.set(sessionId, session);
    }

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = inputCanvas.width;
    exportCanvas.height = inputCanvas.height;
    const exportCtx = exportCanvas.getContext("2d", { willReadFrequently: true });
    if (!exportCtx) return null;
    exportCtx.drawImage(inputCanvas, 0, 0);

    let canvas = exportCanvas;
    const exportState = {
      ...stateRef.current,
      time,
      video,
    };

    if (exportState.convertGrayscale) {
      const maybeGrayscale = grayscale.func(canvas);
      if (maybeGrayscale instanceof HTMLCanvasElement) {
        canvas = maybeGrayscale;
      }
    }

    const enabledEntries = exportState.chain.filter((e) => e.enabled && typeof e.filter?.func === "function");
    const result = await filterOnMainThread(
      canvas,
      enabledEntries,
      0,
      true,
      exportState,
      session,
      () => {},
      false,
    );
    session.frameIndex += 1;
    return result.canvas;
  };

  const clearExportSession = (sessionId: string) => {
    exportSessionsRef.current.delete(sessionId);
  };

  const actions: FilterActions = {
    loadMediaAsync,
    loadVideoFromUrlAsync,
    filterImageAsync,
    triggerDegauss,
    triggerBurst,
    startAnimLoop,
    stopAnimLoop,
    isAnimating,
    renderFrameForExport,
    clearExportSession,
    loadImage: (image: CanvasImageSource, time?: number | null, video?: AnimatedVideoElement | null) =>
    {
      resetProcessingState();
      dispatch({ type: "LOAD_IMAGE", image: image as any, time: time || 0, frameToken: stateRef.current.inputFrameToken ?? 0, video: video || null, dispatch });
    },
    selectFilter: (name, filter) => {
      stopAnimLoop();
      mainThreadPrevOutputMap.current.clear();
      mainThreadPrevInputMap.current.clear();
      mainThreadEmaMap.current.clear();
      clearMotionVectorsState();
      clearCachedOutputs();
      dispatch({ type: "SELECT_FILTER", name, filter });
      maybeStopAutoAnimLoop();
    },
    setConvertGrayscale: (value: boolean) =>
      dispatch({ type: "SET_GRAYSCALE", value }),
    setLinearize: (value: boolean) =>
      dispatch({ type: "SET_LINEARIZE", value }),
    setWasmAcceleration: (value: boolean) =>
      dispatch({ type: "SET_WASM_ACCELERATION", value }),
    setWebglAcceleration: (value: boolean) =>
      dispatch({ type: "SET_WEBGL_ACCELERATION", value }),
    setRandomCycleSeconds: (seconds: number | null) =>
      dispatch({ type: "SET_RANDOM_CYCLE_SECONDS", seconds }),
    setScale: (scale: number) =>
      dispatch({ type: "SET_SCALE", scale }),
    setOutputScale: (scale: number) =>
      dispatch({ type: "SET_OUTPUT_SCALE", scale }),
    setWebcamResolution: (resolution: [number, number]) => {
      dispatch({ type: "SET_WEBCAM_RESOLUTION", resolution });
      const video = stateRef.current.video as any;
      if (video && video.__isWebcam) {
         void loadWebcamAsync();
      }
    },
    loadGlbAsync: async (file: File) => {
      const url = URL.createObjectURL(file);
      await threeManager.loadGlb(url);
      URL.revokeObjectURL(url);
      resetProcessingState();
      
      const canvas = threeManager.getCanvas();
      // Tag it as 3D so the loop knows to update it
      (canvas as any).__is3d = true;
      
      dispatch({ type: "LOAD_IMAGE", image: canvas as any, time: 0, frameToken: 0, video: null, dispatch });
      dispatch({ type: "SET_GLB_ENABLED", value: true });
    },
    setGlbEnabled: (value: boolean) => {
      dispatch({ type: "SET_GLB_ENABLED", value });
    },
    setGlbConfig: (config: Partial<FilterReducerState["glbConfig"]>) => {
      dispatch({ type: "SET_GLB_CONFIG", config });
      threeManager.setConfig(config);
    },
    setMediapipeEnabled: async (value: boolean) => {
      if (value) await initMediaPipe();
      dispatch({ type: "SET_MEDIAPIPE_ENABLED", value });
    },
    setMediapipeOptions: (options: Partial<FilterReducerState["mediapipeOptions"]>) =>
      dispatch({ type: "SET_MEDIAPIPE_OPTIONS", options }),
    setRealtimeFiltering: (enabled: boolean) =>
      dispatch({ type: "SET_REAL_TIME_FILTERING", enabled }),
    loadWebcamAsync,
    setInputCanvas: (canvas: HTMLCanvasElement | null) =>
      dispatch({ type: "SET_INPUT_CANVAS", canvas }),
    setOutputCanvas: (canvas: HTMLCanvasElement | null) => {
      outputCanvasRef.current = canvas;
    },
    setInputVolume: (volume: number) =>
      dispatch({ type: "SET_INPUT_VOLUME", volume }),
    setInputPlaybackRate: (rate: number) =>
      dispatch({ type: "SET_INPUT_PLAYBACK_RATE", rate }),
    toggleVideo: () => {
      const video = stateRef.current.video as AnimatedVideoElement | null;
      if (!video) return;
      if (video.paused) {
        video.__manualPause = false;
        video.play();
      } else {
        video.__manualPause = true;
        video.pause();
      }
    },
    setScalingAlgorithm: (algorithm: string) =>
      dispatch({ type: "SET_SCALING_ALGORITHM", algorithm }),
    setFilterOption: (optionName: string, value: FilterOptionValue, chainIndex?: number) => {
      const ci = chainIndex ?? stateRef.current.activeIndex;
      const chain = stateRef.current.chain;
      for (let i = ci; i < chain.length; i++) {
        evictCachedOutput(chain[i].id);
      }
      clearMotionVectorsState();
      dispatch({
        type: "SET_FILTER_OPTION",
        optionName,
        value,
        ...(chainIndex !== undefined ? { chainIndex } : {}),
      });
    },
    setFilterPaletteOption: (optionName: string, value: FilterOptionValue, chainIndex?: number) => {
      const ci = chainIndex ?? stateRef.current.activeIndex;
      const chain = stateRef.current.chain;
      for (let i = ci; i < chain.length; i++) {
        evictCachedOutput(chain[i].id);
      }
      clearMotionVectorsState();
      dispatch({
        type: "SET_FILTER_PALETTE_OPTION",
        optionName,
        value,
        ...(chainIndex !== undefined ? { chainIndex } : {}),
      });
    },
    addPaletteColor: (color: number[], chainIndex?: number) => {
      const ci = chainIndex ?? stateRef.current.activeIndex;
      const chain = stateRef.current.chain;
      for (let i = ci; i < chain.length; i++) {
        evictCachedOutput(chain[i].id);
      }
      clearMotionVectorsState();
      dispatch({
        type: "ADD_PALETTE_COLOR",
        color,
        ...(chainIndex !== undefined ? { chainIndex } : {}),
      });
    },
    importState: (json: string) => {
      const deserialized = JSON.parse(json) as SerializedFilterState;
      mainThreadPrevOutputMap.current.clear();
      mainThreadPrevInputMap.current.clear();
      mainThreadEmaMap.current.clear();
      clearMotionVectorsState();
      dispatch({ type: "LOAD_STATE", data: deserialized });
      restoreAudioVizFromShareState(deserialized);
    },
    saveCurrentColorPalette: (name: string, colors: number[][]) => {
      window.localStorage.setItem(
        `_palette_${name.replace(" ", "")}`,
        JSON.stringify({ type: optionTypes.PALETTE, name, colors })
      );
      THEMES[name] = colors;
      dispatch({ type: "SAVE_CURRENT_COLOR_PALETTE", name });
    },
    deleteCurrentColorPalette: (name: string) => {
      window.localStorage.removeItem(`_palette_${name.replace(" ", "")}`);
      delete THEMES[name];
      dispatch({ type: "DELETE_CURRENT_COLOR_PALETTE", name });
    },
    chainAdd: (displayName: string, filter) => {
      clearMotionVectorsState();
      dispatch({ type: "CHAIN_ADD", displayName, filter });
      if (filter?.autoAnimate && animLoopRef.current == null) {
        const canvas = stateRef.current.inputCanvas;
        if (canvas instanceof HTMLCanvasElement) {
          startAnimLoop(canvas, filter.autoAnimateFps ?? 20);
          animLoopAutoStartedRef.current = true;
        }
      }
    },
    chainRemove: (id: string) => {
      mainThreadPrevOutputMap.current.delete(id);
      mainThreadPrevInputMap.current.delete(id);
      mainThreadEmaMap.current.delete(id);
      evictCachedOutput(id);
      clearMotionVectorsState();
      dispatch({ type: "CHAIN_REMOVE", id });
      maybeStopAutoAnimLoop();
    },
    chainReorder: (fromIndex: number, toIndex: number) => {
      mainThreadPrevOutputMap.current.clear();
      mainThreadPrevInputMap.current.clear();
      mainThreadEmaMap.current.clear();
      clearCachedOutputs();
      clearMotionVectorsState();
      dispatch({ type: "CHAIN_REORDER", fromIndex, toIndex });
    },
    chainSetActive: (index: number) => {
      dispatch({ type: "CHAIN_SET_ACTIVE", index });
    },
    chainToggle: (id: string) => {
      dispatch({ type: "CHAIN_TOGGLE", id });
      maybeStopAutoAnimLoop();
    },
    chainShuffle: () => {
      mainThreadPrevOutputMap.current.clear();
      mainThreadPrevInputMap.current.clear();
      mainThreadEmaMap.current.clear();
      clearCachedOutputs();
      clearMotionVectorsState();
      dispatch({ type: "CHAIN_SHUFFLE" });
    },
    chainReplace: (id: string, displayName: string, filter) => {
      mainThreadPrevOutputMap.current.delete(id);
      mainThreadPrevInputMap.current.delete(id);
      mainThreadEmaMap.current.delete(id);
      evictCachedOutput(id);
      clearMotionVectorsState();
      dispatch({ type: "CHAIN_REPLACE", id, displayName, filter });
      if (filter?.autoAnimate && animLoopRef.current == null) {
        const canvas = stateRef.current.inputCanvas;
        if (canvas instanceof HTMLCanvasElement) {
          startAnimLoop(canvas, filter.autoAnimateFps ?? 20);
          animLoopAutoStartedRef.current = true;
        }
      } else {
        maybeStopAutoAnimLoop();
      }
    },
    chainDuplicate: (id: string) => {
      clearMotionVectorsState();
      dispatch({ type: "CHAIN_DUPLICATE", id });
    },
    setChainAudioModulation: (id: string, modulation: EntryAudioModulation | null) => {
      clearMotionVectorsState();
      evictCachedOutput(id);
      dispatch({ type: "SET_CHAIN_AUDIO_MODULATION", id, modulation });
    },
    copyChainToClipboard: () => {
      try {
        const json = serializeStateJson(stateRef.current);
        navigator.clipboard.writeText(json);
      } catch (e) {
        console.warn("Failed to copy chain:", e);
      }
    },
    pasteChainFromClipboard: async () => {
      try {
        const text = await navigator.clipboard.readText();
        const data = JSON.parse(text) as SerializedFilterState;
        mainThreadPrevOutputMap.current.clear();
        mainThreadPrevInputMap.current.clear();
        mainThreadEmaMap.current.clear();
        clearMotionVectorsState();
        clearCachedOutputs();
        dispatch({ type: "LOAD_STATE", data });
        maybeStopAutoAnimLoop();
      } catch (e) {
        console.warn("Failed to paste chain:", e);
      }
    },
    getExportUrl: (filterState: FilterReducerState) => {
      const json = serializeStateJson(filterState);
      const hash = getShareHash(json, DEFAULT_SHARE_STATE_JSON);
      return `${window.location.origin}${getShareUrl(window.location.pathname, "", hash)}`;
    },
    exportState: (filterState: FilterReducerState) => {
      return serializeStateJson(filterState, true);
    },
    getIntermediatePreview: (entryId: string): HTMLCanvasElement | null =>
      cachedOutputsRef.current.get(entryId) || null,
  };

  return (
    <FilterContext.Provider value={{ state, actions, filterList, grayscale }}>
      {children}
    </FilterContext.Provider>
  );
};
