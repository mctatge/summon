export type TeachingMode = 'desktop' | 'browser';
export type TeachingApp = { bundleId: string; name: string };
export type TeachingParameter = { name: string; label: string; example: string; primary: boolean };

export type TeachingStep = {
  kind: 'activate' | 'fill' | 'click' | 'select' | 'press';
  surface?: { kind: 'desktop'; bundleId: string; app: string; title?: string };
  target?: { name?: string; placeholder?: string; tag?: string; role?: string; inputType?: string; selector?: string; identifier?: string };
  value?: string;
};

type ProcedureFields = {
  id: string;
  name: string;
  summary: string;
  intent?: string;
  parameters: TeachingParameter[];
  steps: TeachingStep[];
  verification: { text: string } | null;
};
export type BrowserProcedure = ProcedureFields & { kind?: 'browser'; scope: { origin: string; pathname: string } };
export type DesktopProcedure = ProcedureFields & { kind: 'desktop'; apps: TeachingApp[] };
export type Procedure = BrowserProcedure | DesktopProcedure;

export type TeachingView = {
  mode: TeachingMode;
  phase: 'idle' | 'recording' | 'reviewing' | 'proposal' | 'running' | 'error';
  message: string;
  desktop?: { permissions: { accessibility: boolean; inputMonitoring: boolean; screenRecording?: boolean }; apps: TeachingApp[]; selectedApps: string[]; engine?: 'local' | 'codex' | 'claude'; visualReading?: boolean; visualStatus?: string; visualMessage?: string };
  browser: { connected: boolean; url?: string; title?: string };
  connection?: { port: number; token: string } | null;
  proposal: Procedure | null;
  procedures: Procedure[];
  activeId: string | null;
  lastRun?: { id: string; verified: boolean; confirmed?: boolean } | null;
};

export type TeachingBridge = {
  showTeachingExtension?(): Promise<void>;
  teachingRead(): Promise<TeachingView>;
  teachingAction(action: string, input?: unknown): Promise<TeachingView>;
};
