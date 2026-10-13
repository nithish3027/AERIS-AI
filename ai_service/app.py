import logging
import os
import sys
import tempfile
from pathlib import Path

ai_dir = str(Path(__file__).resolve().parent)
if ai_dir not in sys.path:
    sys.path.insert(0, ai_dir)

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from accident_detector import detect_accident, load_model

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai_service")

app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 150 * 1024 * 1024

SNAPSHOT_DIR = Path(__file__).resolve().parent / "snapshots"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/snapshots/<path:filename>")
def get_snapshot(filename):
    return send_from_directory(SNAPSHOT_DIR, filename)


@app.post("/detect")
def detect():
    uploaded_video = request.files.get("video")
    if uploaded_video is None or not uploaded_video.filename:
        return jsonify(message="Upload a video in the 'video' field."), 400

    suffix = Path(uploaded_video.filename).suffix.lower()
    if suffix not in {".mp4", ".mov", ".avi", ".mkv", ".webm", ".mpeg", ".mpg"}:
        return jsonify(message="Unsupported video type. Upload MP4, MOV, AVI, MKV, or WEBM."), 400

    temporary_path = None
    try:
        logger.info(f"Received video for detection: {uploaded_video.filename}")
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary_file:
            uploaded_video.save(temporary_file)
            temporary_path = temporary_file.name

        result = detect_accident(temporary_path)
        logger.info(f"Detection result for {uploaded_video.filename}: {result}")
        return jsonify(result)
    except ValueError as error:
        logger.warning(f"Validation error: {error}")
        return jsonify(message=str(error)), 400
    except Exception:
        logger.exception("AI accident analysis failed")
        return jsonify(message="AI analysis failed. Check the model weights and AI service logs."), 503
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)


@app.errorhandler(413)
def video_too_large(_error):
    return jsonify(message="Video exceeds the 150 MB upload limit."), 413


if __name__ == "__main__":
    logger.info("Pre-warming YOLO model...")
    load_model()
    logger.info("Model pre-warmed. Starting server on port 8000...")
    port = int(os.getenv("AI_PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
