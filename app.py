import base64
import io
import os
import re

import requests
import speech_recognition as sr
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request
from openai import OpenAI

load_dotenv()

app = Flask(__name__)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
# Rachel — female default voice; override with ELEVENLABS_VOICE_ID
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM").strip()
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
OPENAI_IMAGE_DETAIL = os.getenv("OPENAI_IMAGE_DETAIL", "high").strip() or "high"

# When true (or when keys are missing), return sample replies so the UI stays demoable.
FORCE_DEMO = os.getenv("BEACON_DEMO_MODE", "").strip().lower() in ("1", "true", "yes")


def demo_mode_active():
    return FORCE_DEMO or not OPENAI_API_KEY


SYSTEM_PROMPT = (
    "You are Beacon, a friendly voice companion for blind and low-vision users. "
    "Keep replies concise and natural — usually 1 to 3 short sentences — "
    "so they sound good when read aloud. Avoid markdown, bullet lists, and long essays. "
    "Prefer clear spatial language and practical help. "
    "If the user's message is empty, unclear, or not understandable, say you couldn't "
    "understand and ask them to repeat. Do not guess what they meant. "
    "This app is a demo template — if asked, say Beacon is a starter template for "
    "assistive voice and camera experiences."
)

LABEL_VISION_PROMPT = (
    "You are helping a blind or low-vision user read a physical label from a photo. "
    "Carefully read the visible text on the label (product name, ingredients, warnings, "
    "nutrition facts, dosage, brand, and other important details). "
    "Respond in clear spoken language in at most 3 short sentences. "
    "Do not use markdown or bullet lists."
)

SCENE_VISION_PROMPT = (
    "You are helping a blind or low-vision user understand a photo holistically. "
    "Describe what the image shows overall: the main subject, setting, and notable details. "
    "If there is some readable text, you may mention it briefly, but do not treat this "
    "as a label-reading task — focus on the whole scene. "
    "Respond in clear spoken language in at most 3 short sentences. "
    "Do not use markdown or bullet lists."
)

NAVIGATION_VISION_PROMPT = (
    "You are a navigation assistant for a blind or low-vision person. "
    "The camera view is from their perspective facing forward. "
    "Give practical, confidence-building guidance using clear spatial language "
    "(ahead, left, right, near, far, open path, obstacle). "
    "Call out hazards first when relevant (steps, sharp edges, low objects, open doors). "
    "If the user asked a specific question, answer that question first, then add only "
    "the most useful nearby navigation detail. "
    "If they did not ask a question, describe what is immediately ahead and how they "
    "can move safely through the space. "
    "Use calm, direct spoken language in at most 4 short sentences. "
    "Do not use markdown, bullet lists, or visual-only details like color unless useful for identification."
)

DEMO_CHAT_REPLY = (
    "This is Beacon in demo mode. I would normally answer with OpenAI once you add "
    "OPENAI_API_KEY. Try the shortcuts: help, read this label, describe this, or capture this."
)

DEMO_LABEL_REPLY = (
    "Demo mode: I would read the label text from your photo using vision. "
    "Add OPENAI_API_KEY to enable real label reading. For now, imagine I read the brand, "
    "key ingredients, and any warnings aloud."
)

DEMO_SCENE_REPLY = (
    "Demo mode: I would describe the whole scene from your camera. "
    "Add OPENAI_API_KEY for live descriptions. Imagine I tell you the main subject, "
    "setting, and one useful detail."
)

DEMO_NAV_REPLY = (
    "Demo mode: I would give navigation guidance from your forward-facing photo. "
    "Add OPENAI_API_KEY for live guidance. Imagine I say what is ahead, left, and right, "
    "and whether the path looks clear."
)


def _openai_client():
    if not OPENAI_API_KEY:
        return None
    return OpenAI(api_key=OPENAI_API_KEY)


def _image_data_url_from_upload(image_file):
    image_bytes = image_file.read()
    if not image_bytes:
        return None, "Empty image data."

    mime = image_file.mimetype or "image/jpeg"
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        mime = "image/jpeg"

    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"
    return data_url, None


def _describe_image_with_prompt(data_url, system_prompt, user_text, max_tokens=180):
    client = _openai_client()
    completion = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": data_url,
                            "detail": OPENAI_IMAGE_DETAIL,
                        },
                    },
                ],
            },
        ],
        temperature=0.2,
        max_tokens=max_tokens,
    )
    return (completion.choices[0].message.content or "").strip()


def _require_image_upload():
    if "image" not in request.files:
        return None, (jsonify({"error": "No image file received."}), 400)

    image_file = request.files["image"]
    if not image_file or image_file.filename == "":
        return None, (jsonify({"error": "Empty image upload."}), 400)

    return image_file, None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config")
