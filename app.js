const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const styles = {
  bass: { bass: 8, reverb: 10, presence: 0 },
  guitar: { bass: 1, reverb: 8, presence: 5 },
  drums: { bass: 7, reverb: 3, presence: 3 },
  dreamy: { bass: 2, reverb: 55, presence: 1 },
  custom: { bass: 3, reverb: 12, presence: 0 }
};
let file = null, buffer = null, audioCtx = null, source = null, graph = null;
let bass = 3, reverb = 12, speed = 1, presence = 0, activeStyle = 'bass';
let playing = false, startedAt = 0, startOffset = 0, raf = 0, toastTimer, pendingVideoUrl = null, pendingRemote = false;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeImpulse(ctx, seconds, decay) {
  const impulse = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, decay);
  }
  return impulse;
}
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const input = audioCtx.createGain();
    const low = audioCtx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 135;
    const presenceFilter = audioCtx.createBiquadFilter(); presenceFilter.type = 'peaking'; presenceFilter.frequency.value = 2600; presenceFilter.Q.value = 0.8;
    const convolver = audioCtx.createConvolver(); convolver.buffer = makeImpulse(audioCtx, 2.1, 2.6);
    const dry = audioCtx.createGain(); dry.gain.value = 0.88;
    const wet = audioCtx.createGain(); wet.gain.value = reverb / 240;
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.18;
    const ceiling = createCeiling(audioCtx);
    input.connect(low); low.connect(presenceFilter);
    presenceFilter.connect(dry); dry.connect(limiter);
    presenceFilter.connect(convolver); convolver.connect(wet); wet.connect(limiter);
    limiter.connect(ceiling); ceiling.connect(audioCtx.destination);
    graph = { input, low, presenceFilter, wet };
    applyEffects();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function createCeiling(ctx) {
  const shaper = ctx.createWaveShaper(), curve = new Float32Array(65536), ceiling = 0.89;
  for (let i = 0; i < curve.length; i++) {
    const x = (i * 2) / (curve.length - 1) - 1;
    curve[i] = ceiling * Math.tanh(x / ceiling);
  }
  shaper.curve = curve; shaper.oversample = '4x'; shaper.normalize = false;
  return shaper;
}
function showToast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function setRange(el, value, min, max) {
  el.value = value; el.style.setProperty('--progress', `${(value - min) / (max - min) * 100}%`);
}
function applyEffects() {
  $('#bassValue').textContent = `+${bass} dB`;
  $('#reverbValue').textContent = `${reverb}%`;
  $('#speedValue').textContent = `${Math.round(speed * 100)}%`;
  if (graph) {
    const now = audioCtx.currentTime;
    graph.low.gain.setTargetAtTime(bass, now, 0.025);
    graph.presenceFilter.gain.setTargetAtTime(presence, now, 0.025);
    graph.wet.gain.setTargetAtTime(reverb / 240, now, 0.025);
  }
}
function chooseStyle(name) {
  activeStyle = name;
  $$('.profile').forEach(button => button.classList.toggle('active', button.dataset.profile === name));
  const style = styles[name]; bass = style.bass; reverb = style.reverb; presence = style.presence;
  setRange($('#bassSlider'), bass, 0, 75); setRange($('#reverbSlider'), reverb, 0, 100);
  applyEffects();
}
function drawWaveform() {
  const canvas = $('#waveform'), box = canvas.getBoundingClientRect();
  if (!box.width || !buffer) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * scale); canvas.height = Math.round(box.height * scale);
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.clearRect(0, 0, box.width, box.height);
  const data = buffer.getChannelData(0), bars = Math.max(1, Math.floor(box.width / 3));
  const step = Math.max(1, Math.floor(data.length / bars)), mid = box.height / 2;
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = 0; j < step && i * step + j < data.length; j++) peak = Math.max(peak, Math.abs(data[i * step + j]));
    const h = Math.max(2, peak * box.height * 0.92);
    ctx.fillStyle = '#a5bd69'; ctx.globalAlpha = 0.4 + peak * 0.6; ctx.fillRect(i * 3, mid - h / 2, 1.5, h);
  }
  ctx.globalAlpha = 1;
}
function displayTrack() {
  $('#dropzone').hidden = true; $('#extractRow').hidden = true;
  $('#loadedTrack').hidden = false; $('#changeFile').hidden = false;
  $('#trackName').textContent = file.name;
  $('#trackDuration').textContent = `${formatTime(buffer.duration)} · AUDIO READY`;
  $('#playBtn').disabled = false; $('#madeSongBtn').disabled = false;
  drawWaveform(); updateProgress();
}
async function loadAudio(nextFile) {
  stop(); file = nextFile; buffer = null; $('#fileMeta').textContent = 'Reading your track…';
  try {
    ensureAudio();
    buffer = await audioCtx.decodeAudioData(await file.arrayBuffer()); startOffset = 0;
    $('#fileMeta').textContent = 'Ready to shape'; displayTrack(); showToast('Track ready. Pick a style and make it yours.');
  } catch {
    file = null; buffer = null; $('#fileMeta').textContent = 'Could not read that audio file';
    showToast('This format could not be opened by your browser. Try MP3, WAV or M4A.');
  }
}
async function chooseFile(nextFile) {
  if (!nextFile) return;
  if (pendingVideoUrl) URL.revokeObjectURL(pendingVideoUrl);
  pendingVideoUrl = null; pendingRemote = false;
  const isVideo = nextFile.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|ogv)$/i.test(nextFile.name);
  file = nextFile;
  if (!isVideo) { await loadAudio(nextFile); return; }
  stop(); buffer = null; $('#loadedTrack').hidden = true; $('#madeSongBtn').disabled = true;
  $('#dropzone').hidden = true; $('#extractRow').hidden = false; $('#changeFile').hidden = false;
  $('#fileMeta').textContent = 'Video ready to extract'; pendingVideoUrl = URL.createObjectURL(nextFile);
  showToast('Video selected. Extract its soundtrack to continue.');
}
function collectMediaLinks(pageText, pageUrl, contentType) {
  const links = [];
  const add = value => {
    if (typeof value !== 'string' || !value.trim()) return;
    try {
      const link = new URL(value.trim(), pageUrl);
      if (['http:', 'https:'].includes(link.protocol) && link.href !== pageUrl) links.push(link.href);
    } catch {}
  };
  if (contentType.includes('json')) {
    try {
      const visit = value => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          if (/^(audio|video|contenturl|streamurl|mediaurl|src|url)$/i.test(key)) {
            if (typeof item === 'string') add(item);
            else if (item && typeof item === 'object') add(item.url || item.contentUrl || item.src);
          }
          if (item && typeof item === 'object') visit(item);
        }
      };
      visit(JSON.parse(pageText));
    } catch {}
    return [...new Set(links)];
  }
  const doc = new DOMParser().parseFromString(pageText, 'text/html');
  doc.querySelectorAll('audio[src],video[src],audio source[src],video source[src]').forEach(node => add(node.getAttribute('src')));
  doc.querySelectorAll('meta[property],meta[name]').forEach(node => {
    const key = `${node.getAttribute('property') || ''} ${node.getAttribute('name') || ''}`.toLowerCase();
    if (/og:audio|og:video|twitter:player:stream/.test(key)) add(node.getAttribute('content'));
  });
  doc.querySelectorAll('link[rel="alternate"][type]').forEach(node => {
    if (/audio|video/.test(node.type)) add(node.getAttribute('href'));
  });
  return [...new Set(links)];
}
function nameFromUrl(value, fallback = 'linked-media') {
  try {
    const last = decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() || '');
    return (last || fallback).replace(/[\\/:*?"<>|]/g, '_');
  } catch { return fallback; }
}
async function mediaFileFromBlob(blob, sourceUrl) {
  const head = new Uint8Array(await blob.slice(0, 376).arrayBuffer());
  const ascii = (start, length) => String.fromCharCode(...head.slice(start, start + length));
  let type = (blob.type || '').split(';')[0].trim().toLowerCase();
  if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') {
    if (ascii(4, 4) === 'ftyp') type = 'video/mp4';
    else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) type = 'video/webm';
    else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') type = 'video/x-msvideo';
    else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') type = 'audio/wav';
    else if (ascii(0, 4) === 'fLaC') type = 'audio/flac';
    else if (ascii(0, 4) === 'OggS') type = 'audio/ogg';
    else if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) type = 'audio/mpeg';
    else if (head[0] === 0x47 && head[188] === 0x47) type = 'video/mp2t';
  }
  const name = nameFromUrl(sourceUrl);
  const looksLikePage = /^(text\/html|application\/xhtml\+xml|application\/json)/.test(type) || /^\s*(<!doctype\s+html|<html|\{\s*["'])/i.test(new TextDecoder().decode(head));
  return { file: new File([blob], name, { type }), looksLikePage };
}
function queueRemoteCapture(url) {
  if (pendingVideoUrl) URL.revokeObjectURL(pendingVideoUrl);
  pendingVideoUrl = url; pendingRemote = true;
  file = new File([], nameFromUrl(url)); stop(); buffer = null;
  $('#loadedTrack').hidden = true; $('#madeSongBtn').disabled = true;
  $('#dropzone').hidden = true; $('#extractRow').hidden = false; $('#changeFile').hidden = false;
  $('#extractRow > span').textContent = 'LINKED MEDIA'; $('#extractBtn').innerHTML = 'Capture audio <span>↗</span>';
}
function isStreamManifest(url, type) {
  return /mpegurl|dash\+xml/.test(type) || /\.(m3u8|mpd)(?:$|[?#])/i.test(url);
}
async function loadFromLink(event) {
  event.preventDefault();
  const input = $('#mediaUrl'), button = $('#loadLinkBtn');
  let url;
  try {
    url = new URL(input.value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use a web link that starts with https:// or http://.');
  } catch (error) {
    showToast(error.message || 'Paste a valid direct audio or video link.'); return;
  }
  button.disabled = true; button.textContent = 'Finding audio…'; $('#fileMeta').textContent = 'Looking for playable media…';
  try {
    let response;
    try { response = await fetch(url.href); }
    catch (error) {
      if (error instanceof TypeError) {
        queueRemoteCapture(url.href); $('#fileMeta').textContent = 'Trying direct browser playback';
        showToast('Trying to capture audio directly from that link.'); return;
      }
      throw error;
    }
    if (!response.ok) throw new Error(`The media host returned ${response.status}.`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (isStreamManifest(response.url || url.href, type)) {
      queueRemoteCapture(response.url || url.href); $('#fileMeta').textContent = 'Stream link ready';
      showToast('Stream link found. Capture its audio to continue.'); return;
    }
    const body = await response.blob();
    const sniffed = await mediaFileFromBlob(body, response.url || url.href);
    if (/text\/html|application\/xhtml\+xml|application\/json/.test(type) || sniffed.looksLikePage) {
      const pageText = await body.text();
      const links = collectMediaLinks(pageText, response.url || url.href, type);
      if (!links.length) throw new Error('No playable audio or video was found on that page. Try a direct media link.');
      let loaded = false;
      for (const link of links.slice(0, 75)) {
        try {
          const mediaResponse = await fetch(link);
          if (!mediaResponse.ok) continue;
          const blob = await mediaResponse.blob();
          const media = await mediaFileFromBlob(blob, link);
          if (media.looksLikePage) continue;
          await chooseFile(media.file);
          if (buffer || pendingVideoUrl) { loaded = true; break; }
        } catch {}
      }
      if (!loaded) throw new Error('The page listed media, but its host would not let this browser load it. Try the media link directly.');
    } else {
      await chooseFile(sniffed.file);
      if (!buffer && !pendingVideoUrl) throw new Error('That link did not contain audio or a supported video.');
    }
    showToast('Link loaded. Pick a style and shape the sound.');
  } catch (error) {
    $('#fileMeta').textContent = 'Could not load that link';
    showToast(error.message || 'Could not find playable audio. The page may require sign-in or block browser access.');
  } finally {
    button.disabled = false; button.innerHTML = 'Load link <span>↗</span>';
  }
}
async function extractVideoAudio() {
  if (!pendingVideoUrl) return;
  const button = $('#extractBtn'); button.disabled = true; button.textContent = 'Capturing audio…';
  const video = document.createElement('video'); video.preload = 'auto'; video.muted = false; video.src = pendingVideoUrl;
  video.playsInline = true; let captureStream = null, activeRecorder = null;
  try {
    ensureAudio();
    const capture = video.captureStream || video.mozCaptureStream;
    if (!capture || !window.MediaRecorder) throw new Error('Video audio extraction is not supported in this browser.');
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Could not open this video.'));
    });
    captureStream = capture.call(video);
    if (!captureStream.getAudioTracks().length) throw new Error('This video does not contain an audio track.');
    const recorder = activeRecorder = new MediaRecorder(captureStream); const chunks = [];
    const recorded = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error('Could not extract this video soundtrack.'));
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    });
    recorder.start(); await video.play();
    if (!captureStream.getAudioTracks().length) throw new Error('This link did not provide a playable audio track.');
    await new Promise(resolve => { video.onended = resolve; video.onerror = resolve; });
    recorder.stop();
    const blob = await recorded; buffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    startOffset = 0; $('#fileMeta').textContent = 'Soundtrack extracted on your device'; displayTrack();
    showToast('Audio captured. Now shape your sound.');
  } catch (error) {
    showToast(error.message || 'Could not capture audio from this link. The site may block playback or recording.');
  } finally {
    if (activeRecorder?.state === 'recording') activeRecorder.stop();
    captureStream?.getTracks().forEach(track => track.stop());
    video.pause(); video.removeAttribute('src'); video.load();
    if (buffer) {
      if (pendingVideoUrl && !pendingRemote) URL.revokeObjectURL(pendingVideoUrl);
      pendingVideoUrl = null; pendingRemote = false;
      button.innerHTML = 'Extract audio <span>↗</span>';
    } else button.innerHTML = `${pendingRemote ? 'Capture' : 'Extract'} audio <span>↗</span>`;
    button.disabled = false;
  }
}
function play() {
  if (!buffer) return;
  ensureAudio(); if (playing) return;
  source = audioCtx.createBufferSource(); source.buffer = buffer; source.playbackRate.value = speed; source.connect(graph.input);
  if (startOffset >= buffer.duration) startOffset = 0;
  source.start(0, startOffset); startedAt = audioCtx.currentTime; playing = true;
  $('#playBtn').textContent = 'Ⅱ'; $('#playBtn').setAttribute('aria-label', 'Pause audio');
  source.onended = () => {
    if (playing) { playing = false; source = null; startOffset = 0; $('#playBtn').textContent = '▶'; $('#playBtn').setAttribute('aria-label', 'Play audio'); updateProgress(); }
  };
  updateProgress();
}
function pause() {
  if (!playing) return;
  startOffset = Math.min(buffer.duration, startOffset + (audioCtx.currentTime - startedAt) * speed); playing = false;
  if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); source = null; }
  $('#playBtn').textContent = '▶'; $('#playBtn').setAttribute('aria-label', 'Play audio'); cancelAnimationFrame(raf); updateProgress();
}
function stop() {
  if (playing) pause(); startOffset = 0;
  $('#playBtn').textContent = '▶'; $('#playBtn').setAttribute('aria-label', 'Play audio'); cancelAnimationFrame(raf);
}
function currentPosition() {
  return playing ? Math.min(buffer.duration, startOffset + (audioCtx.currentTime - startedAt) * speed) : startOffset;
}
function updateProgress() {
  if (!buffer) return;
  const pos = currentPosition(); setRange($('#seek'), Math.round(pos / buffer.duration * 1000), 0, 1000);
  $('#timeDisplay').textContent = formatTime(pos);
  if (playing) raf = requestAnimationFrame(updateProgress);
}
function buildRenderContext() {
  const rate = buffer.sampleRate, duration = buffer.duration / speed + 2.2;
  const offline = new OfflineAudioContext(2, Math.ceil(rate * duration), rate);
  const input = offline.createGain();
  const low = offline.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 135; low.gain.value = bass;
  const presenceFilter = offline.createBiquadFilter(); presenceFilter.type = 'peaking'; presenceFilter.frequency.value = 2600; presenceFilter.Q.value = 0.8; presenceFilter.gain.value = presence;
  const dry = offline.createGain(); dry.gain.value = 0.88;
  const convolver = offline.createConvolver(); convolver.buffer = makeImpulse(offline, 2.1, 2.6);
  const wet = offline.createGain(); wet.gain.value = reverb / 240;
  const limiter = offline.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.18;
  const ceiling = createCeiling(offline);
  input.connect(low); low.connect(presenceFilter);
  presenceFilter.connect(dry); dry.connect(limiter);
  presenceFilter.connect(convolver); convolver.connect(wet); wet.connect(limiter); limiter.connect(ceiling); ceiling.connect(offline.destination);
  const player = offline.createBufferSource(); player.buffer = buffer; player.playbackRate.value = speed; player.connect(input); player.start(0);
  return offline;
}
function toWav(audioBuffer) {
  const channels = 2, frames = audioBuffer.length, dataBytes = frames * channels * 2;
  const out = new ArrayBuffer(44 + dataBytes), view = new DataView(out);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true); view.setUint32(28, audioBuffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, dataBytes, true);
  const left = audioBuffer.getChannelData(0), right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
  let offset = 44;
  for (let i = 0; i < frames; i++) for (const sample of [left[i], right[i]]) {
    const value = clamp(sample, -0.89, 0.89); view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}
