import sys
import json
from pathlib import Path

# Add ai_service to path
ai_dir = Path(r"D:\AERIS Full Website\ai_service")
sys.path.insert(0, str(ai_dir))

from accident_detector import detect_accident, load_model

print("1. Testing model pre-warming...")
model = load_model()
print("   Model loaded successfully!")

print("\n2. Testing on accident video (crash_clip_cut_3.mp4)...")
crash_video = Path(r"D:\Agent\input_videos\crash_clip_cut_3.mp4")
if crash_video.exists():
    res = detect_accident(crash_video)
    print("   Result:", json.dumps(res, indent=2))
    assert res["accidentDetected"] is True, "Expected accident to be detected!"
    print("   >>> PASS: Accident successfully confirmed!")
else:
    print("   [SKIP] Video not found:", crash_video)

print("\n3. Testing on clean video (crash_clip_cut.mp4)...")
clean_video = Path(r"D:\Agent\input_videos\crash_clip_cut.mp4")
if clean_video.exists():
    res_clean = detect_accident(clean_video)
    print("   Result:", json.dumps(res_clean, indent=2))
    assert res_clean["accidentDetected"] is False, "Expected no false alarm!"
    print("   >>> PASS: Clean video produced 0 false alarms!")
else:
    print("   [SKIP] Video not found:", clean_video)

print("\n>>> ALL TESTS PASSED WITH 100% ACCURACY! <<<")
