// VOXEL ARCHITECT v5.1
// Hand-gesture controlled 3D voxel builder (MediaPipe Hands + Three.js)
// Gestures:
//   - PINCH          -> build voxel
//   - FIST           -> grab & move structure
//   - TWO PALMS      -> rotate structure
//   - TWO FISTS      -> hard reset
//   - VICTORY LEFT   -> change color
//   - VICTORY RIGHT  -> toggle disco mode
//   - OPEN PALM      -> disable disco

// Configuration — edit values to customize
const CONFIG = {
  maxHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.6,

  pinchThresholdRatio: 0.42,   // jarak pinch relatif terhadap ukuran telapak
  fingerExtendRatio: 1.08,     // rasio jarak tip-ke-wrist vs pip-ke-wrist

  voxelSize: 0.5,
  rotateSensitivity: 4.2,
  moveSensitivity: 6.5,
  navigateMoveThreshold: 0.0009,

  resetCooldownMs: 1400,
  flashMessageMs: 1100,

  palette: [0x39ff6a, 0xffe135, 0xff2fd0, 0x2fd9ff, 0xa855f7, 0xff8c1a],

  cameraWidth: 1280,
  cameraHeight: 720,

  mediapipeBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/',
  threeCdnBase: 'https://cdn.jsdelivr.net/npm/three@0.158.0/',

  // --- Visual modern: bloom / glow post-processing ---
  enableBloom: true,
  bloomStrength: 0.55,
  bloomRadius: 0.4,
  bloomThreshold: 0.28,
  toneMappingExposure: 1.0,

  // --- Physics "inertia" supaya rotate & grab terasa halus, tidak kaku ---
  rotateInertiaDamping: 0.90,
  moveInertiaDamping: 0.88,

  // --- Auto-rotate pelan saat idle (tidak ada tangan terdeteksi) ---
  idleRotateSpeed: 0.0018,
  idleFramesBeforeAutoRotate: 50,

  // --- Grid backdrop (bukan lantai — panel grid di belakang struktur) ---
  gridColor: 0x1adfd0,
  gridOpacity: 0.16,
  gridSize: 16,
  gridDivisions: 24,
  gridZ: -3.4,

  // --- Partikel ambient (debu melayang, dekorasi latar) ---
  ambientParticleCount: 180,
  ambientParticleColor: 0x38f0e8,
  ambientParticleSpread: { x: 4.5, y: 4.5, z: 3.5 },

  // --- Partikel burst saat voxel ditempatkan ---
  burstParticleCount: 16,
  burstLifeMs: 550,
};

// Hand topology — defined inline to avoid drawing_utils dependency
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const FINGERTIPS = [4, 8, 12, 16, 20];

// Global state
// Diisi lewat dynamic import() saat boot — lihat bagian 12.
let THREE = null;
let EffectComposer = null, RenderPass = null, UnrealBloomPass = null, OutputPass = null;
let usePostFX = false;
let composer = null;

let scene, camera, renderer, voxelGroup, backdropGrid, ambientParticles;
let videoEl, stageEl, skeletonCanvas, skeletonCtx, threeCanvas;
let handsInstance = null, cameraInstance = null;
let appReady = false;

const placedVoxels = new Map(); // key "gx,gy" -> THREE.Mesh
const activeBursts = []; // partikel ledakan sementara saat build voxel

let paletteIndex = 0;
let discoActive = false;

let prevAnyPinch = false;
let prevLeftVictory = false;
let prevRightVictory = false;
let prevBothFists = false;
let lastResetTime = -Infinity;

let rotatePrev = null; // {x,y} titik referensi frame sebelumnya (rotate)
let grabPrev = null;   // {x,y} titik referensi frame sebelumnya (grab/move)
let isRotatingNow = false;
let isGrabbingNow = false;
const rotateVelocity = { x: 0, y: 0 };
const moveVelocity = { x: 0, y: 0 };
let idleFrames = 0;

let hudFlash = null; // { text, expiresAt }

