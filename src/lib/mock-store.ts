// Client-side mock store simulating CSI monitoring + fall detection + auth/devices.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

export type StateMachine = "IDLE" | "SUSPECT" | "FALL" | "COOLDOWN";
export type Service = "HOME" | "FACILITY";
export type Role = "ROOT" | "MEMBER" | "USER"; // FACILITY: ROOT/MEMBER · HOME: USER

export interface PipelineConfig {
  window_sec: number;
  stride_sec: number;
  fs_hz: number;
  mv_window_sec: number;
  n_streams: number;
  bandpass_low: number;
  bandpass_high: number;
  bandpass_order: number;
  mv_threshold: number;
  wander_threshold: number;
  presence_timeout_s: number;
  min_duration_s: number;
  merge_gap_s: number;
  max_duration_s: number;
  cooldown_s: number;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  window_sec: 3.0,
  stride_sec: 0.5,
  fs_hz: 100,
  mv_window_sec: 0.5,
  n_streams: 10,
  bandpass_low: 2.0,
  bandpass_high: 50.0,
  bandpass_order: 4,
  mv_threshold: 2.5,
  wander_threshold: 0.6,
  presence_timeout_s: 6.0,
  min_duration_s: 0.5,
  merge_gap_s: 0.25,
  max_duration_s: 2.0,
  cooldown_s: 3.0,
};


export interface Facility {
  id: string;
  name: string;
  code: string; // 초대 코드
  rootUserId: string;
}

export interface UserAccount {
  id: string;
  email: string;
  password: string; // mock only
  name: string;
  service: Service;
  role: Role;
  facilityId?: string;
  onboarded: boolean;
}

export interface Session {
  userId: string;
}

export interface Device {
  id: string;
  name: string;
  room: string;
  mqttTopic: string;
  mac: string;
  fw: string;
  online: boolean;
  lastSeen: number;
  base_rssi: number;
  current_rssi: number;
  agc: number;
  noise_floor: number;
  calibrating: boolean;
  calibrationStage: "IDLE" | "WAITING" | "MEASURING";
  calibrationProgress: number; // 0..1
  connection: "MQTT" | "SERIAL"; // 통신 방식
  serialPort?: string; // SERIAL 연결일 때
  facilityId?: string; // FACILITY 소속
  ownerUserId?: string; // HOME 소유자
}

export type Presence = "PRESENT" | "ABSENT";

export interface Resident {
  id: string;
  name: string;
  room: string;
  age: number;
  caregiver: string;
  deviceId: string; // 주 매핑 장치 (하위 호환)
  deviceIds?: string[]; // 다중 매핑 장치 (선택, deviceId 포함)
  facilityId?: string; // FACILITY 소속
  ownerUserId?: string; // HOME 소유자
  thresholdOverride?: number;
  state: StateMachine;
  mv: number;
  wander: number;
  presence: Presence;
  lastActivityAt: number;
  confidence: number;
  online: boolean;
}



export interface FallEvent {
  id: string;
  residentId: string;
  residentName: string;
  room: string;
  timestamp: number;
  confidence: number;
  duration: number;
  response: "PENDING" | "ACKNOWLEDGED" | "DISPATCHED" | "FALSE_ALARM";
}

export interface Recipient {
  id: string;
  name: string;
  role: "가족" | "요양사" | "관리자";
  phone: string;
  sms: boolean;
  push: boolean;
  ars: boolean;
  residentId?: string; // FACILITY: 입소자별 알림. HOME/공용: undefined
}

export interface EventLogEntry {
  ts: number;
  level: "INFO" | "WARN" | "ERROR" | "FALL";
  msg: string;
  residentId?: string; // 해당 로그가 특정 거주자/장치에 귀속되는 경우
}


interface Store {
  running: boolean;
  port: string;
  mqttBroker: string;
  serialBaud: number;
  activeResidentId: string;
  activeDeviceId: string;
  residents: Resident[];
  devices: Device[];
  facilities: Facility[];
  users: UserAccount[];
  session: Session | null;
  config: PipelineConfig;
  falls: FallEvent[];
  recipients: Recipient[];
  logs: EventLogEntry[];
  mvHistory: { t: number; mv: number }[];
  lastFallAt: number | null;
  alarm: FallEvent | null;
}

