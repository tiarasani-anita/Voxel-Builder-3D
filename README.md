Voxel Architect v5.1

Aplikasi web hand_tracking 3D voxel builder bangun kubus 3D hanya dengan gerakan tangan di depan webcam.

Library utama
- MediaPipe Hands: deteksi 21 titik landmark tangan real time dari webcam
- Three.js (ES modules): render voxel 3D di-overlay di atas video webcam

Semua library dimuat dari CDN jsdelivr versi dikunci, tidak akan tiba-tiba berubah.

Cara Menjalankan
Kamera browser (`getUserMedia`) tidak akan jalan kalau `index.html` dibuka langsung dengan cara double click (`file://...`). Wajib dijalankan lewat server lokal persis seperti `127.0.0.1:5500`.

1. Buka folder ini di VS Code.
2. Install ekstensi "Live Server" (by Ritwick Dey) dari tab Extensions, kalau belum ada.
3. Klik kanan pada `index.html` "Open with Live Server".
4. Browser akan terbuka otomatis ke `http://127.0.0.1:5500`.
5. Izinkan akses kamera saat diminta browser.
6. Tunggu 1-2 detik sampai overlay "Mengaktifkan kamera" hilang lalu mulai gesture.

> Alternatif tanpa VS Code: `python3 -m http.server 5500` di folder ini, lalu buka `http://127.0.0.1:5500`.

Browser yang disarankan: Chrome atau Edge versi terbaru (butuh WebGL + getUserMedia).

Panduan Gesture
- Pinch (jempol + telunjuk nempel, jari lain santai) Bangun 1 voxel di posisi tangan
- 1 tangan mengepal (fist), lalu digeser Pegang & geser seluruh struktur  
- Kedua telapak terbuka, lalu digeser Putar (rotate) seluruh struktur
- Kedua tangan mengepal bersamaan Hard reset posisi & rotasi (voxel tidak hilang)
- Victory tangan kiri (di layar) Ganti warna semua voxel (siklus palet)
- Victory tangan kanan (di layar) Nyalakan mode disco (warna berputar-putar)
- Telapak terbuka saat mode disco aktif Matikan mode disco

Kiri/kanan ditentukan dari posisi tangan di layar (bukan tangan asli kamu), supaya konsisten dengan tampilan cermin (mirror) di layar.

Struktur File

- `index.html`:struktur halaman, HUD, memuat library dari CDN
- `style.css` :tampilan HUD ala "terminal cyberpunk" + layout fullscreen
- `script.js` :semua logic: deteksi gesture, kontrol Three.js, state machine HUD

Kustomisasi Cepat

Semua konstanta yang sering ingin diubah ada di bagian atas `script.js`, di objek `CONFIG`:

js
const CONFIG =
  pinchThresholdRatio: 0.42,  : makin kecil = pinch harus makin rapat
  voxelSize: 0.5,             : ukuran tiap kubus
  rotateSensitivity: 4.2,     : makin besar = rotasi makin sensitif
  moveSensitivity: 6.5,       : geser makin sensitif
  palette: [0x39ff6a, 0xffe135, 0xff2fd0, 0x2fd9ff, 0xa855f7, 0xff8c1a],

  enableBloom: true,          : matikan kalau device terasa berat/lag
  bloomStrength: 0.55,        : makin besar = glow makin terang/menyebar
  bloomThreshold: 0.28,       : makin kecil = makin banyak yg ikut nge-glow

  rotateInertiaDamping: 0.90, : makin dekat ke 1 = momentum bertahan makin lama
  moveInertiaDamping: 0.88,   :


> Kalau device terasa berat/nge-lag: set `enableBloom: false` di `CONFIG` aplikasi otomatis fallback ke render biasa tanpa glow, tetap berfungsi penuh.

Troubleshooting

- Layar putih / kamera tidak nyala, pastikan dibuka lewat `http://127.0.0.1:5500` (Live Server), bukan `file://`. Cek juga izin kamera di ikon gembok address bar browser.
- Muncul banner error merah → baca pesannya, biasanya soal izin kamera atau koneksi internet (library dimuat dari CDN, jadi butuh internet saat pertama kali load).
- Gestur kurang responsif, coba pastikan pencahayaan cukup terang dan tangan terlihat jelas di kamera, atau kecilkan `pinchThresholdRatio` / sesuaikan `minDetectionConfidence` di `script.js`.
- Ada tulisan kuning "deprecated" soal `three.min.js` di console DevTools, tidak akan muncul lagi (versi ini sudah pakai Three.js ES module + import map, bukan build classic).
- Voxel tidak ada efek glow sama sekali, kemungkinan `EffectComposer`/`UnrealBloomPass` gagal dimuat dari CDN (jarang terjadi, biasanya karena koneksi bermasalah saat load pertama). Aplikasi tetap jalan normal tanpa glow (fallback otomatis); coba muat ulang halaman.

Selamat membangun guys