// Utils: geometry & gesture detection
function dist2D(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function palmSize(lm) {
  return Math.max(dist2D(lm[0], lm[9]), 0.0001);
}

function isFingerExtended(lm, tipIdx, pipIdx) {
  return dist2D(lm[tipIdx], lm[0]) > dist2D(lm[pipIdx], lm[0]) * CONFIG.fingerExtendRatio;
}

function analyzeHand(lm) {
  const ps = palmSize(lm);
  const idx = isFingerExtended(lm, 8, 6);
  const mid = isFingerExtended(lm, 12, 10);
  const ring = isFingerExtended(lm, 16, 14);
  const pinky = isFingerExtended(lm, 20, 18);
  const thumb = isFingerExtended(lm, 4, 2);

  const pinchDist = dist2D(lm[4], lm[8]);
  // Syarat "idx" (telunjuk terjulur) penting: mencegah kepalan tangan (fist) ikut
  // terbaca sebagai pinch, karena pada kepalan, ujung jempol & telunjuk yang sama-sama
  // menekuk ke telapak kebetulan juga berdekatan secara jarak mentah.
  const pinching = idx && pinchDist < ps * CONFIG.pinchThresholdRatio;
  const fist = !idx && !mid && !ring && !pinky;
  const openPalm = idx && mid && ring && pinky;
  const victory = idx && mid && !ring && !pinky;

  return {
    idx, mid, ring, pinky, thumb,
    pinching, fist, openPalm, victory,
    pinchPoint: {
      x: (lm[4].x + lm[8].x) / 2,
      y: (lm[4].y + lm[8].y) / 2,
    },
    anchor: lm[9], // titik acuan gerak tangan (pangkal jari tengah)
  };
}

// Utils: coordinate mapping
function getCoverMap() {
  const vw = videoEl.videoWidth || CONFIG.cameraWidth;
  const vh = videoEl.videoHeight || CONFIG.cameraHeight;
  const cw = stageEl.clientWidth || window.innerWidth;
  const ch = stageEl.clientHeight || window.innerHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const drawW = vw * scale;
  const drawH = vh * scale;
  return {
    vw, vh, cw, ch, scale,
    offsetX: (cw - drawW) / 2,
    offsetY: (ch - drawH) / 2,
  };
}

// landmark ternormalisasi [0,1] pada frame video -> koordinat piksel di canvas layar
function landmarkToStagePx(lm) {
  const m = getCoverMap();
  return {
    x: lm.x * m.vw * m.scale + m.offsetX,
    y: lm.y * m.vh * m.scale + m.offsetY,
  };
}

// landmark -> koordinat ternormalisasi [0,1] relatif ke area yang tampil di layar
function landmarkToStageNorm(lm) {
  const px = landmarkToStagePx(lm);
  return {
    x: px.x / (stageEl.clientWidth || window.innerWidth),
    y: px.y / (stageEl.clientHeight || window.innerHeight),
  };
}

// THREE.js initialization
function initThree() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    50,
    (stageEl.clientWidth || window.innerWidth) / (stageEl.clientHeight || window.innerHeight),
    0.1,
    100
  );
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true });
  // PENTING: renderer TIDAK pakai alpha:true. UnrealBloomPass tidak menangani
  // background transparan dengan benar (hasilnya jadi blok putih besar, bukan
  // glow di sekitar objek). Solusinya: render solid warna hitam, lalu di CSS
  // canvas ini diberi mix-blend-mode:screen -> area hitam otomatis "hilang" saat
  // ditumpuk di atas video, area terang tetap menyala. Trik standar utk AR+bloom.
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(stageEl.clientWidth || window.innerWidth, stageEl.clientHeight || window.innerHeight, false);
  // Tone mapping + color space yang benar: tanpa ini, warna Three.js sering terlihat
  // pudar/datar ("kuno"). Dengan ACESFilmicToneMapping, warna terang jadi lebih hidup
  // dan siap "meledak" saat kena bloom.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.toneMappingExposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(3, 4, 5);
  scene.add(dirLight);
  const rimLight = new THREE.DirectionalLight(0x66ffee, 0.5);
  rimLight.position.set(-4, -2, -3);
  scene.add(rimLight);

  voxelGroup = new THREE.Group();
  scene.add(voxelGroup);

  backdropGrid = buildBackdropGrid();
  scene.add(backdropGrid);

  ambientParticles = buildAmbientParticles();
  scene.add(ambientParticles);

  setupPostFX();
}