// --- Seed data ---
const facility1: Facility = { id: "fac-1", name: "강남요양원", code: "GN-8421", rootUserId: "u-root" };

const seedDevices: Device[] = [
  mkDevice("d1", "302호 화장실", "302", "csi/gn/302/bed", "AA:BB:CC:00:01:12", facility1.id),
  mkDevice("d2", "305호 화장실", "305", "csi/gn/305/bed", "AA:BB:CC:00:01:08", facility1.id),
  mkDevice("d3", "201호 화장실", "201", "csi/gn/201/bed", "AA:BB:CC:00:02:04", facility1.id),
  mkDevice("d4", "208호 화장실", "208", "csi/gn/208/bed", "AA:BB:CC:00:02:15", facility1.id),
  mkDevice("d5", "104호 화장실", "104", "csi/gn/104/bed", "AA:BB:CC:00:03:21", facility1.id),
  mkDevice("d6", "204호 화장실", "204", "csi/gn/204/bed", "AA:BB:CC:00:03:09", facility1.id),
  // 같은 호실의 화장실/샤워실 등 서브 공간 장치 (다중 매핑 시연용)
  mkDevice("d6b", "204호 샤워실", "204", "csi/gn/204/shower", "AA:BB:CC:00:03:0A", facility1.id),
  mkDevice("d1b", "302호 화장실", "302", "csi/gn/302/bath", "AA:BB:CC:00:01:13", facility1.id),
  // HOME 데모 계정(u-home)의 가정 내 장치들
  mkDeviceHome("dh1", "거실 장치", "거실", "csi/home/user/livingroom", "AA:BB:CC:10:00:01", "u-home"),
  mkDeviceHome("dh2", "침실 장치", "침실", "csi/home/user/bedroom", "AA:BB:CC:10:00:02", "u-home"),
  mkDeviceHome("dh3", "화장실 장치", "화장실", "csi/home/user/bathroom", "AA:BB:CC:10:00:03", "u-home"),
];


function mkDeviceHome(id: string, name: string, room: string, topic: string, mac: string, ownerUserId: string): Device {
  return mkDevice(id, name, room, topic, mac, undefined, ownerUserId);
}

function mkDevice(id: string, name: string, room: string, topic: string, mac: string, facilityId?: string, ownerUserId?: string, connection: "MQTT" | "SERIAL" = "MQTT", serialPort?: string): Device {
  return {
    id, name, room, mqttTopic: topic, mac, fw: "v1.4.2",
    online: true, lastSeen: Date.now(),
    base_rssi: -55 + Math.round(Math.random() * 6),
    current_rssi: -55 + Math.round(Math.random() * 6),
    agc: 24 + Math.round(Math.random() * 4),
    noise_floor: -92 + Math.round(Math.random() * 3),
    calibrating: false, calibrationStage: "IDLE", calibrationProgress: 0,
    connection, serialPort,
    facilityId, ownerUserId,
  };
}

const P = { wander: 0.15, presence: "ABSENT" as Presence, lastActivityAt: 0 };
const seedResidents: Resident[] = [
  { id: "r1", name: "김순옥", room: "302", age: 82, caregiver: "강은우", deviceId: "d1", deviceIds: ["d1"], facilityId: facility1.id, state: "IDLE", mv: 0.4, confidence: 0.12, online: true, ...P },
  { id: "r2", name: "박영수", room: "305", age: 75, caregiver: "강은우", deviceId: "d2", deviceIds: ["d2"], facilityId: facility1.id, state: "IDLE", mv: 0.6, confidence: 0.18, online: true, ...P },
  { id: "r3", name: "이철수", room: "201", age: 79, caregiver: "김민지", deviceId: "d3", deviceIds: ["d3"], facilityId: facility1.id, state: "IDLE", mv: 0.3, confidence: 0.09, online: true, ...P },
  { id: "r4", name: "최영희", room: "208", age: 84, caregiver: "김민지", deviceId: "d4", deviceIds: ["d4"], facilityId: facility1.id, state: "IDLE", mv: 0.5, confidence: 0.14, online: true, ...P },
  { id: "r5", name: "정말순", room: "104", age: 88, caregiver: "박지현", deviceId: "d5", deviceIds: ["d5"], facilityId: facility1.id, state: "IDLE", mv: 0.35, confidence: 0.10, online: false, ...P },
  // 다중 매핑 예: 같은 204호의 침실 + 샤워실
  { id: "r6", name: "김옥자", room: "204", age: 84, caregiver: "박지현", deviceId: "d6", deviceIds: ["d6", "d6b"], facilityId: facility1.id, state: "IDLE", mv: 0.7, confidence: 0.22, online: true, ...P },

  // HOME 데모: u-home 소유. 거실+침실 두 대의 장치를 함께 매핑.
  { id: "rh1", name: "이복순", room: "화장실", age: 82, caregiver: "이가정 (아들)", deviceId: "dh2", deviceIds: ["dh2", "dh3"], ownerUserId: "u-home", state: "IDLE", mv: 0.3, confidence: 0.08, online: true, ...P },
];



