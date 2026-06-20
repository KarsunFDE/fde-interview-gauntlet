// stt.js — Speech-to-text (Web Speech API) + text-to-speech helpers.
// STT: webkitSpeechRecognition / SpeechRecognition. Not available in Firefox/Safari.
// TTS: speechSynthesis. Both degrade gracefully.

(function () {
  "use strict";

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function sttSupported() {
    return !!SR;
  }

  // Recorder wraps a SpeechRecognition instance. The recognizer fills an INTERNAL
  // transcript buffer — the caller never feeds a visible textarea while recording.
  // Read the buffered transcript on stop via getTranscript(). onUpdate(text) fires
  // with the live composed buffer (committed + interim) so the caller can show a
  // non-editable hint such as a running word count — NOT an editable field.
  //
  // Graceful restart: Chrome silently ends recognition every ~minute. While we are
  // still "listening" (user hasn't stopped, no external stop), we auto-restart so
  // the answer is never cut short. Only the caller's explicit stop() ends capture.
  function createRecorder(opts) {
    opts = opts || {};
    if (!SR) return null;

    var rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = opts.lang || "en-US";

    var listening = false;
    var stoppedByUser = false;
    var finalBuffer = ""; // committed transcript so far

    function composed(interim) {
      return (finalBuffer + (interim ? " " + interim : "")).trim();
    }

    rec.onresult = function (event) {
      var interim = "";
      var finalChunk = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var r = event.results[i];
        if (r.isFinal) {
          finalChunk += r[0].transcript;
        } else {
          interim += r[0].transcript;
        }
      }
      if (finalChunk) {
        finalBuffer = (finalBuffer + " " + finalChunk).trim();
      }
      if (typeof opts.onUpdate === "function") opts.onUpdate(composed(interim));
    };

    rec.onerror = function (e) {
      if (typeof opts.onError === "function") opts.onError(e);
    };

    rec.onend = function () {
      // Chrome stops recognition periodically; auto-restart while still listening so
      // its silent auto-stop never ends the answer early. Only the 2-min timer, the
      // word ceiling, or a user Stop (all routed through stop()) end capture.
      if (listening && !stoppedByUser) {
        try {
          rec.start();
          return;
        } catch (err) {
          listening = false;
        }
      }
      listening = false;
      if (typeof opts.onEnd === "function") opts.onEnd();
    };

    return {
      start: function () {
        if (listening) return;
        stoppedByUser = false;
        finalBuffer = "";
        listening = true;
        try {
          rec.start();
          if (typeof opts.onStart === "function") opts.onStart();
        } catch (err) {
          listening = false;
          if (typeof opts.onError === "function") opts.onError({ error: "start_failed", message: String(err) });
        }
      },
      stop: function () {
        stoppedByUser = true;
        listening = false;
        try {
          rec.stop();
        } catch (err) {
          /* no-op */
        }
      },
      isListening: function () {
        return listening;
      },
      // Final buffered transcript (committed text only — interim is dropped on stop).
      getTranscript: function () {
        return finalBuffer.trim();
      }
    };
  }

  // ---- Text to speech -----------------------------------------------------

  function ttsSupported() {
    return typeof window.speechSynthesis !== "undefined";
  }

  function speak(text, enabled) {
    if (!enabled || !ttsSupported() || !text) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.0;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    } catch (err) {
      /* no-op — TTS is best-effort */
    }
  }

  function cancelSpeech() {
    if (ttsSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch (err) {
        /* no-op */
      }
    }
  }

  window.STT = {
    supported: sttSupported,
    createRecorder: createRecorder,
    tts: {
      supported: ttsSupported,
      speak: speak,
      cancel: cancelSpeech
    }
  };
})();
