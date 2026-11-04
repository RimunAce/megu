// Injected into the isolated provider webview. This script has no access to
// MEGU's credentials or Tauri capabilities. Its output is untrusted telemetry.
(() => {
  const session = __MEGU_SESSION_JSON__;
  const initialPosition = __MEGU_RESUME__;
  const expectedDuration = __MEGU_EXPECTED_DURATION__;
  const isTop = window === window.top;
  const marker = '__megu_video_probe_v1__';
  const leaf = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  let bound = null, sought = false, targetPosition = initialPosition;
  let active = isTop, last = '', lastSent = 0;
  let selectedLeaf = null, chooseAt = 0, lastPosition = initialPosition, selectedSeen = 0;
  const candidates = new Map();
  const routes = new Map();
  const plausibleDuration = (value) => Number.isFinite(value) && value > 0 && value <= 86400 && (!expectedDuration || (value >= expectedDuration * 0.5 && value <= expectedDuration * 2.5));

  function visibleVideo() {
    return [...document.querySelectorAll('video')].find((v) => {
      const rect = v.getBoundingClientRect();
      const style = getComputedStyle(v);
      return rect.width >= 20 && rect.height >= 20 && style.display !== 'none' && style.visibility !== 'hidden';
    }) || null;
  }

  function send(payload, force) {
    const encoded = JSON.stringify(payload);
    if ((encoded === last && !force) || (!force && Date.now() - lastSent < 500)) return;
    last = encoded; lastSent = Date.now();
    if (isTop) document.title = '__MEGU_PROGRESS__' + encoded;
    else window.parent.postMessage({ marker, session, leaf, type: 'progress', ...payload }, '*');
  }

  function report(force = false) {
    const video = visibleVideo();
    if (!video || !plausibleDuration(video.duration)) return;
    if (bound !== video) {
      if (bound && Number.isFinite(bound.currentTime)) targetPosition = bound.currentTime;
      bound = video; sought = false;
      for (const name of ['pause', 'seeked', 'ended']) video.addEventListener(name, () => report(true));
    }
    const ready = video.readyState >= 2 && video.seekable.length > 0;
    if (!isTop && !active) {
      if (ready) window.parent.postMessage({ marker, session, leaf, type: 'candidate', duration: video.duration }, '*');
      return;
    }
    if (!sought) {
      if (!ready) return;
      const target = Math.min(targetPosition, Math.max(0, video.duration - 1));
      try { video.currentTime = target; sought = Math.abs(video.currentTime - target) < 1; } catch { return; }
      if (!sought) return;
    }
    send({ session, time: video.currentTime, duration: video.duration, paused: video.paused }, force || (!isTop && Date.now() - lastSent >= 2000));
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.marker !== marker || data.session !== session) return;
    if (data.type === 'select') {
      if (isTop || event.source !== window.parent || typeof data.leaf !== 'string' || typeof data.position !== 'number' || !Number.isFinite(data.position)) return;
      if (data.leaf === leaf) {
        active = true; sought = false; targetPosition = Math.max(0, data.position);
        report(true);
      } else routes.get(data.leaf)?.postMessage(data, '*');
      return;
    }
    // Ignore frames hidden offscreen, tiny advertising frames, and messages
    // from unrelated windows. Only direct, prominently visible child frames
    // can become the active playback source.
    const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === event.source);
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    if (style.display === 'none' || style.visibility === 'hidden' || width * height < innerWidth * innerHeight * 0.35) return;
    if (typeof data.leaf !== 'string' || data.leaf.length < 1 || data.leaf.length > 64) return;
    if (!routes.has(data.leaf) && routes.size >= 32) return;
    routes.set(data.leaf, event.source);
    if (!isTop) {
      if (data.type === 'candidate' || data.type === 'progress') window.parent.postMessage(data, '*');
      return;
    }
    if (data.type === 'candidate') {
      if (visibleVideo() || !plausibleDuration(data.duration) || data.duration < (expectedDuration ? Math.min(60, expectedDuration * 0.5) : 60) || (initialPosition > 0 && data.duration < initialPosition)) return;
      candidates.set(data.leaf, { duration: data.duration, at: Date.now(), frame: event.source });
      if (!chooseAt) chooseAt = Date.now() + 1500;
      if (selectedLeaf === data.leaf) {
        event.source.postMessage({ marker, session, leaf: data.leaf, type: 'select', position: lastPosition }, '*');
      }
    } else if (data.type === 'progress' && selectedLeaf === data.leaf && routes.get(data.leaf) === event.source && !visibleVideo()) {
      if (!Number.isFinite(data.time) || !plausibleDuration(data.duration) || typeof data.paused !== 'boolean' || data.time < 0 || data.time > data.duration + 1) return;
      selectedSeen = Date.now();
      lastPosition = data.time;
      send({ session, time: data.time, duration: data.duration, paused: data.paused }, false);
    }
  });

  setInterval(() => {
    report();
    if (!isTop || !chooseAt || Date.now() < chooseAt || visibleVideo()) return;
    if (selectedLeaf && Date.now() - selectedSeen < 10000) return;
    const available = [...candidates].filter(([, value]) => Date.now() - value.at < 2000);
    available.sort((a, b) => b[1].duration - a[1].duration);
    if (!available.length) { chooseAt = 0; return; }
    selectedLeaf = available[0][0];
    selectedSeen = Date.now();
    available[0][1].frame.postMessage({ marker, session, leaf: selectedLeaf, type: 'select', position: lastPosition }, '*');
  }, 500);
})();