const seedUsers: UserAccount[] = [
  { id: "u-root", email: "root@demo.io", password: "demo", name: "강은우", service: "FACILITY", role: "ROOT", facilityId: facility1.id, onboarded: true },
  { id: "u-mem1", email: "member@demo.io", password: "demo", name: "김민지", service: "FACILITY", role: "MEMBER", facilityId: facility1.id, onboarded: true },
  { id: "u-home", email: "home@demo.io", password: "demo", name: "이가정", service: "HOME", role: "USER", onboarded: true },
];

function seedHistory() {
  const now = Date.now();
  const arr: { t: number; mv: number }[] = [];
  for (let i = 240; i > 0; i--) arr.push({ t: now - i * 100, mv: 0.3 + Math.random() * 0.4 });
  return arr;
}

// --- Session persistence ---
const SESSION_KEY = "csi-guard-session";
function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try { const raw = window.localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveSession(s: Session | null) {
  if (typeof window === "undefined") return;
  try { s ? window.localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : window.localStorage.removeItem(SESSION_KEY); } catch {}
}

let state: Store = {
  running: false,
  port: "COM4",
  mqttBroker: "mqtt://broker.csi-guard.io:1883",
  serialBaud: 921600,
  activeResidentId: "r1",
  activeDeviceId: "d1",
  residents: seedResidents,
  devices: seedDevices,
  facilities: [facility1],
  users: seedUsers,
  session: null, // hydrated on client after mount
  config: { ...DEFAULT_CONFIG },
  falls: [
    { id: "f-seed-fac", residentId: "r1", residentName: "김순옥", room: "302", timestamp: Date.now() - 1000 * 60 * 42, confidence: 0.94, duration: 1.12, response: "PENDING" },
    { id: "f-seed-home", residentId: "rh1", residentName: "이복순", room: "화장실", timestamp: Date.now() - 1000 * 60 * 60 * 3, confidence: 0.88, duration: 0.86, response: "ACKNOWLEDGED" },
  ],
  recipients: [
    { id: "n1", name: "김보호 (김순옥 아들)", role: "가족", phone: "010-1234-5678", sms: true, push: true, ars: true, residentId: "r1" },
    { id: "n2", name: "박정민 (박영수 딸)", role: "가족", phone: "010-9876-5432", sms: true, push: true, ars: false, residentId: "r2" },
    { id: "n3", name: "강은우 요양사", role: "요양사", phone: "010-2222-3333", sms: true, push: true, ars: false, residentId: "r1" },
    { id: "n4", name: "김민지 요양사", role: "요양사", phone: "010-3333-4444", sms: true, push: true, ars: false, residentId: "r3" },
    { id: "n5", name: "시설 당직실", role: "관리자", phone: "010-0000-0000", sms: true, push: true, ars: true },
  ],
  logs: [{ ts: Date.now() - 60_000, level: "INFO", msg: "시스템 초기화 완료" }],
  mvHistory: seedHistory(),
  lastFallAt: null,
  alarm: null,
};

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }
function set(patch: Partial<Store> | ((s: Store) => Partial<Store>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}

export function getState() { return state; }
export function useStore<T>(selector: (s: Store) => T): T {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => selector(state),
    () => selector(state),
  );
}