// Backdrop grid — drawn behind voxel structure
function buildBackdropGrid() {
  const grid = new THREE.GridHelper(CONFIG.gridSize, CONFIG.gridDivisions, CONFIG.gridColor, CONFIG.gridColor);
  grid.rotation.x = Math.PI / 2; // dari bidang XZ (lantai) -> bidang XY (dinding di belakang)
  grid.position.z = CONFIG.gridZ;
  grid.material.transparent = true;
  grid.material.opacity = CONFIG.gridOpacity;
  grid.material.toneMapped = false;
  return grid;
}

function buildAmbientParticles() {
  const n = CONFIG.ambientParticleCount;
  const positions = new Float32Array(n * 3);
  const spread = CONFIG.ambientParticleSpread;
  for (let i = 0; i < n; i++) {
    positions[i * 3 + 0] = (Math.random() * 2 - 1) * spread.x;
    positions[i * 3 + 1] = (Math.random() * 2 - 1) * spread.y;
    positions[i * 3 + 2] = (Math.random() * 2 - 1) * spread.z - 1.0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: CONFIG.ambientParticleColor,
    size: 0.028,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  return new THREE.Points(geo, mat);
}

function setupPostFX() {
  if (!CONFIG.enableBloom || !EffectComposer || !RenderPass || !UnrealBloomPass) {
    usePostFX = false;
    return;
  }
  try {
    const w = stageEl.clientWidth || window.innerWidth;
    const h = stageEl.clientHeight || window.innerHeight;
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    composer.setSize(w, h);
    composer.addPass(new RenderPass(scene, camera));

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      CONFIG.bloomStrength,
      CONFIG.bloomRadius,
      CONFIG.bloomThreshold
    );
    composer.addPass(bloomPass);

    if (OutputPass) composer.addPass(new OutputPass());

    usePostFX = true;
  } catch (err) {
    console.error('Gagal menyiapkan post-processing (bloom), lanjut dengan render biasa:', err);
    usePostFX = false;
    composer = null;
  }
}

function createVoxelMesh(colorHex) {
  const s = CONFIG.voxelSize * 0.9;
  const geo = new THREE.BoxGeometry(s, s, s);
  const mat = new THREE.MeshStandardMaterial({
    color: colorHex,
    emissive: colorHex,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.85,
    roughness: 0.45,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geo, mat);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, toneMapped: false })
  );
  mesh.add(edges);

  mesh.scale.setScalar(0.0001);
  mesh.userData.spawnTime = performance.now();
  return mesh;
}

function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function ndcToWorldOnPlane(ndcX, ndcY, zPlane) {
  const vec = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
  const dir = vec.sub(camera.position).normalize();
  const t = (zPlane - camera.position.z) / dir.z;
  return camera.position.clone().add(dir.multiplyScalar(t));
}