def api_config():
    return jsonify({
        "app_name": "Beacon",
        "demo_mode": demo_mode_active(),
        "openai_configured": bool(OPENAI_API_KEY),
        "elevenlabs_configured": bool(ELEVENLABS_API_KEY),
        "template": True,
    })


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file received."}), 400

    audio_file = request.files["audio"]
    if not audio_file or audio_file.filename == "":
        return jsonify({"error": "Empty audio upload."}), 400

    audio_bytes = audio_file.read()
    if not audio_bytes or len(audio_bytes) < 800:
        return jsonify({
            "error": "Couldn't understand that. Please speak clearly and try again."
        }), 400

    filename = audio_file.filename or "speech.webm"
    unclear = {
        "error": "Couldn't understand that. Please speak clearly and try again."
    }

    # Prefer Whisper when OpenAI is configured (more reliable than browser WAV + Google STT)
    if OPENAI_API_KEY and not FORCE_DEMO:
        try:
            client = _openai_client()
            buffer = io.BytesIO(audio_bytes)
            buffer.name = filename
            result = client.audio.transcriptions.create(
                model="whisper-1",
                file=buffer,
                response_format="verbose_json",
                temperature=0,
            )
            text = _clean_transcript_text(getattr(result, "text", "") or "")
            if not text or _is_unreliable_transcript(result, text):
                return jsonify(unclear), 400
            return jsonify({"text": text})
        except Exception as exc:
            return jsonify({"error": f"Whisper transcription failed: {exc}"}), 502

    # Fallback: Google STT via SpeechRecognition (WAV only)
    if not filename.lower().endswith(".wav"):
        if demo_mode_active():
            return jsonify({
                "error": (
                    "Demo mode: live speech-to-text needs OPENAI_API_KEY. "
                    "Use the type box or the command shortcuts for now."
                )
            }), 400
        return jsonify({
            "error": "Set OPENAI_API_KEY for reliable transcription, or upload WAV audio."
        }), 400

    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 300
    try:
        wav_buffer = io.BytesIO(audio_bytes)
        wav_buffer.name = "speech.wav"
        with sr.AudioFile(wav_buffer) as source:
            audio_data = recognizer.record(source)
        text = _clean_transcript_text(recognizer.recognize_google(audio_data) or "")
        if not text:
            return jsonify(unclear), 400
        return jsonify({"text": text})
    except sr.UnknownValueError:
        return jsonify(unclear), 400
    except sr.RequestError as exc:
        return jsonify({"error": f"Speech service unavailable: {exc}"}), 503
    except Exception as exc:
        return jsonify({"error": f"Transcription failed: {exc}"}), 500


def _clean_transcript_text(text):
    return " ".join((text or "").strip().split())


def _is_unreliable_transcript(result, text):
    """Reject silence / low-confidence Whisper guesses instead of inventing speech."""
    normalized = re.sub(r"[^\w\s]", " ", (text or "").lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()

    hallucinations = {
        "",
        "thank you for watching",
        "thanks for watching",
        "please subscribe",
        "subscribe",
        "thanks for watching please subscribe",
        "thank you for watching please subscribe",
        "bye bye",
        "www",
        "http",
        "hmm",
        "uh",
        "um",
        "ah",
        "eh",
        ".",
        "...",
        "you",
    }
    if normalized in hallucinations:
        return True
    if normalized.startswith("thank you for watching") or normalized.startswith(
        "thanks for watching"
    ):
        return True

    segments = getattr(result, "segments", None) or []
    if not segments:
        return len(normalized) < 1

    no_speech_probs = [
        float(seg.get("no_speech_prob", 0))
        if isinstance(seg, dict)
        else float(getattr(seg, "no_speech_prob", 0) or 0)
        for seg in segments
    ]
    avg_logprobs = [
        float(seg.get("avg_logprob", 0))
        if isinstance(seg, dict)
        else float(getattr(seg, "avg_logprob", 0) or 0)
        for seg in segments
    ]

    avg_no_speech = sum(no_speech_probs) / len(no_speech_probs)
    avg_logprob = sum(avg_logprobs) / len(avg_logprobs)

    if avg_no_speech >= 0.55:
        return True
    if avg_logprob <= -0.95:
        return True
    return False


@app.route("/chat", methods=["POST"])
def chat():
    payload = request.get_json(silent=True) or {}
    message = (payload.get("message") or "").strip()
    history = payload.get("history") or []

    if not message:
        return jsonify({"error": "No message provided."}), 400

    if demo_mode_active():
        return jsonify({
            "reply": (
                f"You said: {message}. {DEMO_CHAT_REPLY}"
            ),
            "demo": True,
        })

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if isinstance(history, list):
        for turn in history[-12:]:
            if not isinstance(turn, dict):
                continue
            role = turn.get("role")
            content = (turn.get("content") or "").strip()
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message})

    try:
        client = OpenAI(api_key=OPENAI_API_KEY)
        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=300,
        )
        reply = (completion.choices[0].message.content or "").strip()
        if not reply:
            return jsonify({"error": "OpenAI returned an empty response."}), 502
        return jsonify({"reply": reply})
    except Exception as exc:
        return jsonify({"error": f"OpenAI chat failed: {exc}"}), 502


