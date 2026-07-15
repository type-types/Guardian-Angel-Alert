# CSI-Guard 로컬 백엔드

수신기(csi_recv) 시리얼 스트림을 받아 실시간 CSI 데이터와 낙상 판정을 제공하는 FastAPI 서버.
전 과정이 로컬(127.0.0.1)에서 동작한다. 작업 명세는 dcos/작업명세_로컬_실시간_낙상감지_v1.0.md 참조.

## 설치와 실행

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

수신기 포트는 자동 탐지된다(cu.usbmodem 첫 번째). 포트가 여러 개면 다음처럼 지정한다.

```bash
.venv/bin/python main.py --port /dev/cu.usbmodem5B7B0323351
```

모델 추론 관련 옵션:

```bash
.venv/bin/python main.py --no-model            # 추론 없이 수신/스트림만
.venv/bin/python main.py --device cpu          # 기본 auto (macOS는 MPS 우선)
.venv/bin/python main.py --threshold 0.5       # 낙상 판정 임계값 (기본: 체크포인트 값 0.5)
.venv/bin/python main.py --checkpoint path/to/temporal_segmentation_fixed_delay.pt
```

체크포인트 기본 경로는 저장소 루트의
InhouseSegmentationRealtime/weights/temporal_segmentation_fixed_delay.pt 이다.

## 푸시 알림 (단계 5, ntfy)

FALL 확정 시 ntfy 토픽으로 휴대폰 푸시 알림을 보낸다. 팀 합의로 ntfy.sh 공개 서버를 사용한다.

설정 순서:

1. 팀에서 정한 토픽명을 준비한다. 토픽명을 아는 누구나 구독과 발행이 가능하므로
   추측하기 어려운 이름을 쓴다 (예: csi-guard-fall-x7k2m9).
2. 휴대폰에 ntfy 앱(iOS/Android)을 설치하고 해당 토픽을 구독한다.
3. 백엔드를 토픽과 함께 실행한다.

```bash
.venv/bin/python main.py --ntfy-topic csi-guard-fall-x7k2m9
# 또는 환경변수: NTFY_TOPIC=csi-guard-fall-x7k2m9 .venv/bin/python main.py
# 셀프호스트 서버 사용 시: --ntfy-server https://ntfy.example.com
```

토픽을 지정하지 않으면 알림은 비활성 상태로 서버가 뜬다(/monitor/status의 notify에 표시).
경로 점검은 서버 실행 후 다음으로 한다. 수 초 내 휴대폰 알림이 오면 정상이다.

```bash
curl -X POST http://127.0.0.1:8000/notify/test
```

동작 방식: 발송은 전용 스레드와 큐로 처리해 0.25초 탐지 루프를 막지 않으며,
실패 시 1, 2, 4초 백오프로 최대 3회 재시도한다. FALL 확정당 1회만 발송되고
COOLDOWN(10초) 동안 재알람이 억제된다. 구현은 notifier.py, 훅은 detector.py의
FALL 확정 지점(on_fall 콜백)이다.

## 엔드포인트

| 경로 | 내용 |
|---|---|
| GET /monitor/status | 시리얼 연결 상태, 수신률(Hz), 체크섬 오류, 버퍼, 낙상 판정, 알림 발송 상태 |
| GET /monitor/window?seconds=3 | 최근 N초 윈도우 요약 (프레임 수, 진폭 통계) |
| GET /monitor/detect | 낙상 판정 상세 + 최근 60초 확률 히스토리 |
| POST /notify/test | ntfy 테스트 알림 발송 (알림 경로 수동 점검) |
| WS /ws/live | 10Hz 실시간 요약 푸시 (수신률, RSSI, 진폭, 낙상 확률/상태) |

## 낙상 탐지 파이프라인 (0.25초 주기)

```
링버퍼 3초 윈도우 -> 균일 그리드 리샘플 (native Hz)
  -> 서브캐리어 30개 선택 -> PCA motion signal
  -> S3 scalogram (224,224) + PCA-ACF (1,128,64)
  -> DualBranchTemporalSegmentationModel 추론 (temporal_segmentation_fixed_delay.pt)
  -> 64-bin 세그멘테이션 확률 -> 윈도우 중앙 확률 선형 보간
  -> 중앙 확률 >= 0.5 -> IDLE/FALL/COOLDOWN (고정 지연 1.5초)
```

