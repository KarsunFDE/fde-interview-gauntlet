# FDE Interview Gauntlet

A self-contained static web app for practicing FDE-style interviews. Learners answer
spoken interview questions (speech-to-text), an LLM judge (served by a Cloudflare
Worker) scores each answer, and completed interviews post to a daily leaderboard with
a prize pool.

This repo is the **frontend only**. The backend Worker (`worker/`) and any seed data
(`data/`) are separate and implement the API contract below.

## Quick start (local)

No build step. Serve the repo root with any static server:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Speech-to-text requires **Chrome or Edge** (Web Speech API `webkitSpeechRecognition`).
Firefox and Safari fall back to typing — the app detects this and adjusts.

## Configuration

Edit `config.js`:

```js
window.CONFIG = {
  WORKER_URL: "https://your-worker.example.workers.dev", // <- set this
  ROSTER: ["Kevin Sung", "Aaron Grau", "…", "Practice (no leaderboard)"]
};
```

- `WORKER_URL` — base URL of the deployed Cloudflare Worker. Until set, the app loads
  but shows a config warning and network calls fail with a toast.
- `ROSTER` — names shown in the gate dropdown. `"Practice (no leaderboard)"` is a
  non-scoring practice identity.

## Flow

1. **Gate** — pick name + enter shared passcode → `POST /session`. Creds persist in
   `sessionStorage` for the session.
2. **Lobby** — greeting, tier, attempts used/remaining, **Start Interview**, a
   **Leaderboard** tab, "how it works", and a mic-support notice.
3. **Interview** — 10 questions. Each is read aloud (TTS, toggle in header, default ON).
   Record button captures speech into an **editable textarea**; learner can fix STT
   errors or type entirely. Submit → `POST /judge` → score /100, 5 dimension bars,
   strengths, improvements, and a collapsible model answer. Next.
4. **Results** — `POST /interview/finish` → big interview score (count-up), per-question
   sparkline, "Personal best today!" badge, today's rank, and navigation.
5. **Leaderboard** — `GET /leaderboard` → today's ranking, prize-pool panel, yesterday's
   winner, refresh.

## Speech (STT) + fallback

- STT uses `SpeechRecognition` / `webkitSpeechRecognition` (`js/stt.js`). Continuous mode
  with interim results; Chrome's periodic auto-stop is transparently restarted while the
  user is recording.
- Interim text streams into the textarea live; final chunks are committed. Manual edits to
  the textarea become the new base when recording resumes.
- **Mic permission denied** → toast + keep typing. **Browser unsupported** (Firefox/Safari)
  → record button hidden, "Speech not supported — type your answer" shown, textarea stays
  fully usable.
- TTS uses `speechSynthesis` to read each question aloud; header toggle, default ON,
  cancelled on navigation/submit.

## Backend API contract

Base URL = `CONFIG.WORKER_URL`. All JSON; CORS handled by the Worker.

| Method | Path | Body | Success | Error |
|--------|------|------|---------|-------|
| POST | `/session` | `{name, passcode}` | `{ok:true, name, tier, attemptsUsed, attemptsRemaining, maxPerDay, date}` | `401 {ok:false, error:"bad_passcode"}` |
| POST | `/interview/start` | `{name, passcode}` | `{ok:true, interviewId, questions:[{id,idx,prompt,type,topic,tier}×10]}` | `403 {ok:false, error:"cap_reached"}` |
| POST | `/judge` | `{interviewId, questionId, transcript}` | `{ok:true, score, dims:{structure,mindset,technical,communication,specificity}, strengths:[], improvements:[], modelAnswer}` | — |
| POST | `/interview/finish` | `{interviewId}` | `{ok:true, interviewScore, perQuestion:[{questionId,score}], personalBestToday, rankToday}` | — |
| GET | `/leaderboard` | — | `{ok:true, date, board:[{name,tier,bestScore,interviews}], pools:[{name,total,daysWon}], yesterdayWinner}` | — |

`score` values are 0–100. The frontend renders only what the API returns — no judge or
rubric internals.

## Files

```
index.html              app shell + script load order
css/site.css            dark-slate / teal theme, animations
js/api.js               fetch wrappers (timeout, try/catch, toasts)
js/stt.js               speech-to-text recorder + TTS helpers
js/app.js               screen flow + state machine
config.js               WORKER_URL + ROSTER (edit before deploy)
.github/workflows/      GitHub Pages deploy-from-root Action
```

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` deploys the repo root on push to `main`
(checkout → configure-pages → upload-pages-artifact `path: .` → deploy-pages).
Enable **Settings → Pages → Source: GitHub Actions**, set `WORKER_URL` in `config.js`,
push to `main`.

## Robustness notes

- All network calls are in `js/api.js` with try/catch, a 30s abort timeout, and visible
  error toasts — nothing hangs silently.
- Submit shows a **Judging…** state and disables the button while in flight; the same
  pattern guards session and start-interview calls.
- Very short answers prompt a confirm before submit (allowed, not blocked).
