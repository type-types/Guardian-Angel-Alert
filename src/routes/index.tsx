import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  useStore,
  useTick,
  stateLabel,
  stateColor,
  fmtDateTime,
  setActiveResident,
  useCurrentUser,
  simulateFall,
  presenceLabel,
  presenceColor,
  unifiedStatusLabel,
  unifiedStatusColor,
} from "@/lib/mock-store";
import { toast } from "sonner";
import { EventLogPanel } from "@/components/EventLogPanel";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { useLiveStream } from "@/lib/backend";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "실시간 관제 · CSI-Guard" }] }),
  component: MonitoringPage,
});

function MonitoringPage() {
  useTick();
  const user = useCurrentUser();
  const isFacility = user?.service === "FACILITY";
  const running = useStore((s) => s.running);
  const allResidents = useStore((s) => s.residents);
  const residents = isFacility
    ? allResidents.filter((r) => r.facilityId === user?.facilityId)
    : allResidents.filter((r) => r.ownerUserId === user?.id);
  const activeId = useStore((s) => s.activeResidentId);
  const active = residents.find((r) => r.id === activeId) ?? residents[0];
  const activeDevice = useStore((s) => s.devices.find((d) => d.id === active?.deviceId));
  const config = useStore((s) => s.config);
  const mvHistory = useStore((s) => s.mvHistory);
  const allFalls = useStore((s) => s.falls);
  const falls = allFalls.filter((f) => residents.some((r) => r.id === f.residentId));
  const criticalCount = residents.filter((r) => r.state === "FALL" || r.state === "SUSPECT").length;
  const onlineCount = residents.filter((r) => r.online).length;

  const chartData = mvHistory.map((p, i) => ({ i, mv: Number(p.mv.toFixed(3)) }));
  const threshold = active?.thresholdOverride ?? config.mv_threshold;

  // 로컬 백엔드 실시간 스트림 (가정용 화면은 mock 대신 실데이터만 표시)
  const live = useLiveStream();
  const backendUp = live.wsUp;
  const serialUp = live.last?.connected ?? false;
  const liveMode = backendUp && serialUp;
  const liveChartData = live.history.map((p, i) => ({ i, amp: p.amp_std ?? 0 }));

  const title = isFacility ? "요양원 통합 대시보드" : "가정 모니터링 대시보드";

  return (
    <div className="flex flex-col">
      <Header title={title} criticalCount={criticalCount} onlineCount={onlineCount} />

      <div className="p-6 space-y-6">
        {!running && (
          <div className="bg-surface border border-warning/40 rounded p-4 flex items-center gap-3">
            <div className="size-2 rounded-full bg-warning" />
            <div className="text-sm">
              <span className="font-semibold text-warning">모니터링 정지 상태</span>
            </div>
          </div>
        )}

        {isFacility && (
          <section>
            <SectionTitle>
              다중 거주자 상태 그리드 · 호실 클릭 시 해당 ESP32와 MQTT 통신
            </SectionTitle>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {residents.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setActiveResident(r.id)}
                  className={`text-left bg-surface border rounded-lg p-4 hover:border-muted transition-colors ${
                    r.id === activeId
                      ? "border-foreground ring-2 ring-primary/30"
                      : r.state === "FALL"
                        ? "border-primary animate-alert"
                        : r.state === "SUSPECT"
                          ? "border-warning"
                          : "border-border"
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="text-sm font-semibold">
                        {r.room}호 · {r.name}
                      </div>
                      <div className="text-[10px] text-muted font-mono">
                        {r.deviceId} · {r.age}세
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-mono uppercase font-bold ${unifiedStatusColor(r.state, r.presence)}`}
                    >
                      {unifiedStatusLabel(r.state, r.presence)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className={`font-bold ${presenceColor(r.presence)}`}>
                      {presenceLabel(r.presence)}
                    </span>
                    <span className="text-muted">MV {r.mv.toFixed(2)}</span>
                    <span className="text-muted">W {r.wander.toFixed(2)}</span>
                    <span className={r.online ? "text-success" : "text-muted"}>
                      {r.online ? "ON" : "OFF"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="grid grid-cols-3 gap-4">
          {isFacility ? (
            <>
              <StatCard
                label="현재 상태"
                value={unifiedStatusLabel(active?.state ?? "IDLE", active?.presence ?? "ABSENT")}
                sub={`${active?.name ?? "—"} (${active?.room ?? "—"}호)`}
                tone={
                  active?.state === "FALL"
                    ? "danger"
                    : active?.state === "SUSPECT"
                      ? "warn"
                      : active?.state === "COOLDOWN"
                        ? "default"
                        : active?.presence === "PRESENT"
                          ? "success"
                          : "default"
                }
              />
              <StatCard
                label="DNN 낙상 신뢰도"
                value={`${((active?.confidence ?? 0) * 100).toFixed(1)}%`}
                sub="Model: CSI-NET v2 (딥러닝)"
              />
              <StatCard
                label="움직임 감지 임계값"
                value={threshold.toFixed(3)}
                sub={active?.thresholdOverride != null ? "거주자별 오버라이드" : "전역 설정"}
              />
            </>
          ) : (
            <>
              <StatCard
                label="수신기 상태"
                value={liveMode ? "수신 중" : "연결 끊김"}
                sub={
                  liveMode
                    ? `${live.last?.hz_1s ?? 0}Hz · RSSI ${live.last?.rssi ?? "—"}dBm`
                    : backendUp
                      ? "수신기(USB) 미연결 · 장치 설정에서 포트 확인"
                      : "로컬 백엔드 미실행 (backend/main.py)"
                }
                tone={liveMode ? "success" : "danger"}
              />
              <StatCard
                label="낙상 판정"
                value={
                  !liveMode
                    ? "연결 끊김"
                    : live.last?.proba_fall != null
                      ? stateLabel(live.last.detect_state ?? "IDLE")
                      : "모델 미가동"
                }
                sub={
                  liveMode && live.last?.proba_fall != null
                    ? `낙상 확률 ${(live.last.proba_fall * 100).toFixed(3)}% (1.5초 전 시점, 0.25초 주기)`
                    : liveMode
                      ? "백엔드가 --no-model로 실행 중이거나 모델 로드 실패"
                      : "백엔드/수신기 연결 후 표시됩니다"
                }
                tone={
                  !liveMode || live.last?.proba_fall == null
                    ? "default"
                    : live.last?.detect_state === "FALL"
                      ? "danger"
                      : live.last?.detect_state === "SUSPECT"
                        ? "warn"
                        : "success"
                }
              />
              <StatCard
                label="판정 임계값"
                value={
                  liveMode && live.last?.threshold != null
                    ? live.last.threshold.toFixed(3)
                    : threshold.toFixed(3)
                }
                sub={
                  liveMode && live.last?.threshold != null
                    ? "윈도우 중앙 확률 기준 (고정 지연 1.5초, 후처리 없음)"
                    : "전역 설정 (mock)"
                }
              />
            </>
          )}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-surface border border-border rounded-lg flex flex-col">
            <div className="p-4 border-b border-border flex justify-between items-center">
              <h3 className="text-xs font-mono font-semibold uppercase tracking-widest">
                {isFacility
                  ? `실시간 움직임 감지 · ${active?.name}`
                  : "실시간 움직임 감지 · 수신기 실데이터"}
              </h3>
              <div className="flex items-center gap-2">
                {isFacility ? (
                  <span className="text-[10px] font-mono text-muted px-2 py-0.5 rounded bg-background border border-border">
                    MQTT: {activeDevice?.mqttTopic ?? "—"} · {chartData.length} samples
                  </span>
                ) : liveMode ? (
                  <span className="text-[10px] font-mono text-success px-2 py-0.5 rounded bg-success/10 border border-success/30">
                    ● LIVE · {live.last?.hz_1s ?? 0}Hz · {live.history.length} samples
                  </span>
                ) : (
                  <span className="text-[10px] font-mono text-danger px-2 py-0.5 rounded bg-danger/10 border border-danger/30">
                    ○ 연결 끊김
                  </span>
                )}
                <button
                  onClick={() => {
                    simulateFall(active?.id);
                    toast.warning(
                      "[시뮬레이션] 딥러닝 낙상 이벤트 발생 — 알람 응답 파이프라인 확인",
                    );
                  }}
                  className="px-2.5 py-1 rounded text-[10px] font-mono uppercase font-bold bg-danger text-white hover:brightness-110"
                  title="현재 활성 대상에 딥러닝 추론 결과로 낙상 이벤트를 강제 발생시킵니다"
                >
                  ⚠ 낙상 시뮬레이션
                </button>
              </div>
            </div>
            <div className="p-4 h-72">
              {isFacility ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <XAxis
                      dataKey="i"
                      tick={{ fill: "#71717a", fontSize: 10, fontFamily: "JetBrains Mono" }}
                      axisLine={{ stroke: "#e4e4e7" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#71717a", fontSize: 10, fontFamily: "JetBrains Mono" }}
                      axisLine={{ stroke: "#e4e4e7" }}
                      tickLine={false}
                      domain={[0, "dataMax + 1"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#ffffff",
                        border: "1px solid #e4e4e7",
                        fontFamily: "JetBrains Mono",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#71717a" }}
                    />
                    <ReferenceLine
                      y={threshold}
                      stroke="#ef4444"
                      strokeDasharray="4 4"
                      label={{
                        value: `임계값 ${threshold}`,
                        fill: "#ef4444",
                        fontSize: 10,
                        position: "insideTopRight",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="mv"
                      stroke="#22c55e"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : liveMode ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={liveChartData}
                    margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
                  >
                    <XAxis
                      dataKey="i"
                      tick={{ fill: "#71717a", fontSize: 10, fontFamily: "JetBrains Mono" }}
                      axisLine={{ stroke: "#e4e4e7" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#71717a", fontSize: 10, fontFamily: "JetBrains Mono" }}
                      axisLine={{ stroke: "#e4e4e7" }}
                      tickLine={false}
                      domain={[0, "dataMax + 2"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#ffffff",
                        border: "1px solid #e4e4e7",
                        fontFamily: "JetBrains Mono",
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#71717a" }}
                    />
                    <Line
                      type="monotone"
                      dataKey="amp"
                      stroke="#22c55e"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-muted">
                  <div className="text-3xl">📡</div>
                  <div className="text-sm font-semibold">수신기 연결 안 됨</div>
                  <div className="text-xs font-mono text-center">
                    {backendUp
                      ? "로컬 백엔드는 실행 중이지만 수신기(USB)가 감지되지 않습니다. 수신기 연결 후 자동으로 복구됩니다."
                      : "로컬 백엔드가 실행되고 있지 않습니다. backend 디렉토리에서 main.py를 실행하세요."}
                  </div>
                </div>
              )}
            </div>
          </div>

          <EventLogPanel />
        </div>

        <section className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="p-4 border-b border-border">
            <h3 className="text-xs font-mono font-semibold uppercase tracking-widest">
              최근 낙상 이벤트
            </h3>
          </div>
          <table className="w-full text-left text-sm font-mono">
            <thead>
              <tr className="text-[10px] text-muted border-b border-border">
                <th className="p-3 font-medium uppercase">Timestamp</th>
                <th className="p-3 font-medium uppercase">Resident</th>
                <th className="p-3 font-medium uppercase">DNN Confidence</th>
                <th className="p-3 font-medium uppercase text-right">Response</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {falls.slice(0, 5).map((f) => (
                <tr key={f.id}>
                  <td className="p-3 text-muted">{fmtDateTime(f.timestamp)}</td>
                  <td className="p-3">
                    {f.residentName} (Room {f.room})
                  </td>
                  <td className="p-3">{(f.confidence * 100).toFixed(1)}%</td>
                  <td className="p-3 text-right">
                    <ResponseBadge response={f.response} />
                  </td>
                </tr>
              ))}
              {falls.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted text-xs">
                    감지된 낙상이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

export function Header({
  title,
  criticalCount,
  onlineCount,
}: {
  title: string;
  criticalCount: number;
  onlineCount: number;
}) {
  const [now, setNow] = useState<string>("");
  const user = useCurrentUser();
  const allResidents = useStore((s) => s.residents);
  const scoped =
    user?.service === "FACILITY"
      ? allResidents.filter((r) => r.facilityId === user?.facilityId)
      : allResidents.filter((r) => r.ownerUserId === user?.id);
  const presentCount = scoped.filter((r) => r.presence === "PRESENT").length;
  const absentCount = scoped.length - presentCount;
  useEffect(() => {
    const fmt = () => setNow(new Date().toLocaleString("sv-SE").replace("T", " ").slice(0, 19));
    fmt();
    const id = setInterval(fmt, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <header className="h-14 border-b border-border flex items-center justify-between px-6 shrink-0 bg-background sticky top-0 z-10">
      <div className="flex items-center gap-4">
        <h2 className="text-sm font-medium">{title}</h2>
        <div className="flex gap-2">
          <span
            className={`px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-mono border border-primary/20 ${criticalCount > 0 ? "animate-pulse" : ""}`}
          >
            CRITICAL: {criticalCount}
          </span>
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
              presentCount > 0
                ? "bg-success/10 text-success border-success/20"
                : "bg-muted/10 text-muted border-muted/20"
            }`}
            title="재실 감지: 움직임+WANDER 통합 판단"
          >
            {user?.service === "FACILITY"
              ? presentCount > 0
                ? `재실 ${presentCount}`
                : `퇴실 ${absentCount}`
              : presentCount > 0
                ? "재실"
                : "퇴실"}
          </span>
          <span className="px-2 py-0.5 rounded bg-surface text-muted text-[10px] font-mono border border-border">
            ONLINE: {onlineCount}
          </span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] font-mono text-muted">SYSTEM TIME</div>
        <div className="text-xs font-mono min-h-[14px]" suppressHydrationWarning>
          {now || "—"}
        </div>
      </div>
    </header>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-mono font-semibold uppercase tracking-widest text-muted mb-3">
      {children}
    </h3>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "danger" | "warn" | "success" | "default";
}) {
  const toneClass =
    tone === "danger"
      ? "text-primary"
      : tone === "warn"
        ? "text-warning"
        : tone === "success"
          ? "text-success"
          : "text-foreground";
  return (
    <div className="bg-surface p-4 rounded border border-border">
      <div className="text-[10px] font-mono text-muted mb-1 uppercase">{label}</div>
      <div className={`text-2xl font-mono font-medium tracking-tight ${toneClass}`}>{value}</div>
      <div className="text-[10px] text-muted mt-2 font-mono truncate">{sub}</div>
    </div>
  );
}

export function ResponseBadge({ response }: { response: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    PENDING: { label: "대기중", cls: "text-warning border-warning/30 bg-warning/10" },
    ACKNOWLEDGED: { label: "확인함", cls: "text-sky-600 border-sky-600/30 bg-sky-600/10" },
    DISPATCHED: { label: "출동중", cls: "text-success border-success/30 bg-success/10" },
    FALSE_ALARM: { label: "오탐지", cls: "text-muted border-border bg-background" },
  };
  const m = map[response] ?? map.PENDING;
  return (
    <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded border ${m.cls}`}>
      {m.label}
    </span>
  );
}
