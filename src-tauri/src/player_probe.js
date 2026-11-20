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
  let lastHealth = '', lastHealthSent = 0, lastMediaError = null;
  let reportedPlaying = false;
  const startedAt = Date.now();
  const candidates = new Map();
  const routes = new Map();
  const plausibleDuration = (value) => Number.isFinite(value) && value > 0 && value <= 86400 && (!expectedDuration || (value >= expectedDuration * 0.5 && value <= expectedDuration * 2.5));

  function visibleVideo() {
    if (typeof document.querySelectorAll !== 'function') return null;
    return [...document.querySelectorAll('video')].find((v) => {
      const rect = v.getBoundingClientRect();
      const style = getComputedStyle(v);
      return rect.width >= 20 && rect.height >= 20 && style.display !== 'none' && style.visibility !== 'hidden';
    }) || null;
  }

  function looksLikeChallenge() {
    try {
      const title = typeof document.title === 'string' ? document.title.toLowerCase() : '';
      if (title.includes('just a moment') || title.includes('attention required') || title.includes('verify you are human') || title.includes('ddos-guard')) return true;
      if (typeof document.querySelector === 'function') {
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #cf-challenge-running, .cf-turnstile, .g-recaptcha, .h-captcha')) return true;
      }
      const bodyText = document.body && typeof document.body.innerText === 'string' ? document.body.innerText.slice(0, 1200).toLowerCase() : '';
      if (bodyText.includes('checking your browser') || bodyText.includes('verify you are human') || bodyText.includes('performing security verification')) return true;
    } catch {}
    return false;
  }

  function looksLikeErrorPage() {
    try {
      const title = typeof document.title === 'string' ? document.title.toLowerCase() : '';
      if (/\b(404|403|410|500|502|503|504)\b/.test(title) || title.includes('not found') || title.includes('access denied') || title.includes('video unavailable')) return true;
      const bodyText = document.body && typeof document.body.innerText === 'string' ? document.body.innerText.slice(0, 1000).toLowerCase() : '';
      if (bodyText.length > 0 && bodyText.length < 400 && (bodyText.includes('file was deleted') || bodyText.includes('video not found') || bodyText.includes('no longer available') || bodyText.includes('404 not found') || bodyText.includes('access denied'))) return true;
    } catch {}
    return false;
  }

  function send(payload, force) {
    const encoded = JSON.stringify(payload);
    if ((encoded === last && !force) || (!force && Date.now() - lastSent < 500)) return;
    last = encoded; lastSent = Date.now();
    if (isTop) document.title = '__MEGU_PROGRESS__' + encoded;
    else window.parent.postMessage({ marker, session, leaf, type: 'progress', ...payload }, '*');
  }

  function sendHealth(state, detail, force = false) {
    const payload = { session, state, detail: typeof detail === 'string' ? detail.slice(0, 160) : '' };
    const encoded = JSON.stringify(payload);
    if ((encoded === lastHealth && !force) || (!force && Date.now() - lastHealthSent < 1000)) return;
    lastHealth = encoded; lastHealthSent = Date.now();
    if (isTop) document.title = '__MEGU_HEALTH__' + encoded;
    else window.parent.postMessage({ marker, session, leaf, type: 'health', state, detail: payload.detail }, '*');
  }

  function report(force = false) {
    const video = visibleVideo();
    if (!video) {
      if (looksLikeChallenge()) {
        sendHealth('challenge', 'Verification required in player');
      } else if (!reportedPlaying && Date.now() - startedAt > 2500 && looksLikeErrorPage()) {
        sendHealth('dead', 'Embed returned an error page');
      }
      return;
    }
    if (bound !== video) {
      if (bound && Number.isFinite(bound.currentTime)) targetPosition = bound.currentTime;
      bound = video; sought = false; lastMediaError = null;
      for (const name of ['pause', 'seeked', 'ended']) video.addEventListener(name, () => report(true));
      video.addEventListener('error', () => {
        const code = video.error && typeof video.error.code === 'number' ? video.error.code : 0;
        lastMediaError = code ? `Media error ${code}` : 'Video playback error';
        sendHealth('dead', lastMediaError, true);
      });
    }
    if (video.error) {
      const code = typeof video.error.code === 'number' ? video.error.code : 0;
      sendHealth('dead', code ? `Media error ${code}` : 'Video playback error');
      return;
    }
    if (!plausibleDuration(video.duration)) return;
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
    if (!reportedPlaying && (!video.paused || video.currentTime > 0 || video.readyState >= 3)) {
      reportedPlaying = true;
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
      if (data.type === 'candidate' || data.type === 'progress' || data.type === 'health') window.parent.postMessage(data, '*');
      return;
    }
    if (data.type === 'health') {
      if (!visibleVideo() && (data.state === 'challenge' || data.state === 'dead')) {
        sendHealth(data.state, typeof data.detail === 'string' ? data.detail : '', data.state === 'dead');
      }
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
      reportedPlaying = true;
      send({ session, time: data.time, duration: data.duration, paused: data.paused }, false);
    }
  });

  setInterval(() => {
    report();
    if (!isTop) return;
    if (!chooseAt || Date.now() < chooseAt || visibleVideo()) return;
    if (selectedLeaf && Date.now() - selectedSeen < 10000) return;
    const available = [...candidates].filter(([, value]) => Date.now() - value.at < 2000);
    available.sort((a, b) => b[1].duration - a[1].duration);
    if (!available.length) { chooseAt = 0; return; }
    selectedLeaf = available[0][0];
    selectedSeen = Date.now();
    available[0][1].frame.postMessage({ marker, session, leaf: selectedLeaf, type: 'select', position: lastPosition }, '*');
  }, 500);
})();
