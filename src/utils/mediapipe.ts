import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";

let faceLandmarker: FaceLandmarker | null = null;
let isLoading = false;

export async function initMediaPipe() {
  if (faceLandmarker || isLoading) return faceLandmarker;
  isLoading = true;
  try {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU"
      },
      outputFaceBlendshapes: true,
      runningMode: "VIDEO",
      numFaces: 1
    });
    return faceLandmarker;
  } catch (error) {
    console.error("Failed to initialize MediaPipe FaceLandmarker:", error);
    return null;
  } finally {
    isLoading = false;
  }
}

export interface MediaPipeOptions {
  faceMesh: boolean;
  landmarks: boolean;
  wireframe: boolean;
  wireSurface: boolean;
  landmarkColor: string;
  wireframeColor: string;
  wireSurfaceColor: string;
  landmarkSize: number;
  wireThickness: number;
}

export function drawMediaPipeResults(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  result: FaceLandmarkerResult,
  options: MediaPipeOptions
) {
  if (!result.faceLandmarks) return;

  for (const landmarks of result.faceLandmarks) {
    if (options.wireSurface) {
      ctx.fillStyle = options.wireSurfaceColor;
      // Draw surface using triangles if we want to be fancy, 
      // but for simplicity we can use standard face mesh connections
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, options.wireSurfaceColor, options.wireThickness, true);
    }

    if (options.wireframe) {
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, options.wireframeColor, options.wireThickness);
      drawConnectors(ctx, landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, options.wireframeColor, options.wireThickness);
    }

    if (options.landmarks) {
      ctx.fillStyle = options.landmarkColor;
      for (const landmark of landmarks) {
        ctx.beginPath();
        ctx.arc(landmark.x * ctx.canvas.width, landmark.y * ctx.canvas.height, options.landmarkSize, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
}

// Simple connector drawing utility
function drawConnectors(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  landmarks: any[],
  connections: any[],
  color: string,
  thickness: number,
  fill = false
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  
  if (fill) {
      // For filling we need to be more careful, but let's just draw lines for now
      // as full mesh filling requires proper triangulation handling.
  }

  for (const connection of connections) {
    const from = landmarks[connection.start];
    const to = landmarks[connection.end];
    if (from && to) {
      ctx.beginPath();
      ctx.moveTo(from.x * ctx.canvas.width, from.y * ctx.canvas.height);
      ctx.lineTo(to.x * ctx.canvas.width, to.y * ctx.canvas.height);
      ctx.stroke();
    }
  }
}

export async function processFrame(video: HTMLVideoElement) {
  if (!faceLandmarker) return null;
  return faceLandmarker.detectForVideo(video, performance.now());
}
