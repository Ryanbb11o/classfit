// Camera QR scanner. Uses the browser's BarcodeDetector when it exists, otherwise jsQR.
// Load jsQR before this file. onCode(text) is called for each read; repeats of the
// same code within 4 seconds are ignored.
window.createScanner = function ({ video, onCode, onState }) {
  let stream = null, timer = null, last = "", lastAt = 0;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;

  function hit(code) {
    if (code === last && Date.now() - lastAt < 4000) return;
    last = code; lastAt = Date.now();
    onCode(code);
  }

  async function frame() {
    if (!stream || video.readyState < 2) return;
    try {
      if (detector) {
        const codes = await detector.detect(video);
        if (codes[0]) hit(codes[0].rawValue);
      } else if (window.jsQR) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code) hit(code.data);
      }
    } catch {}
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = stream;
      await video.play();
      timer = setInterval(frame, 250);
      onState && onState("on");
    } catch {
      stream = null;
      onState && onState("denied");
    }
  }

  function stop() {
    clearInterval(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    onState && onState("off");
  }

  return { start, stop, toggle: () => (stream ? stop() : start()), get on() { return !!stream; } };
};
