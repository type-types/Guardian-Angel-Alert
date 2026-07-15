"""temporal_segmentation_fixed_delay.pt 체크포인트 로드와 단일 윈도우 추론.

InhouseSegmentationRealtime/infer.py 의 정규화, 중앙 확률 보간과 동일한
경로를 실시간 단건 입력에 맞게 감쌌다. feature_a = S3, feature_b = PCA-ACF.

모델은 3초 윈도우의 64-bin 세그멘테이션 확률을 출력하고, predict는 그중
정확한 윈도우 중앙 시점 확률을 선형 보간해 반환한다. 윈도우가 끝나는
시점에 공개되는 이 값은 1.5초 전 시점에 대한 판정이다 (고정 지연 1.5초).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from .model import DualBranchTemporalSegmentationModel

DEFAULT_CHECKPOINT = (
    Path(__file__).resolve().parents[2]
    / "InhouseSegmentationRealtime"
    / "weights"
    / "temporal_segmentation_fixed_delay.pt"
)


def select_device(requested: str = "auto") -> torch.device:
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable")
        return torch.device("cuda")
    if requested == "mps":
        if not torch.backends.mps.is_available():
            raise RuntimeError("MPS requested but unavailable")
        return torch.device("mps")
    if requested == "cpu":
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class FallInferenceEngine:
    def __init__(self, checkpoint_path: Path | str = DEFAULT_CHECKPOINT, device: str = "auto") -> None:
        checkpoint_path = Path(checkpoint_path)
        if not checkpoint_path.exists():
            raise FileNotFoundError(f"checkpoint not found: {checkpoint_path}")
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        config = checkpoint["model_config"]
        self.image_size = int(config["image_size"])
        self.output_bins = int(config["output_bins"])
        self.normalization = checkpoint["normalization"]
        fixed_delay = checkpoint.get("fixed_delay") or {}
        self.default_threshold = float(fixed_delay.get("default_threshold", 0.5))
        self.fixed_delay_seconds = float(fixed_delay.get("delay_seconds", 1.5))
        self.checkpoint_path = checkpoint_path
        self.model = DualBranchTemporalSegmentationModel(
            backbone=str(checkpoint.get("backbone", "resnet18")),
            embedding_dim=int(checkpoint.get("embedding_dim", 512)),
            source_dropout=float(checkpoint.get("source_dropout", 0.3)),
            output_bins=self.output_bins,
            pyramid_channels=int(config["pyramid_channels"]),
            decoder_channels=int(config["decoder_channels"]),
            decoder_dilations=[int(value) for value in config["decoder_dilations"]],
            dropout=float(config["dropout"]),
        )
        self.model.load_state_dict(checkpoint["model_state_dict"], strict=True)
        self.device = select_device(device)
        self.model.to(self.device)
        self.model.eval()
        # bin 중심 좌표 (0~1 정규화). 윈도우 중앙 0.5 위치를 선형 보간한다.
        self._bin_centers = (np.arange(self.output_bins, dtype=np.float64) + 0.5) / self.output_bins

    def warmup(self) -> None:
        """첫 추론의 커널 컴파일 지연을 미리 치른다."""
        s3 = np.zeros((self.image_size, self.image_size), dtype=np.float32)
        acf = np.zeros((1, 128, 64), dtype=np.float32)
        self.predict(s3, acf)

    @torch.no_grad()
    def predict_bins(self, s3: np.ndarray, acf: np.ndarray) -> np.ndarray:
        """단일 윈도우의 64-bin 세그멘테이션 확률을 반환한다. s3 (224,224), acf (1,128,64)."""
        s3_norm = self.normalization["feature_a"]
        acf_norm = self.normalization["feature_b"]
        s3_in = (s3.astype(np.float32)[None, None, :, :] - float(s3_norm["mean"])) / max(
            float(s3_norm["std"]), 1e-6
        )
        acf_in = (acf.astype(np.float32)[None, :, :, :] - float(acf_norm["mean"])) / max(
            float(acf_norm["std"]), 1e-6
        )
        logits = self.model(
            torch.from_numpy(s3_in).to(self.device),
            torch.from_numpy(acf_in).to(self.device),
            image_size=self.image_size,
        )
        return torch.sigmoid(logits)[0].cpu().numpy().astype(np.float32)

    def predict(self, s3: np.ndarray, acf: np.ndarray) -> float:
        """단일 윈도우의 중앙 시점 낙상 확률(고정 지연 1.5초)을 반환한다."""
        probabilities = self.predict_bins(s3, acf)
        return float(np.interp(0.5, self._bin_centers, probabilities.astype(np.float64)))
