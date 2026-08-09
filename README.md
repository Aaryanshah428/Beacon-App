# Beacon

Voice-first companion **demo template** for blind and low-vision users. Speak to chat, read labels, describe a scene, or get simple navigation guidance from the camera. Replies are spoken aloud.

> Non-production starter for assistive-tech demos and hackathons. Customize branding, prompts, and APIs for your product.

## Features

- **Voice chat** — speak (or type); OpenAI replies in short, speakable sentences
- **Read this label** — camera + vision reads product/label text aloud
- **Describe this** — short holistic scene description
- **Capture this** — forward-facing navigation tips (optionally add a question)
- **Help / intro** — spoken onboarding and command list
- **Accessible UI** — large mic control, skip link, live status, screen-reader announcements, Space to talk
- **Demo mode** — sample replies when `OPENAI_API_KEY` is missing; browser TTS if ElevenLabs is missing

## Stack

| Layer | Tech |
| --- | --- |
| Backend | Flask (`app.py`) |
| Speech-to-text | OpenAI Whisper (preferred), Google STT fallback for WAV |
| Chat / vision | OpenAI (`gpt-4o-mini` by default) |
| Text-to-speech | ElevenLabs (browser `speechSynthesis` fallback) |
| Frontend | HTML / CSS / JS (`templates/`, `static/`) |

## Setup

### 1. Clone and install

```bash
git clone git@github.com:Aaryanshah428/Beacon-App.git
cd Beacon-App
py -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
# source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Environment variables

Copy the example file and add your keys (never commit `.env`):

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | For real STT / chat / vision | Whisper + GPT |
| `ELEVENLABS_API_KEY` | For cloud TTS | Spoken replies |
| `ELEVENLABS_VOICE_ID` | Optional | Default: Rachel voice |
| `ELEVENLABS_MODEL_ID` | Optional | Default: `eleven_multilingual_v2` |
| `OPENAI_MODEL` | Optional | Default: `gpt-4o-mini` |
| `OPENAI_IMAGE_DETAIL` | Optional | Default: `high` |
| `BEACON_DEMO_MODE` | Optional | `true` forces sample replies |

Without OpenAI, the UI still runs in **demo mode** (typed commands and shortcuts work; live mic STT needs a key).

### 3. Run

```bash
py app.py
```

Open [http://localhost:5000](http://localhost:5000).

## How to use

1. Tap **Allow mic & camera** (required for voice unlock on mobile).
2. Tap the mic or press **Space**, speak, then tap/Space again to send.
3. Or use shortcuts: **Help**, **Read label**, **Describe scene**, **Navigate**.
4. Or type in the text box if speech recognition misses you.

### Voice commands

| Say | What happens |
| --- | --- |
| `help` | Hears available commands |
| `read this label` | Opens camera, reads label text |
| `describe this` | Opens camera, describes the scene |
| `capture this` [question] | Navigation guidance ahead / left / right |
| Anything else | Normal spoken chat |

## Project layout

```
Beacon-App/
├── app.py                 # Flask API + prompts
├── requirements.txt
├── .env.example           # Safe placeholders (commit this)
├── .gitignore             # Ignores .env and credentials
├── templates/index.html   # Accessible UI
└── static/
    ├── app.js             # Mic, camera, TTS, commands
    └── styles.css
```

### Main API routes

| Route | Method | Role |
| --- | --- | --- |
| `/` | GET | App UI |
| `/api/config` | GET | Demo flags / key status (no secrets) |
| `/transcribe` | POST | Audio → text |
| `/chat` | POST | Conversation reply |
| `/describe-label` | POST | Label vision |
| `/describe-image` | POST | Scene vision |
| `/capture-nav` | POST | Navigation vision |
| `/speak` | POST | Text → audio (ElevenLabs) |

## Notes

- Use HTTPS or `localhost` so the browser allows mic/camera.
- On iPhone, allow mic/camera once and keep the Ring/Silent switch unmuted for AI voice.
- This repo intentionally excludes `.env` and credential files. Only `.env.example` is committed.

## License

Demo / template project — use and adapt as needed for your assistive-tech prototype.