// --- Session helpers ---
export function currentUser(): UserAccount | null {
  if (!state.session) return null;
  return state.users.find((u) => u.id === state.session!.userId) ?? null;
}
export function useCurrentUser(): UserAccount | null {
  return useStore((s) => s.session ? s.users.find((u) => u.id === s.session!.userId) ?? null : null);
}
export function useCurrentFacility(): Facility | null {
  const u = useCurrentUser();
  return useStore((s) => u?.facilityId ? s.facilities.find((f) => f.id === u.facilityId) ?? null : null);
}

export function hydrateSession() {
  if (state.session) return;
  const s = loadSession();
  if (s && state.users.some((u) => u.id === s.userId)) set({ session: s });
}

export function login(email: string, password: string): { ok: boolean; error?: string; user?: UserAccount } {
  const u = state.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
  if (!u || u.password !== password) return { ok: false, error: "이메일 또는 비밀번호가 올바르지 않습니다." };
  const sess = { userId: u.id };
  set({ session: sess });
  saveSession(sess);
  addLog("INFO", `로그인: ${u.name} (${u.service})`);
  return { ok: true, user: u };
}

export function logout() {
  saveSession(null);
  set({ session: null, running: false });
}

export interface SignupInput {
  email: string; password: string; name: string; service: Service;
  facilityMode?: "ROOT" | "MEMBER"; // when service === FACILITY
  facilityName?: string;
  inviteCode?: string;
}
export function signup(input: SignupInput): { ok: boolean; error?: string; user?: UserAccount } {
  const s = state;
  if (s.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) return { ok: false, error: "이미 사용 중인 이메일입니다." };
  const uid = `u-${Date.now()}`;
  let role: Role = "USER";
  let facilityId: string | undefined;
  const newFacilities = [...s.facilities];

  if (input.service === "FACILITY") {
    if (input.facilityMode === "ROOT") {
      if (!input.facilityName) return { ok: false, error: "시설명을 입력하세요." };
      const fac: Facility = {
        id: `fac-${Date.now()}`,
        name: input.facilityName,
        code: `${input.facilityName.slice(0, 2).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`,
        rootUserId: uid,
      };
      newFacilities.push(fac);
      facilityId = fac.id;
      role = "ROOT";
    } else {
      const fac = newFacilities.find((f) => f.code.toUpperCase() === (input.inviteCode ?? "").toUpperCase());
      if (!fac) return { ok: false, error: "유효하지 않은 초대 코드입니다." };
      facilityId = fac.id;
      role = "MEMBER";
    }
  }

  const user: UserAccount = {
    id: uid, email: input.email, password: input.password, name: input.name,
    service: input.service, role, facilityId, onboarded: false,
  };
  const sess = { userId: uid };
  set({ users: [...s.users, user], facilities: newFacilities, session: sess });
  saveSession(sess);
  addLog("INFO", `신규 가입: ${user.name} (${user.service}/${role})`);
  return { ok: true, user };
}

export function completeOnboarding() {
  const u = currentUser(); if (!u) return;
  set((s) => ({ users: s.users.map((x) => x.id === u.id ? { ...x, onboarded: true } : x) }));
}

export function addLog(level: EventLogEntry["level"], msg: string, residentId?: string) {
  set((s) => ({ logs: [{ ts: Date.now(), level, msg, residentId }, ...s.logs].slice(0, 50) }));
}


export function startMonitor() { if (state.running) return; set({ running: true }); addLog("INFO", `모니터링 시작 (포트: ${state.port})`); }
export function stopMonitor() { if (!state.running) return; set({ running: false }); addLog("INFO", "모니터링 중지"); }
export function setPort(port: string) { set({ port }); }
export function setMqttBroker(mqttBroker: string) { set({ mqttBroker }); }
export function setSerialBaud(serialBaud: number) { set({ serialBaud }); }
export function updateAccount(patch: Partial<Pick<UserAccount, "name" | "email" | "password">>) {
  const s = state.session; if (!s) return;
  set((st) => ({ users: st.users.map((u) => u.id === s.userId ? { ...u, ...patch } : u) }));
  addLog("INFO", "계정 정보 업데이트됨");
}
export function setActiveResident(id: string) {
  const r = state.residents.find((x) => x.id === id);
  set({ activeResidentId: id, activeDeviceId: r?.deviceId ?? state.activeDeviceId });
  if (r) addLog("INFO", `MQTT 구독 전환: ${r.room}호 (${r.name}) · ${state.devices.find(d => d.id === r.deviceId)?.mqttTopic ?? "-"}`, r.id);
}