@app.route("/describe-label", methods=["POST"])
def describe_label():
    image_file, error = _require_image_upload()
    if error:
        return error

    if demo_mode_active():
        # Still consume upload so the client flow stays realistic
        image_file.read()
        return jsonify({"reply": DEMO_LABEL_REPLY, "demo": True})

    data_url, err = _image_data_url_from_upload(image_file)
    if err:
        return jsonify({"error": err}), 400

    try:
        reply = _describe_image_with_prompt(
            data_url,
            LABEL_VISION_PROMPT,
            "Please read this label. Reply in at most 3 short sentences.",
        )
        if not reply:
            return jsonify({"error": "OpenAI returned an empty label description."}), 502
        return jsonify({"reply": reply})
    except Exception as exc:
        return jsonify({"error": f"OpenAI vision failed: {exc}"}), 502


@app.route("/describe-image", methods=["POST"])
def describe_image():
    image_file, error = _require_image_upload()
    if error:
        return error

    if demo_mode_active():
        image_file.read()
        return jsonify({"reply": DEMO_SCENE_REPLY, "demo": True})

    data_url, err = _image_data_url_from_upload(image_file)
    if err:
        return jsonify({"error": err}), 400

    try:
        reply = _describe_image_with_prompt(
            data_url,
            SCENE_VISION_PROMPT,
            "Please describe this image holistically in at most 3 short sentences.",
        )
        if not reply:
            return jsonify({"error": "OpenAI returned an empty image description."}), 502
        return jsonify({"reply": reply})
    except Exception as exc:
        return jsonify({"error": f"OpenAI vision failed: {exc}"}), 502


@app.route("/capture-nav", methods=["POST"])
def capture_nav():
    image_file, error = _require_image_upload()
    if error:
        return error

    question = (request.form.get("question") or "").strip()

    if demo_mode_active():
        image_file.read()
        if question:
            reply = (
                f"Demo mode: you asked “{question}”. {DEMO_NAV_REPLY}"
            )
        else:
            reply = DEMO_NAV_REPLY
        return jsonify({"reply": reply, "demo": True})

    data_url, err = _image_data_url_from_upload(image_file)
    if err:
        return jsonify({"error": err}), 400

    if question:
        user_text = (
            f'The user asked after saying "capture this": "{question}". '
            "Answer that question using this camera view, with clear spatial guidance "
            "for a blind person navigating the space. At most 4 short sentences."
        )
    else:
        user_text = (
            "This is a room or space view from the user's perspective. "
            "Give specific navigation directions for a blind person: what is ahead, "
            "left, and right, plus any hazards or a clear path to move. "
            "At most 4 short sentences."
        )

    try:
        reply = _describe_image_with_prompt(
            data_url,
            NAVIGATION_VISION_PROMPT,
            user_text,
            max_tokens=240,
        )
        if not reply:
            return jsonify({"error": "OpenAI returned an empty navigation description."}), 502
        return jsonify({"reply": reply})
    except Exception as exc:
        return jsonify({"error": f"OpenAI vision failed: {exc}"}), 502


@app.route("/speak", methods=["POST"])
def speak():
    payload = request.get_json(silent=True) or {}
    text = (payload.get("text") or "").strip()
    if not text:
        return jsonify({"error": "No text provided."}), 400

    if not ELEVENLABS_API_KEY:
        return jsonify({
            "error": "ElevenLabs API key missing. The browser will use built-in speech instead.",
            "fallback": "browser_tts",
        }), 503

    try:
        response = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}",
            headers={
                "xi-api-key": ELEVENLABS_API_KEY,
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "model_id": ELEVENLABS_MODEL_ID,
                "voice_settings": {
                    "stability": 0.45,
                    "similarity_boost": 0.8,
                },
            },
            timeout=60,
        )
    except requests.RequestException as exc:
        return jsonify({"error": f"ElevenLabs request failed: {exc}"}), 503

    if response.status_code != 200:
        detail = response.text[:300] if response.text else "Unknown error"
        return jsonify({
            "error": f"ElevenLabs TTS failed ({response.status_code}): {detail}"
        }), 502

    return Response(
        response.content,
        mimetype="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
