const videoElement = document.getElementById('input_video');
const drawCanvas = document.getElementById('draw_canvas');
const overlayCanvas = document.getElementById('overlay_canvas');
const drawCtx = drawCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');
const loadingScreen = document.getElementById('loading-screen');

const lineWidthInput = document.getElementById('lineWidth');
const lineWidthValue = document.getElementById('lineWidthValue');
const smoothnessInput = document.getElementById('smoothness');
const smoothnessValue = document.getElementById('smoothnessValue');

const undoBtn = document.getElementById('undoBtn');
const clearBtn = document.getElementById('clearBtn');
const saveBtn = document.getElementById('saveBtn');

const state = {
  paths: [],
  currentPath: null,
  isDrawing: false,
  smoothed: null,
  lastSmoothAt: 0,
  pinchStableFrames: 0,
  releaseStableFrames: 0,
  minFramesToToggle: 2,
  drawColor: '#ffffff',
  hasReceivedFrame: false,
  lastHandLandmarks: null,
  lastHandTime: 0,
  handHoldMs: 260,
  waveTrail: [],
  eraseCooldownMs: 900,
  lastEraseAt: 0,
  lastWaveSpan: 0
};

function showLoadingMessage(message, isError = false) {
  loadingScreen.textContent = message;
  loadingScreen.style.color = isError ? '#ff7f7f' : '#d9ecff';
}

function syncLabels() {
  lineWidthValue.textContent = lineWidthInput.value;
  smoothnessValue.textContent = Number(smoothnessInput.value).toFixed(2);
}

[lineWidthInput, smoothnessInput].forEach((el) => {
  el.addEventListener('input', syncLabels);
});
syncLabels();

function setupCanvas() {
  drawCanvas.width = window.innerWidth;
  drawCanvas.height = window.innerHeight;
  overlayCanvas.width = window.innerWidth;
  overlayCanvas.height = window.innerHeight;
  redrawAll();
}
window.addEventListener('resize', setupCanvas);
setupCanvas();