export function setActiveDevice(id: string) { set({ activeDeviceId: id }); }
export function updateConfig(patch: Partial<PipelineConfig>) {
  set((s) => ({ config: { ...s.config, ...patch } })); addLog("INFO", "탐지 설정 적용됨");
}
export function acknowledgeAlarm(response: FallEvent["response"]) {
  const a = state.alarm; if (!a) return;
  set((s) => ({ alarm: null, falls: s.falls.map((f) => f.id === a.id ? { ...f, response } : f) }));
  addLog("INFO", `알람 응답: ${response} (${a.residentName})`);
}
export function dismissAlarm() { set({ alarm: null }); }

// 데모: 딥러닝 추론 결과로 낙상 발생을 강제 트리거 (파이프라인 시연용)
export function simulateFall(residentId?: string) {
  const s = state;
  const u = currentUser();
  const targetId = residentId ?? s.activeResidentId;
  const r = s.residents.find((x) => x.id === targetId);
  const now = Date.now();
  const confidence = 0.88 + Math.random() * 0.1;
  const duration = 0.9 + Math.random() * 0.6;

  // HOME 계정에 등록된 거주자가 없으면 사용자 본인을 대상 이벤트로 생성
  const evt: FallEvent = r
    ? { id: `f-sim-${now}`, residentId: r.id, residentName: r.name, room: r.room, timestamp: now, confidence, duration, response: "PENDING" }
    : { id: `f-sim-${now}`, residentId: u?.id ?? "u", residentName: u?.name ?? "사용자", room: s.devices.find((d) => d.ownerUserId === u?.id)?.room ?? "거실", timestamp: now, confidence, duration, response: "PENDING" };

  // 대상 거주자 상태를 FALL로 전이시켜 그래프에도 스파이크 반영
  set((prev) => ({
    residents: prev.residents.map((x) => x.id === targetId ? { ...x, state: "FALL", mv: 3.8, confidence } : x),
    falls: [evt, ...prev.falls].slice(0, 200),
    lastFallAt: now,
    alarm: prev.alarm ?? evt,
    mvHistory: [...prev.mvHistory, { t: now, mv: 3.8 }].slice(-240),
  }));
  fallCooldown[targetId] = now + s.config.cooldown_s * 1000 + 2000;
  addLog("FALL", `[시뮬레이션] ${evt.residentName} (${evt.room}) 낙상 감지 · DNN confidence ${(confidence * 100).toFixed(1)}%`, evt.residentId);
}
export function upsertResident(r: Resident) {
  set((s) => {
    const exists = s.residents.some((x) => x.id === r.id);
    return { residents: exists ? s.residents.map((x) => x.id === r.id ? r : x) : [...s.residents, r] };
  });
}
export function deleteResident(id: string) { set((s) => ({ residents: s.residents.filter((r) => r.id !== id) })); }
export function upsertRecipient(r: Recipient) {
  set((s) => {
    const exists = s.recipients.some((x) => x.id === r.id);
    return { recipients: exists ? s.recipients.map((x) => x.id === r.id ? r : x) : [...s.recipients, r] };
  });
}
export function deleteRecipient(id: string) { set((s) => ({ recipients: s.recipients.filter((r) => r.id !== id) })); }
export function updateResponse(id: string, response: FallEvent["response"]) {
  set((s) => ({ falls: s.falls.map((f) => f.id === id ? { ...f, response } : f) }));
}

// --- Device management ---
export function upsertDevice(d: Device) {
  set((s) => {
    const exists = s.devices.some((x) => x.id === d.id);
    return { devices: exists ? s.devices.map((x) => x.id === d.id ? d : x) : [...s.devices, d] };
  });
}
export function deleteDevice(id: string) { set((s) => ({ devices: s.devices.filter((d) => d.id !== id) })); }
export function removeMember(userId: string) {
  set((s) => ({ users: s.users.filter((u) => u.id !== userId) }));
}
export function regenerateInviteCode(facilityId: string) {
  set((s) => ({
    facilities: s.facilities.map((f) => f.id === facilityId ? {
      ...f, code: `${f.name.slice(0, 2).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`
    } : f),
  }));
}