async function exportAudio() {
  if (!buffer) return;
  $('#warningModal').hidden = true;
  const button = $('#madeSongBtn'); button.disabled = true; button.querySelector('span').textContent = 'Making your song…';
  try {
    const rendered = await buildRenderContext().startRendering();
    const wav = toWav(rendered);
    const stem = (file?.name || 'boostbeat-song').replace(/\.[^.]+$/, '');
    const outputFile = new File([wav], `${stem}-boostbeat.wav`, { type: 'audio/wav' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [outputFile] })) {
      try {
        await navigator.share({ files: [outputFile], title: 'BoostBeat song' });
        showToast('Choose where to save or share your WAV.');
      } catch (error) {
        if (error.name === 'AbortError') showToast('Share cancelled. You can make the song again when ready.');
        else downloadFile(outputFile);
      }
    } else downloadFile(outputFile);
  } catch (error) {
    console.error(error); showToast('Could not create the WAV in this browser. Try a shorter track.');
  }
  button.disabled = false; button.querySelector('span').textContent = 'Made song';
}
function downloadFile(fileToSave) {
  const url = URL.createObjectURL(fileToSave), link = document.createElement('a');
  link.href = url; link.download = fileToSave.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000); showToast('Your WAV is downloading.');
}

$('#mediaInput').addEventListener('change', event => { const selected = event.target.files[0]; event.target.value = ''; chooseFile(selected); });
$('#linkForm').addEventListener('submit', loadFromLink);
$('#changeFile').onclick = () => $('#mediaInput').click();
$('#extractBtn').onclick = extractVideoAudio;
$('#dropzone').addEventListener('dragover', event => { event.preventDefault(); $('#dropzone').classList.add('dragover'); });
$('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('dragover'));
$('#dropzone').addEventListener('drop', event => { event.preventDefault(); $('#dropzone').classList.remove('dragover'); chooseFile(event.dataTransfer.files[0]); });
$('#playBtn').onclick = () => playing ? pause() : play();
$('#seek').oninput = event => {
  if (!buffer) return; const resume = playing; if (playing) pause();
  startOffset = buffer.duration * Number(event.target.value) / 1000; updateProgress(); if (resume) play();
};
$$('.profile').forEach(button => button.onclick = () => chooseStyle(button.dataset.profile));
$('#bassSlider').oninput = event => {
  bass = Number(event.target.value); activeStyle = 'custom'; $$('.profile').forEach(button => button.classList.remove('active'));
  applyEffects(); setRange(event.target, bass, 0, 75);
};
$('#reverbSlider').oninput = event => { reverb = Number(event.target.value); applyEffects(); setRange(event.target, reverb, 0, 100); };
$('#speedSlider').oninput = event => {
  const wasPlaying = playing;
  if (wasPlaying) pause();
  speed = Number(event.target.value) / 100;
  if (wasPlaying) play();
  applyEffects(); setRange(event.target, Number(event.target.value), 50, 200);
};
$('#resetBtn').onclick = () => { chooseStyle('bass'); speed = 1; setRange($('#speedSlider'), 100, 50, 200); applyEffects(); showToast('Adjustments reset.'); };
$('#madeSongBtn').onclick = () => { $('#warningModal').hidden = false; $('#agreeBtn').focus(); };
$('#backBtn').onclick = () => { $('#warningModal').hidden = true; $('#bassSlider').focus(); };
$('#agreeBtn').onclick = exportAudio;
$('#warningModal').addEventListener('click', event => { if (event.target === $('#warningModal')) $('#warningModal').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#warningModal').hidden) $('#warningModal').hidden = true; });
setRange($('#bassSlider'), bass, 0, 75); applyEffects();
setRange($('#reverbSlider'), 12, 0, 100); setRange($('#speedSlider'), 100, 50, 200);
window.addEventListener('resize', () => { if (buffer) drawWaveform(); });

// Photo to editable text, then copy or save the result as a plain text file.
const photoInput = $('#photoInput'), recognizedText = $('#recognizedText');
const ocrProgress = $('#ocrProgress'), ocrStatus = $('#ocrStatus');
const saveTextBtn = $('#saveTextBtn'), copyTextBtn = $('#copyTextBtn');
function syncOcrActions() {
  const hasText = Boolean(recognizedText.value.trim());
  saveTextBtn.disabled = !hasText; copyTextBtn.disabled = !hasText;
}
recognizedText.addEventListener('input', syncOcrActions);
photoInput.addEventListener('change', async event => {
  const photo = event.target.files?.[0]; event.target.value = '';
  if (!photo) return;
  if (!photo.type.startsWith('image/')) { showToast('Choose an image file to scan.'); return; }
  if (!window.Tesseract) { showToast('Text recognition could not load. Check your connection and try again.'); return; }
  ocrProgress.hidden = false; ocrProgress.textContent = 'Reading photo…';
  ocrStatus.textContent = photo.name;
  try {
    const result = await Tesseract.recognize(photo, 'eng', {
      logger: message => {
        if (message.status === 'recognizing text') ocrProgress.textContent = `Recognizing text… ${Math.round((message.progress || 0) * 100)}%`;
        else if (message.status) ocrProgress.textContent = `${message.status}…`;
      }
    });
    recognizedText.value = result.data.text.trim();
    ocrStatus.textContent = recognizedText.value ? `Scanned ${photo.name}` : 'No text found';
    syncOcrActions();
    showToast(recognizedText.value ? 'Text extracted. Review it, then save as .txt.' : 'No readable text found in that photo.');
  } catch (error) {
    console.error(error); ocrStatus.textContent = 'Scan failed';
    showToast('Could not read that photo. Try a sharper, well-lit image.');
  } finally { ocrProgress.hidden = true; }
});
saveTextBtn.addEventListener('click', () => {
  const output = new Blob([recognizedText.value], { type: 'text/plain;charset=utf-8' });
  downloadFile(new File([output], 'photo-text.txt', { type: 'text/plain' }));
});
copyTextBtn.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(recognizedText.value); showToast('Text copied to clipboard.'); }
  catch { recognizedText.focus(); recognizedText.select(); showToast('Text selected. Copy it from the text box.'); }
});