function distanceNorm(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function isFingerUp(hand, tip, pip) {
  return hand[tip].y < hand[pip].y;
}

function isFingerDown(hand, tip, pip, wrist) {
  if (hand[tip].y > hand[pip].y) return true;
  const tipToWrist = distanceNorm(hand[tip], wrist);
  const pipToWrist = distanceNorm(hand[pip], wrist);
  return tipToWrist < pipToWrist;
}

function isIndexOnlyPose(hand) {
  const wrist = hand[0];
  const indexUp = isFingerUp(hand, 8, 6);
  const middleDown = isFingerDown(hand, 12, 10, wrist);
  const ringDown = isFingerDown(hand, 16, 14, wrist);
  const pinkyDown = isFingerDown(hand, 20, 18, wrist);
  return indexUp && middleDown && ringDown && pinkyDown;
}

function isOpenPalmPose(hand) {
  const indexUp = isFingerUp(hand, 8, 6);
  const middleUp = isFingerUp(hand, 12, 10);
  const ringUp = isFingerUp(hand, 16, 14);
  const pinkyUp = isFingerUp(hand, 20, 18);
  const thumbSpread = distanceNorm(hand[4], hand[5]) > 0.1;
  return indexUp && middleUp && ringUp && pinkyUp && thumbSpread;
}

function getPalmCenter(hand, canvas) {
  const ids = [0, 5, 9, 13, 17];
  const sum = ids.reduce((acc, id) => {
    const p = mapLandmarkToCanvas(hand[id], canvas);
    acc.x += p.x;
    acc.y += p.y;
    return acc;
  }, { x: 0, y: 0 });

  return {
    x: sum.x / ids.length,
    y: sum.y / ids.length
  };
}

function resetWaveDetector() {
  state.waveTrail = [];
  state.lastWaveSpan = 0;
}

function updateWaveEraseDetector(hand) {
  const now = performance.now();
  const palm = getPalmCenter(hand, drawCanvas);

  state.waveTrail.push({ x: palm.x, t: now });
  state.waveTrail = state.waveTrail.filter((p) => now - p.t <= 1000);

  if (state.waveTrail.length < 4) {
    state.lastWaveSpan = 0;
    return { triggered: false, waveSpan: 0 };
  }

  const xs = state.waveTrail.map((p) => p.x);
  const waveSpan = Math.max(...xs) - Math.min(...xs);
  state.lastWaveSpan = waveSpan;

  let flips = 0;
  let prevDir = 0;
  let movementTotal = 0;

  for (let i = 1; i < state.waveTrail.length; i++) {
    const dx = state.waveTrail[i].x - state.waveTrail[i - 1].x;
    movementTotal += Math.abs(dx);
    if (Math.abs(dx) < 5) continue;
    const dir = dx > 0 ? 1 : -1;
    if (prevDir !== 0 && dir !== prevDir) flips += 1;
    prevDir = dir;
  }

  const cooledDown = now - state.lastEraseAt > state.eraseCooldownMs;
  const minSpan = drawCanvas.width * 0.12;
  const minMovement = drawCanvas.width * 0.24;
  const triggered = cooledDown && waveSpan > minSpan && movementTotal > minMovement && flips >= 1;

  if (triggered) {
    state.lastEraseAt = now;
    resetWaveDetector();
    return { triggered: true, waveSpan };
  }

  return { triggered: false, waveSpan };
}

function mapLandmarkToCanvas(landmark, canvas) {
  const sourceWidth = videoElement.videoWidth || 1280;
  const sourceHeight = videoElement.videoHeight || 720;
  const targetWidth = canvas.width;
  const targetHeight = canvas.height;

  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  let scale;
  let offsetX = 0;
  let offsetY = 0;

  if (sourceAspect > targetAspect) {
    scale = targetHeight / sourceHeight;
    const drawnWidth = sourceWidth * scale;
    offsetX = (drawnWidth - targetWidth) / 2;
  } else {
    scale = targetWidth / sourceWidth;
    const drawnHeight = sourceHeight * scale;
    offsetY = (drawnHeight - targetHeight) / 2;
  }

  const mirroredX = 1 - landmark.x;
  const mapped = {
    x: mirroredX * sourceWidth * scale - offsetX,
    y: landmark.y * sourceHeight * scale - offsetY
  };

  return {
    x: Math.max(0, Math.min(canvas.width, mapped.x)),
    y: Math.max(0, Math.min(canvas.height, mapped.y))
  };
}

function smoothPoint(rawPoint, timestampMs) {
  const base = Number(smoothnessInput.value);
  if (!state.smoothed) {
    state.smoothed = { ...rawPoint };
    state.lastSmoothAt = timestampMs;
    return { ...rawPoint };
  }

  const dt = Math.max(1, timestampMs - state.lastSmoothAt);
  const dx = rawPoint.x - state.smoothed.x;
  const dy = rawPoint.y - state.smoothed.y;
  const dist = Math.hypot(dx, dy);
  const speed = dist / dt;

  const alpha = Math.max(0.06, Math.min(0.7, base + speed * 0.015));

  if (dist < 0.9) {
    state.lastSmoothAt = timestampMs;
    return { ...state.smoothed };
  }

  state.smoothed.x = state.smoothed.x + alpha * dx;
  state.smoothed.y = state.smoothed.y + alpha * dy;
  state.lastSmoothAt = timestampMs;
  return { ...state.smoothed };
}

function beginPath(point) {
  state.currentPath = {
    id: Date.now() + Math.random(),
    width: Number(lineWidthInput.value),
    color: state.drawColor,
    points: [point]
  };
  state.paths.push(state.currentPath);
}

function addPoint(point) {
  if (!state.currentPath) {
    beginPath(point);
    return;
  }

  const prev = state.currentPath.points[state.currentPath.points.length - 1];
  const d = Math.hypot(point.x - prev.x, point.y - prev.y);
  if (d > 0.6) {
    state.currentPath.points.push(point);
  }
}

function drawPath(path) {
  if (!path || path.points.length < 2) return;

  drawCtx.save();
  drawCtx.lineCap = 'round';
  drawCtx.lineJoin = 'round';
  drawCtx.strokeStyle = path.color;
  drawCtx.lineWidth = path.width;
  drawCtx.shadowBlur = 8;
  drawCtx.shadowColor = 'rgba(255,255,255,0.35)';

  drawCtx.beginPath();
  drawCtx.moveTo(path.points[0].x, path.points[0].y);

  for (let i = 1; i < path.points.length - 1; i++) {
    const xc = (path.points[i].x + path.points[i + 1].x) / 2;
    const yc = (path.points[i].y + path.points[i + 1].y) / 2;
    drawCtx.quadraticCurveTo(path.points[i].x, path.points[i].y, xc, yc);
  }

  const last = path.points[path.points.length - 1];
  drawCtx.lineTo(last.x, last.y);
  drawCtx.stroke();
  drawCtx.restore();
}

function redrawAll() {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  state.paths.forEach(drawPath);
}

function drawHandOverlay(hand, indexOnly, openPalm, isDrawing, waveSpan = 0) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  const links = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17]
  ];

  overlayCtx.save();
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = 'rgba(45, 212, 255, 0.8)';
  overlayCtx.fillStyle = 'rgba(45, 212, 255, 0.9)';

  links.forEach(([a, b]) => {
    const pa = mapLandmarkToCanvas(hand[a], overlayCanvas);
    const pb = mapLandmarkToCanvas(hand[b], overlayCanvas);
    overlayCtx.beginPath();
    overlayCtx.moveTo(pa.x, pa.y);
    overlayCtx.lineTo(pb.x, pb.y);
    overlayCtx.stroke();
  });

  hand.forEach((p) => {
    const mapped = mapLandmarkToCanvas(p, overlayCanvas);
    overlayCtx.beginPath();
    overlayCtx.arc(mapped.x, mapped.y, 3, 0, Math.PI * 2);
    overlayCtx.fill();
  });

  const indexAnchor = {
    x: hand[8].x * 0.75 + hand[7].x * 0.25,
    y: hand[8].y * 0.75 + hand[7].y * 0.25
  };
  const indexPoint = mapLandmarkToCanvas(indexAnchor, overlayCanvas);

  overlayCtx.beginPath();
  overlayCtx.arc(indexPoint.x, indexPoint.y, 10, 0, Math.PI * 2);
  overlayCtx.strokeStyle = isDrawing ? '#00ff9f' : (openPalm ? '#ff6b6b' : '#ffd166');
  overlayCtx.lineWidth = 3;
  overlayCtx.stroke();

  if (openPalm) {
    const palmCenter = getPalmCenter(hand, overlayCanvas);
    overlayCtx.beginPath();
    overlayCtx.arc(palmCenter.x, palmCenter.y, 18, 0, Math.PI * 2);
    overlayCtx.strokeStyle = '#ff6b6b';
    overlayCtx.lineWidth = 3;
    overlayCtx.stroke();
  }

  overlayCtx.font = '14px Segoe UI';
  overlayCtx.fillStyle = '#dff7ff';
  const poseText = openPalm ? 'Pose: OPEN PALM' : (indexOnly ? 'Pose: INDEX ONLY' : 'Pose: NOT READY');
  const modeText = isDrawing
    ? 'Mode: DRAW'
    : (openPalm ? `Mode: WAVE TO ERASE (${Math.round(Math.min(waveSpan / (drawCanvas.width * 0.12), 1) * 100)}%)` : 'Mode: IDLE');
  overlayCtx.fillText(poseText, 16, 26);
  overlayCtx.fillText(modeText, 16, 48);

  overlayCtx.restore();
}

