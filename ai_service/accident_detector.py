
from __future__ import annotations

import os
import time
from pathlib import Path
from threading import Lock
from typing import Any
from collections import deque
from datetime import datetime

import cv2
import numpy as np
from ultralytics import YOLO


_model = None
_model_lock = Lock()
_inference_lock = Lock()


def _resolve_model_path() -> str:
    env_model = os.getenv("YOLO_MODEL")
    ai_dir = Path(__file__).resolve().parent
    candidates = [
        env_model,
        str(ai_dir / "yolov8n.pt"),
        str(ai_dir / "models" / "yolov8n.pt"),
        str(ai_dir.parent / "yolov8n.pt"),
        "yolov8n.pt",
        str(ai_dir / "yolov8s.pt"),
        str(ai_dir / "models" / "yolov8s.pt"),
        str(ai_dir.parent / "yolov8s.pt"),
        "yolov8s.pt",
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return str(Path(c).resolve())
    return "yolov8n.pt"


MODEL_PATH = _resolve_model_path()
SNAPSHOT_DIR = Path(__file__).resolve().parent / "snapshots"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def load_model() -> YOLO:
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                import torch
                if hasattr(torch, "set_num_threads"):
                    cores = os.cpu_count() or 4
                    torch.set_num_threads(max(1, min(cores, 8)))
                model_file = _resolve_model_path()
                print(f"[INFO] Loading YOLO model: {model_file}")
                _model = YOLO(model_file)
    return _model


class VehicleKinematicsTracker:
    """Maintains spatial and temporal kinematic telemetry for tracked vehicles."""
    def __init__(self, track_id: int, max_history: int = 25):
        self.track_id = track_id
        self.history = deque(maxlen=max_history)
        self.last_seen_frame = 0
        self.velocity = (0.0, 0.0)
        self.speed = 0.0
        self.expansion_rate = 0.0
        self.ttc = float("inf")
        self.threat_level = "NORMAL"

    def update(self, frame_idx: int, bbox: tuple[int, int, int, int], fps: float = 30.0):
        x1, y1, x2, y2 = bbox
        width = max(1.0, x2 - x1)
        height = max(1.0, y2 - y1)
        area = width * height
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        now = time.time()

        if len(self.history) > 0:
            prev_f, prev_b, prev_a, (prev_cx, prev_cy), prev_t = self.history[-1]
            df = max(1, frame_idx - prev_f)
            vx = (cx - prev_cx) / df
            vy = (cy - prev_cy) / df
            self.velocity = (vx, vy)
            self.speed = float(np.hypot(vx, vy))

            old_f, old_b, old_a, (old_cx, old_cy), old_t = self.history[0]
            total_dt = max(0.01, (frame_idx - old_f) / max(1.0, fps))
            delta_area = area - old_a
            self.expansion_rate = delta_area / (max(1.0, old_a) * total_dt)

            if delta_area > 0 and self.expansion_rate > 0.08:
                scale_ratio = np.sqrt(area / max(1.0, old_a))
                if scale_ratio > 1.002:
                    self.ttc = total_dt / (scale_ratio - 1.0)
                else:
                    self.ttc = float("inf")
            else:
                self.ttc = float("inf")
        else:
            self.velocity = (0.0, 0.0)
            self.speed = 0.0
            self.expansion_rate = 0.0
            self.ttc = float("inf")

        self.history.append((frame_idx, bbox, area, (cx, cy), now))
        self.last_seen_frame = frame_idx
        return self.expansion_rate, self.ttc


class VisualShockSensor:
    """Monitors global optical flux to detect violent chassis impact shock."""
    def __init__(self, baseline_history: int = 45):
        self.prev_gray = None
        self.motion_history = deque(maxlen=baseline_history)
        self.shock_ratio = 1.0
        self.last_diff = 0.0

    def compute_shock(self, frame: np.ndarray):
        small = cv2.resize(frame, (240, 135))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        diff = 0.0
        is_impact_shock = False
        is_extreme_shock = False

        if self.prev_gray is not None:
            diff = float(np.mean(cv2.absdiff(gray, self.prev_gray)))
            self.last_diff = diff
            base_mean = max(2.0, float(np.mean(self.motion_history))) if len(self.motion_history) >= 5 else 3.5
            self.shock_ratio = diff / base_mean

            if (self.shock_ratio >= 2.8 and diff >= 16.0) or (diff >= 25.0 and self.shock_ratio >= 3.0) or (diff >= 35.0):
                is_impact_shock = True
            if (diff >= 25.0 and self.shock_ratio >= 3.0) or (diff >= 35.0):
                is_extreme_shock = True

            if diff < 20.0:
                self.motion_history.append(diff)
        else:
            self.motion_history.append(3.5)

        self.prev_gray = gray
        return diff, self.shock_ratio, is_impact_shock, is_extreme_shock


class DashcamAccidentDetector:
    def __init__(
        self,
        model: YOLO | None = None,
        confidence_thresh: float = 0.30,
        detect_v2v: bool = False,
        snapshot_dir: Path | str = SNAPSHOT_DIR,
        imgsz: int = 416,
        tracker: str = "bytetrack.yaml",
        frame_stride: int = 2,
    ):
        self.model = model or load_model()
        self.conf_thresh = confidence_thresh
        self.vehicle_classes = [2, 3, 5, 7]  # car, motorcycle, bus, truck
        self.detect_v2v = detect_v2v
        self.snapshot_dir = str(snapshot_dir)
        os.makedirs(self.snapshot_dir, exist_ok=True)
        self.imgsz = int(os.getenv("YOLO_IMGSZ", str(imgsz)))
        self.tracker_config = os.getenv("YOLO_TRACKER", tracker)
        self.frame_stride = int(os.getenv("FRAME_STRIDE", str(frame_stride)))

        self.shock_sensor = VisualShockSensor()
        self.trackers: dict[int, VehicleKinematicsTracker] = {}
        self.v2v_history: dict[tuple[int, int], list] = {}

        self.frame_idx = 0
        self.accident_active = False
        self.last_crash_reason = ""
        self.incident_history = []

    def check_ego_collision(self, bbox, tracker, is_impact_shock, diff, shock_ratio, w, h):
        x1, y1, x2, y2 = bbox
        area = (x2 - x1) * (y2 - y1)
        area_ratio = area / float(w * h)

        is_hood_penetration = (
            (y2 > 0.76 * h) and
            (x1 < 0.75 * w and x2 > 0.25 * w) and
            (area_ratio > 0.050)
        )
        deep_penetration = (
            (y2 > 0.82 * h) and
            (x1 < 0.70 * w and x2 > 0.30 * w) and
            (area_ratio > 0.070)
        )

        threat = "NORMAL"
        is_crash = False
        reason = ""

        if is_hood_penetration or deep_penetration:
            if is_impact_shock or diff >= 20.0:
                is_crash = True
                reason = f"Ego Impact: Target ID#{tracker.track_id} bumper contact with physical shock (diff={diff:.1f}, shock_ratio={shock_ratio:.1f})"
                threat = "CRASH_IMPACT"
            else:
                threat = "CRITICAL_PROXIMITY"
        elif tracker.ttc < 1.0 or tracker.expansion_rate > 0.25:
            threat = "CRITICAL_PROXIMITY"
        elif tracker.ttc < 2.0 or tracker.expansion_rate > 0.12:
            threat = "APPROACHING"

        return is_crash, threat, reason

    def check_v2v_collision(self, active_boxes):
        if not self.detect_v2v:
            return False, None, ""

        v2v_crash = False
        crash_pair = None
        details = ""

        n = len(active_boxes)
        for i in range(n):
            for j in range(i + 1, n):
                b1, tid1, v1, spd1 = active_boxes[i]
                b2, tid2, v2, spd2 = active_boxes[j]
                pair_key = (min(tid1, tid2), max(tid1, tid2))

                rel_speed = float(np.linalg.norm(np.array(v1) - np.array(v2)))
                ix1, iy1 = max(b1[0], b2[0]), max(b1[1], b2[1])
                ix2, iy2 = min(b1[2], b2[2]), min(b1[3], b2[3])

                if ix2 > ix1 and iy2 > iy1:
                    inter_area = (ix2 - ix1) * (iy2 - iy1)
                    a1 = max(1.0, (b1[2] - b1[0]) * (b1[3] - b1[1]))
                    a2 = max(1.0, (b2[2] - b2[0]) * (b2[3] - b2[1]))
                    min_overlap = inter_area / float(min(a1, a2))

                    if min_overlap > 0.40:
                        hist = self.v2v_history.get(pair_key, [])
                        hist.append((rel_speed, spd1, spd2))
                        self.v2v_history[pair_key] = hist
                        if len(hist) >= 4:
                            init_v = hist[0][0]
                            curr_v = hist[-1][0]
                            if (init_v >= 10.0) and (curr_v <= 4.0 or curr_v < init_v * 0.40):
                                v2v_crash = True
                                crash_pair = pair_key
                                details = f"V2V Crash: Vehicles ID#{pair_key[0]} & ID#{pair_key[1]} collision (overlap={min_overlap:.2f}, speed drop {init_v:.1f}->{curr_v:.1f})"
                                break
                    else:
                        if pair_key in self.v2v_history:
                            del self.v2v_history[pair_key]
            if v2v_crash:
                break
        return v2v_crash, crash_pair, details

    def process_frame(self, frame: np.ndarray, fps: float = 30.0):
        self.frame_idx += 1
        h, w = frame.shape[:2]

        diff, shock_ratio, is_impact_shock, is_extreme_shock = self.shock_sensor.compute_shock(frame)

        if self.frame_idx < 15:
            return frame, False, ""


        has_approaching_threat = any(
            tr.threat_level in ("APPROACHING", "CRITICAL_PROXIMITY") for tr in self.trackers.values()
        )
        should_run_yolo = (
            (self.frame_idx % self.frame_stride == 0)
            or is_impact_shock
            or is_extreme_shock
            or (diff >= 15.0)
            or has_approaching_threat
        )

        active_boxes = []
        crash_detected_this_frame = False
        crash_reason = ""

        if should_run_yolo:
            results = self.model.track(
                frame,
                persist=True,
                conf=self.conf_thresh,
                classes=self.vehicle_classes,
                verbose=False,
                tracker=self.tracker_config,
                imgsz=self.imgsz,
            )

            if results and len(results) > 0 and results[0].boxes is not None and results[0].boxes.id is not None:
                boxes = results[0].boxes.xyxy.cpu().numpy()
                track_ids = results[0].boxes.id.int().cpu().numpy()

                for bbox, track_id in zip(boxes, track_ids):
                    x1, y1, x2, y2 = map(int, bbox)
                    if track_id not in self.trackers:
                        self.trackers[track_id] = VehicleKinematicsTracker(track_id)

                    tracker = self.trackers[track_id]
                    expansion_rate, ttc = tracker.update(self.frame_idx, (x1, y1, x2, y2), fps)
                    active_boxes.append(((x1, y1, x2, y2), track_id, tracker.velocity, tracker.speed))

                    is_ego_crash, threat, reason = self.check_ego_collision(
                        (x1, y1, x2, y2), tracker, is_impact_shock, diff, shock_ratio, w, h
                    )
                    tracker.threat_level = threat
                    if is_ego_crash:
                        crash_detected_this_frame = True
                        crash_reason = reason

                if self.detect_v2v and not crash_detected_this_frame:
                    v2v_crash, crash_pair, v2v_reason = self.check_v2v_collision(active_boxes)
                    if v2v_crash:
                        crash_detected_this_frame = True
                        crash_reason = v2v_reason

        if not crash_detected_this_frame and is_extreme_shock:
            crash_detected_this_frame = True
            crash_reason = f"Catastrophic Ego Impact: Violent chassis jerk spike (diff={diff:.1f}, shock_ratio={shock_ratio:.1f})"

        stale_ids = [tid for tid, tr in self.trackers.items() if self.frame_idx - tr.last_seen_frame > 45]
        for tid in stale_ids:
            del self.trackers[tid]

        if crash_detected_this_frame:
            self.accident_active = True
            self.last_crash_reason = crash_reason
            return frame, True, crash_reason

        return frame, False, ""


def _detect_accident(video_path: str | Path) -> dict[str, Any]:
    import torch
    model = load_model()
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("The uploaded file is not a readable video.")

    fps = capture.get(cv2.CAP_PROP_FPS)
    if fps <= 0 or np.isnan(fps):
        fps = 30.0

    detect_v2v = os.getenv("DETECT_V2V", "0").lower() in ("1", "true", "yes")
    detector = DashcamAccidentDetector(model=model, detect_v2v=detect_v2v)
    read_idx = 0
    confirmed_accident = None

    try:
        with torch.inference_mode():
            while read_idx < 3000:
                ok, frame = capture.read()
                if not ok:
                    break
                read_idx += 1

                _, is_crash, reason = detector.process_frame(frame, fps=fps)
                if is_crash:
                    shock_val = detector.shock_sensor.shock_ratio
                    confidence = round(min(0.99, max(0.85, 0.75 + (shock_val * 0.015))), 2)

                    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
                    snapshot_path = Path(detector.snapshot_dir) / f"accident_{timestamp_str}_frame{read_idx}.jpg"
                    cv2.imwrite(str(snapshot_path), frame)

                    collision_sec = round(read_idx / fps, 2)
                    pre_crash_sec = max(0.0, round(collision_sec - 20.0, 2))
                    confirmed_accident = {
                        "accidentDetected": True,
                        "confidence": float(confidence),
                        "frame": int(read_idx),
                        "fps": float(round(fps, 2)),
                        "collision_sec": float(collision_sec),
                        "pre_crash_sec": float(pre_crash_sec),
                        "message": f"Collision confirmed at frame {read_idx}: {reason}",
                        "reason": reason,
                        "shock_ratio": round(float(shock_val), 2),
                        "snapshot": snapshot_path.name,
                    }
                    break
    finally:
        capture.release()

    if read_idx == 0:
        raise ValueError("The uploaded video has no readable frames.")

    if confirmed_accident is not None:
        return confirmed_accident

    return {
        "accidentDetected": False,
        "confidence": 0.0,
        "frame": None,
        "message": "No collision detected in the analysed video.",
    }


def detect_accident(video_path: str | Path) -> dict[str, Any]:
    with _inference_lock:
        return _detect_accident(video_path)