// Device calibration: 10s WAITING + 10s MEASURING
const resetTimers: Record<string, ReturnType<typeof setInterval>> = {};
export function startDeviceReset(deviceId: string) {
  const d = state.devices.find((x) => x.id === deviceId); if (!d) return;
  if (resetTimers[deviceId]) clearInterval(resetTimers[deviceId]);
  const start = Date.now();
  const WAIT = 10_000, MEASURE = 10_000;
  set((s) => ({
    devices: s.devices.map((x) => x.id === deviceId ? { ...x, calibrating: true, calibrationStage: "WAITING", calibrationProgress: 0 } : x),
  }));
  addLog("WARN", `[${d.name}] 재설정 시작 · 10초간 감지 공간 비워주세요`);
  resetTimers[deviceId] = setInterval(() => {
    const el = Date.now() - start;
    if (el < WAIT) {
      set((s) => ({ devices: s.devices.map((x) => x.id === deviceId ? { ...x, calibrationStage: "WAITING", calibrationProgress: el / WAIT } : x) }));
    } else if (el < WAIT + MEASURE) {
      const p = (el - WAIT) / MEASURE;
      set((s) => ({ devices: s.devices.map((x) => x.id === deviceId ? { ...x, calibrationStage: "MEASURING", calibrationProgress: p } : x) }));
    } else {
      clearInterval(resetTimers[deviceId]); delete resetTimers[deviceId];
      const nb_rssi = -58 + Math.round(Math.random() * 6);
      const nb_noise = -94 + Math.round(Math.random() * 3);
      set((s) => ({
        devices: s.devices.map((x) => x.id === deviceId ? {
          ...x, calibrating: false, calibrationStage: "IDLE", calibrationProgress: 1,
          base_rssi: nb_rssi, current_rssi: nb_rssi, noise_floor: nb_noise, lastSeen: Date.now(),
        } : x),
      }));
      addLog("INFO", `[${d.name}] 캘리브레이션 완료 · base_rssi=${nb_rssi}dBm noise=${nb_noise}dBm`);
    }
  }, 100);
}
export function getResetTimeLeft(deviceId: string): { stage: Device["calibrationStage"]; secLeft: number; progress: number } {
  const d = state.devices.find((x) => x.id === deviceId);
  if (!d || !d.calibrating) return { stage: "IDLE", secLeft: 0, progress: 0 };
  const secLeft = Math.max(0, Math.ceil((1 - d.calibrationProgress) * 10));
  return { stage: d.calibrationStage, secLeft, progress: d.calibrationProgress };
}

// --- 로컬 백엔드 실판정 연동 (HOME 실장치 1대) ---
// BackendDetectionBridge가 /ws/live 판정을 이 함수로 흘려보낸다.
// 이 거주자는 mock tick 시뮬레이션에서 제외되며, 연결이 끊기면 mock으로
// 위장하지 않고 오프라인(연결 끊김)으로 명시 표시한다.
let backendDrivenResidentId: string | null = null;