function onResults(results) {
  state.hasReceivedFrame = true;
  if (loadingScreen.style.display !== 'none') {
    loadingScreen.style.display = 'none';
  }

  const now = performance.now();
  let hand = null;

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    hand = results.multiHandLandmarks[0];
    state.lastHandLandmarks = hand;
    state.lastHandTime = now;
  } else if (state.lastHandLandmarks && (now - state.lastHandTime) <= state.handHoldMs) {
    hand = state.lastHandLandmarks;
  }

  if (!hand) {
    state.isDrawing = false;
    state.currentPath = null;
    state.smoothed = null;
    state.lastSmoothAt = 0;
    state.pinchStableFrames = 0;
    state.releaseStableFrames = 0;
    state.lastHandLandmarks = null;
    resetWaveDetector();
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    return;
  }

  const indexAnchor = {
    x: hand[8].x * 0.75 + hand[7].x * 0.25,
    y: hand[8].y * 0.75 + hand[7].y * 0.25
  };

  const mappedIndex = mapLandmarkToCanvas(indexAnchor, drawCanvas);
  const smooth = smoothPoint(mappedIndex, now);

  const indexOnly = isIndexOnlyPose(hand);
  const openPalm = isOpenPalmPose(hand);

  if (indexOnly && !openPalm) {
    state.pinchStableFrames += 1;
    state.releaseStableFrames = 0;
    if (state.pinchStableFrames >= state.minFramesToToggle) {
      state.isDrawing = true;
    }
  } else {
    state.releaseStableFrames += 1;
    state.pinchStableFrames = 0;
    if (state.releaseStableFrames >= state.minFramesToToggle) {
      state.isDrawing = false;
      state.currentPath = null;
    }
  }

  if (openPalm) {
    state.isDrawing = false;
    state.currentPath = null;
    const wave = updateWaveEraseDetector(hand);
    if (wave.triggered && state.paths.length > 0) {
      state.paths = [];
      state.currentPath = null;
      redrawAll();
    }
    drawHandOverlay(hand, indexOnly, openPalm, state.isDrawing, wave.waveSpan);
    return;
  }

  resetWaveDetector();

  if (state.isDrawing) {
    addPoint(smooth);
    redrawAll();
  }

  drawHandOverlay(hand, indexOnly, openPalm, state.isDrawing, 0);
}

