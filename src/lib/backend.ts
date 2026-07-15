// 로컬 백엔드(backend/main.py, 127.0.0.1:8000) API 클라이언트.
// 대시보드와 같은 맥에서 돌아가는 FastAPI 서버로, 수신기 시리얼 스트림을 중계한다.

import { useEffect, useState } from "react";

export const BACKEND_URL = "http://127.0.0.1:8000";

export interface DetectedPort {
  device: string;
  description: string | null;
  serial_number: string | null;
  active: boolean;
}

export async function fetchPorts(): Promise<DetectedPort[]> {
  const res = await fetch(`${BACKEND_URL}/ports`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`ports ${res.status}`);
  const data = (await res.json()) as { ports: DetectedPort[] };
  return data.ports;
}

// ---- 실시간 스트림 (/ws/live, 10Hz) ----

export type DetectState = "IDLE" | "SUSPECT" | "FALL" | "COOLDOWN";

export interface LiveSample {
  t: number;
  connected: boolean; // 백엔드-수신기 시리얼 연결 여부
  hz_1s: number;
  rssi: number | null;
  buffered_seconds: number;
  amp_mean: number | null;
  amp_std: number | null; // 최근 0.5초 진폭 표준편차 (움직임 근사 지표)
  // 낙상 판정 (백엔드 모델 가동 시에만 존재)
  detect_state?: DetectState;
  proba_fall?: number | null; // 3초 윈도우 중앙 시점 낙상 확률, 1.5초 고정 지연 (0.25초 주기 갱신)
  threshold?: number; // 판정 임계값 (기본: 체크포인트 값 0.5)
  fall_count?: number; // 백엔드 기동 후 낙상 확정 횟수
  last_fall_time?: number | null;
}

export interface LiveStreamState {
  wsUp: boolean; // 브라우저-백엔드 WebSocket 연결 여부
  last: LiveSample | null;
  history: LiveSample[];
}

export function useLiveStream(maxHistory = 300): LiveStreamState {
  const [state, setState] = useState<LiveStreamState>({ wsUp: false, last: null, history: [] });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(`${BACKEND_URL.replace(/^http/, "ws")}/ws/live`);
      } catch {
        retry = setTimeout(connect, 2000);
        return;
      }
      ws.onopen = () => setState((s) => ({ ...s, wsUp: true }));
      ws.onmessage = (e) => {
        const sample = JSON.parse(e.data as string) as LiveSample;
        setState((s) => ({
          wsUp: true,
          last: sample,
          history: [...s.history.slice(-(maxHistory - 1)), sample],
        }));
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, wsUp: false }));
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [maxHistory]);

  return state;
}
