(() => {
  const micBtn = document.getElementById("micBtn");
  const statusEl = document.getElementById("status");
  const chatLog = document.getElementById("chatLog");
  const waveform = document.getElementById("waveform");
  const cameraOverlay = document.getElementById("cameraOverlay");
  const cameraPreview = document.getElementById("cameraPreview");
  const cameraStatus = document.getElementById("cameraStatus");
  const muteBtn = document.getElementById("muteBtn");
  const volumeSlider = document.getElementById("volumeSlider");
  const permissionBtn = document.getElementById("permissionBtn");
  const flipCameraBtn = document.getElementById("flipCameraBtn");
  const welcomeBtn = document.getElementById("welcomeBtn");
  const textForm = document.getElementById("textForm");
  const textInput = document.getElementById("textInput");
  const srAnnouncer = document.getElementById("srAnnouncer");
  const resCapturedEl = document.getElementById("resCaptured");
  const resSentEl = document.getElementById("resSent");
  const resOpenAIEl = document.getElementById("resOpenAI");

  let isListening = false;
  let isBusy = false;
  let spaceHeld = false;
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let conversationHistory = [];
  let recorderMimeType = "audio/webm";
  let listenStartedAt = 0;
  let isMuted = false;
  let voiceVolume = 0.85;
  let flipCameraHorizontal = true;
  let currentAudioUrl = null;
  let voiceUnlocked = false;
  let unlockAudioCtx = null;
  let demoMode = false;
  let welcomePlayed = false;

  const WELCOME_TEXT =
    "Welcome to Beacon, a demo companion for blind and low-vision users. " +
    "First tap Allow mic and camera. Then tap the microphone or press Space, speak, and tap again to send. " +
    "You can say help, read this label, describe this, or capture this for navigation. " +
    "You can also type below. This is a template — customize it for your product.";

  const HELP_TEXT =
    "Here is what you can do. Tap the microphone and speak, or use the shortcuts. " +
    "Say help to hear this again. " +
    "Say read this label to open the camera and hear label text. " +
    "Say describe this for a short scene description. " +
    "Say capture this, and optionally add a question, for navigation tips like what is ahead. " +
    "Or ask any everyday question in chat. Press Space to start and stop listening.";

  const voicePlayer = new Audio();
  voicePlayer.setAttribute("playsinline", "true");
  voicePlayer.setAttribute("webkit-playsinline", "true");
  voicePlayer.playsInline = true;
  voicePlayer.preload = "auto";
  voicePlayer.crossOrigin = "anonymous";

  const SILENT_WAV =
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";

  function idleStatusText() {
    return "Tap the mic or press <kbd>Space</kbd> to talk";
  }

  function announce(text) {
    if (!srAnnouncer) return;
    srAnnouncer.textContent = "";
    // Force a change so screen readers re-announce
    requestAnimationFrame(() => {
      srAnnouncer.textContent = text;
    });
  }

  function setStatus(text, listening = false) {
    statusEl.innerHTML = text;
    statusEl.classList.toggle("listening", listening);
    const plain = text.replace(/<[^>]+>/g, "");
    announce(plain);
  }

  function setListeningUI(active) {
    isListening = active;
    micBtn.setAttribute("aria-pressed", String(active));
    micBtn.setAttribute(
      "aria-label",
      active
        ? "Stop listening. Tap the mic or press Space to stop."
        : "Start listening. Tap the mic or press Space to talk."
    );
    waveform.hidden = !active;

    if (active) {
      setStatus("Listening… tap the mic or press <kbd>Space</kbd> to stop", true);
    } else if (!isBusy) {
      setStatus(idleStatusText(), false);
    }
  }

  function clearEmptyState() {
    const empty = chatLog.querySelector(".chat-empty");
    if (empty) empty.remove();
  }

  function appendMessage(role, text, imageUrl = null) {
    clearEmptyState();
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;
    const label = document.createElement("span");
    label.className = "chat-label";
    label.textContent = role === "user" ? "You" : "Beacon";
    const body = document.createElement("p");
    body.className = "chat-text";
    body.textContent = text;
    bubble.append(label, body);
    if (imageUrl) {
      const img = document.createElement("img");
      img.className = "chat-thumb";
      img.src = imageUrl;
      img.alt = role === "user" ? "Photo you captured" : "Captured photo";
      bubble.appendChild(img);
    }
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function normalizeSpeech(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isHelpCommand(text) {
    const normalized = normalizeSpeech(text);
    return (
      normalized === "help" ||
      normalized === "help me" ||
      normalized === "what can you do" ||
      normalized === "commands" ||
      normalized.includes("what can i say")
    );
  }

  function isReadLabelCommand(text) {
    const normalized = normalizeSpeech(text);
    return (
      normalized === "read this label" ||
      normalized === "read the label" ||
      normalized.includes("read this label") ||
      normalized.includes("read the label")
    );
  }

  function isDescribeThisCommand(text) {
    const normalized = normalizeSpeech(text);
    return (
      normalized === "describe this" ||
      normalized === "describe this image" ||
      normalized === "describe the image" ||
      normalized.includes("describe this")
    );
  }

  function parseCaptureThisCommand(text) {
    const normalized = normalizeSpeech(text);
    const marker = "capture this";
    const idx = normalized.indexOf(marker);
    if (idx === -1) return null;
    const question = normalized.slice(idx + marker.length).trim();
    return { question: question || "" };
  }

  function openaiHighDetailSize(width, height) {
    let w = width;
    let h = height;
    const maxSide = Math.max(w, h);
    if (maxSide > 2048) {
      const scale = 2048 / maxSide;
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const minSide = Math.min(w, h);
    if (minSide > 0 && minSide !== 768) {
      const scale = 768 / minSide;
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    return { width: w, height: h };
  }

  function updateResolutionInfo(width, height, fileBytes) {
    const sent = `${width} × ${height}px`;
    const ai = openaiHighDetailSize(width, height);
    const kb = fileBytes ? ` (${Math.round(fileBytes / 1024)} KB JPEG)` : "";
    resCapturedEl.textContent = sent;
    resSentEl.textContent = `${sent}${kb}`;
    resOpenAIEl.textContent = `${ai.width} × ${ai.height}px (detail: high)`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isAppleMobile() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  let activeVoiceSource = null;
  let activeVoiceGain = null;

  function stopPlayback() {
    if (activeVoiceSource) {
      try {
        activeVoiceSource.stop();
      } catch {
        /* ignore */
      }
      try {
        activeVoiceSource.disconnect();
      } catch {
        /* ignore */
      }
      activeVoiceSource = null;
    }
    if (activeVoiceGain) {
      try {
        activeVoiceGain.disconnect();
      } catch {
        /* ignore */
      }
      activeVoiceGain = null;
    }
    try {
      voicePlayer.pause();
    } catch {
      /* ignore */
    }
    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = null;
    }
  }

  function updateMuteButton() {
    muteBtn.setAttribute("aria-pressed", String(isMuted));
    muteBtn.textContent = isMuted ? "Unmute voice" : "Mute voice";
    muteBtn.setAttribute(
      "aria-label",
      isMuted ? "Unmute AI voice" : "Mute AI voice"
    );
    muteBtn.classList.toggle("muted", isMuted);
  }

  function applyVoiceVolume() {
    const level = isMuted ? 0 : Math.max(0, Math.min(1, voiceVolume));
    voicePlayer.muted = isMuted;
    voicePlayer.volume = level;
    if (activeVoiceGain) {
      activeVoiceGain.gain.value = level;
    }
    volumeSlider.setAttribute("aria-valuenow", String(Math.round(voiceVolume * 100)));
  }

  async function ensureAudioContextRunning() {
    if (!unlockAudioCtx) {
      unlockAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (unlockAudioCtx.state === "suspended") {
      await unlockAudioCtx.resume();
    }
    return unlockAudioCtx;
  }

  async function playUnlockChime() {
    const ctx = await ensureAudioContextRunning();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  async function unlockVoicePlayback({ playChime = false } = {}) {
    try {
      await ensureAudioContextRunning();

      const buffer = unlockAudioCtx.createBuffer(1, 1, unlockAudioCtx.sampleRate || 22050);
      const source = unlockAudioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(unlockAudioCtx.destination);
      source.start(0);

      voicePlayer.muted = false;
      voicePlayer.volume = Math.max(voiceVolume, 0.35);
      voicePlayer.src = SILENT_WAV;
      const playPromise = voicePlayer.play();
      if (playPromise) await playPromise;
      voicePlayer.pause();
      voicePlayer.currentTime = 0;

      if (playChime && !isMuted) {
        await playUnlockChime();
      }

      voiceUnlocked = true;
      return true;
    } catch (err) {
      console.warn("Voice unlock failed:", err);
      return false;
    }
  }

  async function playViaWebAudio(arrayBuffer) {
    const ctx = await ensureAudioContextRunning();
    if (ctx.state !== "running") {
      throw new Error("Audio context still suspended");
    }

    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (!audioBuffer || audioBuffer.duration < 0.05) {
      throw new Error("Decoded audio was empty");
    }

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const level = isMuted ? 0 : Math.max(0.35, voiceVolume);
    gain.gain.value = level;
    source.buffer = audioBuffer;
    source.connect(gain);
    gain.connect(ctx.destination);
    activeVoiceSource = source;
    activeVoiceGain = gain;

    await new Promise((resolve, reject) => {
      source.onended = () => {
        activeVoiceSource = null;
        activeVoiceGain = null;
        resolve();
      };
      try {
        source.start(0);
      } catch (err) {
        reject(err);
      }
    });
  }

  function playViaHtmlAudio(playableBlob) {
    return new Promise((resolve, reject) => {
      if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
      }
      currentAudioUrl = URL.createObjectURL(playableBlob);

      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        voicePlayer.removeEventListener("canplaythrough", onCanPlay);
        voicePlayer.removeEventListener("error", onError);
        if (err) reject(err);
        else resolve();
      };

      const onError = () => finish(new Error("HTML audio failed to load"));
      const onCanPlay = async () => {
        try {
          voicePlayer.currentTime = 0;
          voicePlayer.muted = false;
          voicePlayer.volume = isMuted ? 0 : Math.max(0.35, voiceVolume);
          const playPromise = voicePlayer.play();
          if (playPromise) await playPromise;
          finish();
        } catch (err) {
          finish(err);
        }
      };

      voicePlayer.addEventListener("canplaythrough", onCanPlay, { once: true });
      voicePlayer.addEventListener("error", onError, { once: true });
      voicePlayer.onended = () => {
        if (currentAudioUrl) {
          URL.revokeObjectURL(currentAudioUrl);
          currentAudioUrl = null;
        }
      };
      voicePlayer.src = currentAudioUrl;
      voicePlayer.load();
    });
  }

  function speakWithBrowserTTS(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        resolve(false);
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1;
        utterance.volume = isMuted ? 0 : Math.max(0.35, voiceVolume);
        utterance.onend = () => resolve(true);
        utterance.onerror = () => resolve(false);
        window.speechSynthesis.speak(utterance);
      } catch {
        resolve(false);
      }
    });
  }

  async function speakReply(text) {
    if (isMuted) {
      setStatus("AI voice muted — reply shown in conversation");
      return;
    }

    stopPlayback();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    await delay(isAppleMobile() ? 250 : 50);

    try {
      await ensureAudioContextRunning();
    } catch {
      /* continue */
    }

    const response = await fetch("/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      let message = "Speech failed.";
      try {
        const data = await response.json();
        if (data.error) message = data.error;
      } catch {
        /* ignore */
      }
      // Demo / missing ElevenLabs: fall back to browser TTS
      const usedBrowser = await speakWithBrowserTTS(text);
      if (usedBrowser) return;
      throw new Error(message);
    }

    const audioBlob = await response.blob();
    if (!audioBlob || audioBlob.size < 100) {
      const usedBrowser = await speakWithBrowserTTS(text);
      if (usedBrowser) return;
      throw new Error("AI voice audio was empty.");
    }

    const playableBlob = new Blob([audioBlob], { type: "audio/mpeg" });
    const arrayBuffer = await playableBlob.arrayBuffer();

    try {
      await ensureAudioContextRunning();
    } catch {
      /* ignore */
    }

    if (isAppleMobile()) {
      try {
        await playViaHtmlAudio(playableBlob);
        return;
      } catch (htmlErr) {
        console.warn("HTML audio failed on iOS, trying WebAudio:", htmlErr);
      }
      try {
        await playViaWebAudio(arrayBuffer);
        return;
      } catch (webErr) {
        console.error(webErr);
        const usedBrowser = await speakWithBrowserTTS(text);
        if (usedBrowser) return;
        voiceUnlocked = false;
        throw new Error(
          "Could not play AI voice on iPhone. Tap “Allow mic & camera” (listen for a beep), turn the Ring/Silent switch on, then try again."
        );
      }
    }

    try {
      await playViaWebAudio(arrayBuffer);
      return;
    } catch (webAudioErr) {
      console.warn("WebAudio playback failed, trying HTML audio:", webAudioErr);
    }

    try {
      await playViaHtmlAudio(playableBlob);
    } catch (err) {
      console.error(err);
      const usedBrowser = await speakWithBrowserTTS(text);
      if (usedBrowser) return;
      voiceUnlocked = false;
      throw new Error(
        "Could not play AI voice. Tap “Allow mic & camera” once, then try again."
      );
    }
  }

  async function askChatbot(userText) {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userText,
        history: conversationHistory,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Chat failed.");
    }
    return data.reply;
  }

  async function describeLabelImage(imageBlob) {
    const formData = new FormData();
    formData.append("image", imageBlob, "label.jpg");

    const response = await fetch("/describe-label", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Label description failed.");
    }
    return data.reply;
  }

  async function describeSceneImage(imageBlob) {
    const formData = new FormData();
    formData.append("image", imageBlob, "scene.jpg");

    const response = await fetch("/describe-image", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Image description failed.");
    }
    return data.reply;
  }

  async function captureNavImage(imageBlob, question = "") {
    const formData = new FormData();
    formData.append("image", imageBlob, "nav.jpg");
    if (question) {
      formData.append("question", question);
    }

    const response = await fetch("/capture-nav", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Navigation guidance failed.");
    }
    return data.reply;
  }

  async function getCameraStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  }

  async function capturePhoto(aimText = "Point at the subject…", { flipHorizontal = true } = {}) {
    setStatus("Opening camera…");
    cameraStatus.textContent = aimText;
    const titleEl = document.getElementById("cameraTitle");
    if (titleEl) titleEl.textContent = aimText.replace(/…$/, "");
    cameraOverlay.hidden = false;
    cameraPreview.classList.toggle("mirrored", flipHorizontal);
    announce(aimText);

    let stream = null;
    try {
      stream = await getCameraStream();

      cameraPreview.srcObject = stream;
      await cameraPreview.play();

      const readyAt = Date.now();
      while (
        (!cameraPreview.videoWidth || !cameraPreview.videoHeight) &&
        Date.now() - readyAt < 4000
      ) {
        await delay(50);
      }

      cameraStatus.textContent = "Hold steady — capturing…";
      announce("Hold steady. Capturing.");
      await delay(1400);

      const width = cameraPreview.videoWidth || 1280;
      const height = cameraPreview.videoHeight || 720;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (flipHorizontal) {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(cameraPreview, 0, 0, width, height);

      cameraStatus.textContent = "Photo captured.";
      announce("Photo captured.");

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (result) => {
            if (result) resolve(result);
            else reject(new Error("Could not capture photo."));
          },
          "image/jpeg",
          0.9
        );
      });

      updateResolutionInfo(width, height, blob.size);
      return blob;
    } finally {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      cameraPreview.srcObject = null;
      cameraOverlay.hidden = true;
    }
  }

  function pickRecorderMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return "";
  }

  function extensionForMime(mime) {
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("ogg")) return "ogg";
    return "webm";
  }

  async function startListening() {
    if (isBusy) return;

    try {
      stopPlayback();
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      recorderMimeType = pickRecorderMimeType();
      recordedChunks = [];

      mediaRecorder = recorderMimeType
        ? new MediaRecorder(mediaStream, { mimeType: recorderMimeType })
        : new MediaRecorder(mediaStream);

      recorderMimeType = mediaRecorder.mimeType || recorderMimeType || "audio/webm";

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.start(250);
      listenStartedAt = Date.now();
      setListeningUI(true);
    } catch (err) {
      console.error(err);
      setStatus(idleStatusText());
      appendMessage(
        "assistant",
        "Microphone permission denied or unavailable. Allow mic access and try again."
      );
      setListeningUI(false);
    }
  }

  function cleanupAudio() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {
        /* already stopped */
      }
    }
    mediaRecorder = null;

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
  }

  function stopRecorder() {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder) {
        resolve(null);
        return;
      }

      const recorder = mediaRecorder;

      if (recorder.state === "inactive") {
        const blob = recordedChunks.length
          ? new Blob(recordedChunks, { type: recorderMimeType })
          : null;
        cleanupAudio();
        resolve(blob);
        return;
      }

      recorder.onstop = () => {
        const blob = recordedChunks.length
          ? new Blob(recordedChunks, { type: recorderMimeType })
          : null;
        if (mediaStream) {
          mediaStream.getTracks().forEach((track) => track.stop());
          mediaStream = null;
        }
        mediaRecorder = null;
        resolve(blob);
      };

      recorder.onerror = () => {
        cleanupAudio();
        reject(new Error("Recording failed."));
      };

      try {
        recorder.requestData();
      } catch {
        /* not all browsers support requestData */
      }
      recorder.stop();
    });
  }

  async function speakAndShow(reply, { pushHistory = true, userText = null } = {}) {
    if (userText) {
      conversationHistory.push({ role: "user", content: userText });
    }
    if (pushHistory) {
      conversationHistory.push({ role: "assistant", content: reply });
    }
    appendMessage("assistant", reply);
    setStatus(demoMode ? "Speaking (demo)…" : "Speaking…");
    try {
      await speakReply(reply);
    } catch (ttsErr) {
      console.error(ttsErr);
      appendMessage("assistant", `Voice playback error: ${ttsErr.message}`);
    }
  }

  async function handleHelpCommand(userText) {
    appendMessage("user", userText);
    await speakAndShow(HELP_TEXT, { userText });
  }

  async function handleVisionCommand(userText, options) {
    setStatus(options.statusOpen);
    const imageBlob = await capturePhoto(options.aimText, {
      flipHorizontal: flipCameraHorizontal,
    });
    const previewUrl = URL.createObjectURL(imageBlob);
    appendMessage("user", userText, previewUrl);

    setStatus(options.statusAnalyze);
    const reply = await options.analyze(imageBlob);

    conversationHistory.push({ role: "user", content: userText });
    await speakAndShow(reply, { userText: null });
  }

  async function handleLabelCommand(userText) {
    await handleVisionCommand(userText, {
      statusOpen: "Opening camera for label…",
      aimText: "Point at the label…",
      statusAnalyze: "Reading label…",
      analyze: describeLabelImage,
    });
  }

  async function handleDescribeThisCommand(userText) {
    await handleVisionCommand(userText, {
      statusOpen: "Opening camera to describe…",
      aimText: "Point at what you want described…",
      statusAnalyze: "Describing scene…",
      analyze: describeSceneImage,
    });
  }

  async function handleCaptureThisCommand(userText, question) {
    await handleVisionCommand(userText, {
      statusOpen: "Opening camera for navigation…",
      aimText: "Hold the camera facing ahead…",
      statusAnalyze: "Preparing navigation guidance…",
      analyze: (imageBlob) => captureNavImage(imageBlob, question),
    });
  }

  async function handleChatCommand(userText) {
    appendMessage("user", userText);
    setStatus("Thinking…");

    const reply = await askChatbot(userText);
    conversationHistory.push({ role: "user", content: userText });
    await speakAndShow(reply, { userText: null });
  }

  async function processUserText(userText) {
    const captureCmd = parseCaptureThisCommand(userText);

    if (isHelpCommand(userText)) {
      await handleHelpCommand(userText);
    } else if (isReadLabelCommand(userText)) {
      await handleLabelCommand(userText);
    } else if (captureCmd) {
      await handleCaptureThisCommand(userText, captureCmd.question);
    } else if (isDescribeThisCommand(userText)) {
      await handleDescribeThisCommand(userText);
    } else {
      await handleChatCommand(userText);
    }
  }

  async function runUserCommand(userText, { fromVoice = false } = {}) {
    const text = (userText || "").trim();
    if (!text || isBusy) return;

    isBusy = true;
    try {
      await processUserText(text);
      setStatus(idleStatusText());
    } catch (err) {
      console.error(err);
      appendMessage("assistant", err.message || "Something went wrong.");
      announce(err.message || "Something went wrong.");
      setStatus(idleStatusText());
    } finally {
      isBusy = false;
      if (!fromVoice) {
        /* keep focus for typed input */
      }
    }
  }

  async function stopListening() {
    if (!isListening || isBusy) return;

    setListeningUI(false);
    isBusy = true;
    setStatus("Converting speech to text…");

    let audioBlob = null;
    try {
      audioBlob = await stopRecorder();
    } catch (err) {
      console.error(err);
      isBusy = false;
      setStatus(idleStatusText());
      appendMessage("assistant", "Recording failed. Try again.");
      return;
    }

    if (!audioBlob || audioBlob.size < 1200 || Date.now() - listenStartedAt < 700) {
      isBusy = false;
      setStatus(idleStatusText());
      appendMessage(
        "assistant",
        "Couldn't understand that. Please speak clearly and try again."
      );
      return;
    }

    const ext = extensionForMime(recorderMimeType);
    const formData = new FormData();
    formData.append("audio", audioBlob, `speech.${ext}`);

    try {
      const response = await fetch("/transcribe", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Couldn't understand that. Please speak clearly and try again."
        );
      }

      const userText = (data.text || "").trim();
      if (!userText) {
        throw new Error("Couldn't understand that. Please speak clearly and try again.");
      }

      // processUserText owns history/UI; keep isBusy true across the handoff
      await processUserText(userText);
      setStatus(idleStatusText());
    } catch (err) {
      console.error(err);
      appendMessage("assistant", err.message || "Something went wrong.");
      setStatus(idleStatusText());
    } finally {
      isBusy = false;
    }
  }

  function toggleListening() {
    if (isBusy) return;
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }

  let lastMicToggleAt = 0;
  function activateMic(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const now = Date.now();
    if (now - lastMicToggleAt < 400) return;
    lastMicToggleAt = now;
    void unlockVoicePlayback({ playChime: false });
    toggleListening();
  }

  micBtn.addEventListener("click", activateMic);
  micBtn.addEventListener(
    "touchend",
    (event) => {
      activateMic(event);
    },
    { passive: false }
  );

  function setPermissionButtonState(state) {
    permissionBtn.classList.remove("granted");
    permissionBtn.disabled = false;

    if (state === "granted") {
      permissionBtn.textContent = "Mic & camera ready";
      permissionBtn.classList.add("granted");
      permissionBtn.setAttribute("aria-label", "Microphone and camera ready. Tap to re-enable voice.");
    } else if (state === "denied") {
      permissionBtn.textContent = "Permissions blocked";
      permissionBtn.setAttribute("aria-label", "Permissions blocked. Open browser settings to allow access.");
    } else if (state === "partial") {
      permissionBtn.textContent = "Retry mic & camera";
      permissionBtn.setAttribute("aria-label", "Retry microphone and camera access");
    } else {
      permissionBtn.textContent = "Allow mic & camera";
      permissionBtn.setAttribute("aria-label", "Allow microphone and camera access");
    }
  }

  async function playWelcome({ force = false } = {}) {
    if (welcomePlayed && !force) return;
    welcomePlayed = true;
    void unlockVoicePlayback({ playChime: false });
    appendMessage("assistant", WELCOME_TEXT);
    setStatus("Playing intro…");
    try {
      await speakReply(WELCOME_TEXT);
    } catch (err) {
      console.warn(err);
    }
    if (!isListening && !isBusy) {
      setStatus(idleStatusText());
    }
  }

  async function requestMediaPermissions() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Browser not supported");
      appendMessage("assistant", "This browser cannot access the mic or camera.");
      setPermissionButtonState("denied");
      return;
    }

    const unlocked = await unlockVoicePlayback({ playChime: true });
    if (unlocked) {
      setStatus("Voice enabled — you should hear a beep");
    }

    permissionBtn.disabled = true;
    permissionBtn.textContent = "Requesting…";
    if (!unlocked) {
      setStatus("Requesting mic and camera access…");
    }

    let micOk = false;
    let camOk = false;
    let stream = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      micOk = stream.getAudioTracks().length > 0;
      camOk = stream.getVideoTracks().length > 0;
    } catch (err) {
      console.error(err);
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micOk = true;
        audioStream.getTracks().forEach((track) => track.stop());
      } catch (audioErr) {
        console.error(audioErr);
      }
      try {
        const videoStream = await getCameraStream();
        camOk = true;
        videoStream.getTracks().forEach((track) => track.stop());
      } catch (videoErr) {
        console.error(videoErr);
      }
    } finally {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      permissionBtn.disabled = false;
    }

    if (micOk && camOk) {
      setPermissionButtonState("granted");
      setStatus("Mic, camera, and voice ready");
      appendMessage(
        "assistant",
        "Microphone, camera, and voice are ready. You can start talking now."
      );
      if (!welcomePlayed) {
        await playWelcome();
      }
    } else if (micOk || camOk) {
      setPermissionButtonState("partial");
      const missing = [
        !micOk ? "microphone" : null,
        !camOk ? "camera" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      setStatus(`Missing ${missing} permission`);
      appendMessage(
        "assistant",
        `Partial access only. Please allow ${missing} in your browser settings, then tap Retry.`
      );
    } else {
      setPermissionButtonState("denied");
      setStatus("Permissions blocked");
      appendMessage(
        "assistant",
        "Microphone and camera were blocked. Allow access in your browser site settings, then try again."
      );
    }

    if (!isListening && !isBusy && micOk && camOk && welcomePlayed) {
      setTimeout(() => {
        if (!isListening && !isBusy) setStatus(idleStatusText());
      }, 1800);
    }
  }

  let lastPermissionTapAt = 0;
  function onPermissionTap(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const now = Date.now();
    if (now - lastPermissionTapAt < 500) return;
    lastPermissionTapAt = now;
    requestMediaPermissions();
  }

  permissionBtn.addEventListener("click", onPermissionTap);
  permissionBtn.addEventListener("touchend", onPermissionTap, { passive: false });

  welcomeBtn.addEventListener("click", () => {
    void unlockVoicePlayback({ playChime: false });
    void playWelcome({ force: true });
  });

  document.querySelectorAll(".command-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const command = btn.getAttribute("data-command");
      if (!command) return;
      void unlockVoicePlayback({ playChime: false });
      void runUserCommand(command);
    });
  });

  textForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = textInput.value.trim();
    if (!value) return;
    textInput.value = "";
    void unlockVoicePlayback({ playChime: false });
    void runUserCommand(value);
  });

  function updateFlipCameraButton() {
    flipCameraBtn.setAttribute("aria-pressed", String(flipCameraHorizontal));
    flipCameraBtn.classList.toggle("active", flipCameraHorizontal);
    flipCameraBtn.textContent = flipCameraHorizontal
      ? "Flip camera: On"
      : "Flip camera: Off";
    flipCameraBtn.setAttribute(
      "aria-label",
      flipCameraHorizontal
        ? "Flip camera image horizontally. Currently on."
        : "Flip camera image horizontally. Currently off."
    );
  }

  flipCameraBtn.addEventListener("click", () => {
    flipCameraHorizontal = !flipCameraHorizontal;
    updateFlipCameraButton();
    cameraPreview.classList.toggle("mirrored", flipCameraHorizontal);
    setStatus(
      flipCameraHorizontal
        ? "Camera flip on (mirrored)"
        : "Camera flip off (normal)"
    );
    if (!isListening && !isBusy) {
      setTimeout(() => {
        if (!isListening && !isBusy) setStatus(idleStatusText());
      }, 1400);
    }
  });

  updateFlipCameraButton();

  muteBtn.addEventListener("click", () => {
    isMuted = !isMuted;
    if (!isMuted) {
      void unlockVoicePlayback({ playChime: true });
    } else if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    updateMuteButton();
    applyVoiceVolume();
    if (isMuted) {
      stopPlayback();
      setStatus("AI voice muted");
    } else if (!isListening && !isBusy) {
      setStatus(idleStatusText());
    }
  });

  volumeSlider.addEventListener("input", () => {
    voiceVolume = Number(volumeSlider.value) / 100;
    if (voiceVolume > 0 && isMuted) {
      isMuted = false;
      updateMuteButton();
    }
    applyVoiceVolume();
  });

  updateMuteButton();
  applyVoiceVolume();

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" && event.key !== " ") return;
    if (event.repeat) return;

    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) {
      return;
    }

    event.preventDefault();
    if (spaceHeld) return;
    spaceHeld = true;
    void unlockVoicePlayback({ playChime: false });
    toggleListening();
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.key === " ") {
      spaceHeld = false;
    }
  });

  async function loadConfig() {
    try {
      const response = await fetch("/api/config");
      if (!response.ok) return;
      const data = await response.json();
      demoMode = Boolean(data.demo_mode);
      if (demoMode) {
        const banner = document.querySelector(".demo-banner p");
        if (banner && !banner.textContent.includes("offline demo")) {
          banner.innerHTML =
            '<span class="demo-badge">Demo mode</span> ' +
            "API keys not set — Beacon will use sample replies so you can still explore the template.";
        }
      }
    } catch {
      /* optional */
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Browser not supported");
    appendMessage("assistant", "This browser cannot access the microphone.");
    micBtn.disabled = true;
  }

  void loadConfig();
})();