export function applyBackendDetection(input: {
  connected: boolean; // 브라우저-백엔드 WS와 백엔드-수신기 시리얼 모두 연결됨
  state?: StateMachine;
  proba?: number | null;
}) {
  const u = currentUser();
  if (!u || u.service !== "HOME") return;
  const target = state.residents.find((r) => r.ownerUserId === u.id);
  if (!target) return;
  backendDrivenResidentId = target.id;

  if (!input.connected) {
    if (target.online) {
      set((s) => ({
        residents: s.residents.map((r) => (r.id === target.id ? { ...r, online: false } : r)),
      }));
      addLog("WARN", `${target.name} 실장치 연결 끊김 · 백엔드/수신기 확인 필요`, target.id);
    }
    return;
  }

  const nextState = input.state ?? "IDLE";
  const confidence = input.proba ?? 0;
  const now = Date.now();

  if (target.state !== "FALL" && nextState === "FALL") {
    const fall: FallEvent = {
      id: `f-${now}-${target.id}`,
      residentId: target.id,
      residentName: target.name,
      room: target.room,
      timestamp: now,
      confidence,
      // 세그멘테이션 모델의 고정 지연 판정 설계값 (윈도우 중앙 시점, 1.5초 전)
      duration: 1.5,
      response: "PENDING",
    };
    set((s) => ({
      residents: s.residents.map((r) =>
        r.id === target.id ? { ...r, online: true, state: "FALL", confidence } : r,
      ),
      falls: [fall, ...s.falls].slice(0, 200),
      lastFallAt: now,
      alarm: s.alarm ?? fall,
    }));
    addLog(
      "FALL",
      `${target.name} (${target.room}) 낙상 감지 · 모델 확률 ${(confidence * 100).toFixed(1)}%`,
      target.id,
    );
    return;
  }

  // 상태/확률이 실제로 바뀔 때만 반영해 불필요한 리렌더를 줄인다
  if (
    target.state !== nextState ||
    !target.online ||
    Math.abs(target.confidence - confidence) > 0.001
  ) {
    set((s) => ({
      residents: s.residents.map((r) =>
        r.id === target.id ? { ...r, online: true, state: nextState, confidence } : r,
      ),
    }));
  }
}

// --- Simulation loop ---
let fallCooldown: Record<string, number> = {};

function tick() {
  const s = state;
  if (!s.running) return;
  const now = Date.now();

  const u = currentUser();
  const scopedResidents = u?.service === "FACILITY"
    ? s.residents.filter((r) => r.facilityId === u.facilityId)
    : s.residents; // HOME uses own devices; treat all for demo

  // For FACILITY: only active device (선택한 호실) receives MQTT tick sim
  // 백엔드 실판정으로 구동되는 거주자는 mock 시뮬레이션 대상에서 제외
  const activeIds = (u?.service === "FACILITY"
    ? [s.activeResidentId]
    : scopedResidents.filter((r) => r.online).map((r) => r.id)
  ).filter((id) => id !== backendDrivenResidentId);

  // HOME 실장치가 백엔드 실판정으로 구동 중이면 데모 거주자에게도 무작위 낙상을
  // 주입하지 않는다. 실데이터 화면에서 가짜 낙상 알람이 실판정과 섞이면 안 된다.
  const injectMockFalls = !(u?.service === "HOME" && backendDrivenResidentId !== null);

  const updated = s.residents.map((r) => {
    if (!activeIds.includes(r.id)) return r;
    const baseline = 0.3 + Math.random() * 0.5;
    const cooling = (fallCooldown[r.id] ?? 0) > now;
    const spike = injectMockFalls && !cooling && Math.random() < 0.006;
    const mv = spike ? 3.0 + Math.random() * 2.0 : baseline;
    const threshold = r.thresholdOverride ?? s.config.mv_threshold;
    let nextState: StateMachine = r.state;
    const confidence = Math.min(0.99, mv / (threshold * 1.5));

    // WANDER 감지 (더미): 온라인 거주자에게 랜덤 신호 + 움직임 잔향 반영
    const wanderBase = 0.15 + Math.random() * 0.35;
    const wanderSpike = Math.random() < 0.05 ? 0.4 + Math.random() * 0.4 : 0;
    const mvEcho = mv >= threshold ? 0.35 : 0; // 움직임 감지 직후 WANDER 지속되는 경향 반영
    const wander = Math.min(1, wanderBase + wanderSpike + mvEcho);

    // 재실 판단 (더미 로직): 움직임(MV) 또는 WANDER 신호가 감지되면 활동 시각 갱신 → 재실
    //   지속적으로 배경노이즈만 있으면 presence_timeout_s 후 퇴실 판단
    const mvHit = mv >= threshold;
    const wanderHit = wander >= s.config.wander_threshold;
    const lastActivityAt = (mvHit || wanderHit) ? now : r.lastActivityAt;
    const idleMs = now - (lastActivityAt || 0);
    const presence: Presence = (lastActivityAt > 0 && idleMs < s.config.presence_timeout_s * 1000)
      ? "PRESENT"
      : "ABSENT";
    if (presence !== r.presence) {
      const label = presence === "PRESENT" ? "재실" : "퇴실";
      queueMicrotask(() => addLog("INFO", `${r.name} (${r.room}호) ${label} 판단 · MV+WANDER 재실 감지`, r.id));
    }


    if (r.state === "COOLDOWN") { if (!cooling) nextState = "IDLE"; }
    else if (mv >= threshold) { nextState = r.state === "SUSPECT" ? "FALL" : "SUSPECT"; }
    else { nextState = "IDLE"; }

    if (r.state !== "FALL" && nextState === "FALL") {
      const fall: FallEvent = {
        id: `f-${now}-${r.id}`, residentId: r.id, residentName: r.name, room: r.room,
        timestamp: now, confidence, duration: s.config.min_duration_s + Math.random(), response: "PENDING",
      };
      fallCooldown[r.id] = now + s.config.cooldown_s * 1000 + 2000;
      queueMicrotask(() => {
        set((prev) => ({
          falls: [fall, ...prev.falls].slice(0, 200),
          lastFallAt: now,
          alarm: prev.alarm ?? fall,
        }));
        addLog("FALL", `${r.name} (${r.room}호) 낙상 감지 · DNN confidence ${(confidence * 100).toFixed(1)}%`, r.id);
      });
      nextState = "COOLDOWN";
    }
    return { ...r, mv, wander, presence, lastActivityAt, confidence, state: nextState };
  });


  // devices: tiny rssi/noise wobble (only for online, non-calibrating)
  const updDevices = s.devices.map((d) => {
    if (d.calibrating || !d.online) return d;
    const rssi = d.base_rssi + Math.round((Math.random() - 0.5) * 4);
    const noise = d.noise_floor + Math.round((Math.random() - 0.5) * 2);
    return { ...d, current_rssi: rssi, noise_floor: noise, lastSeen: now };
  });

  const active = updated.find((r) => r.id === s.activeResidentId);
  const nextHistory = [...s.mvHistory, { t: now, mv: active?.mv ?? 0 }].slice(-240);
  set({ residents: updated, devices: updDevices, mvHistory: nextHistory });
}