const transcribeBtn = $('#transcribeBtn');
let speechRecognizer = null;
function syncTranscribeButton() { transcribeBtn.disabled = !buffer; }
syncTranscribeButton();
const originalDisplayTrack = displayTrack;
displayTrack = function () { originalDisplayTrack(); syncTranscribeButton(); };
transcribeBtn.addEventListener('click', async () => {
  if (!buffer) { showToast('Choose a video from Photos and extract its audio first.'); return; }
  transcribeBtn.disabled = true; ocrProgress.hidden = false;
  recognizedText.value = ''; ocrStatus.textContent = 'Loading speech model…';
  try {
    const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    const transcriber = speechRecognizer || (speechRecognizer = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: info => {
        if (info.status === 'progress') ocrProgress.textContent = `Downloading speech model… ${Math.round(info.progress || 0)}%`;
        else if (info.status) ocrProgress.textContent = `${info.status}…`;
      }
    }));
    ocrProgress.textContent = 'Preparing video audio…';
    const mono = audioCtx.createBuffer(1, buffer.length, buffer.sampleRate);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const monoData = mono.getChannelData(0);
    for (let i = 0; i < monoData.length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i];
      monoData[i] = sample / channels.length;
    }
    const targetRate = 16000;
    const resampler = new OfflineAudioContext(1, Math.ceil(buffer.duration * targetRate), targetRate);
    const sourceNode = resampler.createBufferSource(); sourceNode.buffer = mono; sourceNode.connect(resampler.destination); sourceNode.start();
    const resampled = await resampler.startRendering();
    ocrProgress.textContent = 'Transcribing speech…'; ocrStatus.textContent = 'Transcribing…';
    let transcript = '';
    const chunkSize = targetRate * 25;
    for (let offset = 0; offset < resampled.length; offset += chunkSize) {
      const chunk = resampled.getChannelData(0).slice(offset, Math.min(offset + chunkSize, resampled.length));
      const result = await transcriber(chunk, { sampling_rate: targetRate });
      transcript += `${result.text || ''} `;
      ocrProgress.textContent = `Transcribing… ${Math.min(100, Math.round((offset + chunk.length) / resampled.length * 100))}%`;
    }
    recognizedText.value = transcript.trim(); syncOcrActions();
    ocrStatus.textContent = transcript.trim() ? `Transcript from ${file?.name || 'audio'}` : 'No speech recognized';
    showToast(transcript.trim() ? 'Transcript ready. Review and save it as .txt.' : 'No speech was recognized.');
  } catch (error) {
    console.error(error); ocrStatus.textContent = 'Transcription failed';
    showToast('Could not transcribe this media. Try a shorter video or check your connection.');
  } finally { ocrProgress.hidden = true; syncTranscribeButton(); }
});
