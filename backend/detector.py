"""0.25초 주기 실시간 낙상 탐지 루프.

링버퍼에서 3초 윈도우를 꺼내 피처 추출 + 세그멘테이션 모델 추론을 수행하고,
윈도우 중앙 확률 >= 임계값이면 낙상으로 판정한다 (고정 지연 1.5초).

판정 규칙은 InhouseSegmentationRealtime 배포 규칙을 그대로 따른다:
겹침 평균, 최소 지속시간, 간격 연결, 다수결 필터를 적용하지 않고
중앙 확률 단독으로 판정한다. 각 tick의 확률은 윈도우 끝(현재) 기준
1.5초 전 시점에 대한 판정이다.

상태 매핑 (대시보드 도메인 용어와 동일):
  IDLE(대기)      중앙 확률 < 임계값
  FALL(낙상)      중앙 확률 >= 임계값 -> 낙상 이벤트 확정
  COOLDOWN(냉각중) FALL 종료 후 cooldown_seconds 동안 재알람 억제
  (SUSPECT는 이전 다수결 후처리의 중간 상태였고 현재는 쓰지 않는다)
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any, Callable

from csi.buffer import RingBuffer
from features import FeatureConfig, extract_window_features
from inference import FallInferenceEngine

log = logging.getLogger("detector")

STRIDE_SEC = 0.25
COOLDOWN_SECONDS = 10.0
HISTORY_MAXLEN = 240  # 최근 60초 (0.25s x 240)


class FallDetector(threading.Thread):
    def __init__(
        self,
        ring: RingBuffer,
        engine: FallInferenceEngine,
        threshold: float | None = None,
        stride_sec: float = STRIDE_SEC,
        cooldown_seconds: float = COOLDOWN_SECONDS,
        feature_config: FeatureConfig | None = None,
        on_fall: Callable[[int, float | None, float], None] | None = None,
    ) -> None:
        super().__init__(daemon=True, name="fall-detector")
        self.ring = ring
        self.engine = engine
        # 기본 임계값은 체크포인트에 실린 배포 규칙 값 (fixed_delay.default_threshold)
        self.threshold = engine.default_threshold if threshold is None else threshold
        self.stride_sec = stride_sec
        self.cooldown_seconds = cooldown_seconds
        self.feature_config = feature_config or FeatureConfig()
        # FALL 확정 시 (fall_count, proba, 시각) 콜백. 블로킹 금지 (큐 적재 수준만 허용)
        self.on_fall = on_fall

        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._history: deque[dict[str, Any]] = deque(maxlen=HISTORY_MAXLEN)
        self._state = "IDLE"
        self._cooldown_until = 0.0
        self._fall_count = 0
        self._last_fall_time: float | None = None
        self._last_result: dict[str, Any] | None = None
        self._last_error: str | None = None
        self._inference_count = 0
        self._skip_count = 0
        self._latency_ema_ms: float | None = None

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        log.info(
            "detector start: device=%s threshold=%.3f stride=%.2fs postprocess=fixed_delay_center(%.1fs)",
            self.engine.device, self.threshold, self.stride_sec, self.engine.fixed_delay_seconds,
        )
        next_tick = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            if now < next_tick:
                time.sleep(min(next_tick - now, 0.05))
                continue
            next_tick = max(next_tick + self.stride_sec, now)
            try:
                self._tick()
            except Exception:
                log.exception("detector tick failed")

    def _tick(self) -> None:
        started = time.monotonic()
        times, amps = self.ring.window(self.feature_config.window_seconds + 0.5)
        if times.size == 0:
            self._record_skip("no data")
            return
        try:
            features = extract_window_features(times, amps, self.feature_config)
        except ValueError as error:
            self._record_skip(str(error))
            return
        feature_ms = (time.monotonic() - started) * 1000.0

        infer_started = time.monotonic()
        proba = self.engine.predict(features.s3, features.acf)
        infer_ms = (time.monotonic() - infer_started) * 1000.0
        total_ms = (time.monotonic() - started) * 1000.0

        raw_pred = int(proba >= self.threshold)
        with self._lock:
            self._advance_state(raw_pred, proba)
            self._inference_count += 1
            self._last_error = None
            self._latency_ema_ms = (
                total_ms
                if self._latency_ema_ms is None
                else 0.9 * self._latency_ema_ms + 0.1 * total_ms
            )
            result = {
                "t": time.time(),
                # 새 모델은 비낙상 확률이 1e-5 수준까지 내려가므로 6자리로 남긴다
                "proba_fall": round(proba, 6),
                "raw_pred": raw_pred,
                "state": self._state,
                "fs_hz": round(features.fs_hz, 2),
                "window_samples": features.window_samples,
                "feature_ms": round(feature_ms, 1),
                "infer_ms": round(infer_ms, 1),
                "total_ms": round(total_ms, 1),
            }
            self._last_result = result
            self._history.append(
                {"t": result["t"], "proba_fall": result["proba_fall"], "state": self._state}
            )
        if total_ms > self.stride_sec * 1000.0:
            log.warning("tick %.0fms exceeds stride %.0fms", total_ms, self.stride_sec * 1000.0)

    def _advance_state(self, raw_pred: int, proba: float | None = None) -> None:
        now = time.monotonic()
        if self._state == "COOLDOWN":
            if now >= self._cooldown_until:
                self._state = "FALL" if raw_pred else "IDLE"
            return
        if raw_pred:
            if self._state != "FALL":
                self._fall_count += 1
                self._last_fall_time = time.time()
                log.warning("FALL confirmed (#%d)", self._fall_count)
                self._emit_fall(proba)
            self._state = "FALL"
            return
        if self._state == "FALL":
            # 낙상 종료: 재알람 억제 냉각 구간으로
            self._state = "COOLDOWN"
            self._cooldown_until = now + self.cooldown_seconds
            return
        self._state = "IDLE"

    def _emit_fall(self, proba: float | None) -> None:
        """FALL 확정 시점 콜백 호출. 콜백 오류가 탐지 루프를 깨지 않게 격리한다."""
        if self.on_fall is None:
            return
        try:
            self.on_fall(self._fall_count, proba, self._last_fall_time or time.time())
        except Exception:
            log.exception("on_fall 콜백 실패")

    def _record_skip(self, reason: str) -> None:
        with self._lock:
            self._skip_count += 1
            self._last_error = reason

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "enabled": True,
                "device": str(self.engine.device),
                "checkpoint": self.engine.checkpoint_path.name,
                "threshold": self.threshold,
                "postprocess": "fixed_delay_center",
                "fixed_delay_seconds": self.engine.fixed_delay_seconds,
                "state": self._state,
                "fall_count": self._fall_count,
                "last_fall_time": self._last_fall_time,
                "inference_count": self._inference_count,
                "skip_count": self._skip_count,
                "latency_ema_ms": round(self._latency_ema_ms, 1) if self._latency_ema_ms else None,
                "last_error": self._last_error,
                "last": self._last_result,
            }

    def live_payload(self) -> dict[str, Any]:
        """/ws/live에 합쳐 보낼 최소 필드."""
        with self._lock:
            last = self._last_result
            return {
                "detect_state": self._state,
                "proba_fall": last["proba_fall"] if last else None,
                "threshold": self.threshold,
                "fall_count": self._fall_count,
                "last_fall_time": self._last_fall_time,
            }

    def history(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._history)