if (typeof window !== "undefined") {
  setInterval(tick, 100);
}

export function useTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), 200);
    return () => clearInterval(id);
  }, []);
}

// Utility formatters
export function fmtTime(ts: number) { return new Date(ts).toLocaleTimeString("ko-KR", { hour12: false }); }
export function fmtDateTime(ts: number) { return new Date(ts).toLocaleString("ko-KR", { hour12: false }); }
export function stateLabel(s: StateMachine) { return { IDLE: "대기", SUSPECT: "의심", FALL: "낙상", COOLDOWN: "냉각중" }[s]; }
export function stateColor(s: StateMachine) { return { IDLE: "text-muted", SUSPECT: "text-warning", FALL: "text-primary", COOLDOWN: "text-sky-600" }[s]; }
export function presenceLabel(p: Presence) { return p === "PRESENT" ? "재실" : "퇴실"; }
export function presenceColor(p: Presence) { return p === "PRESENT" ? "text-success" : "text-muted"; }

// 현재 사용자의 스코프에 속한 로그만 반환 (거주자 귀속 로그는 소유/시설 매칭, 시스템 로그는 공통)
export function useScopedLogs(): EventLogEntry[] {
  const logs = useStore((s) => s.logs);
  const residents = useStore((s) => s.residents);
  const user = useCurrentUser();
  return useMemo(() => {
    if (!user) return logs;
    const scopedIds = new Set(
      residents
        .filter((r) => user.service === "FACILITY" ? r.facilityId === user.facilityId : r.ownerUserId === user.id)
        .map((r) => r.id),
    );
    return logs.filter((l) => !l.residentId || scopedIds.has(l.residentId));
  }, [logs, residents, user]);
}


// 통합 현재상태: 우선순위 낙상/의심/COOLDOWN > 재실 > 대기(퇴실)
export function unifiedStatusLabel(s: StateMachine, p: Presence) {
  if (s === "FALL" || s === "SUSPECT" || s === "COOLDOWN") return stateLabel(s);
  return p === "PRESENT" ? "재실" : "퇴실";
}
export function unifiedStatusColor(s: StateMachine, p: Presence) {
  if (s === "FALL" || s === "SUSPECT" || s === "COOLDOWN") return stateColor(s);
  return p === "PRESENT" ? "text-success" : "text-muted";
}