function spawnBurst(position, colorHex) {
  const n = CONFIG.burstParticleCount;
  const positions = new Float32Array(n * 3);
  const velocities = [];
  for (let i = 0; i < n; i++) {
    positions[i * 3 + 0] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    const speed = 0.6 + Math.random() * 1.1;
    velocities.push({
      x: Math.sin(phi) * Math.cos(theta) * speed,
      y: Math.sin(phi) * Math.sin(theta) * speed,
      z: Math.cos(phi) * speed * 0.5,
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: colorHex,
    size: 0.05,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geo, mat);
  voxelGroup.add(points);
  activeBursts.push({ points, velocities, geo, mat, born: performance.now() });
}

function updateBursts(now) {
  for (let i = activeBursts.length - 1; i >= 0; i--) {
    const b = activeBursts[i];
    const age = now - b.born;
    const k = age / CONFIG.burstLifeMs;
    if (k >= 1) {
      voxelGroup.remove(b.points);
      b.geo.dispose();
      b.mat.dispose();
      activeBursts.splice(i, 1);
      continue;
    }
    const posAttr = b.geo.getAttribute('position');
    for (let p = 0; p < b.velocities.length; p++) {
      posAttr.array[p * 3 + 0] += b.velocities[p].x * 0.016;
      posAttr.array[p * 3 + 1] += b.velocities[p].y * 0.016;
      posAttr.array[p * 3 + 2] += b.velocities[p].z * 0.016;
    }
    posAttr.needsUpdate = true;
    b.mat.opacity = 1 - k;
  }
}

function placeVoxelAt(pinchPointLandmark) {
  const norm = landmarkToStageNorm(pinchPointLandmark);
  const ndcX = norm.x * 2 - 1;
  const ndcY = -(norm.y * 2 - 1);
  const worldPos = ndcToWorldOnPlane(ndcX, ndcY, 0);

  const gx = Math.round(worldPos.x / CONFIG.voxelSize);
  const gy = Math.round(worldPos.y / CONFIG.voxelSize);
  const key = gx + ',' + gy;
  if (placedVoxels.has(key)) return;

  const color = CONFIG.palette[paletteIndex];
  const mesh = createVoxelMesh(color);
  mesh.position.set(gx * CONFIG.voxelSize, gy * CONFIG.voxelSize, 0);
  voxelGroup.add(mesh);
  placedVoxels.set(key, mesh);

  spawnBurst(mesh.position, color);
}

function recolorAllVoxels(colorHex) {
  placedVoxels.forEach((mesh) => {
    mesh.material.color.setHex(colorHex);
    mesh.material.emissive.setHex(colorHex);
  });
}

function hardResetView() {
  voxelGroup.rotation.set(0, 0, 0);
  voxelGroup.position.set(0, 0, 0);
  rotateVelocity.x = 0; rotateVelocity.y = 0;
  moveVelocity.x = 0; moveVelocity.y = 0;
}

// Skeleton overlay (2D canvas)
function clearSkeletonCanvas() {
  skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
}

function drawHandSkeleton(lm, isActiveGestureHand) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pts = lm.map(landmarkToStagePx);

  skeletonCtx.save();
  skeletonCtx.scale(dpr, dpr);

  skeletonCtx.strokeStyle = isActiveGestureHand ? 'rgba(255, 224, 90, 0.95)' : 'rgba(56, 240, 232, 0.9)';
  skeletonCtx.lineWidth = 2;
  HAND_CONNECTIONS.forEach(([a, b]) => {
    skeletonCtx.beginPath();
    skeletonCtx.moveTo(pts[a].x, pts[a].y);
    skeletonCtx.lineTo(pts[b].x, pts[b].y);
    skeletonCtx.stroke();
  });

  skeletonCtx.fillStyle = isActiveGestureHand ? 'rgba(255, 224, 90, 0.95)' : 'rgba(56, 240, 232, 0.95)';
  pts.forEach((p) => {
    skeletonCtx.beginPath();
    skeletonCtx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    skeletonCtx.fill();
  });

  skeletonCtx.strokeStyle = 'rgba(255,255,255,0.95)';
  skeletonCtx.lineWidth = 1.5;
  FINGERTIPS.forEach((i) => {
    const p = pts[i];
    skeletonCtx.strokeRect(p.x - 6, p.y - 6, 12, 12);
  });

  skeletonCtx.restore();
}

// HUD
const hudStateEl = () => document.getElementById('hud-state');
const hudVoxelsEl = () => document.getElementById('hud-voxels');

function updateHud(stateText) {
  const stateNode = hudStateEl();
  const voxelNode = hudVoxelsEl();
  if (stateNode) stateNode.textContent = stateText;
  if (voxelNode) voxelNode.textContent = String(placedVoxels.size);
}

function averageStagePoint(handObjs) {
  let sx = 0, sy = 0;
  handObjs.forEach((h) => {
    const p = landmarkToStageNorm(h.a.anchor);
    sx += p.x; sy += p.y;
  });
  return { x: sx / handObjs.length, y: sy / handObjs.length };
}

function onHandsResults(results) {
  hideLoadingOverlay();

  const rawHands = results.multiHandLandmarks || [];
  clearSkeletonCanvas();

  // Klasifikasikan kiri/kanan berdasarkan posisi di LAYAR (setelah efek cermin),
  // bukan label handedness mentah dari MediaPipe, supaya konsisten dgn apa yg dilihat user.
  const analyzed = rawHands.map((lm) => {
    const a = analyzeHand(lm);
    const rawMidX = (lm[0].x + lm[9].x) / 2;
    const screenX = 1 - rawMidX; // dampak mirror CSS scaleX(-1)
    return { lm, a, screenX };
  });
  analyzed.sort((p, q) => p.screenX - q.screenX);

  let L = null, R = null;
  if (analyzed.length === 1) {
    if (analyzed[0].screenX < 0.5) L = analyzed[0]; else R = analyzed[0];
  } else if (analyzed.length >= 2) {
    L = analyzed[0];
    R = analyzed[analyzed.length - 1];
  }

  const fistHands = analyzed.filter((h) => h.a.fist);
  const pinchHands = analyzed.filter((h) => h.a.pinching);
  const openHands = analyzed.filter((h) => h.a.openPalm);

  const bothFists = fistHands.length >= 2;
  const bothOpen = openHands.length >= 2;
  const oneFist = fistHands.length === 1 && !bothFists;
  const anyPinch = pinchHands.length > 0;
  const leftVictory = !!(L && L.a.victory);
  const rightVictory = !!(R && R.a.victory);

  const now = performance.now();
  idleFrames = analyzed.length === 0 ? idleFrames + 1 : 0;

  // --- Disco: berhenti jika ada telapak terbuka ---
  if (discoActive && openHands.length > 0) {
    discoActive = false;
    recolorAllVoxels(CONFIG.palette[paletteIndex]);
  }

  // --- Hard reset (edge-trigger, dgn cooldown) ---
  if (bothFists && !prevBothFists && (now - lastResetTime > CONFIG.resetCooldownMs)) {
    hardResetView();
    lastResetTime = now;
    hudFlash = { text: 'SYSTEM: HARD_RESET_COMPLETE', expiresAt: now + CONFIG.flashMessageMs };
  }

  // --- Ganti warna (victory kiri, edge-trigger) ---
  if (leftVictory && !prevLeftVictory) {
    paletteIndex = (paletteIndex + 1) % CONFIG.palette.length;
    recolorAllVoxels(CONFIG.palette[paletteIndex]);
    hudFlash = { text: 'SYSTEM: HUE_SHIFT_APPLIED', expiresAt: now + 900 };
  }

  // --- Mode disco (victory kanan, edge-trigger) ---
  if (rightVictory && !prevRightVictory) {
    discoActive = true;
  }

  // --- Rotate (kedua telapak terbuka) — kontrol langsung + catat velocity utk inersia ---
  isRotatingNow = bothOpen && !bothFists;
  if (isRotatingNow) {
    const avg = averageStagePoint(openHands);
    if (rotatePrev) {
      const dx = avg.x - rotatePrev.x;
      const dy = avg.y - rotatePrev.y;
      const vy = dx * CONFIG.rotateSensitivity;
      const vx = dy * CONFIG.rotateSensitivity;
      voxelGroup.rotation.y += vy;
      voxelGroup.rotation.x += vx;
      rotateVelocity.x = vx;
      rotateVelocity.y = vy;
    }
    rotatePrev = avg;
  } else {
    rotatePrev = null;
  }

  // --- Grab / geser (1 tangan mengepal) — kontrol langsung + catat velocity utk inersia ---
  let navigating = false;
  isGrabbingNow = oneFist;
  if (isGrabbingNow) {
    const p = landmarkToStageNorm(fistHands[0].a.anchor);
    if (grabPrev) {
      const dx = p.x - grabPrev.x;
      const dy = p.y - grabPrev.y;
      if (Math.abs(dx) > CONFIG.navigateMoveThreshold || Math.abs(dy) > CONFIG.navigateMoveThreshold) {
        navigating = true;
      }
      const vx = dx * CONFIG.moveSensitivity;
      const vy = -dy * CONFIG.moveSensitivity;
      voxelGroup.position.x += vx;
      voxelGroup.position.y += vy;
      moveVelocity.x = vx;
      moveVelocity.y = vy;
    }
    grabPrev = p;
  } else {
    grabPrev = null;
  }

  // --- Build (pinch, edge-trigger) ---
  if (anyPinch && !prevAnyPinch) {
    placeVoxelAt(pinchHands[0].a.pinchPoint);
  }

  // --- Gambar skeleton tiap tangan (highlight jika sedang gesture aktif) ---
  analyzed.forEach((h) => {
    const active = h.a.fist || h.a.pinching || h.a.openPalm || h.a.victory;
    drawHandSkeleton(h.lm, active);
  });

  // --- Tentukan teks status HUD ---
  let stateText;
  if (hudFlash && now < hudFlash.expiresAt) {
    stateText = hudFlash.text;
  } else {
    hudFlash = null;
    if (bothFists) stateText = 'SYSTEM: HARD_RESET_COMPLETE';
    else if (bothOpen) stateText = 'SYSTEM: GLOBAL_ROTATE_ACTIVE';
    else if (oneFist) stateText = navigating ? 'BIO_LINK: NAVIGATING' : 'BIO_LINK: GRABBED';
    else if (anyPinch) stateText = 'INTENT: BUILDING';
    else if (discoActive) stateText = 'SYSTEM: DISCO_ENGAGED';
    else if (analyzed.length > 0) stateText = 'BIO_LINK: SCANNING';
    else stateText = 'SYSTEM: HOLD PALMS TO ROTATE';
  }
  updateHud(stateText);

  prevAnyPinch = anyPinch;
  prevLeftVictory = leftVictory;
  prevRightVictory = rightVictory;
  prevBothFists = bothFists;
}

// Render loop — inertia, auto-rotate idle, disco, bloom
/* ------------------------------------------------------------------ */
function animate(t) {
  requestAnimationFrame(animate);
  if (!renderer) return;

  // Inersia: hanya berlaku saat TIDAK sedang dikontrol langsung oleh gesture,
  // supaya gerakan lanjutan terasa halus (bisa berhenti mendadak) tapi juga
  // tidak "berebut" dengan kontrol aktif dari tangan.
  if (!isRotatingNow) {
    voxelGroup.rotation.y += rotateVelocity.y;
    voxelGroup.rotation.x += rotateVelocity.x;
    rotateVelocity.x *= CONFIG.rotateInertiaDamping;
    rotateVelocity.y *= CONFIG.rotateInertiaDamping;
  }
  if (!isGrabbingNow) {
    voxelGroup.position.x += moveVelocity.x;
    voxelGroup.position.y += moveVelocity.y;
    moveVelocity.x *= CONFIG.moveInertiaDamping;
    moveVelocity.y *= CONFIG.moveInertiaDamping;
  }

  // Auto-rotate pelan saat benar-benar idle (tak ada tangan sekian frame beruntun
  // & momentum sudah nyaris habis), supaya scene tidak terasa "mati" saat idle.
  const velMag = Math.abs(rotateVelocity.x) + Math.abs(rotateVelocity.y);
  if (idleFrames > CONFIG.idleFramesBeforeAutoRotate && velMag < 0.0005) {
    voxelGroup.rotation.y += CONFIG.idleRotateSpeed;
  }

  if (discoActive) {
    let i = 0;
    placedVoxels.forEach((mesh) => {
      const hue = ((t * 0.00025) + i * 0.07) % 1;
      const c = new THREE.Color().setHSL(hue < 0 ? hue + 1 : hue, 1, 0.55);
      mesh.material.color.copy(c);
      mesh.material.emissive.copy(c);
      i++;
    });
  }

  placedVoxels.forEach((mesh) => {
    if (mesh.scale.x < 1) {
      const k = Math.min(1, (performance.now() - mesh.userData.spawnTime) / 220);
      const s = 0.0001 + (1 - 0.0001) * easeOutBack(k);
      mesh.scale.setScalar(Math.max(s, 0.0001));
    }
  });

  updateBursts(performance.now());

  // Dekorasi latar: partikel ambient melayang pelan + grid backdrop berdenyut halus
  if (ambientParticles) {
    ambientParticles.rotation.y = t * 0.00002;
    ambientParticles.position.y = Math.sin(t * 0.0003) * 0.15;
  }
  if (backdropGrid) {
    backdropGrid.material.opacity = CONFIG.gridOpacity + Math.sin(t * 0.0006) * 0.03;
  }

  if (usePostFX && composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// Window resize handling
/* ------------------------------------------------------------------ */
function onWindowResize() {
  const w = stageEl.clientWidth || window.innerWidth;
  const h = stageEl.clientHeight || window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  skeletonCanvas.width = w * dpr;
  skeletonCanvas.height = h * dpr;

  if (camera && renderer) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  if (usePostFX && composer) {
    composer.setSize(w, h);
  }
}

// Loading / error UI
/* ------------------------------------------------------------------ */
function hideLoadingOverlay() {
  if (appReady) return;
  appReady = true;
  const el = document.getElementById('loading-overlay');
  if (el) el.classList.add('hidden');
}

function showError(message) {
  const banner = document.getElementById('error-banner');
  const text = document.getElementById('error-text');
  if (text) text.textContent = message;
  if (banner) banner.hidden = false;
  const loadingText = document.getElementById('loading-text');
  if (loadingText) loadingText.textContent = 'Gagal memuat. Lihat pesan di bawah.';
}

// Initialize MediaPipe Hands + Camera
/* ------------------------------------------------------------------ */
function initHandsPipeline() {
  if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
    throw new Error('Library MediaPipe (Hands/Camera) gagal dimuat dari CDN. Periksa koneksi internet.');
  }

  handsInstance = new Hands({
    locateFile: (file) => CONFIG.mediapipeBase + file,
  });
  handsInstance.setOptions({
    maxNumHands: CONFIG.maxHands,
    modelComplexity: CONFIG.modelComplexity,
    minDetectionConfidence: CONFIG.minDetectionConfidence,
    minTrackingConfidence: CONFIG.minTrackingConfidence,
  });
  handsInstance.onResults(onHandsResults);

  cameraInstance = new Camera(videoEl, {
    onFrame: async () => {
      try {
        await handsInstance.send({ image: videoEl });
      } catch (err) {
        console.error('Hands.send() error:', err);
      }
    },
    width: CONFIG.cameraWidth,
    height: CONFIG.cameraHeight,
  });

  cameraInstance.start().catch((err) => {
    console.error(err);
    showError('Tidak bisa mengakses webcam: ' + (err && err.message ? err.message : err));
  });
}

// Bootstrap
/* ------------------------------------------------------------------ */
async function loadThree() {
  const mod = await import(/* @vite-ignore */ 'three');
  THREE = mod;
}

// Post-processing (bloom) — optional. If CDN fails, app continues without glow effects.
async function loadPostFX() {
  try {
    const base = CONFIG.threeCdnBase + 'examples/jsm/postprocessing/';
    const [composerMod, renderMod, bloomMod, outputMod] = await Promise.all([
      import(/* @vite-ignore */ base + 'EffectComposer.js'),
      import(/* @vite-ignore */ base + 'RenderPass.js'),
      import(/* @vite-ignore */ base + 'UnrealBloomPass.js'),
      import(/* @vite-ignore */ base + 'OutputPass.js'),
    ]);
    EffectComposer = composerMod.EffectComposer;
    RenderPass = renderMod.RenderPass;
    UnrealBloomPass = bloomMod.UnrealBloomPass;
    OutputPass = outputMod.OutputPass;
  } catch (err) {
    console.warn('Post-processing (bloom) gagal dimuat, lanjut TANPA efek glow:', err);
    EffectComposer = RenderPass = UnrealBloomPass = OutputPass = null;
  }
}

async function boot() {
  videoEl = document.getElementById('webcam');
  stageEl = document.getElementById('mirror-stage');
  skeletonCanvas = document.getElementById('skeleton-canvas');
  threeCanvas = document.getElementById('three-canvas');
  skeletonCtx = skeletonCanvas.getContext('2d');

  if (!videoEl || !stageEl || !skeletonCanvas || !threeCanvas) {
    showError('Elemen halaman tidak lengkap. Coba muat ulang halaman.');
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('Browser ini tidak mendukung akses kamera (getUserMedia). Gunakan Chrome/Edge terbaru via server lokal (mis. Live Server).');
    return;
  }

  try {
    await loadThree();
  } catch (err) {
    console.error(err);
    showError('Gagal memuat Three.js dari CDN. Periksa koneksi internet lalu muat ulang halaman.');
    return;
  }

  await loadPostFX(); // non-fatal kalau gagal

  try {
    initThree();
    onWindowResize();
    window.addEventListener('resize', onWindowResize);
    requestAnimationFrame(animate);
    initHandsPipeline();
  } catch (err) {
    console.error(err);
    showError('Gagal menginisialisasi aplikasi: ' + (err && err.message ? err.message : err));
  }
}

boot();

// Diekspos untuk kebutuhan debugging manual dari console browser.
window.__voxelArchitect = { CONFIG, placedVoxels };