undoBtn.addEventListener('click', () => {
  if (state.currentPath) state.currentPath = null;
  state.paths.pop();
  redrawAll();
});

clearBtn.addEventListener('click', () => {
  state.currentPath = null;
  state.paths = [];
  redrawAll();
});

saveBtn.addEventListener('click', () => {
  const out = document.createElement('canvas');
  out.width = drawCanvas.width;
  out.height = drawCanvas.height;
  const outCtx = out.getContext('2d');
  outCtx.fillStyle = '#000';
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.drawImage(drawCanvas, 0, 0);

  const link = document.createElement('a');
  link.download = `air-writing-${Date.now()}.png`;
  link.href = out.toDataURL('image/png');
  link.click();
});

async function startApp() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showLoadingMessage('Camera API not supported in this browser.', true);
      return;
    }

    if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
      showLoadingMessage('Failed to load MediaPipe scripts. Check internet/CDN access.', true);
      return;
    }

    const hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.55
    });

    hands.onResults(onResults);

    const camera = new Camera(videoElement, {
      onFrame: async () => {
        await hands.send({ image: videoElement });
      },
      width: 1280,
      height: 720
    });

    await camera.start();

    window.setTimeout(() => {
      if (!state.hasReceivedFrame && loadingScreen.style.display !== 'none') {
        showLoadingMessage('Camera started but hand model is not responding. Enable hardware acceleration and reload.', true);
      }
    }, 9000);
  } catch (error) {
    console.error(error);
    showLoadingMessage('Camera start failed. Allow camera permission and reload page.', true);
  }
}

startApp();