- 피처 코드는 ACF_Scalogram_FeatureExtraction(연구단 제공, gitignore)에서 이식했고,
  합성 입력에 대해 원본과 비트 단위 동일 출력을 확인했다.
- 모델과 판정 규칙은 InhouseSegmentationRealtime(연구단 제공, gitignore)의 배포
  규칙을 따른다. 겹침 평균, 최소 지속시간, 간격 연결, 다수결 필터를 쓰지 않고
  윈도우 중앙 확률 단독으로 판정한다. 각 판정은 현재 시점이 아니라 1.5초 전
  시점에 대한 것이다 (윈도우 끝에서 중앙 시점 결과를 공개하는 고정 지연 설계).
- 이전 분류 모델(best_model.pt)의 인과 다수결 후처리는 제거했다. 교체 근거와
  비교 분석은 dcos/모델비교_세그멘테이션_전환_v1.0.md 참조.
- CWT scale 계산(freq_to_scale, 호출당 약 0.5초)은 fs와 윈도우 길이에 결정적이라
  캐시한다. 측정 fs를 0.25Hz 격자로 양자화해 캐시가 적중하게 한다.

벤치마크:

```bash
.venv/bin/python bench_pipeline.py --fs 166.67
```

## 2x2 실험 도구 (배치 x 모델)

송수신기 배치(의자 마주보기 / 천장 송신기)별로 낙상을 수행하면서 두 모델
(신규 세그멘테이션, 구 분류)의 최대 confidence를 측정하는 도구는 전용
레포로 분리했다 (수집 데이터와 발견 문서 포함):

https://github.com/type-types/csi-guard-2x2-experiment

이 저장소에서는 experiment.py, experiment_server.py, experiment_report.py,
inference/legacy.py, experiments/ 가 gitignore 처리돼 있다. 로컬에서 실험을
돌릴 때는 이 폴더에 해당 파일들을 두고 쓰되, 변경분은 전용 레포에 커밋한다.
실험 서버는 main.py와 같은 시리얼 포트를 쓰므로 동시에 띄우지 않는다.

## 구조

```
backend/
  main.py               FastAPI 앱, 엔드포인트, 탐지 루프와 알림 기동
  detector.py           0.25초 주기 추론 루프, 상태머신 (고정 지연 중앙 판정)
  notifier.py           ntfy 푸시 알림 발송 (전용 스레드, 재시도)
  csi/protocol.py       바이너리 프레임 파서 (매직 0xA55A, 체크섬, 재동기화)
  csi/serial_reader.py  포트 탐지, 921600 연결, 자동 재연결 스레드
  csi/buffer.py         링버퍼 (30초), 타임스탬프 unwrap, 수신 품질 지표
  features/common.py    S3 scalogram 코어 (원본 amfall_losnlos_common.py 이식)
  features/acf.py       PCA-ACF 계산 (원본 build_losnlos_pca_motion_acf_dataset.py 이식)
  features/realtime.py  실시간 윈도우 -> 모델 입력 피처 래퍼
  inference/model.py    DualBranchTemporalSegmentationModel 정의 (체크포인트와 1:1, 구조 변경 금지)
  inference/engine.py   체크포인트 로드, 정규화, 64-bin 추론과 중앙 확률 보간
  bench_pipeline.py     파이프라인 지연 벤치마크
```

프레임 프로토콜 정의의 원본은 esp32c5/csi_recv/main/app_main.c 이다.
프로토콜이 바뀌면 csi/protocol.py 의 HEADER_FMT 를 함께 갱신해야 한다.
피처 파라미터(FeatureConfig)는 학습 설정과 일치해야 하며, 근거는
InhouseSegmentationRealtime/data/config.json 과
ACF_Scalogram_FeatureExtraction/README_KO.md 의 모델 호환 설정 표이다.
