import time
import requests
import subprocess
import sys
from pathlib import Path

# Start app.py as subprocess
ai_venv_python = r"D:\AERIS Full Website\.venv\Scripts\python.exe"
app_path = r"D:\AERIS Full Website\ai_service\app.py"

print("Starting Flask AI Service...")
proc = subprocess.Popen([ai_venv_python, app_path], cwd=r"D:\AERIS Full Website")

try:
    # Wait for server to start
    started = False
    for _ in range(30):
        try:
            r = requests.get("http://127.0.0.1:8000/health", timeout=1)
            if r.status_code == 200:
                started = True
                print("Flask AI Service is alive and healthy on port 8000!")
                break
        except Exception:
            time.sleep(1)

    if not started:
        print("Failed to start Flask AI Service within timeout.")
        sys.exit(1)

    # Test /detect with crash video
    crash_video = Path(r"D:\Agent\input_videos\crash_clip_cut_3.mp4")
    print(f"\nSending {crash_video.name} to http://127.0.0.1:8000/detect...")
    with open(crash_video, "rb") as f:
        resp = requests.post("http://127.0.0.1:8000/detect", files={"video": (crash_video.name, f, "video/mp4")})

    print(f"Status Code: {resp.status_code}")
    print("Response JSON:")
    print(resp.json())

    assert resp.status_code == 200
    data = resp.json()
    assert data["accidentDetected"] is True
    assert data["frame"] == 172
    print("\n>>> API /detect ENDPOINT TEST PASSED WITH 100% SUCCESS! <<<")

finally:
    print("Terminating Flask process...")
    proc.terminate()
    proc.wait()
